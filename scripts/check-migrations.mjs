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
// Statements are separated by drizzle's `--> statement-breakpoint` marker (or, without it, by `;` at the
// end of a line). Comments and quoted strings are ignored when looking for the keywords; the
// justification must be a `--` comment inside the statement (on its own line, usually just above it).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE = 15; // 0015_catalog_entry.sql is the last migration written before this gate

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
export function checkMigrationSql(sql) {
  const problems = [];
  splitStatements(sql).forEach((raw, i) => {
    const code = stripped(raw);
    for (const [rule, re] of RULES) {
      // "DROP NOT NULL" / "DROP DEFAULT" / "DROP INDEX" are allowed; none of the rules above match them.
      if (re.test(code) && !ALLOW.test(raw)) problems.push({ statement: i + 1, rule, text: raw.trim().split('\n').find((l) => !l.trim().startsWith('--'))?.trim().slice(0, 140) ?? '' });
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
    for (const p of checkMigrationSql(fs.readFileSync(path.join(dir, f), 'utf8'))) failures.push({ file: f, ...p });
  }
  return failures;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(root, 'database', 'migrations');
  const failures = checkMigrationsDir(dir);
  const checked = fs.readdirSync(dir).filter((f) => (migrationNumber(f) ?? 0) > BASELINE).length;
  if (failures.length) {
    console.error('Migration check FAILED: destructive statements without "-- allow-destructive: <reason>":');
    for (const f of failures) console.error(`  ${f.file} statement ${f.statement}: ${f.rule} — ${f.text}`);
    console.error('Add the comment with a real reason inside the statement (REM-5 does this for the planned drops), or rewrite the migration.');
    process.exit(1);
  }
  console.log(`migrations OK: ${checked} migration(s) after ${String(BASELINE).padStart(4, '0')} checked for destructive statements.`);
}
