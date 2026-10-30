// MNY-1 (docs/plans/MNY-1.md §7): money between branches and to the General Manager. A branch manager sends money
// from the drawer or the bank, confirms what comes to the branch (choosing the drawer or the bank), and cancels what
// the branch sent while it is on the way. The General Manager sees every transfer, read only, and confirms only the
// ones addressed to him (he records nothing). No step asks for the password again (owner, decision 7); every write
// carries an Idempotency-Key. A wrong amount: cancel, then send the right amount (owner's procedure).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { validBankReference } from '@jerp/shared';
import { get, postOnce } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, money } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { useBranchDirectory, useBranches } from '../../lib/hooks';
import { useActionKeys } from '../../lib/idempotency';
import { Badge, Button, Card, CardHeader, Dialog, Field, MoneyInput, Mono, PageHeader, PillGroup, ReferenceInput, Select, Textarea, type Tone } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';

type Account = 'CASH' | 'BANK';
type Status = 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED';
export interface MoneyTransfer {
  id: number;
  number: string;
  fromBranchId: number;
  fromBranchName: string;
  fromBranchNameAr: string;
  toKind: 'BRANCH' | 'GM';
  toBranchId: number | null;
  toBranchName: string | null;
  toBranchNameAr: string | null;
  sourceAccount: Account;
  amount: number;
  reason: string;
  bankReference: string | null;
  status: Status;
  createdAt: string;
  createdByName: string;
  closedAt: string | null;
  closedByName: string | null;
  landedAccount: Account | null;
  landedBankReference: string | null;
  cancelReason: string | null;
}
interface Page {
  rows: MoneyTransfer[];
  total: number;
  totals: { count: number; amount: number; inTransit: number };
}

/** A money amount or a reference isolated left-to-right inside Arabic text. */
const ltr = (s: string) => `⁦${s}⁩`;
const TONE: Record<Status, Tone> = { IN_TRANSIT: 'warn', RECEIVED: 'ok', CANCELLED: 'crit' };

const listOf = (q: Record<string, string | number | undefined>) => get<Page>('/money-transfers', { pageSize: 200, ...q });

export function MoneyTransfersPage() {
  const { t, L, lang } = useI18n();
  const { me, isGlobal, can } = useAuth();
  const branches = useBranches();
  const [historyBranch, setHistoryBranch] = useState<number | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState<MoneyTransfer | null>(null);
  const [cancelling, setCancelling] = useState<MoneyTransfer | null>(null);
  const sends = can('money_transfers.send');
  const receives = can('money_transfers.receive');
  const incoming = useQuery({ queryKey: ['money-transfers', 'in'], queryFn: () => listOf({ direction: 'IN', status: 'IN_TRANSIT' }), enabled: receives });
  const outgoing = useQuery({ queryKey: ['money-transfers', 'out'], queryFn: () => listOf({ direction: 'OUT', status: 'IN_TRANSIT' }), enabled: sends });
  const history = useQuery({ queryKey: ['money-transfers', 'all', historyBranch ?? 'all'], queryFn: () => listOf({ branchId: historyBranch }) });

  const from = (r: MoneyTransfer) => L(r.fromBranchName, r.fromBranchNameAr);
  const to = (r: MoneyTransfer) => (r.toKind === 'GM' ? t('The General Manager') : L(r.toBranchName ?? '', r.toBranchNameAr ?? ''));
  const account = (a: Account | null) => (a === 'CASH' ? t('Drawer') : a === 'BANK' ? t('Bank') : '—');
  const statusLabel = (s: Status) => (s === 'IN_TRANSIT' ? t('On the way') : s === 'RECEIVED' ? t('Received') : t('Cancelled'));
  const amount = (r: MoneyTransfer) => <span className="font-semibold num">{money(r.amount, false)}</span>;
  const base = [
    { key: 'number', header: t('Number'), render: (r: MoneyTransfer) => <Mono className="font-semibold">{r.number}</Mono> },
    { key: 'createdAt', header: t('Sent'), value: (r: MoneyTransfer) => dateTime(r.createdAt, lang), render: (r: MoneyTransfer) => dateTime(r.createdAt, lang) },
  ];

  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={t('Money transfers')}
        subtitle={isGlobal ? t('Money between the branches and to you. You see every transfer; you confirm only the ones sent to you.') : t('Money your branch sends and receives.')}
        help={t('Wrong amount? Cancel the transfer while it is on the way, then send the right amount.')}
        actions={
          sends ? (
            <Button variant="primary" icon={<Send className="size-4" />} onClick={() => setSending(true)} data-testid="mt-send">
              {t('Send money')}
            </Button>
          ) : undefined
        }
      />

      {receives && (
        <Card padded={false} className="mb-5">
          <div data-testid="mt-incoming">
            <CardHeader title={t('Waiting for you')} subtitle={isGlobal ? t('Money a branch handed to you. Confirm when you have it.') : t('Confirm when the money is in your drawer or your bank.')} />
            <DataTable
              query={incoming}
              rows={incoming.data?.rows ?? []}
              rowKey={(r) => r.id}
              searchable={false}
              emptyTitle={t('Nothing waiting for you')}
              columns={[
                ...base,
                { key: 'from', header: t('From'), value: from, render: from },
                { key: 'amount', header: t('Amount'), align: 'end', render: amount },
                { key: 'reason', header: t('Reason'), render: (r) => <span className="whitespace-pre-wrap">{r.reason}</span> },
                { key: 'createdByName', header: t('Sent by') },
                {
                  key: 'confirm',
                  header: '',
                  align: 'end',
                  render: (r) => (
                    <Button size="sm" variant="primary" onClick={() => setConfirming(r)} data-testid={`mt-confirm-${r.number}`}>
                      {t('Confirm')}
                    </Button>
                  ),
                },
              ]}
            />
          </div>
        </Card>
      )}

      {sends && (
        <Card padded={false} className="mb-5">
          <div data-testid="mt-outgoing">
            <CardHeader title={t('Sent, not yet received')} subtitle={t('You can cancel a transfer until it is confirmed; the money goes back where it came from.')} />
            <DataTable
              query={outgoing}
              rows={outgoing.data?.rows ?? []}
              rowKey={(r) => r.id}
              searchable={false}
              emptyTitle={t('Nothing on the way')}
              columns={[
                ...base,
                { key: 'to', header: t('To'), value: to, render: to },
                { key: 'sourceAccount', header: t('From'), value: (r) => account(r.sourceAccount), render: (r) => account(r.sourceAccount) },
                { key: 'amount', header: t('Amount'), align: 'end', render: amount },
                { key: 'reason', header: t('Reason'), render: (r) => <span className="whitespace-pre-wrap">{r.reason}</span> },
                {
                  key: 'cancel',
                  header: '',
                  align: 'end',
                  render: (r) => (
                    <Button size="sm" variant="ghost" onClick={() => setCancelling(r)} data-testid={`mt-cancel-${r.number}`}>
                      {t('Cancel transfer')}
                    </Button>
                  ),
                },
              ]}
            />
          </div>
        </Card>
      )}

      <Card padded={false}>
        <div data-testid="mt-history">
          <CardHeader
            title={t('History')}
            subtitle={history.data ? t('{count} transfer(s) · on the way now: {amount}', { count: history.data.totals.count, amount: ltr(money(history.data.totals.inTransit)) }) : undefined}
            actions={
              isGlobal ? (
                <Select value={historyBranch ?? ''} onChange={(e) => setHistoryBranch(e.target.value ? Number(e.target.value) : undefined)} className="h-8 w-44 text-[13px]" aria-label={t('Branch')} data-testid="mt-history-branch">
                  <option value="">{t('All branches')}</option>
                  {branches.data?.map((b) => <option key={b.id} value={b.id}>{L(b.name, b.nameAr)}</option>)}
                </Select>
              ) : undefined
            }
          />
          <DataTable
            query={history}
            rows={history.data?.rows ?? []}
            rowKey={(r) => r.id}
            exportName="money-transfers"
            emptyTitle={t('No money transfers yet')}
            columns={[
              ...base,
              { key: 'from', header: t('From'), value: from, render: (r) => <span>{from(r)} · {account(r.sourceAccount)}</span> },
              { key: 'to', header: t('To'), value: to, render: (r) => <span>{to(r)}{r.landedAccount ? <> · {account(r.landedAccount)}</> : null}</span> },
              { key: 'amount', header: t('Amount'), align: 'end', render: amount },
              { key: 'reason', header: t('Reason'), render: (r) => <span className="whitespace-pre-wrap">{r.reason}</span> },
              {
                key: 'status',
                header: t('Status'),
                value: (r) => statusLabel(r.status),
                render: (r) => (
                  <span className="block" data-testid={`mt-status-${r.number}`}>
                    <Badge tone={TONE[r.status]}>{statusLabel(r.status)}</Badge>
                    {r.closedAt && (
                      <span className="mt-0.5 block text-meta text-ink-3">
                        {r.status === 'CANCELLED' ? t('Cancelled by {name}', { name: r.closedByName ?? '—' }) : t('Confirmed by {name}', { name: r.closedByName ?? '—' })} · {dateTime(r.closedAt, lang)}
                      </span>
                    )}
                    {r.cancelReason && <span className="block whitespace-pre-wrap text-meta text-ink-2">{t('Why: {reason}', { reason: r.cancelReason })}</span>}
                  </span>
                ),
              },
              {
                key: 'references',
                header: t('Reference'),
                value: (r) => [r.bankReference, r.landedBankReference].filter(Boolean).join(' · '),
                render: (r) => <span className="font-mono text-[12.5px]">{[r.bankReference, r.landedBankReference].filter(Boolean).map((x) => ltr(x!)).join(' · ') || '—'}</span>,
              },
              { key: 'createdByName', header: t('Sent by') },
            ]}
          />
        </div>
      </Card>

      {sending && me?.user.branch && <SendDialog fromBranchId={me.user.branch.id} onClose={() => setSending(false)} />}
      {confirming && <ConfirmDialog transfer={confirming} toGm={confirming.toKind === 'GM'} from={from(confirming)} onClose={() => setConfirming(null)} />}
      {cancelling && <CancelDialog transfer={cancelling} to={to(cancelling)} onClose={() => setCancelling(null)} />}
    </div>
  );
}

function useDone() {
  const qc = useQueryClient();
  return () => {
    for (const key of ['money-transfers', 'cash-drawer', 'cash-reconciliation', 'attention']) qc.invalidateQueries({ queryKey: [key] });
  };
}

function SendDialog({ fromBranchId, onClose }: { fromBranchId: number; onClose: () => void }) {
  const { t, L } = useI18n();
  const toast = useToast();
  const done = useDone();
  const directory = useBranchDirectory();
  const actionKeys = useActionKeys();
  const [target, setTarget] = useState('');
  const [account, setAccount] = useState<Account>('CASH');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [bankRef, setBankRef] = useState('');
  const value = Number(amount);
  const amountOk = amount !== '' && Number.isInteger(value) && value > 0;
  const refOk = account === 'CASH' || !!validBankReference(bankRef);
  const reasonOk = reason.trim().length >= 3;
  const valid = target !== '' && amountOk && refOk && reasonOk;
  const scope = `money-transfer:${target}`;
  const m = useMutation({
    mutationFn: () =>
      postOnce<MoneyTransfer>(
        '/money-transfers',
        { to: target === 'GM' ? { generalManager: true } : { branchId: Number(target) }, account, amount: value, reason: reason.trim(), bankReference: account === 'BANK' ? bankRef.trim() : undefined },
        actionKeys.for(scope),
      ),
    onSuccess: (r) => {
      actionKeys.rotate(scope);
      toast.success(t('Transfer {number} sent', { number: r.number }), t('The money is on the way until the receiver confirms it.'));
      done();
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Send money')}
      subtitle={t('The money leaves your drawer or bank now and is on the way until the receiver confirms it.')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!valid} loading={m.isPending} onClick={() => m.mutate()} data-testid="mt-send-submit">
            {t('Send')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('To')}>
          <Select value={target} onChange={(e) => setTarget(e.target.value)} data-testid="mt-send-to">
            <option value="">{t('Select…')}</option>
            <option value="GM">{t('The General Manager')}</option>
            {directory.data
              ?.filter((b) => b.id !== fromBranchId && b.isActive !== false)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {L(b.name, b.nameAr)}
                </option>
              ))}
          </Select>
        </Field>
        <div data-testid="mt-send-account">
          <span className="mb-1.5 block text-meta font-medium text-ink-2">{t('From')}</span>
          <PillGroup<Account>
            label={t('From')}
            value={account}
            onChange={setAccount}
            options={[
              { value: 'CASH', label: t('Drawer') },
              { value: 'BANK', label: t('Bank') },
            ]}
          />
        </div>
        <Field label={t('Amount')}>
          <MoneyInput value={amount} onValueChange={setAmount} min={1} data-testid="mt-send-amount" />
        </Field>
        {account === 'BANK' && (
          <Field label={t('Bank transfer reference')} hint={bankRef && !refOk ? t('4 to 40 letters or digits') : undefined}>
            <ReferenceInput value={bankRef} onValueChange={setBankRef} data-testid="mt-send-bank-ref" />
          </Field>
        )}
        <Field label={t('Reason')} className="sm:col-span-2">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} data-testid="mt-send-reason" />
        </Field>
      </div>
    </Dialog>
  );
}

function ConfirmDialog({ transfer, toGm, from, onClose }: { transfer: MoneyTransfer; toGm: boolean; from: string; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const done = useDone();
  const actionKeys = useActionKeys();
  const [account, setAccount] = useState<Account>('CASH');
  const [bankRef, setBankRef] = useState('');
  const refOk = toGm || account === 'CASH' || !!validBankReference(bankRef);
  const scope = `money-transfer-confirm:${transfer.id}`;
  const m = useMutation({
    mutationFn: () =>
      postOnce<MoneyTransfer>(`/money-transfers/${transfer.id}/confirm`, toGm ? {} : { account, bankReference: account === 'BANK' ? bankRef.trim() : undefined }, actionKeys.for(scope)),
    onSuccess: (r) => {
      actionKeys.rotate(scope);
      toast.success(t('Transfer {number} confirmed', { number: r.number }));
      done();
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Confirm {number}', { number: transfer.number })}
      subtitle={toGm ? t('Confirm that you received this money. Nothing else is recorded.') : t('Where is the money now? It is added to your drawer or your bank.')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!refOk} loading={m.isPending} onClick={() => m.mutate()} data-testid="mt-confirm-submit">
            {t('Confirm receipt')}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-ink-2">
        {from} · <span className="num">{ltr(money(transfer.amount))}</span> · {transfer.reason}
      </p>
      {!toGm && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div data-testid="mt-confirm-account">
            <span className="mb-1.5 block text-meta font-medium text-ink-2">{t('Into')}</span>
            <PillGroup<Account>
              label={t('Into')}
              value={account}
              onChange={setAccount}
              options={[
                { value: 'CASH', label: t('Drawer') },
                { value: 'BANK', label: t('Bank') },
              ]}
            />
          </div>
          {account === 'BANK' && (
            <Field label={t('Bank transfer reference')} hint={bankRef && !refOk ? t('4 to 40 letters or digits') : undefined}>
              <ReferenceInput value={bankRef} onValueChange={setBankRef} data-testid="mt-confirm-bank-ref" />
            </Field>
          )}
        </div>
      )}
    </Dialog>
  );
}

function CancelDialog({ transfer, to, onClose }: { transfer: MoneyTransfer; to: string; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const done = useDone();
  const actionKeys = useActionKeys();
  const [reason, setReason] = useState('');
  const scope = `money-transfer-cancel:${transfer.id}`;
  const m = useMutation({
    mutationFn: () => postOnce<MoneyTransfer>(`/money-transfers/${transfer.id}/cancel`, { reason: reason.trim() }, actionKeys.for(scope)),
    onSuccess: (r) => {
      actionKeys.rotate(scope);
      toast.success(t('Transfer {number} cancelled', { number: r.number }), t('The money is back where it came from.'));
      done();
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Cancel {number}', { number: transfer.number })}
      subtitle={t('The money goes back to your drawer or bank. Wrong amount? Send the right amount afterwards.')}
      footer={
        <>
          <Button onClick={onClose}>{t('Keep it')}</Button>
          <Button variant="danger-solid" disabled={reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate()} data-testid="mt-cancel-submit">
            {t('Cancel transfer')}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-ink-2">
        {to} · <span className="num">{ltr(money(transfer.amount))}</span>
      </p>
      <Field label={t('Reason')}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} data-testid="mt-cancel-reason" />
      </Field>
    </Dialog>
  );
}
