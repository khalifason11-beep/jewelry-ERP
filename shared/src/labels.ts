// LBL-1 (D-lbl1-2): the size rule of a piece label, pure and property-tested (backend/test/lbl1-labels.test.ts).
//
// A label carries one Code128 symbol of the piece's barcode (digits only) and the same digits under it. It is printed
// on a 203 DPI thermal label printer through the browser; the bars must stay scannable by a 1D scanner:
//   * one module (the narrowest bar) is a whole number of printer dots, at least LABEL_MIN_MODULE_DOTS;
//   * a quiet zone of LABEL_QUIET_MODULES modules on each side;
//   * bars at least LABEL_MIN_BAR_MM high, plus the digits line.
// A size that cannot hold the symbol is refused with the minimum, never shrunk. These are the printer CLASS's limits
// (203 DPI, 48 mm print width), documented here once; no client value lives in code.

/** The printer class's resolution (dots per inch) and one dot in mm. */
export const LABEL_DPI = 203;
export const LABEL_DOT_MM = 25.4 / LABEL_DPI;
/** The narrowest bar, in dots: one-dot bars blur on a thermal head and many 1D scanners cannot read them. */
export const LABEL_MIN_MODULE_DOTS = 2;
/** Code128's quiet zone: at least 10 modules of white on each side of the bars. */
export const LABEL_QUIET_MODULES = 10;
/** The bars' minimum height, and the digits line under them (text height + gap). */
export const LABEL_MIN_BAR_MM = 5;
export const LABEL_TEXT_MM = 2.5;
export const LABEL_TEXT_GAP_MM = 0.5;
/** The printer class's maximum print width (48 mm), and a generous upper bound for the label's height. */
export const LABEL_MAX_WIDTH_MM = 48;
export const LABEL_MAX_HEIGHT_MM = 60;
/** Sizes and the margin are set in steps of 0.5 mm (owner Q6). */
export const LABEL_STEP_MM = 0.5;
/** The default inner margin (owner Q5): a generic print margin, not a client value. */
export const LABEL_DEFAULT_MARGIN_MM = 1;
export const LABEL_MAX_MARGIN_MM = 5;
/** Copies per piece (owner Q10): on the piece page, and per piece in a batch. */
export const LABEL_MAX_COPIES_ONE = 20;
export const LABEL_MAX_COPIES_BATCH = 5;
/** A piece's barcode today: 12 digits (`628100` + the number padded to 6, core/numbering.ts). */
export const LABEL_DEFAULT_BARCODE_DIGITS = 12;

export interface LabelSize {
  widthMm: number | null;
  heightMm: number | null;
  marginMm: number;
}

/** A value in 0.5 mm steps. */
export const onLabelStep = (mm: number) => Number.isFinite(mm) && Math.abs(mm / LABEL_STEP_MM - Math.round(mm / LABEL_STEP_MM)) < 1e-9;

/**
 * The Code128 modules of a digits-only value as jsbarcode's automatic encoding draws it (start, code set C pairs, one
 * code-set switch and a set-B digit when the count is odd, the check symbol: 11 modules each; the stop: 13), without
 * the quiet zones. 12 digits = 101, 13 digits = 123 (checked against jsbarcode in the tests).
 */
export function code128DigitModules(value: string): number {
  if (!/^\d{4,}$/.test(value)) throw new RangeError(`a label barcode is 4 or more digits, got "${value}"`);
  const n = value.length;
  const symbols = n % 2 === 0 ? n / 2 + 2 : (n - 1) / 2 + 4;
  return symbols * 11 + 13;
}

const ceilTo = (mm: number, step = 0.1) => Math.ceil(mm / step - 1e-9) * step;

/** The smallest label (width with the margins, in 0.1 mm) that holds `digits` digits with LABEL_MIN_MODULE_DOTS bars. */
export function minLabelWidthMm(digits: number, marginMm: number): number {
  const modules = code128DigitModules('0'.repeat(Math.max(4, digits))) + 2 * LABEL_QUIET_MODULES;
  return Number(ceilTo(modules * LABEL_MIN_MODULE_DOTS * LABEL_DOT_MM + 2 * marginMm).toFixed(1));
}

/** The smallest label height: the bars, the digits line and the margins. */
export function minLabelHeightMm(marginMm: number): number {
  return Number(ceilTo(LABEL_MIN_BAR_MM + LABEL_TEXT_MM + LABEL_TEXT_GAP_MM + 2 * marginMm).toFixed(1));
}

export type LabelLayout =
  | { ok: true; moduleDots: number; moduleMm: number; symbolMm: number; quietMm: number; barHeightMm: number; textMm: number; gapMm: number }
  | { ok: false; reason: 'NOT_SET' | 'TOO_NARROW' | 'TOO_SHORT'; minWidthMm: number; minHeightMm: number };

/**
 * How `value` is drawn on a label of `size`: the widest whole-dot module that fits (never below the minimum), the bars'
 * and the text's height. Not set, too narrow or too short: refused with the minimum sizes.
 */
export function labelLayout(size: LabelSize, value: string): LabelLayout {
  const minWidthMm = minLabelWidthMm(value.length, size.marginMm);
  const minHeightMm = minLabelHeightMm(size.marginMm);
  if (size.widthMm == null || size.heightMm == null) return { ok: false, reason: 'NOT_SET', minWidthMm, minHeightMm };
  const modules = code128DigitModules(value) + 2 * LABEL_QUIET_MODULES;
  const printableDots = Math.floor((size.widthMm - 2 * size.marginMm) / LABEL_DOT_MM + 1e-9);
  const moduleDots = Math.floor(printableDots / modules);
  if (moduleDots < LABEL_MIN_MODULE_DOTS) return { ok: false, reason: 'TOO_NARROW', minWidthMm, minHeightMm };
  const printableHeight = size.heightMm - 2 * size.marginMm;
  const barHeightMm = printableHeight - LABEL_TEXT_MM - LABEL_TEXT_GAP_MM;
  if (barHeightMm < LABEL_MIN_BAR_MM - 1e-9) return { ok: false, reason: 'TOO_SHORT', minWidthMm, minHeightMm };
  const moduleMm = moduleDots * LABEL_DOT_MM;
  return { ok: true, moduleDots, moduleMm, symbolMm: modules * moduleMm, quietMm: LABEL_QUIET_MODULES * moduleMm, barHeightMm, textMm: LABEL_TEXT_MM, gapMm: LABEL_TEXT_GAP_MM };
}
