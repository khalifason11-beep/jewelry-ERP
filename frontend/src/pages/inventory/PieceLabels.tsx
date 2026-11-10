// LBL-1 (D-lbl1-1…5): printing piece labels from the screens, and a piece's print history. Shown to the people who
// enter pieces and the opening balance (`opening.enter`: the branch manager of the branch, the General Manager); the
// server checks the same and records every print (first or reprint) before the labels are handed out.

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Tag } from 'lucide-react';
import { LABEL_MAX_COPIES_BATCH, LABEL_MAX_COPIES_ONE, parseIntegerInput, type LabelPrintSource } from '@jerp/shared';
import { get } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime } from '../../lib/format';
import { useActionKeys } from '../../lib/idempotency';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { printPieceLabels } from '../../print/labels';
import { Badge, Button, Card, CardHeader, Dialog, Field, IntegerInput } from '../../components/ui';

export interface LabelPrintRow {
  id: number;
  kind: 'FIRST' | 'REPRINT';
  source: LabelPrintSource;
  copies: number;
  printedByName: string;
  printedByNameAr: string | null;
  createdAt: string;
}

/** May this person print labels (the server checks the same, and the piece's branch). */
export function useCanPrintLabels() {
  const { can } = useAuth();
  return can('opening.enter');
}

/**
 * Print labels of some pieces: one dialog with the copies (one field for every piece; empty = 1), then the server
 * records the print and the labels are printed. `pieces` of one piece allow up to 20 copies, a batch up to 5 each.
 */
export function PrintLabelsButton({ pieces, source, label, testId, variant }: { pieces: { id: number; code: string }[]; source: LabelPrintSource; label?: string; testId: string; variant?: 'primary' }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const keys = useActionKeys();
  const [open, setOpen] = useState(false);
  const [copiesText, setCopiesText] = useState('');
  const [busy, setBusy] = useState(false);
  const max = pieces.length === 1 ? LABEL_MAX_COPIES_ONE : LABEL_MAX_COPIES_BATCH;
  const copies = copiesText === '' ? 1 : parseIntegerInput(copiesText);
  const copiesOk = copies != null && copies >= 1 && copies <= max;
  const scope = `labels-${source}-${pieces.map((p) => p.id).join(',')}`;
  const print = async () => {
    if (!copiesOk) return;
    setBusy(true);
    try {
      const r = await printPieceLabels(pieces.map((p) => ({ itemId: p.id, copies: copies! })), source, keys.for(scope));
      keys.rotate(scope);
      const reprints = r.labels.filter((l) => l.kind === 'REPRINT').length;
      toast.success(t('{n} label(s) sent to the printer', { n: r.labels.reduce((s, l) => s + l.copies, 0) }), reprints ? t('{n} piece(s) already had a label: recorded as a reprint.', { n: reprints }) : undefined);
      setOpen(false);
      setCopiesText('');
      qc.invalidateQueries({ queryKey: ['label-prints'] });
    } catch (e) {
      keys.rotate(scope);
      toast.fromError(e, t('Labels not printed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant={variant} icon={<Tag className="size-4" />} disabled={!pieces.length} onClick={() => setOpen(true)} data-testid={testId}>
        {label ?? t('Print label')}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={pieces.length === 1 ? t('Print the label of {code}', { code: pieces[0].code }) : t('Print the labels of {n} pieces', { n: pieces.length })}
        subtitle={t('Every print is recorded: who, when, how many, and whether it is a reprint.')}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('Cancel')}</Button>
            <Button variant="primary" icon={<Tag className="size-4" />} disabled={!copiesOk} loading={busy} onClick={() => void print()} data-testid="label-print-confirm">
              {t('Print')}
            </Button>
          </>
        }
      >
        <Field label={pieces.length === 1 ? t('Copies') : t('Copies of each piece')} hint={t('Empty: 1. At most {max}.', { max })}>
          <IntegerInput value={copiesText} onValueChange={setCopiesText} min={1} max={max} placeholder="1" data-testid="label-copies" />
        </Field>
      </Dialog>
    </>
  );
}

/** The labels printed for a piece (newest first): when, who, how many, first or reprint. */
export function LabelPrintsCard({ itemId }: { itemId: number }) {
  const { t, L, lang } = useI18n();
  const q = useQuery({ queryKey: ['label-prints', itemId], queryFn: () => get<LabelPrintRow[]>(`/inventory/items/${itemId}/label-prints`) });
  const rows = q.data ?? [];
  return (
    <div data-testid="label-prints">
      <Card padded={false}>
        <CardHeader title={t('Labels printed')} subtitle={rows.length ? t('{n} print(s)', { n: rows.length }) : t('No label printed yet')} />
        {rows.length > 0 && (
          <table className="w-full text-[13px]">
            <thead className="bg-[#f7f8fa] text-ink-500">
              <tr>
                <th className="px-5 py-2 text-start font-medium">{t('When')}</th>
                <th className="px-3 py-2 text-start font-medium">{t('By')}</th>
                <th className="px-3 py-2 text-end font-medium">{t('Copies')}</th>
                <th className="px-5 py-2 text-start font-medium">{t('Print')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id} data-testid="label-print-row" data-kind={r.kind}>
                  <td className="px-5 py-2 num">{dateTime(r.createdAt, lang)}</td>
                  <td className="px-3 py-2">{L(r.printedByName, r.printedByNameAr)}</td>
                  <td className="px-3 py-2 text-end num">{r.copies}</td>
                  <td className="px-5 py-2">{r.kind === 'REPRINT' ? <Badge tone="warn">{t('Reprint')}</Badge> : <Badge tone="info">{t('First label')}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
