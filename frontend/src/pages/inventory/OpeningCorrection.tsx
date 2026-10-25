// OPN-FIX (docs/plans/OPN-FIX.md, D-opnfix-1…5): on the page of a piece of a sealed opening, the General Manager corrects
// its condition, karat or weights, or voids it, while it is AVAILABLE (in any branch).
//   * The dialog asks Void or Correct, the new values (prefilled with the current ones), the reason, the password and a
//     passkey confirmation (as the seal).
//   * Before the final confirmation it shows the server's preview (D-opnfix-5): the current price, the new price and the
//     change in the stock valuation, from the live rates; a refusal (a missing rate, nothing changed…) shows there too.
//     The preview writes nothing; the correction re-reads everything under the piece's lock.
//   * The piece page lists the corrections (before → after, reason, who, when, the branch it was in).

import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Fingerprint, PencilLine } from 'lucide-react';
import { parseWeightInput } from '@jerp/shared';
import { errorText, get, postOnce } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { useActionKeys } from '../../lib/idempotency';
import { useDebounced } from '../../lib/hooks';
import { dateTime, grams, karatLabel, signedMoney, money } from '../../lib/format';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Textarea, WeightInput } from '../../components/ui';
import { confirmWithPasskey } from '../../components/ReauthDialog';
import type { ItemRow } from '../../lib/types';

type Condition = 'NEW' | 'USED';
const CONDITION_LABELS: Record<Condition, string> = { NEW: 'New', USED: 'Used' };

export interface OpeningCorrectionRow {
  id: number;
  kind: 'CORRECT' | 'VOID';
  branchName: string;
  branchNameAr: string;
  conditionBefore: Condition;
  conditionAfter: Condition;
  karatBefore: number;
  karatAfter: number;
  grossWeightMgBefore: number;
  grossWeightMgAfter: number;
  netWeightMgBefore: number;
  netWeightMgAfter: number;
  reason: string;
  correctedByName: string;
  createdAt: string;
}

interface Preview {
  before: { condition: Condition; karat: number; netWeightMg: number; sellingPrice: number | null };
  after: { condition: Condition; karat: number; netWeightMg: number; sellingPrice: number | null } | null;
  valuationChange: number;
  stockWeightChangeMg: number;
  stockCountChange: number;
}

const toGrams = (mg: number) => (mg / 1000).toFixed(3);

/** The button on the piece page (General Manager, an AVAILABLE piece of a sealed opening) and its dialog. */
export function OpeningCorrectionButton({ item, openingId }: { item: ItemRow; openingId: number }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  if (!can('opening.correct') || item.origin !== 'OPENING' || item.status !== 'AVAILABLE') return null;
  return (
    <>
      <Button icon={<PencilLine className="size-4" />} onClick={() => setOpen(true)} data-testid="opening-correct">
        {t('Correct this opening piece')}
      </Button>
      {open && <OpeningCorrectionDialog item={item} openingId={openingId} onClose={() => setOpen(false)} />}
    </>
  );
}

function OpeningCorrectionDialog({ item, openingId, onClose }: { item: ItemRow; openingId: number; onClose: () => void }) {
  const { t } = useI18n();
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const keys = useActionKeys();
  const [action, setAction] = useState<'CORRECT' | 'VOID'>('CORRECT');
  const [condition, setCondition] = useState<Condition>(item.rateKind);
  const [karat, setKarat] = useState(item.karat);
  const [gross, setGross] = useState(toGrams(item.grossWeightMg));
  const [net, setNet] = useState(toGrams(item.netWeightMg));
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [passkeyDone, setPasskeyDone] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const grossMg = parseWeightInput(gross);
  const netMg = parseWeightInput(net);
  const change = action === 'VOID' ? { action } : { action, condition, karat, ...(grossMg ? { grossWeightMg: grossMg } : {}), ...(netMg ? { netWeightMg: netMg } : {}) };
  const query = useDebounced(JSON.stringify(change), 250);
  // D-opnfix-5: the server's preview, read-only; it refreshes when the values change.
  const preview = useQuery({
    queryKey: ['opening-correction-preview', openingId, item.id, query],
    queryFn: () => get<Preview>(`/openings/${openingId}/pieces/${item.id}/correction-preview`, JSON.parse(query)),
    retry: false,
    placeholderData: keepPreviousData,
  });
  const passkey = useMutation({
    mutationFn: confirmWithPasskey,
    onSuccess: () => {
      setPasskeyDone(true);
      setPasskeyError(null);
    },
    onError: (e) => setPasskeyError(errorText(e)),
  });
  const save = useMutation({
    mutationFn: () => postOnce(`/openings/${openingId}/pieces/${item.id}/correction`, { ...change, reason, confirmPassword: password }, keys.for('opening-correction')),
    onSuccess: () => {
      keys.rotate('opening-correction');
      toast.success(action === 'VOID' ? t('The opening piece {code} is voided', { code: item.code }) : t('The opening piece {code} is corrected', { code: item.code }));
      qc.invalidateQueries();
      onClose();
    },
    onError: (e) => {
      keys.rotate('opening-correction');
      toast.fromError(e);
    },
  });
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 200;
  const ready = preview.isSuccess && !preview.isFetching && JSON.stringify(change) === query && reasonOk && !!password && passkeyDone;
  const p = preview.data;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Correct the opening piece {code}', { code: item.code })}
      subtitle={t('The opening stays as sealed; the piece changes and the change is recorded with your reason.')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant={action === 'VOID' ? 'danger-solid' : 'primary'} disabled={!ready} loading={save.isPending} onClick={() => save.mutate()} data-testid="opening-correct-confirm">
            {action === 'VOID' ? t('Void the piece') : t('Save the correction')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('What to do')}>
          <Select value={action} onChange={(e) => setAction(e.target.value as 'CORRECT' | 'VOID')} data-testid="opening-correct-action">
            <option value="CORRECT">{t('Correct its values')}</option>
            <option value="VOID">{t('Void it (entered by mistake)')}</option>
          </Select>
        </Field>
        {action === 'CORRECT' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('Condition')}>
              <Select value={condition} onChange={(e) => setCondition(e.target.value as Condition)} data-testid="opening-correct-condition">
                <option value="NEW">{t('New')}</option>
                <option value="USED">{t('Used')}</option>
              </Select>
            </Field>
            <Field label={t('Karat')}>
              <Select value={karat} onChange={(e) => setKarat(Number(e.target.value))} data-testid="opening-correct-karat">
                {[...new Set([item.karat, ...(me?.allowedKarats ?? [])])].map((k) => (
                  <option key={k} value={k}>
                    {karatLabel(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('Gross weight (g)')}>
              <WeightInput value={gross} onValueChange={setGross} data-testid="opening-correct-gross" />
            </Field>
            <Field label={t('Net weight (g)')}>
              <WeightInput value={net} onValueChange={setNet} data-testid="opening-correct-net" />
            </Field>
          </div>
        )}
        <div className="rounded-md border border-line bg-panel px-3 py-2 text-[13px]" data-testid="opening-correct-preview">
          {preview.isError ? (
            <span className="text-crit">{errorText(preview.error)}</span>
          ) : !p ? (
            <span className="text-ink-3">{t('Checking the change…')}</span>
          ) : (
            <dl className="space-y-1">
              <div className="flex justify-between">
                <dt>{t('Price now')}</dt>
                <dd className="num">{money(p.before.sellingPrice)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>{action === 'VOID' ? t('After the void') : t('Price after the correction')}</dt>
                <dd className="num font-medium" data-testid="opening-correct-new-price">
                  {p.after ? money(p.after.sellingPrice) : t('out of stock (voided)')}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt>{t('Stock valuation')}</dt>
                <dd className="num" data-testid="opening-correct-valuation">
                  {signedMoney(p.valuationChange, true)}
                </dd>
              </div>
              {p.stockWeightChangeMg !== 0 && (
                <div className="flex justify-between text-ink-3">
                  <dt>{t('Stock weight')}</dt>
                  <dd className="num">{`${p.stockWeightChangeMg > 0 ? '+' : ''}${grams(p.stockWeightChangeMg)}`}</dd>
                </div>
              )}
            </dl>
          )}
        </div>
        <Field label={t('Reason')} hint={reasonOk || !reason ? undefined : t('Write a reason of {min} to {max} characters', { min: 3, max: 200 })}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} data-testid="opening-correct-reason" />
        </Field>
        <Field label={t('Your password')}>
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="opening-correct-password" />
        </Field>
        <Button icon={passkeyDone ? <CheckCircle2 className="size-4" /> : <Fingerprint className="size-4" />} disabled={passkeyDone} loading={passkey.isPending} onClick={() => passkey.mutate()} data-testid="opening-correct-passkey">
          {passkeyDone ? t('Passkey confirmed') : t('Confirm with your passkey')}
        </Button>
        {passkeyError && <Alert tone="danger">{passkeyError}</Alert>}
      </div>
    </Dialog>
  );
}

/** The corrections of an opening piece (its page) or of a sealed opening (its page), oldest first. */
export function OpeningCorrectionsCard({ rows, showCode }: { rows: (OpeningCorrectionRow & { code?: string })[]; showCode?: boolean }) {
  const { t, L, lang } = useI18n();
  if (!rows.length) return null;
  const change = (r: OpeningCorrectionRow) => {
    if (r.kind === 'VOID') return t('Voided');
    const parts: string[] = [];
    if (r.conditionBefore !== r.conditionAfter) parts.push(`${t(CONDITION_LABELS[r.conditionBefore])} → ${t(CONDITION_LABELS[r.conditionAfter])}`);
    if (r.karatBefore !== r.karatAfter) parts.push(`${karatLabel(r.karatBefore)} → ${karatLabel(r.karatAfter)}`);
    if (r.netWeightMgBefore !== r.netWeightMgAfter) parts.push(`${t('Net weight')} ${grams(r.netWeightMgBefore)} → ${grams(r.netWeightMgAfter)}`);
    if (r.grossWeightMgBefore !== r.grossWeightMgAfter) parts.push(`${t('Gross weight')} ${grams(r.grossWeightMgBefore)} → ${grams(r.grossWeightMgAfter)}`);
    return parts.join(' · ');
  };
  return (
    <Card padded={false}>
      <CardHeader title={t('Corrections after the seal')} subtitle={t('The opening stays as sealed; each correction is recorded with its reason.')} />
      <ul className="divide-y divide-line px-5" data-testid="opening-corrections">
        {rows.map((r) => (
          <li key={r.id} className="py-3 text-[13px]" data-testid={`opening-correction-${r.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              {showCode && r.code && <span className="font-mono text-[12px]">{r.code}</span>}
              <Badge tone={r.kind === 'VOID' ? 'crit' : 'warn'}>{r.kind === 'VOID' ? t('Void') : t('Correction')}</Badge>
              <span>{change(r)}</span>
            </div>
            <div className="mt-1 text-[12px] text-ink-500">
              {dateTime(r.createdAt, lang)} · {r.correctedByName} · {L(r.branchName, r.branchNameAr)} · <span className="text-ink-700">{r.reason}</span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
