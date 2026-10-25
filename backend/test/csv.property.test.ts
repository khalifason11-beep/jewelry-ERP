// OPN-1 (plan §5, D-opn1-2): the CSV reader and writer of the opening balance (shared/src/csv.ts). Random tables written
// with either separator, with or without a BOM and with CRLF or LF, read back to exactly the same cells; every record
// keeps the physical line it starts on. Plus the hand-made cases a spreadsheet produces.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CsvSyntaxError, csvField, detectSeparator, readCsv, writeCsv, type CsvSeparator } from '@jerp/shared';

const RUNS = { numRuns: 500 };
// Cells with the characters that matter: separators, quotes, line breaks, spaces, Arabic letters and digits.
const cellChars = fc.constantFrom('a', 'Z', '7', ' ', ',', ';', '"', '\n', '\r\n', 'خ', 'ا', 'تم', '٣', '٫', '.', '-', '\t');
const cell = fc.array(cellChars, { maxLength: 12 }).map((cs) => cs.join(''));
const nonBlank = cell.filter((c) => c.trim() !== '');

const table = fc.integer({ min: 1, max: 6 }).chain((cols) =>
  fc.record({
    header: fc.array(nonBlank, { minLength: cols, maxLength: cols }),
    // A row with only blank cells is a blank line to the reader (skipped), so every row has one non-blank cell.
    rows: fc.array(
      fc.tuple(fc.array(cell, { minLength: cols, maxLength: cols }), fc.integer({ min: 0, max: cols - 1 }), nonBlank).map(([cells, at, keep]) => cells.map((c, i) => (i === at ? keep : c))),
      { maxLength: 15 },
    ),
  }),
);

describe('CSV round trip', () => {
  it('writer → reader gives back every cell, with either separator, a BOM or not, CRLF or LF', () => {
    fc.assert(
      fc.property(table, fc.constantFrom<CsvSeparator>(',', ';'), fc.boolean(), fc.boolean(), ({ header, rows }, separator, bom, lf) => {
        let text = writeCsv([header, ...rows], { separator, bom });
        if (lf) text = text.replace(/\r\n/g, '\n');
        const back = readCsv(text);
        // A one-column file has no separator to detect: it reads as comma, with the same cells.
        if (header.length > 1) expect(back.separator).toBe(separator);
        const norm = (c: string) => (lf ? c.replace(/\r\n/g, '\n') : c);
        expect(back.header).toEqual(header.map(norm));
        expect(back.rows.map((r) => r.cells)).toEqual(rows.map((r) => r.map(norm)));
      }),
      RUNS,
    );
  });

  it('each record keeps the physical line it starts on (line breaks inside quotes counted)', () => {
    fc.assert(
      fc.property(table, ({ header, rows }) => {
        const text = writeCsv([header, ...rows]);
        const back = readCsv(text);
        const breaks = (r: string[]) => r.reduce((s, c) => s + (c.match(/\r\n|\r|\n/g) ?? []).length, 0);
        let line = 1 + breaks(header) + 1;
        back.rows.forEach((r, i) => {
          expect(r.line).toBe(line);
          line += breaks(rows[i]) + 1;
        });
      }),
      RUNS,
    );
  });
});

describe('what spreadsheets write', () => {
  it('Excel "CSV UTF-8" with semicolons and a BOM; blank lines skipped; line numbers kept', () => {
    const t = readCsv('﻿النوع;الوصف;العيار\r\nخاتم;"قديم; رقم 7";21\r\n\r\n;;\r\nسوار;;١٨\r\n');
    expect(t.separator).toBe(';');
    expect(t.header).toEqual(['النوع', 'الوصف', 'العيار']);
    expect(t.rows).toEqual([
      { line: 2, cells: ['خاتم', 'قديم; رقم 7', '21'] },
      { line: 5, cells: ['سوار', '', '١٨'] },
    ]);
  });

  it('doubled quotes, a quoted line break, no final line end', () => {
    expect(readCsv('a,b\n"say ""hi""","two\nlines"').rows).toEqual([{ line: 2, cells: ['say "hi"', 'two\nlines'] }]);
  });

  it('broken quoting is refused with its line', () => {
    expect(() => readCsv('a,b\nx,"open')).toThrow(CsvSyntaxError);
    const e = (() => {
      try {
        readCsv('a,b\nx,y\nab"c,d');
      } catch (err) {
        return err as CsvSyntaxError;
      }
    })();
    expect([e?.line, e?.problem]).toEqual([3, 'quote-in-field']);
    expect(() => readCsv('a,b\n"x"y,z')).toThrow(CsvSyntaxError);
  });

  it('the separator comes from the header row only; NULL is an empty cell', () => {
    expect(detectSeparator('"a,b";c\n1,2')).toBe(';');
    expect(detectSeparator('single\nx;y')).toBe(',');
    expect(csvField(null)).toBe('');
    expect(csvField(' x')).toBe('" x"');
    expect(writeCsv([['a', null, 0]])).toBe('a,,0\r\n');
  });
});
