// CSH-2 piece B (D-csh-1…D-csh-5, owner answer Q10): "Funding from the General Manager" on the Cash page, for the
// General Manager only (`funding.view`; a branch manager never sees it). What each branch owes him (the OWED_TO_GM
// balances, derived by the server), the company total, the history of advances, repayments and corrections, and the
// three actions: record an advance, record a repayment, correct an event. Each saves with the password
// re-confirmation (the shared dialog) and an Idempotency-Key. Money and references are isolated left-to-right.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HandCoins, Undo2 } from 'lucide-react';
import { validBankReference } from '@jerp/shared';
import { get, postOnce } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, money } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { useBranches } from '../../lib/hooks';
import { useActionKeys } from '../../lib/idempotency';
import { Badge, Button, Card, CardHeader, Dialog, Field, Input, MoneyInput, Mono, ReferenceInput, PillGroup, Select, Textarea } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';

type Account = 'CASH' | 'BANK';
interface FundingEvent {
  id: number;
  number: string;
  branchId: number;
  kind: 'ADVANCE' | 'REPAYMENT' | 'REVERSAL';
  account: Account;
  amount: number;
  reason: string;
  bankReference: string | null;
  paidDirectlyToSeller: boolean;
  linkedRef: string | null;
  reversesEventId: number | null;
  at: string;
  createdByName: string;
  corrected: boolean;
}
interface FundingView {
  branches: { branchId: number; branchCode: string; branchName: string; branchNameAr: string; owedToGm: number }[];
  totalOwedToGm: number;
  events: FundingEvent[];
  hasMore: boolean;
  offset: number;
}

/** A money amount isolated left-to-right inside Arabic text. */
const ltr = (s: string) => `⁦${s}⁩`;

export function FundingPanel({ branchId }: { branchId?: number }) {
  const { t, L, lang } = useI18n();
  const { can } = useAuth();
  const [dialog, setDialog] = useState<'ADVANCE' | 'REPAYMENT' | null>(null);
  const [correcting, setCorrecting] = useState<FundingEvent | null>(null);
  const q = useQuery({ queryKey: ['funding', branchId ?? 'all'], queryFn: () => get<FundingView>('/funding', { branchId }), enabled: can('funding.view') });
  if (!can('funding.view')) return null;
  const manage = can('funding.manage');
  const branchName = (id: number) => {
    const b = q.data?.branches.find((x) => x.branchId === id);
    return b ? L(b.branchName, b.branchNameAr) : String(id);
  };
  const kindLabel = (e: FundingEvent) => (e.kind === 'ADVANCE' ? t('Advance') : e.kind === 'REPAYMENT' ? t('Repayment') : t('Correction'));
  const sign = (e: FundingEvent) => {
    // Effect on what the branch owes: + for an advance, − for a repayment; a correction undoes its original.
    const orig = e.kind === 'REVERSAL' ? q.data?.events.find((x) => x.id === e.reversesEventId)?.kind : e.kind;
    if (!orig) return '';
    const plus = (orig === 'ADVANCE') !== (e.kind === 'REVERSAL');
    return plus ? '+' : '−';
  };

  return (
    <Card padded={false} className="mb-5">
      <div data-testid="funding-panel">
        <CardHeader
          title={t('Funding from the General Manager')}
          subtitle={t('What each branch owes the General Manager.')}
          help={t('An advance puts money into the drawer or the bank as a loan to the branch; a repayment returns it. Only you see this.')}
          actions={
            manage ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" icon={<HandCoins className="size-4" />} onClick={() => setDialog('ADVANCE')} data-testid="funding-advance">
                  {t('Record an advance')}
                </Button>
                <Button size="sm" icon={<Undo2 className="size-4" />} onClick={() => setDialog('REPAYMENT')} data-testid="funding-repayment">
                  {t('Record a repayment')}
                </Button>
              </div>
            ) : undefined
          }
        />
        <DataTable
          query={q}
          rows={q.data?.branches ?? []}
          rowKey={(r) => r.branchId}
          searchable={false}
          exportName="owed-to-gm"
          emptyTitle={t('No branches')}
          columns={[
            { key: 'branchName', header: t('Branch'), render: (r) => L(r.branchName, r.branchNameAr) },
            {
              key: 'owedToGm',
              header: t('Owed to the General Manager'),
              align: 'end',
              render: (r) => <span className="font-semibold num" data-testid={`owed-${r.branchCode}`}>{money(r.owedToGm, false)}</span>,
              footer: <span data-testid="owed-total">{money(q.data?.totalOwedToGm ?? 0, false)}</span>,
            },
          ]}
        />
        <div className="border-t border-line px-5 pb-1 pt-4 text-[13px] font-semibold text-ink-700">{t('History')}</div>
        <DataTable
          query={q}
          rows={q.data?.events ?? []}
          rowKey={(r) => r.id}
          exportName="gm-funding"
          emptyTitle={t('No advances recorded yet')}
          emptyBody={manage ? t('Record the money you put into a branch, so its drawer and bank add up.') : undefined}
          columns={[
            { key: 'number', header: t('Number'), render: (r) => <Mono className="font-semibold">{r.number}</Mono> },
            { key: 'at', header: t('Recorded'), render: (r) => dateTime(r.at, lang) },
            { key: 'branchId', header: t('Branch'), value: (r) => branchName(r.branchId), render: (r) => branchName(r.branchId) },
            {
              key: 'kind',
              header: t('Type'),
              value: (r) => kindLabel(r),
              render: (r) => (
                <span className="inline-flex flex-wrap items-center gap-1">
                  {kindLabel(r)}
                  {r.corrected && <Badge tone="warn">{t('Corrected')}</Badge>}
                  {r.paidDirectlyToSeller && <Badge tone="info">{t('Paid directly to a seller')}</Badge>}
                </span>
              ),
            },
            { key: 'account', header: t('Account'), value: (r) => (r.account === 'CASH' ? t('Drawer') : t('Bank')), render: (r) => (r.account === 'CASH' ? t('Drawer') : t('Bank')) },
            { key: 'amount', header: t('Amount'), align: 'end', render: (r) => <span className="num">{ltr(`${sign(r)}${money(r.amount, false)}`)}</span> },
            { key: 'reason', header: t('Reason'), render: (r) => <span className="whitespace-pre-wrap">{r.reason}</span> },
            {
              key: 'bankReference',
              header: t('Reference'),
              value: (r) => [r.bankReference, r.linkedRef].filter(Boolean).join(' · '),
              render: (r) => (
                <span className="font-mono text-[12.5px]">
                  {r.bankReference ? ltr(r.bankReference) : '—'}
                  {r.linkedRef && <span className="block text-ink-3">{t('For purchase {number}', { number: ltr(r.linkedRef) })}</span>}
                </span>
              ),
            },
            { key: 'createdByName', header: t('Recorded by') },
            ...(manage
              ? [
                  {
                    key: 'correct',
                    header: '',
                    align: 'end' as const,
                    render: (r: FundingEvent) =>
                      r.kind !== 'REVERSAL' && !r.corrected ? (
                        <Button size="sm" variant="ghost" onClick={() => setCorrecting(r)} data-testid={`funding-correct-${r.number}`}>
                          {t('Correct')}
                        </Button>
                      ) : null,
                  },
                ]
              : []),
          ]}
        />
      </div>
      {dialog && q.data && <FundingDialog kind={dialog} defaultBranch={branchId} view={q.data} onClose={() => setDialog(null)} />}
      {correcting && <CorrectDialog event={correcting} branch={branchName(correcting.branchId)} onClose={() => setCorrecting(null)} />}
    </Card>
  );
}

function useFundingDone() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['funding'] });
    qc.invalidateQueries({ queryKey: ['cash-drawer'] });
    qc.invalidateQueries({ queryKey: ['cash-reconciliation'] });
  };
}

function FundingDialog({ kind, defaultBranch, view, onClose }: { kind: 'ADVANCE' | 'REPAYMENT'; defaultBranch?: number; view: FundingView; onClose: () => void }) {
  const { t, L } = useI18n();
  const toast = useToast();
  const done = useFundingDone();
  const branches = useBranches();
  const actionKeys = useActionKeys();
  const [branchId, setBranchId] = useState<number | ''>(defaultBranch ?? '');
  const [account, setAccount] = useState<Account>('CASH');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [bankRef, setBankRef] = useState('');
  const [direct, setDirect] = useState(false);
  const [linkedRef, setLinkedRef] = useState('');
  const owed = branchId === '' ? null : (view.branches.find((b) => b.branchId === branchId)?.owedToGm ?? 0);
  const value = Number(amount);
  const amountOk = amount !== '' && Number.isInteger(value) && value > 0 && (kind === 'ADVANCE' || owed == null || value <= owed);
  const refOk = account === 'CASH' || !!validBankReference(bankRef);
  const reasonOk = reason.trim().length >= 3;
  const linkedOk = !linkedRef.trim() || linkedRef.trim().length >= 3;
  const valid = branchId !== '' && amountOk && refOk && reasonOk && linkedOk;
  const scope = `funding:${kind}:${branchId}`;
  const m = useMutation({
    mutationFn: () =>
      postOnce<{ number: string; owedToGm: number }>(
        kind === 'ADVANCE' ? '/funding/advances' : '/funding/repayments',
        {
          branchId,
          account,
          amount: value,
          reason: reason.trim(),
          bankReference: account === 'BANK' ? bankRef.trim() : undefined,
          ...(kind === 'ADVANCE' ? { paidDirectlyToSeller: direct || undefined, linkedRef: linkedRef.trim() || undefined } : {}),
        },
        actionKeys.for(scope),
      ),
    onSuccess: (r) => {
      actionKeys.rotate(scope);
      toast.success(kind === 'ADVANCE' ? t('Advance {number} recorded', { number: r.number }) : t('Repayment {number} recorded', { number: r.number }), t('Owed to the General Manager now: {amount}', { amount: ltr(money(r.owedToGm)) }));
      done();
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={kind === 'ADVANCE' ? t('Record an advance to a branch') : t('Record a repayment from a branch')}
      subtitle={
        kind === 'ADVANCE'
          ? t('Money you put into the branch’s drawer or bank. The branch owes it to you until it is repaid. Record it when the money moves.')
          : t('Money the branch returns to you from its drawer or bank. Never more than it owes you.')
      }
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!valid} loading={m.isPending} onClick={() => m.mutate()} data-testid="funding-submit">
            {kind === 'ADVANCE' ? t('Record advance') : t('Record repayment')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Branch')}>
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : '')} data-testid="funding-branch">
            <option value="">{t('Select…')}</option>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {L(b.name, b.nameAr)}
              </option>
            ))}
          </Select>
        </Field>
        <div data-testid="funding-account">
          <span className="mb-1.5 block text-meta font-medium text-ink-2">{kind === 'ADVANCE' ? t('Into') : t('From')}</span>
          <PillGroup<Account>
            label={kind === 'ADVANCE' ? t('Into') : t('From')}
            value={account}
            onChange={setAccount}
            options={[
              { value: 'CASH', label: t('Drawer') },
              { value: 'BANK', label: t('Bank') },
            ]}
          />
        </div>
        <Field
          label={t('Amount')}
          hint={owed != null ? t('Owed to the General Manager now: {amount}', { amount: ltr(money(owed)) }) : undefined}
          error={kind === 'REPAYMENT' && owed != null && amount !== '' && value > owed ? t('More than the branch owes you') : undefined}
        >
          <MoneyInput value={amount} onValueChange={setAmount} min={1} data-testid="funding-amount" />
        </Field>
        {account === 'BANK' && (
          <Field label={t('Bank transfer reference')} hint={bankRef && !refOk ? t('4 to 40 letters or digits') : undefined}>
            <ReferenceInput value={bankRef} onValueChange={setBankRef} data-testid="funding-bank-ref" />
          </Field>
        )}
        <Field label={t('Reason, and when the money moved')} className="sm:col-span-2">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} data-testid="funding-reason" />
        </Field>
        {kind === 'ADVANCE' && (
          <>
            <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
              <input type="checkbox" checked={direct} onChange={(e) => setDirect(e.target.checked)} className="accent-gold-600" data-testid="funding-direct" />
              {t('I paid a seller directly from my own money')}
            </label>
            {direct && (
              <Field label={t('Purchase number (optional)')} help={t('The scrap purchase the branch records for it, if you know the number.')}>
                <Input value={linkedRef} onChange={(e) => setLinkedRef(e.target.value)} maxLength={40} dir="ltr" data-testid="funding-linked-ref" />
              </Field>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function CorrectDialog({ event, branch, onClose }: { event: FundingEvent; branch: string; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const done = useFundingDone();
  const actionKeys = useActionKeys();
  const [reason, setReason] = useState('');
  const scope = `funding-correct:${event.id}`;
  const m = useMutation({
    mutationFn: () => postOnce<{ number: string }>(`/funding/${event.id}/correct`, { reason: reason.trim() }, actionKeys.for(scope)),
    onSuccess: (r) => {
      actionKeys.rotate(scope);
      toast.success(t('Correction {number} recorded', { number: r.number }), t('Both entries of {original} were reversed.', { original: event.number }));
      done();
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Correct {number}', { number: event.number })}
      subtitle={t('A correction reverses the event in the drawer or bank and in what the branch owes. Nothing is deleted; both stay in the history.')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="danger-solid" disabled={reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate()} data-testid="funding-correct-submit">
            {t('Record correction')}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-ink-2">
        {branch} · {event.kind === 'ADVANCE' ? t('Advance') : t('Repayment')} · <span className="num">{ltr(money(event.amount))}</span>
      </p>
      <Field label={t('Reason')}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} data-testid="funding-correct-reason" />
      </Field>
    </Dialog>
  );
}
