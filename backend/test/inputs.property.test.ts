// UX-1 (D-ux1-1): the typing rules of the kit's number, identifier and date fields (shared/src/inputs.ts). The browser
// behaviour (wheel, keypad, paste events) is checked by scripts/capture-ui-kit.mjs; this file proves the rules.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  dayKeyToInput,
  gramsToMg,
  groupDigits,
  inputToDayKey,
  normalizeDigits,
  parseDecimalInput,
  parseIntegerInput,
  parseMoneyInput,
  parseWeightInput,
  rangeProblem,
  sanitizeDayTyping,
  sanitizeNumber,
  sanitizePhone,
  sanitizeReference,
} from '@jerp/shared';

const RUNS = { numRuns: 1_000 };
const ARABIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
const toArabic = (s: string) => s.replace(/\d/g, (d) => ARABIC[Number(d)]);
const toPersian = (s: string) => s.replace(/\d/g, (d) => PERSIAN[Number(d)]);
const digits = fc.string({ unit: fc.constantFrom(...'0123456789'.split('')), minLength: 1, maxLength: 15 });

describe('number fields', () => {
  it('digits only are kept as typed; an empty field stays empty, never 0', () => {
    fc.assert(fc.property(digits, (d) => {
      expect(sanitizeNumber(d, 0)).toEqual({ ok: true, value: d });
    }), RUNS);
    expect(sanitizeNumber('', 0)).toEqual({ ok: true, value: '' });
    expect(parseMoneyInput('')).toBeNull();
    expect(parseWeightInput('')).toBeNull();
    expect(parseIntegerInput('')).toBeNull();
  });

  it('Arabic-Indic and Persian digits and the Arabic decimal separator are normalized', () => {
    fc.assert(
      fc.property(digits, digits, (a, b) => {
        expect(sanitizeNumber(toArabic(a), 0)).toEqual({ ok: true, value: a });
        expect(sanitizeNumber(toPersian(a), 0)).toEqual({ ok: true, value: a });
        const frac = b.slice(0, 3);
        expect(sanitizeNumber(`${toArabic(a)}٫${toArabic(frac)}`, 3)).toEqual({ ok: true, value: `${a}.${frac}` });
      }),
      RUNS,
    );
    expect(normalizeDigits('١٢٫٥')).toBe('12.5');
    expect(parseWeightInput('٤٫٢٠٥')).toBe(4205);
  });

  it('letters, e, + and - are refused, typed or pasted (a pasted negative too)', () => {
    for (const bad of ['-5', '5-', '+5', '1e3', '1E3', 'e', 'abc', '12a', '٥x', '−5', '--1', 'Infinity', 'NaN', '0x10', '5 kg']) {
      for (const decimals of [0, 3]) expect(sanitizeNumber(bad, decimals), `${bad} (${decimals})`).toEqual({ ok: false, reason: 'chars' });
    }
    fc.assert(
      fc.property(digits, fc.constantFrom('-', '+', 'e', 'E', 'a', 'ج'), fc.nat(16), (d, c, at) => {
        const i = Math.min(at, d.length);
        const r = sanitizeNumber(d.slice(0, i) + c + d.slice(i), 3);
        expect(r.ok).toBe(false);
      }),
      RUNS,
    );
  });

  it('money and integers are whole; a decimal separator is refused', () => {
    expect(sanitizeNumber('12.5', 0)).toEqual({ ok: false, reason: 'whole' });
    expect(sanitizeNumber('12.', 0)).toEqual({ ok: false, reason: 'whole' });
    expect(parseMoneyInput('12.5')).toBeNull();
    fc.assert(fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (n) => {
      expect(parseMoneyInput(String(n))).toBe(n);
    }), RUNS);
    expect(parseMoneyInput('9007199254740993')).toBeNull(); // beyond the safe integer range: not a value
  });

  it('weights take at most 3 decimals and become integer mg through gramsToMg', () => {
    expect(sanitizeNumber('4.2051', 3)).toEqual({ ok: false, reason: 'decimals' });
    expect(sanitizeNumber('1.2.3', 3)).toEqual({ ok: false, reason: 'separator' });
    expect(parseWeightInput('.5')).toBe(500);
    expect(parseWeightInput('5.')).toBe(5000);
    expect(parseWeightInput('.')).toBeNull();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000 }), (mg) => {
        const text = `${Math.floor(mg / 1000)}.${String(mg % 1000).padStart(3, '0')}`;
        expect(parseWeightInput(text)).toBe(mg);
        expect(parseWeightInput(text)).toBe(gramsToMg(text));
      }),
      RUNS,
    );
  });

  it('a pasted grouped number is accepted only when grouped by three', () => {
    expect(sanitizeNumber('1,250,000', 0)).toEqual({ ok: true, value: '1250000' });
    expect(sanitizeNumber('1٬250٬000', 0)).toEqual({ ok: true, value: '1250000' });
    expect(sanitizeNumber('1 250 000', 0)).toEqual({ ok: true, value: '1250000' });
    expect(sanitizeNumber('1,250.125', 3)).toEqual({ ok: true, value: '1250.125' });
    expect(sanitizeNumber('1,5', 3)).toEqual({ ok: false, reason: 'grouping' }); // never read as 15
    expect(sanitizeNumber('12,50', 0)).toEqual({ ok: false, reason: 'grouping' });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (n) => {
        // What the field shows when not focused (grouped) pastes back to the same value.
        const shown = groupDigits(String(n));
        expect(sanitizeNumber(shown, 0)).toEqual({ ok: true, value: String(n) });
        expect(parseMoneyInput(shown)).toBe(n);
      }),
      RUNS,
    );
  });

  it('decimal settings and ranges', () => {
    expect(parseDecimalInput('2.5', 2)).toBe(2.5);
    expect(parseDecimalInput('2.555', 2)).toBeNull();
    expect(rangeProblem(5, 1, 24)).toBeNull();
    expect(rangeProblem(0, 1, 24)).toBe('min');
    expect(rangeProblem(25, 1, 24)).toBe('max');
    expect(rangeProblem(null, 1, 24)).toBeNull();
  });
});

describe('identifier fields', () => {
  it('phone: digits, spaces and a leading +; Arabic digits normalized', () => {
    expect(sanitizePhone('+249 912 345 678')).toEqual({ ok: true, value: '+249 912 345 678' });
    expect(sanitizePhone('٠٩١٢٣٤٥٦٧٨')).toEqual({ ok: true, value: '0912345678' });
    for (const bad of ['09a', '0912-3', '12+3', 'abc', '(0912)']) expect(sanitizePhone(bad).ok, bad).toBe(false);
    expect(sanitizePhone('1'.repeat(31))).toEqual({ ok: false, reason: 'length' });
  });

  it('references: the FIX-2 set, upper-cased, Arabic digits normalized, Arabic letters refused', () => {
    expect(sanitizeReference('trx-٢٠٢٦/15')).toEqual({ ok: true, value: 'TRX-2026/15' });
    expect(sanitizeReference('مرجع 1').ok).toBe(false);
    expect(sanitizeReference('A_B').ok).toBe(false);
    expect(sanitizeReference('A'.repeat(41))).toEqual({ ok: false, reason: 'length' });
    expect(sanitizeReference('A'.repeat(60), 60).ok).toBe(true);
  });
});

describe('date fields: dd/mm/yyyy shown, yyyy-mm-dd stored', () => {
  it('typed digits get their slashes; letters are refused', () => {
    expect(sanitizeDayTyping('17')).toEqual({ ok: true, value: '17' });
    expect(sanitizeDayTyping('171')).toEqual({ ok: true, value: '17/1' });
    expect(sanitizeDayTyping('17102026')).toEqual({ ok: true, value: '17/10/2026' });
    expect(sanitizeDayTyping('١٧١٠٢٠٢٦')).toEqual({ ok: true, value: '17/10/2026' });
    expect(sanitizeDayTyping('7/1/2026')).toEqual({ ok: true, value: '7/1/2026' });
    // Typing on, one digit at a time, after the slashes were added.
    let text = '';
    for (const d of '01102026') {
      const r = sanitizeDayTyping(text + d);
      expect(r.ok).toBe(true);
      if (r.ok) text = r.value;
    }
    expect(text).toBe('01/10/2026');
    expect(sanitizeDayTyping('17-10-2026').ok).toBe(false);
    expect(sanitizeDayTyping('17/10/20261').ok).toBe(false);
    expect(sanitizeDayTyping('a').ok).toBe(false);
  });

  it('round trip for every real day; impossible days are refused', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('1990-01-01T00:00:00Z'), max: new Date('2099-12-31T00:00:00Z'), noInvalidDate: true }), (d) => {
        const key = d.toISOString().slice(0, 10);
        expect(inputToDayKey(dayKeyToInput(key))).toBe(key);
      }),
      RUNS,
    );
    expect(inputToDayKey('7/1/2026')).toBe('2026-01-07');
    expect(inputToDayKey('29/02/2027')).toBeNull();
    expect(inputToDayKey('29/02/2028')).toBe('2028-02-29');
    expect(inputToDayKey('31/04/2026')).toBeNull();
    expect(inputToDayKey('00/10/2026')).toBeNull();
    expect(inputToDayKey('17/13/2026')).toBeNull();
    expect(inputToDayKey('17/10/26')).toBeNull();
    expect(dayKeyToInput('nope')).toBe('');
  });
});
