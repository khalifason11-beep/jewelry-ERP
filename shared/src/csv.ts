// OPN-1 (plan docs/plans/OPN-1.md §5, D-opn1-2): the CSV reader and writer of the opening balance. No dependency.
//
//   * UTF-8 text, with or without a byte-order mark;
//   * comma or semicolon, detected from the header row (the one that appears there outside quotes; a header with
//     neither is one column, comma);
//   * quoted fields ("…") with doubled quotes inside, and line breaks inside quotes; CRLF, LF or CR line ends;
//   * blank lines are skipped; every record keeps the number of the physical line it starts on (the header is line 1),
//     so a validation report names the line a person sees in their spreadsheet.
// Digits (Arabic-Indic too) are the caller's business: a cell is returned as written. Property-tested in
// backend/test/csv.property.test.ts (writer → reader round trip).

export type CsvSeparator = ',' | ';';

export interface CsvRecord {
  /** 1-based physical line the record starts on. */
  line: number;
  cells: string[];
}

export interface CsvTable {
  separator: CsvSeparator;
  header: string[];
  rows: CsvRecord[];
}

export class CsvSyntaxError extends Error {
  constructor(readonly line: number, readonly problem: 'unclosed-quote' | 'quote-in-field') {
    super(`CSV syntax error on line ${line}: ${problem}`);
  }
}

/** The separator of a file: the first comma or semicolon outside quotes on its first line. */
export function detectSeparator(text: string): CsvSeparator {
  let quoted = false;
  for (const ch of stripBom(text)) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && (ch === ',' || ch === ';')) return ch;
  }
  return ',';
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Every record of the text (blank lines skipped), the first one being the header. */
export function readCsv(input: string): CsvTable {
  const text = stripBom(input);
  const separator = detectSeparator(text);
  const records: CsvRecord[] = [];
  let line = 1;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const start = line;
    const cells: string[] = [];
    let cell = '';
    let ended = false;
    let quotedCell = false;
    while (i < n && !ended) {
      const ch = text[i];
      if (ch === '"' && cell === '' && !quotedCell) {
        // A quoted field: up to the closing quote; "" is one quote; line breaks are part of it.
        quotedCell = true;
        i++;
        for (;;) {
          if (i >= n) throw new CsvSyntaxError(start, 'unclosed-quote');
          const c = text[i];
          if (c === '"') {
            if (text[i + 1] === '"') {
              cell += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          if (c === '\r' || c === '\n') {
            if (c === '\r' && text[i + 1] === '\n') {
              cell += '\r\n';
              i += 2;
            } else {
              cell += c;
              i++;
            }
            line++;
            continue;
          }
          cell += c;
          i++;
        }
        // After the closing quote: a separator, a line end or the end of the text.
        if (i < n && text[i] !== separator && text[i] !== '\r' && text[i] !== '\n') throw new CsvSyntaxError(line, 'quote-in-field');
        continue;
      }
      if (ch === separator) {
        cells.push(cell);
        cell = '';
        quotedCell = false;
        i++;
      } else if (ch === '\r' || ch === '\n') {
        i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
        line++;
        ended = true;
      } else {
        if (ch === '"') throw new CsvSyntaxError(line, 'quote-in-field');
        cell += ch;
        i++;
      }
    }
    cells.push(cell);
    if (cells.some((c) => c.trim() !== '')) records.push({ line: start, cells });
  }
  const [head, ...rows] = records;
  return { separator, header: head?.cells ?? [], rows };
}

/**
 * One CSV field: quoted when it holds a comma or a semicolon (either separator, so the first line of a written file
 * never misleads the detection), a quote, a line break or edge spaces. NULL is an empty cell, never 0.
 */
export function csvField(value: string | number | null | undefined): string {
  const s = value == null ? '' : String(value);
  return /[,;"\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows to CSV text (CRLF line ends, as spreadsheets write them); `bom` for Excel to read UTF-8. */
export function writeCsv(rows: (string | number | null | undefined)[][], opts: { separator?: CsvSeparator; bom?: boolean } = {}): string {
  const sep = opts.separator ?? ',';
  const body = rows.map((r) => r.map((v) => csvField(v)).join(sep)).join('\r\n') + '\r\n';
  return (opts.bom ? '\ufeff' : '') + body;
}
