// UX-1 (docs/plans/UX-1.md, D-ux1-1): what a person may type into a number, identifier or date field, and how the
// typed text becomes a value. Pure functions, used by the kit fields (frontend/src/components/ui/NumberInput.tsx,
// DateInput.tsx) and property-tested in backend/test/inputs.property.test.ts.
//
// A field keeps the text as typed (a string) until submit; an empty field stays empty, never 0. A keystroke or a paste
// that would make the text invalid is refused as a whole: the field keeps its previous text and says why.
// Weights go through the existing gramsToMg (integer mg, no float), never a copy of it.

import { gramsToMg } from './units';

/** Arabic-Indic (٠–٩) and Persian (۰–۹) digits to 0–9, the Arabic decimal separator (٫) to ".". */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.');
}

/** Why a typed or pasted text was refused. */
export type InputRefusal = 'chars' | 'whole' | 'decimals' | 'separator' | 'grouping' | 'length';
export type InputCheck = { ok: true; value: string } | { ok: false; reason: InputRefusal };

// Thousands separators a person may paste: comma, Arabic thousands separator, spaces (normal, no-break, thin).
const GROUP_CHARS = /[,٬    ]/;
const GROUP_CHARS_ALL = /[,٬    ]/g;

/**
 * The text of a number field after a keystroke or a paste: digits and at most one decimal separator, at most
 * `decimals` digits after it. Thousands separators are accepted only where they group by three ("1,250,000") and are
 * removed, so a pasted "1,5" is refused rather than read as 15. Letters, "e", "+" and "-" are always refused.
 */
export function sanitizeNumber(raw: string, decimals: number): InputCheck {
  const s = normalizeDigits(raw).trim();
  if (s === '') return { ok: true, value: '' };
  if (/[^0-9.,٬    ]/.test(s)) return { ok: false, reason: 'chars' };
  const dots = (s.match(/\./g) ?? []).length;
  if (dots > 1) return { ok: false, reason: 'separator' };
  if (dots === 1 && decimals === 0) return { ok: false, reason: 'whole' };
  let body = s;
  if (GROUP_CHARS.test(s)) {
    const [int, frac] = s.split('.');
    const grouped = int.replace(GROUP_CHARS_ALL, ',');
    if (!/^\d{1,3}(,\d{3})+$/.test(grouped) || (frac !== undefined && GROUP_CHARS.test(frac))) return { ok: false, reason: 'grouping' };
    body = grouped.replace(/,/g, '') + (frac !== undefined ? `.${frac}` : '');
  }
  const frac = body.split('.')[1];
  if (frac !== undefined && frac.length > decimals) return { ok: false, reason: 'decimals' };
  return { ok: true, value: body };
}

/** "1250000.5" → "1,250,000.5" (display only; the value stays ungrouped). */
export function groupDigits(value: string): string {
  const [int, frac] = value.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac !== undefined ? `${grouped}.${frac}` : grouped;
}

const complete = (value: string) => value !== '' && value !== '.';

/** Whole currency units, or null when empty / not a whole number / beyond the safe integer range. */
export function parseMoneyInput(text: string): number | null {
  const r = sanitizeNumber(text, 0);
  if (!r.ok || !complete(r.value)) return null;
  const n = Number(r.value);
  return Number.isSafeInteger(n) ? n : null;
}

/** An integer (karat, count, percentage), or null. */
export const parseIntegerInput = parseMoneyInput;

/** Grams as typed (≤ 3 decimals) to integer mg through gramsToMg, or null. */
export function parseWeightInput(text: string): number | null {
  const r = sanitizeNumber(text, 3);
  if (!r.ok || !complete(r.value)) return null;
  const mg = gramsToMg(r.value);
  return Number.isSafeInteger(mg) ? mg : null;
}

/** A number with at most `decimals` decimals (a percentage setting), or null. */
export function parseDecimalInput(text: string, decimals: number): number | null {
  const r = sanitizeNumber(text, decimals);
  if (!r.ok || !complete(r.value)) return null;
  const n = Number(r.value);
  return Number.isFinite(n) ? n : null;
}

/** A parsed value against its limits: null when inside, otherwise which limit it breaks. */
export function rangeProblem(n: number | null, min?: number, max?: number): 'min' | 'max' | null {
  if (n == null) return null;
  if (min != null && n < min) return 'min';
  if (max != null && n > max) return 'max';
  return null;
}

/** Phone: digits, spaces and a leading "+" (Arabic digits normalized), at most `max` characters. */
export function sanitizePhone(raw: string, max = 30): InputCheck {
  const s = normalizeDigits(raw);
  if (!/^\+?[0-9 ]*$/.test(s)) return { ok: false, reason: 'chars' };
  if (s.length > max) return { ok: false, reason: 'length' };
  return { ok: true, value: s };
}

/**
 * Bank references, transfer references, supplier invoice numbers and ID document numbers: the FIX-2 character set
 * (A–Z, 0–9, space, "-", "/", "."), upper-cased as typed, Arabic digits normalized, at most `max` characters. The
 * same set `validBankReference` accepts, so what the field shows is what the server stores.
 */
export function sanitizeReference(raw: string, max = 40): InputCheck {
  const s = normalizeDigits(raw).toUpperCase();
  if (!/^[A-Z0-9 ./-]*$/.test(s)) return { ok: false, reason: 'chars' };
  if (s.length > max) return { ok: false, reason: 'length' };
  return { ok: true, value: s };
}

// ── dates: shown dd/mm/yyyy, stored yyyy-mm-dd (a business-day key) ──

/** "2026-10-17" → "17/10/2026" ("" for anything else). */
export function dayKeyToInput(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/**
 * The text of a date field after a keystroke or paste: digits and "/" only. Typed digits get their slashes
 * ("17102026" → "17/10/2026"); text with slashes keeps them (d/m/yyyy is fine).
 */
export function sanitizeDayTyping(raw: string): InputCheck {
  const s = normalizeDigits(raw).trim();
  if (/[^0-9/]/.test(s)) return { ok: false, reason: 'chars' };
  if (s.includes('/')) {
    if (!/^\d{0,2}(\/\d{0,2}(\/\d{0,4})?)?$/.test(s)) return { ok: false, reason: 'separator' };
    return { ok: true, value: s };
  }
  if (s.length > 8) return { ok: false, reason: 'length' };
  const v = s.slice(0, 2) + (s.length > 2 ? `/${s.slice(2, 4)}` : '') + (s.length > 4 ? `/${s.slice(4, 8)}` : '');
  return { ok: true, value: v };
}

/** "17/10/2026" or "7/1/2026" → "2026-10-17" / "2026-01-07"; null when incomplete or not a real day. */
export function inputToDayKey(text: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(normalizeDigits(text).trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2999 || mo < 1 || mo > 12 || d < 1) return null;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > days) return null;
  return `${String(y)}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
