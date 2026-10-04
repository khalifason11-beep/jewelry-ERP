// The one print module (D-print-1). Every printed document goes through `printDocument()`:
// it renders the document into a print-only container (#print-root, a direct child of <body>),
// gives it its OWN @page rule (A4 / A5 with 10 mm margins, or a receipt at the driver's printable
// width with no margin), waits for fonts and images, then calls window.print(). On screen the
// container is off-screen (so it can be measured); in print everything else is hidden.
//
// Chromium renders the HTML and the Windows driver prints it: no ESC/POS, no printer-specific
// commands, Arabic shaped by the browser with the bundled font.
//
// Printing never throws: it resolves to false on failure so a caller (e.g. the POS after a sale)
// can show a message without affecting the business action that came before.

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { contentWidthMm, pageRule, type PrintLayout } from '@jerp/shared';
import { useI18n } from './i18n';

export interface PrintJob {
  layout: PrintLayout;
  /** The document; rendered inside #print-root. */
  content: ReactNode;
}

type Active = PrintJob & { pageCss: string; id: number };
let current: Active | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let seq = 0;

const PX_PER_MM = 96 / 25.4;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function settle(root: HTMLElement) {
  await nextFrame();
  await nextFrame();
  try {
    await document.fonts?.ready;
  } catch {
    /* fonts API missing: print anyway */
  }
  const imgs = Array.from(root.querySelectorAll('img'));
  await Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined))));
}

/** Print a document. Resolves true when the print dialog was opened (or the job was sent silently). */
export async function printDocument(job: PrintJob): Promise<boolean> {
  try {
    current = { ...job, pageCss: pageRule(job.layout, 200), id: ++seq };
    emit();
    const root = document.getElementById('print-root');
    if (!root) throw new Error('print host missing');
    await settle(root);
    if (job.layout.format === 'RECEIPT') {
      // `size: 72mm auto` is not valid CSS: use the measured height of this receipt (+3 mm feed).
      const heightMm = root.scrollHeight / PX_PER_MM + 3;
      current = { ...current, pageCss: pageRule(job.layout, heightMm) };
      emit();
      await nextFrame();
    }
    window.print();
    return true;
  } catch {
    return false;
  }
}

/** Mounted once (App). Renders the active document into <body> > #print-root. */
export function PrintHost() {
  const { lang } = useI18n();
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    const clear = () => {
      current = null;
      emit();
    };
    window.addEventListener('afterprint', clear);
    return () => {
      listeners.delete(l);
      window.removeEventListener('afterprint', clear);
    };
  }, []);
  const job = current;
  return createPortal(
    <div
      id="print-root"
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
      lang={lang}
      data-format={job?.layout.format ?? ''}
      data-job={job?.id ?? ''}
      style={job ? { width: `${contentWidthMm(job.layout)}mm` } : undefined}
    >
      {job && (
        <>
          <style>{job.pageCss}</style>
          {job.content}
        </>
      )}
    </div>,
    document.body,
  );
}
