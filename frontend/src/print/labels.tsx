// LBL-1 (D-lbl1-2): piece labels, printed through the one print module (D-print-1): one label per page, the page the
// label's exact size (`@page { size: W H; margin: 0 }`), the label's own inner margin. Each label is one Code128 symbol
// of the piece's 12-digit barcode, drawn bar by bar with whole printer dots (shared/src/labels.ts), and the same digits
// under it in Latin digits (owner Q3, Q4). Nothing else: no price, weight, karat or shop name.

import JsBarcode from 'jsbarcode';
import { LABEL_QUIET_MODULES, labelLayout, type LabelPrintSource, type LabelSize } from '@jerp/shared';
import { postOnce } from '../lib/api';
import { printDocument } from '../lib/print';

export interface PrintedLabel {
  itemId: number;
  code: string;
  barcode: string;
  copies: number;
  kind: 'FIRST' | 'REPRINT';
}
export interface LabelPrintResult {
  batchId: string;
  size: { widthMm: number; heightMm: number; marginMm: number };
  labels: PrintedLabel[];
}

/** The bars of `value` as jsbarcode encodes it (Code128, automatic code sets): a string of 1 (bar) and 0 (space). */
export function code128Bars(value: string): string {
  const out: { encodings?: { data: string }[] } = {};
  JsBarcode(out, value, { format: 'CODE128' });
  return (out.encodings ?? []).map((e) => e.data).join('');
}

/** One label: the bars (whole-dot modules, quiet zones included) and the digits under them. */
export function Label({ value, size }: { value: string; size: LabelSize & { widthMm: number; heightMm: number } }) {
  const layout = labelLayout(size, value);
  if (!layout.ok) return null;
  const bars = code128Bars(value);
  const rects: { x: number; w: number }[] = [];
  for (let i = 0; i < bars.length; ) {
    if (bars[i] !== '1') {
      i++;
      continue;
    }
    let j = i;
    while (bars[j] === '1') j++;
    rects.push({ x: (LABEL_QUIET_MODULES + i) * layout.moduleMm, w: (j - i) * layout.moduleMm });
    i = j;
  }
  return (
    <div
      className="lbl"
      data-testid="label"
      data-barcode={value}
      data-module-dots={layout.moduleDots}
      style={{
        width: `${size.widthMm}mm`,
        height: `${size.heightMm}mm`,
        padding: `${size.marginMm}mm`,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        background: '#fff',
        color: '#000',
      }}
    >
      <svg
        width={`${layout.symbolMm}mm`}
        height={`${layout.barHeightMm}mm`}
        viewBox={`0 0 ${layout.symbolMm} ${layout.barHeightMm}`}
        shapeRendering="crispEdges"
        data-bars={bars}
        aria-label={value}
      >
        {rects.map((r) => (
          <rect key={r.x} x={r.x} y={0} width={r.w} height={layout.barHeightMm} fill="#000" />
        ))}
      </svg>
      <div
        dir="ltr"
        data-testid="label-digits"
        style={{ marginTop: `${layout.gapMm}mm`, fontSize: `${layout.textMm}mm`, lineHeight: 1, fontFamily: '"IBM Plex Mono", monospace', letterSpacing: '0.05em', fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </div>
    </div>
  );
}

function LabelSheet({ labels, size }: { labels: { barcode: string; copies: number }[]; size: LabelSize & { widthMm: number; heightMm: number } }) {
  return (
    <div data-testid="label-sheet">
      {labels.flatMap((l, i) => Array.from({ length: l.copies }, (_, c) => <Label key={`${i}-${c}`} value={l.barcode} size={size} />))}
    </div>
  );
}

const layoutOf = (size: { widthMm: number; heightMm: number }) => ({ format: 'LABEL' as const, receiptWidthMm: 0, label: { widthMm: size.widthMm, heightMm: size.heightMm } });

/**
 * Ask the server for the labels (it checks who may print, the scope and the size, and records the print: first or
 * reprint), then print them. Throws the server's refusal (shown by the caller); resolves to what was recorded.
 */
export async function printPieceLabels(pieces: { itemId: number; copies: number }[], source: LabelPrintSource, key: string): Promise<LabelPrintResult & { shown: boolean }> {
  const r = await postOnce<LabelPrintResult>('/labels/print', { pieces, source }, key);
  const shown = await printDocument({ layout: layoutOf(r.size), content: <LabelSheet labels={r.labels} size={r.size} /> });
  return { ...r, shown };
}

/** A sample label (Settings): a fixed 12-digit value no piece has, at the saved size, to calibrate the printer. */
export const SAMPLE_LABEL_VALUE = '000000000000';
export function printSampleLabel(size: { widthMm: number; heightMm: number; marginMm: number }) {
  return printDocument({ layout: layoutOf(size), content: <LabelSheet labels={[{ barcode: SAMPLE_LABEL_VALUE, copies: 1 }]} size={size} /> });
}
