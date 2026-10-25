// OPN-1 (plan docs/plans/OPN-1.md §4–§5, D-opn1-1..5): the opening balance of a branch. General Manager only
// (`opening.manage`); one opening per branch (UNIQUE branch_id), DRAFT → SEALED.
//
//   * A draft is not stock: its lines are entered by keyboard or imported from a CSV file, reviewed (count and weight by
//     karat and by type, the lines paged and searchable) and exported, and can be removed while it is a draft.
//   * The importer (CSV only, D-opn1-2) checks the whole file first: one bad row (row number, column, reason) and nothing
//     is written. The same file twice changes nothing (UNIQUE opening + SHA-256 of the bytes); the Idempotency-Key covers
//     a retried request. Types are matched by their normalized name and never created.
//   * Sealing (D-opn1-5): the password in the request and a fresh passkey, always (no passkey → 403 PASSKEY_REQUIRED);
//     refused on a FIXED_TAG installation (D-opn1-4). In one transaction every line becomes a piece: the next system code
//     and barcode in the sheet's order (D-opn1-1), origin OPENING, cost UNKNOWN (NULL, never 0), price from the
//     new-piece rate, an ADJUSTMENT +1 movement with a NULL cost value; no cash, no ledger entry. Then nothing changes:
//     the service answers 409 OPENING_SEALED and the triggers of migration 0026 refuse it in the database too.

import { createHash } from 'node:crypto';
import { and, asc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import { ap, CsvSyntaxError, normalizeName, normalizeDigits, parseIntegerInput, parseWeightInput, readCsv, writeCsv } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, notFound } from '../../core/errors';
import { nextItemCodes } from '../../core/numbering';
import { allowedKarats } from '../../core/karats';
import type { TxIdempotency } from '../../core/idempotency';
import { maxIdOf, runPaged, type PageRequest, type SortSpec } from '../../core/paging';
import { freshFactors, reauthRequired } from '../../auth/reauth';
import { reauthenticate } from '../auth/service';
import { cleanDescription } from '../catalog/service';

/** At most this many rows in one file (plan §5: about 550 kB for a typical sheet; the route limits the body to 1 MB). */
export const OPENING_IMPORT_MAX_ROWS = 5_000;
/** The route's body limit for the CSV file. */
export const OPENING_IMPORT_MAX_BYTES = 1024 * 1024;
/** A refused file lists at most this many of its errors (the count says how many there are). */
const MAX_REPORTED_ERRORS = 500;
/** Inserts and updates of the sealing go in chunks of this many rows. */
const CHUNK = 500;

/** The columns of the sheet, named in Arabic and in English (the template's header is "Arabic / English"). */
export const OPENING_COLUMNS = [
  { key: 'type', ar: 'النوع', en: 'Type' },
  { key: 'description', ar: 'الوصف', en: 'Description' },
  { key: 'karat', ar: 'العيار', en: 'Karat' },
  { key: 'grossWeight', ar: 'الوزن القائم (جم)', en: 'Gross weight (g)' },
  { key: 'netWeight', ar: 'الوزن الصافي (جم)', en: 'Net weight (g)' },
] as const;
type ColumnKey = (typeof OPENING_COLUMNS)[number]['key'];
const REQUIRED: ColumnKey[] = ['type', 'karat', 'grossWeight', 'netWeight'];
const headerCell = (c: { ar: string; en: string }) => `${c.ar} / ${c.en}`;
/** A header cell as compared: normalized, without a unit in brackets. */
const headerKey = (s: string) => typeKey(s.replace(/\([^)]*\)/g, ' '));
/** A type name as compared (the duplicate rule of the catalog: normalized, case and spaces ignored). */
const typeKey = (s: string) => normalizeName(s).replace(/\s+/g, ' ').trim().toLowerCase();

export interface OpeningLineInput {
  categoryId: number;
  description?: string | null;
  karat: number;
  grossWeightMg: number;
  netWeightMg: number;
}

/** One problem of an imported file: its row (the spreadsheet's line number), the column and the reason (a key). */
export interface ImportProblem {
  line: number;
  column: ColumnKey | null;
  key: string;
  params?: Record<string, string | number>;
}

const sealedError = (branchCode: string) => new AppError(409, 'OPENING_SEALED', 'The opening of {branch} is sealed: nothing can be added or removed', { branch: branchCode });

/** The opening row FOR UPDATE (every write takes it, so lines and the seal never interleave) and its branch. */
async function lockOpening(tx: Executor, id: number) {
  const [o] = await tx.select().from(t.openings).where(eq(t.openings.id, id)).for('update');
  if (!o) throw notFound('Opening');
  const [b] = await tx.select({ id: t.branches.id, code: t.branches.code, name: t.branches.name, nameAr: t.branches.nameAr }).from(t.branches).where(eq(t.branches.id, o.branchId));
  return { opening: o, branch: b };
}
async function lockDraft(tx: Executor, id: number) {
  const r = await lockOpening(tx, id);
  if (r.opening.status !== 'DRAFT') throw sealedError(r.branch.code);
  return r;
}

/** The weights of a line: net above 0, gross at least net (integer mg). */
function weightProblem(gross: number, net: number): string | null {
  if (!(net > 0)) return 'The net weight must be above 0';
  if (gross < net) return 'The gross weight cannot be below the net weight';
  return null;
}

/** The active types by every normalized name (Arabic and English). */
async function typesByName(exec: Executor) {
  const all = await exec.select({ id: t.categories.id, name: t.categories.name, nameAr: t.categories.nameAr, isActive: t.categories.isActive }).from(t.categories);
  const map = new Map<string, { id: number; isActive: boolean }>();
  for (const c of all) {
    for (const n of [c.nameAr, c.name]) {
      const k = typeKey(n ?? '');
      if (k && !map.has(k)) map.set(k, { id: c.id, isActive: c.isActive });
    }
  }
  return map;
}

/** Next line number of the opening (lines keep their order: the sheet's, then the keyboard's). */
async function nextLineNo(tx: Executor, openingId: number) {
  const [r] = await tx.select({ n: sql<number>`coalesce(max(${t.openingLines.lineNo}), 0)`.mapWith(Number) }).from(t.openingLines).where(eq(t.openingLines.openingId, openingId));
  return r.n + 1;
}

/** Count and weights by karat (and by type) of an opening's lines. */
async function summaryOf(exec: Executor, openingId: number) {
  const byKarat = await exec
    .select({
      karat: t.openingLines.karat,
      count: sql<number>`count(*)`.mapWith(Number),
      grossWeightMg: sql<number>`coalesce(sum(${t.openingLines.grossWeightMg}), 0)`.mapWith(Number),
      netWeightMg: sql<number>`coalesce(sum(${t.openingLines.netWeightMg}), 0)`.mapWith(Number),
    })
    .from(t.openingLines)
    .where(eq(t.openingLines.openingId, openingId))
    .groupBy(t.openingLines.karat)
    .orderBy(asc(t.openingLines.karat));
  const byType = await exec
    .select({
      categoryId: t.openingLines.categoryId,
      categoryName: t.categories.name,
      categoryNameAr: t.categories.nameAr,
      count: sql<number>`count(*)`.mapWith(Number),
      netWeightMg: sql<number>`coalesce(sum(${t.openingLines.netWeightMg}), 0)`.mapWith(Number),
    })
    .from(t.openingLines)
    .innerJoin(t.categories, eq(t.categories.id, t.openingLines.categoryId))
    .where(eq(t.openingLines.openingId, openingId))
    .groupBy(t.openingLines.categoryId, t.categories.name, t.categories.nameAr)
    .orderBy(asc(t.categories.nameAr));
  const total = byKarat.reduce((s, k) => ({ count: s.count + k.count, grossWeightMg: s.grossWeightMg + k.grossWeightMg, netWeightMg: s.netWeightMg + k.netWeightMg }), { count: 0, grossWeightMg: 0, netWeightMg: 0 });
  return { total, byKarat, byType };
}

/** `GET /openings`: every active branch with its opening (none, DRAFT or SEALED). */
export async function listOpenings(ctx: Ctx, actor: Actor) {
  requirePerm(actor, 'opening.manage');
  const branches = await ctx.db.select({ id: t.branches.id, code: t.branches.code, name: t.branches.name, nameAr: t.branches.nameAr }).from(t.branches).where(eq(t.branches.isActive, true)).orderBy(asc(t.branches.id));
  const openings = await ctx.db
    .select({
      id: t.openings.id,
      branchId: t.openings.branchId,
      status: t.openings.status,
      createdAt: t.openings.createdAt,
      sealedAt: t.openings.sealedAt,
      lineCount: sql<number>`(select count(*) from opening_lines ol where ol.opening_id = "openings"."id")`.mapWith(Number),
      netWeightMg: sql<number>`(select coalesce(sum(ol.net_weight_mg), 0) from opening_lines ol where ol.opening_id = "openings"."id")`.mapWith(Number),
    })
    .from(t.openings);
  const byBranch = new Map(openings.map((o) => [o.branchId, o]));
  return { branches: branches.map((b) => ({ branchId: b.id, branchCode: b.code, branchName: b.name, branchNameAr: b.nameAr, opening: byBranch.get(b.id) ?? null })) };
}

/** `POST /openings`: the DRAFT of a branch; a second opening of the same branch → 409 OPENING_EXISTS. */
export async function createOpening(ctx: Ctx, actor: Actor, input: { branchId: number }, opts: { idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'opening.manage');
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const [b] = await tx.select().from(t.branches).where(eq(t.branches.id, input.branchId));
    if (!b || !b.isActive) throw badRequest('Choose an active branch');
    // The branch row lock serializes two creations for one branch (the UNIQUE branch_id is the last line of defence).
    await tx.execute(sql`SELECT 1 FROM branches WHERE id = ${b.id} FOR UPDATE`);
    const [existing] = await tx.select({ id: t.openings.id, status: t.openings.status }).from(t.openings).where(eq(t.openings.branchId, b.id));
    if (existing) throw new AppError(409, 'OPENING_EXISTS', '{branch} already has an opening balance', { branch: b.code }, { openingId: existing.id, status: existing.status });
    const [o] = await tx.insert(t.openings).values({ branchId: b.id, createdBy: actor.userId, sessionId: actor.sessionId ?? null }).returning();
    await writeAudit(tx, actor, { action: 'OPENING_CREATED', entityType: 'opening', entityId: o.id, branchId: b.id, key: 'Opening balance of {branch} started', params: { branch: ap.text(b.name, b.nameAr) } });
    const result = { id: o.id, branchId: b.id, status: o.status };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

export type OpeningLineSortKey = 'lineNo';
const lineSorts: Record<OpeningLineSortKey, SortSpec> = { lineNo: { by: t.openingLines.lineNo, field: 'lineNo', dir: 'asc' } };

/** `GET /openings/:id`: the opening, its summary (count and weights by karat and by type) and one page of its lines. */
export async function getOpening(ctx: Ctx, actor: Actor, id: number, q: PageRequest<OpeningLineSortKey> & { q?: string; karat?: number; categoryId?: number } = {}) {
  requirePerm(actor, 'opening.manage');
  const [o] = await ctx.db
    .select({ opening: t.openings, branchCode: t.branches.code, branchName: t.branches.name, branchNameAr: t.branches.nameAr })
    .from(t.openings)
    .innerJoin(t.branches, eq(t.branches.id, t.openings.branchId))
    .where(eq(t.openings.id, id));
  if (!o) throw notFound('Opening');
  const where: SQL[] = [eq(t.openingLines.openingId, id)];
  if (q.karat != null) where.push(eq(t.openingLines.karat, q.karat));
  if (q.categoryId != null) where.push(eq(t.openingLines.categoryId, q.categoryId));
  if (q.q?.trim()) {
    const like = `%${q.q.trim()}%`;
    where.push(or(ilike(t.openingLines.description, like), ilike(t.categories.nameAr, like), ilike(t.categories.name, like), ilike(t.jewelryItems.code, like))!);
  }
  const base = () =>
    ctx.db
      .select({
        id: t.openingLines.id,
        lineNo: t.openingLines.lineNo,
        categoryId: t.openingLines.categoryId,
        categoryName: t.categories.name,
        categoryNameAr: t.categories.nameAr,
        description: t.openingLines.description,
        karat: t.openingLines.karat,
        grossWeightMg: t.openingLines.grossWeightMg,
        netWeightMg: t.openingLines.netWeightMg,
        source: t.openingLines.source,
        itemId: t.openingLines.itemId,
        code: t.jewelryItems.code,
        barcode: t.jewelryItems.barcode,
      })
      .from(t.openingLines)
      .innerJoin(t.categories, eq(t.categories.id, t.openingLines.categoryId))
      .leftJoin(t.jewelryItems, eq(t.jewelryItems.id, t.openingLines.itemId));
  const lines = await runPaged(actor, q, {
    sorts: lineSorts,
    defaultSort: 'lineNo',
    id: t.openingLines.id,
    where,
    maxId: async () => Number((await ctx.db.select({ m: maxIdOf(t.openingLines.id) }).from(t.openingLines))[0].m),
    count: async (w) =>
      Number(
        (
          await ctx.db
            .select({ n: sql<number>`count(*)` })
            .from(t.openingLines)
            .innerJoin(t.categories, eq(t.categories.id, t.openingLines.categoryId))
            .leftJoin(t.jewelryItems, eq(t.jewelryItems.id, t.openingLines.itemId))
            .where(w)
        )[0].n,
      ),
    rows: async ({ where: w, orderBy, limit, offset }) => base().where(w).orderBy(...orderBy).limit(limit).offset(offset),
  });
  const { opening } = o;
  return {
    id: opening.id,
    branchId: opening.branchId,
    branchCode: o.branchCode,
    branchName: o.branchName,
    branchNameAr: o.branchNameAr,
    status: opening.status,
    createdAt: opening.createdAt,
    sealedAt: opening.sealedAt,
    summary: await summaryOf(ctx.db, id),
    imports: await ctx.db
      .select({ id: t.openingImports.id, fileName: t.openingImports.fileName, rowCount: t.openingImports.rowCount, createdAt: t.openingImports.createdAt })
      .from(t.openingImports)
      .where(eq(t.openingImports.openingId, id))
      .orderBy(asc(t.openingImports.id)),
    lines,
  };
}

/** Checks a keyboard line (the import checks its rows itself, to report them all at once). */
async function checkLine(ctx: Ctx, exec: Executor, l: OpeningLineInput) {
  const [type] = await exec.select({ id: t.categories.id, isActive: t.categories.isActive }).from(t.categories).where(eq(t.categories.id, l.categoryId));
  if (!type) throw badRequest('Choose the item type');
  if (!type.isActive) throw badRequest('This item type is deactivated');
  const allowed = await allowedKarats(ctx);
  if (!allowed.includes(l.karat)) throw badRequest('{karat}K is not sold here: sellable pieces must be {allowed}', { karat: l.karat, allowed: allowed.map((k) => `${k}K`).join(', ') });
  const w = weightProblem(l.grossWeightMg, l.netWeightMg);
  if (w) throw badRequest(w);
  return { description: cleanDescription(l.description) };
}

/** `POST /openings/:id/lines`: one piece typed in (draft only). */
export async function addOpeningLine(ctx: Ctx, actor: Actor, id: number, input: OpeningLineInput, opts: { idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'opening.manage');
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const { branch } = await lockDraft(tx, id);
    const { description } = await checkLine(ctx, tx, input);
    const lineNo = await nextLineNo(tx, id);
    const [line] = await tx
      .insert(t.openingLines)
      .values({ openingId: id, lineNo, categoryId: input.categoryId, description, karat: input.karat, grossWeightMg: input.grossWeightMg, netWeightMg: input.netWeightMg, source: 'KEYBOARD', createdBy: actor.userId })
      .returning();
    await writeAudit(tx, actor, {
      action: 'OPENING_LINE_ADDED',
      entityType: 'opening',
      entityId: id,
      branchId: branch.id,
      key: 'Opening of {branch}: line {line} added, {karat} {weight}',
      params: { branch: branch.code, line: lineNo, karat: ap.karat(input.karat), weight: ap.mg(input.netWeightMg) },
    });
    const result = { id: line.id, lineNo, openingId: id };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/** `POST /openings/:id/lines/:lineId/remove`: a draft line out (draft only; audited with what it held). */
export async function removeOpeningLine(ctx: Ctx, actor: Actor, id: number, lineId: number, opts: { idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'opening.manage');
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const { branch } = await lockDraft(tx, id);
    const [line] = await tx.select().from(t.openingLines).where(and(eq(t.openingLines.id, lineId), eq(t.openingLines.openingId, id)));
    if (!line) throw notFound('Opening line');
    await tx.delete(t.openingLines).where(eq(t.openingLines.id, lineId));
    await writeAudit(tx, actor, {
      action: 'OPENING_LINE_REMOVED',
      entityType: 'opening',
      entityId: id,
      branchId: branch.id,
      key: 'Opening of {branch}: line {line} removed, {karat} {weight}',
      params: { branch: branch.code, line: line.lineNo, karat: ap.karat(line.karat), weight: ap.mg(line.netWeightMg) },
      metadata: { line: { lineNo: line.lineNo, categoryId: line.categoryId, description: line.description, karat: line.karat, grossWeightMg: line.grossWeightMg, netWeightMg: line.netWeightMg, source: line.source } },
    });
    const result = { ok: true as const, removedLineNo: line.lineNo };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/** The rows of a CSV file as opening lines, or every problem in it (nothing is partial). */
export async function parseOpeningCsv(ctx: Ctx, exec: Executor, bytes: Buffer): Promise<{ lines: (OpeningLineInput & { line: number })[]; problems: ImportProblem[] }> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { lines: [], problems: [{ line: 1, column: null, key: 'The file is not UTF-8 text: save it as "CSV UTF-8"' }] };
  }
  let table;
  try {
    table = readCsv(text);
  } catch (e) {
    if (e instanceof CsvSyntaxError) return { lines: [], problems: [{ line: e.line, column: null, key: 'A quote is not closed or is in the middle of a cell' }] };
    throw e;
  }
  const problems: ImportProblem[] = [];
  // The header: each column once, by its Arabic or English name (or both, as in the template).
  const position = new Map<ColumnKey, number>();
  table.header.forEach((cell, i) => {
    const parts = cell.split('/').map(headerKey).filter(Boolean);
    const col = OPENING_COLUMNS.find((c) => parts.some((p) => p === headerKey(c.ar) || p === headerKey(c.en)));
    if (!col) problems.push({ line: 1, column: null, key: 'Unknown column "{name}"', params: { name: cell.trim() } });
    else if (position.has(col.key)) problems.push({ line: 1, column: col.key, key: 'The column "{name}" appears twice', params: { name: cell.trim() } });
    else position.set(col.key, i);
  });
  for (const k of REQUIRED) if (!position.has(k)) problems.push({ line: 1, column: k, key: 'The column "{name}" is missing', params: { name: headerCell(OPENING_COLUMNS.find((c) => c.key === k)!) } });
  if (problems.length) return { lines: [], problems };
  if (!table.rows.length) return { lines: [], problems: [{ line: 2, column: null, key: 'The file has no rows' }] };
  if (table.rows.length > OPENING_IMPORT_MAX_ROWS) return { lines: [], problems: [{ line: table.rows[OPENING_IMPORT_MAX_ROWS].line, column: null, key: 'A file can have at most {max} rows: split it into several files', params: { max: OPENING_IMPORT_MAX_ROWS } }] };

  const types = await typesByName(exec);
  const allowed = await allowedKarats(ctx);
  const lines: (OpeningLineInput & { line: number })[] = [];
  for (const r of table.rows) {
    const cell = (k: ColumnKey) => (position.has(k) ? (r.cells[position.get(k)!] ?? '').trim() : '');
    const before = problems.length;
    const add = (column: ColumnKey | null, key: string, params?: ImportProblem['params']) => problems.push({ line: r.line, column, key, ...(params ? { params } : {}) });
    if (r.cells.length > table.header.length) add(null, 'This row has more cells than the header');

    const typeName = cell('type');
    const type = typeName ? types.get(typeKey(typeName)) : undefined;
    if (!typeName) add('type', 'Choose the item type');
    else if (!type) add('type', 'Unknown item type "{name}": create it first or correct the name', { name: typeName });
    else if (!type.isActive) add('type', 'The item type "{name}" is deactivated', { name: typeName });

    let description: string | null = null;
    try {
      description = cleanDescription(cell('description'));
    } catch {
      add('description', 'A description can have at most 120 characters');
    }

    const karatText = cell('karat').replace(/[kK]$|قيراط$/, '').trim();
    const karat = karatText ? parseIntegerInput(karatText) : null;
    if (!karatText) add('karat', 'Choose the karat');
    else if (karat == null) add('karat', 'The karat must be a whole number');
    else if (!allowed.includes(karat)) add('karat', '{karat}K is not sold here: sellable pieces must be {allowed}', { karat, allowed: allowed.map((k) => `${k}K`).join(', ') });

    const weight = (k: 'grossWeight' | 'netWeight') => {
      const raw = normalizeDigits(cell(k));
      if (!raw) {
        add(k, 'Enter the weight in grams');
        return null;
      }
      const mg = parseWeightInput(raw);
      if (mg == null) add(k, 'The weight must be a number of grams with at most 3 decimals');
      return mg;
    };
    const gross = weight('grossWeight');
    const net = weight('netWeight');
    if (gross != null && net != null) {
      const w = weightProblem(gross, net);
      if (w) add(w.startsWith('The net') ? 'netWeight' : 'grossWeight', w);
    }
    if (problems.length === before) lines.push({ line: r.line, categoryId: type!.id, description, karat: karat!, grossWeightMg: gross!, netWeightMg: net! });
  }
  return { lines, problems };
}

/** `POST /openings/:id/import`: a CSV file into the draft, all rows or none; the same file again changes nothing. */
export async function importOpeningCsv(ctx: Ctx, actor: Actor, id: number, input: { fileName: string; bytes: Buffer }, opts: { idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'opening.manage');
  if (input.bytes.length > OPENING_IMPORT_MAX_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request is too large');
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const fileName = input.fileName.trim().slice(0, 200) || 'opening.csv';
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const { branch } = await lockDraft(tx, id);
    const [same] = await tx.select().from(t.openingImports).where(and(eq(t.openingImports.openingId, id), eq(t.openingImports.sha256, sha256)));
    if (same) {
      // The same file again: the first import's result, nothing written.
      const result = { importId: same.id, duplicate: true, rowCount: same.rowCount, fileName: same.fileName, summary: await summaryOf(tx, id) };
      await opts.idem?.complete(tx, result);
      return result;
    }
    const { lines, problems } = await parseOpeningCsv(ctx, tx, input.bytes);
    if (problems.length) {
      throw new AppError(422, 'OPENING_IMPORT_INVALID', 'The file has {count} problem(s): nothing was imported', { count: problems.length }, { errorCount: problems.length, errors: problems.slice(0, MAX_REPORTED_ERRORS) });
    }
    const [imp] = await tx.insert(t.openingImports).values({ openingId: id, fileName, sha256, rowCount: lines.length, createdBy: actor.userId }).returning();
    const first = await nextLineNo(tx, id);
    for (let i = 0; i < lines.length; i += CHUNK) {
      await tx.insert(t.openingLines).values(
        lines.slice(i, i + CHUNK).map((l, j) => ({
          openingId: id,
          lineNo: first + i + j,
          categoryId: l.categoryId,
          description: l.description ?? null,
          karat: l.karat,
          grossWeightMg: l.grossWeightMg,
          netWeightMg: l.netWeightMg,
          source: 'IMPORT',
          importId: imp.id,
          createdBy: actor.userId,
        })),
      );
    }
    const netWeightMg = lines.reduce((s, l) => s + l.netWeightMg, 0);
    await writeAudit(tx, actor, {
      action: 'OPENING_IMPORTED',
      entityType: 'opening',
      entityId: id,
      branchId: branch.id,
      key: 'Opening of {branch}: file {file} imported, {n} piece(s), {weight}',
      params: { branch: branch.code, file: fileName, n: lines.length, weight: ap.mg(netWeightMg) },
      metadata: { importId: imp.id, fileName, sha256, rowCount: lines.length, netWeightMg },
    });
    const result = { importId: imp.id, duplicate: false, rowCount: lines.length, fileName, summary: await summaryOf(tx, id) };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

const grams = (mg: number) => `${Math.trunc(mg / 1000)}.${String(mg % 1000).padStart(3, '0')}`;

/** `GET /openings/template.csv`: the header row only, each column in Arabic and English. */
export function openingTemplateCsv(): string {
  return writeCsv([OPENING_COLUMNS.map(headerCell)], { bom: true });
}

/**
 * `GET /openings/:id/export`: the draft as a file that imports again (the sheet's columns), or, once sealed, the pieces
 * with their system codes and barcodes first (D-opn1-1: to write the codes on the tags until labels exist).
 */
export async function exportOpeningCsv(ctx: Ctx, actor: Actor, id: number) {
  requirePerm(actor, 'opening.manage');
  const [o] = await ctx.db.select({ status: t.openings.status, branchCode: t.branches.code }).from(t.openings).innerJoin(t.branches, eq(t.branches.id, t.openings.branchId)).where(eq(t.openings.id, id));
  if (!o) throw notFound('Opening');
  const rowsAll = await ctx.db
    .select({ code: t.jewelryItems.code, barcode: t.jewelryItems.barcode, typeAr: t.categories.nameAr, description: t.openingLines.description, karat: t.openingLines.karat, gross: t.openingLines.grossWeightMg, net: t.openingLines.netWeightMg })
    .from(t.openingLines)
    .innerJoin(t.categories, eq(t.categories.id, t.openingLines.categoryId))
    .leftJoin(t.jewelryItems, eq(t.jewelryItems.id, t.openingLines.itemId))
    .where(eq(t.openingLines.openingId, id))
    .orderBy(asc(t.jewelryItems.id), asc(t.openingLines.lineNo));
  const sealed = o.status === 'SEALED';
  const head = [...(sealed ? [headerCell({ ar: 'الرمز', en: 'Code' }), headerCell({ ar: 'الباركود', en: 'Barcode' })] : []), ...OPENING_COLUMNS.map(headerCell)];
  const body = rowsAll.map((r) => [...(sealed ? [r.code, r.barcode] : []), r.typeAr, r.description, r.karat, grams(r.gross), grams(r.net)]);
  return { fileName: `opening-${o.branchCode}-${sealed ? 'sealed' : 'draft'}.csv`, text: writeCsv([head, ...body], { bom: true }) };
}

/** `POST /openings/:id/seal`: every line becomes a piece of unknown cost; then the opening is closed for good. */
export async function sealOpening(ctx: Ctx, actor: Actor, id: number, input: { confirmPassword?: string }, opts: { at?: Date; idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'opening.manage');
  const settings = await ctx.settings.get();
  // D-opn1-4: opening pieces carry no tag price; they sell at the new-piece rate (computed prices only).
  if (settings.pricing.mode !== 'RATE_COMPUTED') {
    throw new AppError(409, 'OPENING_NEEDS_COMPUTED_PRICES', 'Switch on computed prices (price per gram) before sealing: opening pieces have no tag price');
  }
  if (!input.confirmPassword) throw new AppError(403, 'CONFIRM_PASSWORD_REQUIRED', 'Enter your password to confirm');
  // D-opn1-5: always a fresh passkey too; a General Manager without one registers it first.
  const f = await freshFactors(ctx, ctx.db, actor.sessionId, actor.userId);
  if (!f.hasPasskey) throw new AppError(403, 'PASSKEY_REQUIRED', 'Register a passkey first: sealing the opening balance needs your passkey');
  if (!f.passkey) throw reauthRequired(f);
  await reauthenticate(ctx, actor, input.confirmPassword);

  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const { opening, branch } = await lockDraft(tx, id);
    // The sheet's order (imports in the order they came), then the keyboard lines in entry order (D-opn1-1).
    const lines = await tx
      .select()
      .from(t.openingLines)
      .where(eq(t.openingLines.openingId, id))
      .orderBy(sql`${t.openingLines.importId} IS NULL`, asc(t.openingLines.importId), asc(t.openingLines.lineNo));
    if (!lines.length) throw new AppError(422, 'OPENING_EMPTY', 'The opening has no pieces: enter or import them first');
    const codes = await nextItemCodes(tx, lines.length);
    const ref = { refType: 'opening', refId: opening.id, refNumber: `OPN-${branch.code}` };
    const note = 'Opening balance';
    for (let i = 0; i < lines.length; i += CHUNK) {
      const part = lines.slice(i, i + CHUNK);
      const items = await tx
        .insert(t.jewelryItems)
        .values(
          part.map((l, j) => ({
            code: codes[i + j].code,
            barcode: codes[i + j].barcode,
            categoryId: l.categoryId,
            description: l.description,
            karat: l.karat,
            grossWeightMg: l.grossWeightMg,
            netWeightMg: l.netWeightMg,
            origin: 'OPENING',
            // D-dec1-3: unknown, never 0.
            acquisitionCost: null,
            costIsEstimated: false,
            makingCharge: 0,
            // D-opn1-4: no tag price; the live price is the new-piece rate × weight.
            sellingPrice: 0,
            branchId: branch.id,
            status: 'AVAILABLE',
            createdAt: at,
            updatedAt: at,
          })),
        )
        .returning({ id: t.jewelryItems.id, code: t.jewelryItems.code, netWeightMg: t.jewelryItems.netWeightMg });
      const idOf = new Map(items.map((it) => [it.code, it]));
      const made = part.map((l, j) => ({ line: l, item: idOf.get(codes[i + j].code)! }));
      await tx.insert(t.itemStatusHistory).values(made.map(({ item }) => ({ itemId: item.id, fromStatus: null, toStatus: 'AVAILABLE', branchId: branch.id, ...ref, userId: actor.userId, at, note })));
      // The movement of recordMovement (inventory/ledger.ts), in bulk: ADJUSTMENT +1 at an unknown cost.
      await tx.insert(t.inventoryMovements).values(
        made.map(({ item }) => ({ itemId: item.id, branchId: branch.id, type: 'ADJUSTMENT', direction: 1, fromBranchId: null, toBranchId: null, ...ref, netWeightMg: item.netWeightMg, costValue: null, userId: actor.userId, note, at })),
      );
      await tx.execute(sql`
        UPDATE opening_lines ol SET item_id = v.item_id
        FROM (VALUES ${sql.join(made.map(({ line, item }) => sql`(${line.id}::int, ${item.id}::int)`), sql`, `)}) AS v(id, item_id)
        WHERE ol.id = v.id`);
    }
    await tx.update(t.openings).set({ status: 'SEALED', sealedBy: actor.userId, sealedAt: at, sessionId: actor.sessionId ?? null }).where(eq(t.openings.id, id));
    const { byKarat, total } = await summaryOf(tx, id);
    await writeAudit(tx, actor, {
      action: 'OPENING_SEALED',
      entityType: 'opening',
      entityId: id,
      branchId: branch.id,
      at,
      key: 'Opening of {branch} sealed: {n} piece(s), {weight}, codes {first} to {last}',
      params: { branch: ap.text(branch.name, branch.nameAr), n: total.count, weight: ap.mg(total.netWeightMg), first: codes[0].code, last: codes[codes.length - 1].code },
      metadata: { pieces: total.count, netWeightMg: total.netWeightMg, byKarat, firstCode: codes[0].code, lastCode: codes[codes.length - 1].code, passkeyUv: f.passkeyUv },
    });
    const result = { id, status: 'SEALED' as const, pieces: total.count, netWeightMg: total.netWeightMg, byKarat, firstCode: codes[0].code, lastCode: codes[codes.length - 1].code, sealedAt: at };
    await opts.idem?.complete(tx, result);
    return result;
  });
}
