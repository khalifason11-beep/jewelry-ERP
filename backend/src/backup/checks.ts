// The restore drill's integrity checks (D-2c-4), run against the RESTORED throwaway database.
// Each check returns ok + a short detail; the drill fails if any is not ok.

import type { ClientBase } from 'pg';
import { DB_ENUM_CHECKS, DB_EXPR_CHECKS } from '@jerp/shared';
import { APPEND_ONLY_TABLES } from '../core/startup';
import { collectStats, type DbStats } from './stats';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const first = <T>(xs: T[], n = 5) => (xs.length > n ? [...xs.slice(0, n), `… (+${xs.length - n})`] : xs);

async function scalar(client: ClientBase, q: string): Promise<number> {
  const r = await client.query<{ n: string }>(q);
  return Number(r.rows[0].n);
}

/** Does `statement` fail with the append-only error? Runs inside a savepoint, always rolled back. */
async function refused(client: ClientBase, statement: string): Promise<boolean | string> {
  await client.query('SAVEPOINT jerp_drill');
  try {
    await client.query(statement);
    return false;
  } catch (e) {
    return /append-only/.test(String((e as Error).message)) ? true : String((e as Error).message);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT jerp_drill');
  }
}

export async function checkRestored(client: ClientBase, source: DbStats): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const restored = await collectStats(client);

  // 1. Row counts of every table equal the source at backup time.
  {
    const bad: string[] = [];
    for (const [tbl, n] of Object.entries(source.tables)) {
      const r = restored.tables[tbl];
      if (r !== n) bad.push(`${tbl}: source ${n}, restored ${r ?? 'missing'}`);
    }
    out.push({ name: 'row counts', ok: bad.length === 0, detail: bad.length ? first(bad).join('; ') : `${Object.keys(source.tables).length} tables match` });
  }

  // 2. Every ledger account: balance (= sum of its entries) equals the source; entries are consistent.
  {
    const bad: string[] = [];
    for (const [id, a] of Object.entries(source.ledger)) {
      const r = restored.ledger[id];
      if (!r) bad.push(`account ${id} missing`);
      else if (r.balance !== a.balance || r.branchId !== a.branchId || r.kind !== a.kind) bad.push(`account ${id} (${a.kind}, branch ${a.branchId}): source ${a.balance}, restored ${r.balance}`);
    }
    for (const id of Object.keys(restored.ledger)) if (!source.ledger[id]) bad.push(`account ${id} not in the source`);
    const wrongBranch = await scalar(client, `SELECT count(*) AS n FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.branch_id <> a.branch_id`);
    if (wrongBranch) bad.push(`${wrongBranch} entries on another branch's account`);
    const badReversal = await scalar(
      client,
      `SELECT count(*) AS n FROM ledger_entries r LEFT JOIN ledger_entries o ON o.id = r.reverses_entry_id
       WHERE r.reverses_entry_id IS NOT NULL AND (o.id IS NULL OR o.account_id <> r.account_id OR o.amount <> -r.amount)`,
    );
    if (badReversal) bad.push(`${badReversal} reversal entries that do not mirror their original`);
    out.push({ name: 'ledger balances', ok: bad.length === 0, detail: bad.length ? first(bad).join('; ') : `${Object.keys(source.ledger).length} accounts: balance = sum of entries = source` });
  }

  // 3. Scrap weight pool: every balance equals the sum of its entries at the source, none negative.
  {
    const bad: string[] = [];
    const keys = new Set([...Object.keys(source.pool), ...Object.keys(restored.pool)]);
    for (const k of keys) if ((source.pool[k] ?? 0) !== (restored.pool[k] ?? 0)) bad.push(`pool ${k}: source ${source.pool[k] ?? 0}, restored ${restored.pool[k] ?? 0}`);
    for (const [k, w] of Object.entries(restored.pool)) if (w < 0) bad.push(`pool ${k} is negative (${w})`);
    out.push({ name: 'scrap pool balances', ok: bad.length === 0, detail: bad.length ? first(bad).join('; ') : `${keys.size} branch/karat balances match` });
  }

  // 4. Supplier gold: debt − Σ settled (24K) = still owed, for every order with a gold debt.
  {
    const n = await scalar(
      client,
      `SELECT count(*) AS n FROM purchases p
       WHERE p.gold_debt_mg_pure24 IS NOT NULL
         AND p.gold_debt_mg_pure24 - coalesce((SELECT sum(s.settled_pure_mg24) FROM supplier_settlements s WHERE s.purchase_id = p.id), 0) <> p.gold_owed_mg_pure24`,
    );
    out.push({ name: 'supplier gold owed', ok: n === 0, detail: n ? `${n} purchase orders where debt − settled ≠ owed` : 'debt − settled = owed on every order' });
  }

  // 5. Append-only tables: both triggers exist, are enabled, call jerp_forbid_modification(), and
  //    really refuse UPDATE, DELETE and TRUNCATE (tested in a transaction that is rolled back).
  {
    const bad: string[] = [];
    let behaviour = 0;
    await client.query('BEGIN');
    try {
      for (const tbl of APPEND_ONLY_TABLES) {
        const trg = await client.query<{ name: string; def: string; enabled: string }>(
          `SELECT tgname AS name, pg_get_triggerdef(oid) AS def, tgenabled AS enabled FROM pg_trigger WHERE tgrelid = to_regclass($1) AND NOT tgisinternal`,
          [`public.${tbl}`],
        );
        const row = trg.rows.find((x) => x.name === `${tbl}_append_only`);
        const stmt = trg.rows.find((x) => x.name === `${tbl}_no_truncate`);
        if (!row || !/BEFORE (UPDATE OR DELETE|DELETE OR UPDATE) ON/.test(row.def) || !/FOR EACH ROW/.test(row.def) || !/jerp_forbid_modification\(\)/.test(row.def) || row.enabled === 'D') {
          bad.push(`${tbl}: row trigger missing or altered`);
        }
        if (!stmt || !/BEFORE TRUNCATE/.test(stmt.def) || !/jerp_forbid_modification\(\)/.test(stmt.def) || stmt.enabled === 'D') {
          bad.push(`${tbl}: truncate trigger missing or altered`);
        }
        const rowsIn = await scalar(client, `SELECT count(*) AS n FROM ${ident(tbl)}`);
        const tries: [string, string][] = [[`TRUNCATE ${ident(tbl)} CASCADE`, 'TRUNCATE']];
        if (rowsIn > 0) {
          const col = (await client.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position LIMIT 1`, [tbl])).rows[0].c;
          const one = `ctid = (SELECT ctid FROM ${ident(tbl)} LIMIT 1)`;
          tries.push([`UPDATE ${ident(tbl)} SET ${ident(col)} = ${ident(col)} WHERE ${one}`, 'UPDATE'], [`DELETE FROM ${ident(tbl)} WHERE ${one}`, 'DELETE']);
        }
        for (const [q, what] of tries) {
          const r = await refused(client, q);
          if (r !== true) bad.push(`${tbl}: ${what} was ${r === false ? 'ACCEPTED' : `refused for another reason (${r})`}`);
          else behaviour++;
        }
      }
    } finally {
      await client.query('ROLLBACK');
    }
    out.push({
      name: 'append-only triggers',
      ok: bad.length === 0,
      detail: bad.length ? first(bad, 8).join('; ') : `${APPEND_ONLY_TABLES.length} tables: triggers present, ${behaviour} UPDATE/DELETE/TRUNCATE attempts refused`,
    });
  }

  // 6. CHECK constraints: every one of the source is present, every one the code expects is present,
  //    and none is left NOT VALID.
  {
    const have = new Set(restored.checks);
    const bad: string[] = [];
    for (const c of source.checks) if (!have.has(c)) bad.push(`${c} missing`);
    for (const c of [...DB_ENUM_CHECKS, ...DB_EXPR_CHECKS]) if (!have.has(`${c.table}.${c.name}`)) bad.push(`${c.table}.${c.name} (expected by the code) missing`);
    const notValid = await scalar(client, `SELECT count(*) AS n FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace AND NOT convalidated`);
    if (notValid) bad.push(`${notValid} constraints NOT VALID`);
    out.push({ name: 'check constraints', ok: bad.length === 0, detail: bad.length ? first(bad).join('; ') : `${restored.checks.length} present and validated` });
  }
  return out;
}
