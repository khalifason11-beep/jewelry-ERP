#!/usr/bin/env node
// Gate (REM-3, run by `npm run typecheck`): a NEW migration may not destroy or silently rewrite data or
// protections. Every statement of a migration numbered above BASELINE that contains
//   DROP TABLE · DROP SCHEMA · DROP COLUMN · TRUNCATE · DELETE FROM · ALTER COLUMN … TYPE · RENAME ·
//   DROP CONSTRAINT · DROP TRIGGER · ALTER TABLE … DISABLE TRIGGER · DROP FUNCTION · REVOKE
// fails unless the statement carries an explicit justification comment:
//   -- allow-destructive: <reason>
// DROP INDEX, DROP NOT NULL and DROP DEFAULT stay allowed without a comment. Replacing a CHECK constraint
// (DROP CONSTRAINT then ADD CONSTRAINT) legitimately needs the comment (docs/decisions.md D-rem3-*).
//
// Why: in CAT-0, drizzle-kit run on a partly cut schema file generated DROP TABLE statements for live
// tables; they were caught by hand. This gate catches them automatically. Migrations up to BASELINE were
// reviewed when they were written and are not re-judged.
//
// SAFE-1 additions:
//   * Applied migrations are frozen. database/migrations/checksums.json holds the sha256 of every migration file
//     (line endings normalised to LF, so a Windows checkout hashes the same). The gate fails when a listed file's
//     content changed, when a listed file disappeared, or when a migration file is not listed yet. A NEW migration is
//     added to the manifest with `npm run check:migrations -- --record`, which only ADDS missing entries and never
//     rewrites an existing one. Why a committed manifest rather than "compare with the previous commit": it works in
//     shallow CI clones and offline, and every change to it is visible in review.
//   * From migration DECISION_FROM on, the justification must cite a written decision:
//     `-- allow-destructive: D-xxx <reason>` (CLAUDE.md: destructive changes need a D-* decision and the owner).
//
// Statements are separated by drizzle's `--> statement-breakpoint` marker (or, without it, by `;` at the
// end of a line). Comments and quoted strings are ignored when looking for the keywords; the
// justification must be a `--` comment inside the statement (on its own line, usually just above it).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE = 15; // 0015_catalog_entry.sql is the last migration written before this gate
export const DECISION_FROM = 23; // the first migration written after SAFE-1 must cite a D-* decision
export const MANIFEST = 'checksums.json';

const RULES = [
  ['DROP TABLE', /\bDROP\s+TABLE\b/i],
  ['DROP SCHEMA', /\bDROP\s+SCHEMA\b/i],
  ['DROP COLUMN', /\bDROP\s+COLUMN\b/i],
  // A truncate of a table, not the TRUNCATE event in `CREATE TRIGGER … BEFORE … TRUNCATE ON …` (a protection).
  ['TRUNCATE', /\bTRUNCATE\s+(?!ON\b|OR\b)(TABLE\s+|ONLY\s+)?("|\w)/i],
  ['DELETE FROM', /\bDELETE\s+FROM\b/i],
  ['ALTER COLUMN … TYPE', /\bALTER\s+COLUMN\s+("[^"]*"|\w+)\s+(SET\s+DATA\s+)?TYPE\b/i],
  ['RENAME', /\bRENAME\b/i],
  ['DROP CONSTRAINT', /\bDROP\s+CONSTRAINT\b/i],
  ['DROP TRIGGER', /\bDROP\s+TRIGGER\b/i],
  ['DISABLE TRIGGER', /\bALTER\s+TABLE\b[\s\S]*\bDISABLE\s+TRIGGER\b/i],
  ['DROP FUNCTION', /\bDROP\s+FUNCTION\b/i],
  ['REVOKE', /\bREVOKE\b/i],
];
const ALLOW = /--[ \t]*allow-destructive:[ \t]*\S[^\n]{2,}/i;
const ALLOW_WITH_DECISION = /--[ \t]*allow-destructive:[^\n]*\bD-[A-Za-z0-9]+-?[A-Za-z0-9-]*/i;

/** SQL without comments, quoted strings or dollar-quoted bodies' quoting (keywords inside them are ignored). */
function stripped(sql) {
  return sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, (m) => m.replace(/'[^']*'/g, "''")) // keep body code, drop its strings
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

export function splitStatements(sql) {
  if (sql.includes('--> statement-breakpoint')) return sql.split('--> statement-breakpoint');
  return sql.split(/;[ \t]*\r?\n/);
}

/** Problems in one migration's SQL: `{ statement, rule }` for every destructive statement without a justification. */
export function checkMigrationSql(sql, opts = {}) {
  const allow = opts.requireDecision ? ALLOW_WITH_DECISION : ALLOW;
  const problems = [];
  splitStatements(sql).forEach((raw, i) => {
    const code = stripped(raw);
    for (const [rule, re] of RULES) {
      // "DROP NOT NULL" / "DROP DEFAULT" / "DROP INDEX" are allowed; none of the rules above match them.
      if (re.test(code) && !allow.test(raw)) problems.push({ statement: i + 1, rule, text: raw.trim().split('\n').find((l) => !l.trim().startsWith('--'))?.trim().slice(0, 140) ?? '' });
    }
  });
  return problems;
}

export function migrationNumber(file) {
  const m = /^(\d{4})_.*\.sql$/.exec(path.basename(file));
  return m ? Number(m[1]) : null;
}

/** Check every migration in `dir` numbered above BASELINE; returns the failures. */
export function checkMigrationsDir(dir) {
  const failures = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const n = migrationNumber(f);
    if (n === null || n <= BASELINE) continue;
    for (const p of checkMigrationSql(fs.readFileSync(path.join(dir, f), 'utf8'), { requireDecision: n >= DECISION_FROM })) failures.push({ file: f, ...p });
  }
  return failures;
}

/** sha256 of a migration's text with line endings normalised to LF. */
export const checksum = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

const migrationFiles = (dir) => fs.readdirSync(dir).filter((f) => migrationNumber(f) !== null).sort();

/** Manifest problems: an applied file changed, a listed file is gone, or a file is not listed. */
export function checkManifest(dir, manifest) {
  const problems = [];
  const files = migrationFiles(dir);
  for (const f of files) {
    const sum = checksum(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!(f in manifest)) problems.push({ file: f, kind: 'unlisted' });
    else if (manifest[f] !== sum) problems.push({ file: f, kind: 'changed' });
  }
  for (const f of Object.keys(manifest)) if (!files.includes(f)) problems.push({ file: f, kind: 'missing' });
  return problems;
}

/** Add the files missing from the manifest (never changes an existing entry). Returns the added names. */
export function recordNew(dir, manifest) {
  const added = [];
  for (const f of migrationFiles(dir)) {
    if (f in manifest) continue;
    manifest[f] = checksum(fs.readFileSync(path.join(dir, f), 'utf8'));
    added.push(f);
  }
  return added;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(root, 'database', 'migrations');
  const manifestPath = path.join(dir, MANIFEST);
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  if (process.argv.includes('--record')) {
    const added = recordNew(dir, manifest);
    const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
    fs.writeFileSync(manifestPath, JSON.stringify(sorted, null, 2) + '\n');
    console.log(added.length ? `recorded ${added.length} new migration(s): ${added.join(', ')}` : 'nothing to record: every migration is already listed');
  }
  const frozen = checkManifest(dir, manifest);
  if (frozen.length) {
    console.error('Migration check FAILED: the applied migrations are frozen (database/migrations/checksums.json):');
    for (const p of frozen) {
      const why = { changed: 'content CHANGED after it was recorded: never edit an applied migration, write a new one', missing: 'listed but the file is gone', unlisted: 'not in the manifest: a new migration is recorded with `npm run check:migrations -- --record`' }[p.kind];
      console.error(`  ${p.file}: ${why}`);
    }
    process.exit(1);
  }
  const failures = checkMigrationsDir(dir);
  const checked = fs.readdirSync(dir).filter((f) => (migrationNumber(f) ?? 0) > BASELINE).length;
  if (failures.length) {
    console.error('Migration check FAILED: destructive statements without "-- allow-destructive: <reason>" (from ' + String(DECISION_FROM).padStart(4, '0') + ' on: "-- allow-destructive: D-xxx <reason>"):');
    for (const f of failures) console.error(`  ${f.file} statement ${f.statement}: ${f.rule} — ${f.text}`);
    console.error('Add the comment with a real reason inside the statement (REM-5 does this for the planned drops), or rewrite the migration.');
    process.exit(1);
  }
  console.log(`migrations OK: ${Object.keys(manifest).length} applied migration(s) unchanged (checksums.json); ${checked} after ${String(BASELINE).padStart(4, '0')} checked for destructive statements.`);
}
