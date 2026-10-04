// What a backup is checked against (D-2c-4). Collected by the backup role INSIDE the very snapshot
// pg_dump uses, so the restored copy must match it exactly: row counts of every table, the balance
// of every ledger account, every scrap pool balance and every CHECK constraint name.

import type { ClientBase } from 'pg';

export interface DbStats {
  /** "schema.table" → row count, every base table outside the system schemas. */
  tables: Record<string, number>;
  /** ledger account id → { branchId, kind, balance = SUM(amount) }. */
  ledger: Record<string, { branchId: number; kind: string; balance: number }>;
  /** "branchId:karat" → SUM(weight_mg). */
  pool: Record<string, number>;
  /** "table.constraint" of every CHECK constraint in the public schema. */
  checks: string[];
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

export async function collectStats(client: ClientBase): Promise<DbStats> {
  const tables: Record<string, number> = {};
  const list = await client.query<{ s: string; t: string }>(
    `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
     WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg\\_%'
     ORDER BY 1, 2`,
  );
  for (const { s, t } of list.rows) {
    const r = await client.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${ident(s)}.${ident(t)}`);
    tables[`${s}.${t}`] = Number(r.rows[0].n);
  }
  const ledger: DbStats['ledger'] = {};
  const lr = await client.query<{ id: number; branch_id: number; kind: string; balance: string }>(
    `SELECT a.id, a.branch_id, a.kind, coalesce(sum(e.amount), 0)::bigint AS balance
     FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id GROUP BY a.id ORDER BY a.id`,
  );
  for (const r of lr.rows) ledger[String(r.id)] = { branchId: Number(r.branch_id), kind: r.kind, balance: Number(r.balance) };
  const pool: DbStats['pool'] = {};
  const pr = await client.query<{ b: number; k: number; w: string }>(`SELECT branch_id AS b, karat AS k, sum(weight_mg)::bigint AS w FROM scrap_weight_entries GROUP BY 1, 2 ORDER BY 1, 2`);
  for (const r of pr.rows) pool[`${r.b}:${r.k}`] = Number(r.w);
  const cr = await client.query<{ c: string }>(
    `SELECT conrelid::regclass::text || '.' || conname AS c FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace ORDER BY 1`,
  );
  return { tables, ledger, pool, checks: cr.rows.map((r) => r.c) };
}
