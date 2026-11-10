// LBL-1 (docs/plans/LBL-1.md, D-lbl1-2): the label size rule and its settings (both projects).
//   * Code128 modules of a digits-only value = jsbarcode's own encoding (12 digits = 101, 13 = 123);
//   * the smallest label: (modules + 2 × 10 quiet) × 2 dots at 203 DPI + the margins (12 digits, 1 mm margins:
//     32.3 mm; no margin: 30.3 mm) and 5 mm bars + the digits line + the margins in height;
//   * property: a size on the 0.5 mm grid gives bars of a whole number of dots ≥ 2 that fit inside the margins, or is
//     refused with the minimum; a size at or above the minimum is never refused;
//   * the settings: empty until set; 0.5 mm steps; the printer class's maximum width; a size too small for the
//     longest barcode in stock is refused 409 LABEL_TOO_SMALL with the minimum; every change is in the history.

import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import {
  code128DigitModules,
  DEFAULT_SETTINGS,
  LABEL_DOT_MM,
  LABEL_MAX_WIDTH_MM,
  LABEL_MIN_MODULE_DOTS,
  labelLayout,
  minLabelHeightMm,
  minLabelWidthMm,
  onLabelStep,
} from '@jerp/shared';
import { createContext } from '../src/bootstrap';
import type { Ctx } from '../src/core/context';
import { seedWorld } from './fixtures/world';
import { openTestDatabase } from './helpers';

// jsbarcode is the frontend's renderer (the invoice and the labels); its encoder is the reference for the module count.
const JsBarcode = createRequire(import.meta.url)('jsbarcode') as (target: object, value: string, opts: object) => void;
const jsModules = (value: string) => {
  const o: { encodings?: { data: string }[] } = {};
  JsBarcode(o, value, { format: 'CODE128' });
  return o.encodings!.map((e) => e.data).join('').length;
};

let handle: DatabaseHandle;
let ctx: Ctx;
const save = (changes: Record<string, unknown>) => ctx.db.transaction((tx) => ctx.settings.apply(tx, changes, { actor: { id: 1, username: 'general.manager' } }));
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e as { code?: string }).code ?? String(e));

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, new Date('2026-11-10T09:00:00Z'));
}, 120_000);
afterAll(async () => handle?.close());

describe('the size rule (shared/src/labels.ts)', () => {
  it('Code128 modules of a digits value are jsbarcode’s own encoding', () => {
    expect(code128DigitModules('628100000123')).toBe(101);
    expect(code128DigitModules('6281000001234')).toBe(123);
    for (let n = 4; n <= 24; n++) expect(code128DigitModules('7'.repeat(n)), String(n)).toBe(jsModules('7'.repeat(n)));
    fc.assert(fc.property(fc.stringMatching(/^[0-9]{4,30}$/), (v) => { expect(code128DigitModules(v)).toBe(jsModules(v)); }), { numRuns: 200 });
    for (const bad of ['', '123', 'J-123', '12 34']) expect(() => code128DigitModules(bad), bad).toThrow(RangeError);
  });

  it('the smallest label: 12 digits with 1 mm margins = 32.3 × 10 mm; 30.3 mm without margins', () => {
    expect(minLabelWidthMm(12, 1)).toBe(32.3);
    expect(minLabelWidthMm(12, 0)).toBe(30.3);
    expect(minLabelWidthMm(13, 1)).toBe(37.8);
    expect(minLabelHeightMm(1)).toBe(10);
    expect(labelLayout({ widthMm: null, heightMm: 12, marginMm: 1 }, '628100000123')).toMatchObject({ ok: false, reason: 'NOT_SET' });
    expect(labelLayout({ widthMm: 30, heightMm: 12, marginMm: 1 }, '628100000123')).toMatchObject({ ok: false, reason: 'TOO_NARROW', minWidthMm: 32.3 });
    expect(labelLayout({ widthMm: 40, heightMm: 9.5, marginMm: 1 }, '628100000123')).toMatchObject({ ok: false, reason: 'TOO_SHORT', minHeightMm: 10 });
    expect(labelLayout({ widthMm: 40, heightMm: 12, marginMm: 1 }, '628100000123')).toMatchObject({ ok: true, moduleDots: 2 });
    expect(labelLayout({ widthMm: 48, heightMm: 12, marginMm: 1 }, '628100000123')).toMatchObject({ ok: true, moduleDots: 3 });
    expect(onLabelStep(32.5)).toBe(true);
    expect(onLabelStep(32.3)).toBe(false);
  });

  it('property: whole-dot bars of at least 2 dots that fit inside the margins, or a refusal with the minimum', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 20, max: 96 }).map((h) => h / 2),
        fc.integer({ min: 10, max: 120 }).map((h) => h / 2),
        fc.integer({ min: 0, max: 10 }).map((h) => h / 2),
        fc.integer({ min: 12, max: 14 }),
        (widthMm, heightMm, marginMm, digits) => {
          const value = '6'.repeat(digits);
          const l = labelLayout({ widthMm, heightMm, marginMm }, value);
          const minW = minLabelWidthMm(digits, marginMm);
          const minH = minLabelHeightMm(marginMm);
          if (l.ok) {
            expect(Number.isInteger(l.moduleDots)).toBe(true);
            expect(l.moduleDots).toBeGreaterThanOrEqual(LABEL_MIN_MODULE_DOTS);
            expect(l.moduleMm).toBeCloseTo(l.moduleDots * LABEL_DOT_MM, 9);
            expect(l.symbolMm).toBeLessThanOrEqual(widthMm - 2 * marginMm + 1e-9);
            expect(l.barHeightMm + l.textMm + l.gapMm).toBeLessThanOrEqual(heightMm - 2 * marginMm + 1e-9);
          } else {
            expect(widthMm < minW || heightMm < minH).toBe(true);
            expect(l.minWidthMm).toBe(minW);
          }
          // A size at or above the minimum (rounded up to the grid) is never refused.
          if (widthMm >= Math.ceil(minW * 2) / 2 && heightMm >= minH) expect(l.ok).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('the label settings', () => {
  it('empty by default; 0.5 mm steps; the printer class’s maximum; too small for the barcodes: 409 with the minimum', async () => {
    expect(DEFAULT_SETTINGS.print.labelWidthMm).toBeNull();
    expect(DEFAULT_SETTINGS.print.labelHeightMm).toBeNull();
    expect(DEFAULT_SETTINGS.print.labelMarginMm).toBe(1);
    expect((await ctx.settings.get()).print).toMatchObject({ labelWidthMm: null, labelHeightMm: null, labelMarginMm: 1 });
    expect(await code(save({ 'print.labelWidthMm': 32.3 }))).toBe('BAD_REQUEST');
    expect(await code(save({ 'print.labelWidthMm': LABEL_MAX_WIDTH_MM + 0.5 }))).toBe('BAD_REQUEST');
    expect(await code(save({ 'print.labelMarginMm': -0.5 }))).toBe('BAD_REQUEST');
    const tooNarrow = await save({ 'print.labelWidthMm': 25, 'print.labelHeightMm': 12 }).catch((e) => e);
    expect(tooNarrow.code).toBe('LABEL_TOO_SMALL');
    expect(tooNarrow.status).toBe(409);
    expect(tooNarrow.details).toMatchObject({ minWidthMm: 32.3, minHeightMm: 10, digits: 12 });
    expect(await code(save({ 'print.labelWidthMm': 40, 'print.labelHeightMm': 9.5 }))).toBe('LABEL_TOO_SMALL');
    // One of the two alone is stored (printing stays refused until both are set).
    expect(await code(save({ 'print.labelWidthMm': 40 }))).toBe('OK');
    expect(await code(save({ 'print.labelHeightMm': 12.5 }))).toBe('OK');
    expect((await ctx.settings.get()).print).toMatchObject({ labelWidthMm: 40, labelHeightMm: 12.5, labelMarginMm: 1 });
    // A wider margin that leaves too little room is refused too.
    expect(await code(save({ 'print.labelMarginMm': 5 }))).toBe('LABEL_TOO_SMALL');
    // Cleared: back to "not set".
    expect(await code(save({ 'print.labelWidthMm': null }))).toBe('OK');
    expect((await ctx.settings.get()).print.labelWidthMm).toBeNull();
    const [last] = await ctx.db.select().from(t.settingsHistory).where(eq(t.settingsHistory.key, 'print.labelWidthMm')).orderBy(desc(t.settingsHistory.id)).limit(1);
    expect(last).toMatchObject({ key: 'print.labelWidthMm' });
  });
});
