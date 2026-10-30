// OPN-3 (plan docs/plans/OPN-3.md, D-opn3-*): the broken scrap of an opening balance. Weight only, per karat (any karat
// 1–24), never a piece, no cost, no price; typed in only (no CSV).
//   * ScrapDraftCard: the form (karat, net weight in grams, an optional note) and the lines, each edited or removed while
//     the opening is a draft, with the total per karat and its 24K equivalent.
//   * ScrapSealedCard: the scrap as sealed, the scrap now (after the corrections) and the corrections; the General
//     Manager corrects it (a reason, the password and the passkey, as a piece correction): add, remove, or move weight
//     between two karats.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Fingerprint, PencilLine, Plus, Trash2 } from 'lucide-react';
import { parseWeightInput, pureGoldMg } from '@jerp/shared';
import { errorText, postOnce } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { useActionKeys } from '../../lib/idempotency';
import { dateTime, grams, karatLabel } from '../../lib/format';
import { confirmWithPasskey, openWindowWith } from '../../lib/reauth';
import { Alert, Button, Card, CardHeader, Dialog, Field, Input, Select, WeightInput } from '../../components/ui';

/** Totals by karat with the 24K equivalent (as the server computes them: one rounding per karat). */
export interface ScrapTotals {
  byKarat: { karat: number; lines: number; weightMg: number; pureMg24: number }[];
  lines: number;
  weightMg: number;
  pureMg24: number;
}
export interface ScrapLine {
  id: number;
  lineNo: number;
  karat: number;
  weightMg: number;
  note: string | null;
}
export interface ScrapCorrection {
  id: number;
  karat: number;
  weightMgChange: number;
  reason: string;
  createdAt: string;
  correctedByName: string;
}

/** Every karat a scrap line may have (owner Q2: any karat, as a scrap purchase). */
const KARATS = Array.from({ length: 24 }, (_, i) => 24 - i);
const NOTE_MAX = 120;
/** The 24K equivalent of the pieces, per karat (the same helper as the server and the stock weight). */
export const piecesPure24 = (byKarat: { karat: number; netWeightMg: number }[]) => byKarat.reduce((s, k) => s + pureGoldMg(k.netWeightMg, k.karat), 0);
const signed = (mg: number) => `${mg > 0 ? '+' : '−'}${grams(Math.abs(mg))}`;

/** The scrap totals as a small table: karat, lines, weight, 24K; and the total line. */
export function ScrapTotalsTable({ totals, testId }: { totals: ScrapTotals; testId: string }) {
  const { t } = useI18n();
  return (
    <table className="w-full text-[13px]" data-testid={testId}>
      <thead className="text-ink-3">
        <tr>
          <th className="py-1 text-start font-medium">{t('Karat')}</th>
          <th className="py-1 text-end font-medium">{t('Weight')}</th>
          <th className="py-1 text-end font-medium">{t('24K equivalent')}</th>
        </tr>
      </thead>
      <tbody>
        {totals.byKarat.map((k) => (
          <tr key={k.karat} className="border-t border-line" data-testid={`${testId}-${k.karat}`}>
            <td className="py-1">{karatLabel(k.karat)}</td>
            <td className="py-1 text-end num">{grams(k.weightMg)}</td>
            <td className="py-1 text-end num">{grams(k.pureMg24)}</td>
          </tr>
        ))}
        <tr className="border-t border-line font-medium">
          <td className="py-1">{t('Total')}</td>
          <td className="py-1 text-end num" data-testid={`${testId}-weight`}>{grams(totals.weightMg)}</td>
          <td className="py-1 text-end num" data-testid={`${testId}-pure`}>{grams(totals.pureMg24)}</td>
        </tr>
      </tbody>
    </table>
  );
}

/** The broken scrap of a draft: the form and the lines. */
export function ScrapDraftCard({ openingId, lines, totals }: { openingId: number; lines: ScrapLine[]; totals: ScrapTotals }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<ScrapLine | null>(null);
  return (
    <Card>
      <CardHeader title={t('Broken scrap')} help={t('Weight only, by karat. On sealing it goes into the branch scrap stock and can settle suppliers.')} />
      <div data-testid="opening-scrap">
        <ScrapForm openingId={openingId} />
        {lines.length > 0 && (
          <>
            <table className="mt-3 w-full text-[13px]" data-testid="opening-scrap-lines">
              <thead className="text-ink-3">
                <tr>
                  <th className="py-1 text-start font-medium">#</th>
                  <th className="py-1 text-start font-medium">{t('Karat')}</th>
                  <th className="py-1 text-end font-medium">{t('Weight')}</th>
                  <th className="py-1 text-start font-medium">{t('Note')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-t border-line" data-testid={`opening-scrap-line-${l.lineNo}`}>
                    <td className="py-1 num">{l.lineNo}</td>
                    <td className="py-1">{karatLabel(l.karat)}</td>
                    <td className="py-1 text-end num">{grams(l.weightMg)}</td>
                    <td className="py-1">{l.note ?? '—'}</td>
                    <td className="py-1 text-end">
                      <span className="inline-flex gap-1">
                        <Button size="sm" variant="ghost" icon={<PencilLine className="size-4" />} onClick={() => setEditing(l)} aria-label={t('Edit')} data-testid={`opening-scrap-edit-${l.lineNo}`} />
                        <RemoveScrapLine openingId={openingId} line={l} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3">
              <ScrapTotalsTable totals={totals} testId="opening-scrap-total" />
            </div>
          </>
        )}
      </div>
      {editing && <EditScrapLine openingId={openingId} line={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function ScrapForm({ openingId }: { openingId: number }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const keys = useActionKeys();
  const [karat, setKarat] = useState('');
  const [weight, setWeight] = useState('');
  const [note, setNote] = useState('');
  const mg = parseWeightInput(weight);
  const missing = !karat ? t('Choose the karat') : !mg ? t('Enter the weight') : note.trim().length > NOTE_MAX ? t('A note can have at most {max} characters', { max: NOTE_MAX }) : null;
  const add = useMutation({
    mutationFn: () => postOnce(`/openings/${openingId}/scrap-lines`, { karat: Number(karat), weightMg: mg, note: note.trim() || null }, keys.for('opening-scrap-line')),
    onSuccess: () => {
      keys.rotate('opening-scrap-line');
      // The next bag is often the same karat: the karat stays, the weight and the note start empty.
      setWeight('');
      setNote('');
      qc.invalidateQueries({ queryKey: ['opening'] });
    },
    onError: (e) => {
      keys.rotate('opening-scrap-line');
      toast.fromError(e);
    },
  });
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <Field label={t('Karat')}>
          <Select value={karat} onChange={(e) => setKarat(e.target.value)} data-testid="opening-scrap-karat">
            <option value="">{t('Choose…')}</option>
            {KARATS.map((k) => (
              <option key={k} value={k}>{karatLabel(k)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t('Net weight (g)')}>
          <WeightInput value={weight} onValueChange={setWeight} data-testid="opening-scrap-weight" />
        </Field>
        <Field label={t('Note (optional)')}>
          <Input value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} data-testid="opening-scrap-note" />
        </Field>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-meta text-ink-3">{missing ?? ''}</span>
        <Button variant="primary" icon={<Plus className="size-4" />} disabled={!!missing} loading={add.isPending} onClick={() => add.mutate()} data-testid="opening-scrap-add">{t('Add the scrap')}</Button>
      </div>
    </div>
  );
}

function EditScrapLine({ openingId, line, onClose }: { openingId: number; line: ScrapLine; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const keys = useActionKeys();
  const [karat, setKarat] = useState(String(line.karat));
  const [weight, setWeight] = useState((line.weightMg / 1000).toFixed(3));
  const [note, setNote] = useState(line.note ?? '');
  const mg = parseWeightInput(weight);
  const save = useMutation({
    mutationFn: () => postOnce(`/openings/${openingId}/scrap-lines/${line.id}`, { karat: Number(karat), weightMg: mg, note: note.trim() || null }, keys.for(`opening-scrap-edit-${line.id}`)),
    onSuccess: () => {
      keys.rotate(`opening-scrap-edit-${line.id}`);
      qc.invalidateQueries({ queryKey: ['opening'] });
      onClose();
    },
    onError: (e) => {
      keys.rotate(`opening-scrap-edit-${line.id}`);
      toast.fromError(e);
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Broken scrap line {line}', { line: line.lineNo })}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!mg || note.trim().length > NOTE_MAX} loading={save.isPending} onClick={() => save.mutate()} data-testid="opening-scrap-edit-save">{t('Save')}</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('Karat')}>
          <Select value={karat} onChange={(e) => setKarat(e.target.value)} data-testid="opening-scrap-edit-karat">
            {KARATS.map((k) => (
              <option key={k} value={k}>{karatLabel(k)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t('Net weight (g)')}>
          <WeightInput value={weight} onValueChange={setWeight} data-testid="opening-scrap-edit-weight" />
        </Field>
        <div className="col-span-2">
          <Field label={t('Note (optional)')}>
            <Input value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} data-testid="opening-scrap-edit-note" />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function RemoveScrapLine({ openingId, line }: { openingId: number; line: ScrapLine }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const keys = useActionKeys();
  const remove = useMutation({
    mutationFn: () => postOnce(`/openings/${openingId}/scrap-lines/${line.id}/remove`, {}, keys.for(`opening-scrap-remove-${line.id}`)),
    onSuccess: () => {
      keys.rotate(`opening-scrap-remove-${line.id}`);
      qc.invalidateQueries({ queryKey: ['opening'] });
    },
    onError: (e) => {
      keys.rotate(`opening-scrap-remove-${line.id}`);
      toast.fromError(e);
    },
  });
  return <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} loading={remove.isPending} onClick={() => remove.mutate()} aria-label={t('Remove')} data-testid={`opening-scrap-remove-${line.lineNo}`} />;
}

/** A sealed opening's broken scrap: as sealed, now, and its corrections (the General Manager corrects it here). */
export function ScrapSealedCard({ openingId, sealed, now, corrections }: { openingId: number; sealed: ScrapTotals; now: ScrapTotals; corrections: ScrapCorrection[] }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader
        title={t('Broken scrap')}
        subtitle={t('Sealed: {weight}; now: {now}', { weight: grams(sealed.weightMg), now: grams(now.weightMg) })}
        actions={
          can('opening.correct') ? (
            <Button size="sm" icon={<PencilLine className="size-4" />} onClick={() => setOpen(true)} data-testid="opening-scrap-correct">
              {t('Correct the broken scrap')}
            </Button>
          ) : undefined
        }
      />
      <div data-testid="opening-scrap-sealed">
        <ScrapTotalsTable totals={now} testId="opening-scrap-now" />
        {corrections.length > 0 && (
          <table className="mt-3 w-full text-[13px]" data-testid="opening-scrap-corrections">
            <thead className="text-ink-3">
              <tr>
                <th className="py-1 text-start font-medium">{t('Date')}</th>
                <th className="py-1 text-start font-medium">{t('Karat')}</th>
                <th className="py-1 text-end font-medium">{t('Change')}</th>
                <th className="py-1 text-start font-medium">{t('Reason')}</th>
                <th className="py-1 text-start font-medium">{t('By')}</th>
              </tr>
            </thead>
            <tbody>
              {corrections.map((c) => (
                <tr key={c.id} className="border-t border-line">
                  <td className="py-1">{dateTime(c.createdAt)}</td>
                  <td className="py-1">{karatLabel(c.karat)}</td>
                  <td className="py-1 text-end num" dir="ltr">{signed(c.weightMgChange)}</td>
                  <td className="py-1">{c.reason}</td>
                  <td className="py-1">{c.correctedByName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <ScrapCorrectionDialog openingId={openingId} now={now} onClose={() => setOpen(false)} />}
    </Card>
  );
}

type CorrectionKind = 'ADD' | 'REMOVE' | 'MOVE';

function ScrapCorrectionDialog({ openingId, now, onClose }: { openingId: number; now: ScrapTotals; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const keys = useActionKeys();
  const [kind, setKind] = useState<CorrectionKind>('REMOVE');
  const [karat, setKarat] = useState(String(now.byKarat[0]?.karat ?? 21));
  const [toKarat, setToKarat] = useState('');
  const [weight, setWeight] = useState('');
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [passkeyDone, setPasskeyDone] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const mg = parseWeightInput(weight) ?? 0;
  const from = Number(karat);
  const changes =
    kind === 'ADD'
      ? [{ karat: from, weightMgChange: mg }]
      : kind === 'REMOVE'
        ? [{ karat: from, weightMgChange: -mg }]
        : [
            { karat: from, weightMgChange: -mg },
            { karat: Number(toKarat), weightMgChange: mg },
          ];
  const passkey = useMutation({
    mutationFn: confirmWithPasskey,
    onSuccess: () => {
      setPasskeyDone(true);
      setPasskeyError(null);
    },
    onError: (e) => setPasskeyError(errorText(e)),
  });
  const save = useMutation({
    mutationFn: async () => {
      await openWindowWith(password); // UX-3: one password for the window and the correction
      return postOnce(`/openings/${openingId}/scrap-corrections`, { changes, reason, confirmPassword: password }, keys.for('opening-scrap-correction'));
    },
    onSuccess: () => {
      keys.rotate('opening-scrap-correction');
      toast.success(t('The broken scrap of the opening is corrected'));
      qc.invalidateQueries();
      onClose();
    },
    onError: (e) => {
      keys.rotate('opening-scrap-correction');
      toast.fromError(e);
    },
  });
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 200;
  const moveOk = kind !== 'MOVE' || (!!toKarat && Number(toKarat) !== from);
  const ready = mg > 0 && moveOk && reasonOk && !!password && passkeyDone;
  const preview = kind === 'MOVE' ? `${karatLabel(from)} ${signed(-mg)} · ${toKarat ? karatLabel(Number(toKarat)) : '—'} ${signed(mg)}` : `${karatLabel(from)} ${signed(kind === 'ADD' ? mg : -mg)}`;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Correct the broken scrap of the opening')}
      subtitle={t('The opening stays as sealed; the scrap stock changes and the change is recorded with your reason.')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!ready} loading={save.isPending} onClick={() => save.mutate()} data-testid="opening-scrap-correct-confirm">{t('Save the correction')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('What to do')}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as CorrectionKind)} data-testid="opening-scrap-correct-kind">
            <option value="REMOVE">{t('Less weight')}</option>
            <option value="ADD">{t('More weight')}</option>
            <option value="MOVE">{t('Wrong karat: move the weight')}</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={kind === 'MOVE' ? t('From karat') : t('Karat')}>
            <Select value={karat} onChange={(e) => setKarat(e.target.value)} data-testid="opening-scrap-correct-karat">
              {KARATS.map((k) => (
                <option key={k} value={k}>{karatLabel(k)}</option>
              ))}
            </Select>
          </Field>
          {kind === 'MOVE' && (
            <Field label={t('To karat')}>
              <Select value={toKarat} onChange={(e) => setToKarat(e.target.value)} data-testid="opening-scrap-correct-to-karat">
                <option value="">{t('Choose…')}</option>
                {KARATS.filter((k) => k !== from).map((k) => (
                  <option key={k} value={k}>{karatLabel(k)}</option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('Weight (g)')}>
            <WeightInput value={weight} onValueChange={setWeight} data-testid="opening-scrap-correct-weight" />
          </Field>
        </div>
        {mg > 0 && (
          <p className="text-[13px]" dir="auto" data-testid="opening-scrap-correct-preview">
            {preview}
          </p>
        )}
        <Field label={t('Reason')}>
          <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="opening-scrap-correct-reason" />
        </Field>
        <Field label={t('Your password')}>
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="opening-scrap-correct-password" />
        </Field>
        <Button icon={passkeyDone ? <CheckCircle2 className="size-4" /> : <Fingerprint className="size-4" />} disabled={passkeyDone} loading={passkey.isPending} onClick={() => passkey.mutate()} data-testid="opening-scrap-correct-passkey">
          {passkeyDone ? t('Passkey confirmed') : t('Confirm with your passkey')}
        </Button>
        {passkeyError && <Alert tone="danger">{passkeyError}</Alert>}
      </div>
    </Dialog>
  );
}

/** One line for the seal dialog and the sealed page: the broken scrap by karat. */
export function scrapLine(totals: ScrapTotals) {
  return totals.byKarat.map((k) => `${karatLabel(k.karat)} ${grams(k.weightMg)}`).join(' · ');
}
