// Cash (Phase 2b): the money that should be in each drawer now (from the branch ledger), and the
// daily reconciliation of one branch — opening cash, sales by payment method, the day's drawer and bank
// movements line by line (they always add up to the ledger: anything without its own line is shown as
// "Other"), expected cash, the cash counted by the manager, and the difference.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Banknote, Calculator, Landmark } from 'lucide-react';
import { get, postOnce } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, humanize, money, todayKey } from '../../lib/format';
import { tk, useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { useBranches } from '../../lib/hooks';
import { useActionKeys } from '../../lib/idempotency';
import { Alert, Button, Card, CardHeader, Dialog, ErrorState, Field, Input, Kpi, KeyValue, Loading, Mono, PageHeader, Select } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';

interface Drawer {
  asOf: string;
  branches: { branchId: number; branchCode: string; branchName: string; branchNameAr: string; expectedCash: number; bank: number; fundsInTransit: number; hasadReceivable: number }[];
}
interface ByMethod {
  paymentMethod: string;
  amount: number;
}
interface ReconciliationLine {
  line: string;
  amount: number;
}
interface Reconciliation {
  branchId: number;
  day: string;
  openingCash: number;
  salesByMethod: ByMethod[];
  salesTotal: number;
  voidsByMethod: ByMethod[];
  voidsTotal: number;
  hasadReceivableToBank: number;
  scrapPurchasesCash: number;
  scrapPurchasesBank: number;
  makingChargesCash: number;
  makingChargesBank: number;
  cashLines: ReconciliationLine[];
  bankLines: ReconciliationLine[];
  cashMovement: number;
  bankMovement: number;
  expectedCash: number;
  counted: { amount: number; at: string; countedByName: string | null; note: string | null } | null;
  difference: number | null;
}

const signed = (n: number) => (n > 0 ? `+${money(n, false)}` : money(n, false));

// One label per reconciliation line (backend: RECONCILIATION_LINES in modules/ledger/service.ts).
const LINE_LABEL: Record<string, string> = {
  SALES: tk('Sales'),
  VOIDS: tk('Cancelled sales (refunds)'),
  SCRAP_PURCHASES: tk('Scrap bought from customers'),
  MAKING_CHARGES: tk('Supplier making charges'),
  HASAD_RECEIVABLE_SETTLEMENTS: tk('Hasad transfers received'),
  OTHER: tk('Other movements'),
};

export function CashPage() {
  const { t, L } = useI18n();
  const { me, isGlobal, can } = useAuth();
  const branches = useBranches();
  const [branchId, setBranchId] = useState<number | undefined>(me?.user.branch?.id ?? undefined);
  const [day, setDay] = useState(todayKey());
  const [settling, setSettling] = useState<Drawer['branches'][number] | null>(null);
  const drawer = useQuery({ queryKey: ['cash-drawer'], queryFn: () => get<Drawer>('/cash/drawer'), refetchInterval: 30_000 });
  const selected = branchId ?? (isGlobal ? undefined : me?.user.branch?.id);
  const rec = useQuery({
    queryKey: ['cash-reconciliation', selected, day],
    queryFn: () => get<Reconciliation>('/cash/reconciliation', { branchId: selected, day }),
    enabled: selected != null,
  });

  return (
    <div className="p-5 lg:p-6">
      <PageHeader title={t('Cash')} subtitle={t('Expected cash in each drawer, from the branch money ledger, and the daily cash reconciliation.')} />

      <Card padded={false} className="mb-5">
        <CardHeader title={t('Expected cash now')} subtitle={t('Every sale, cancellation, scrap purchase, supplier making charge and Hasad bank transfer moves these balances. Nothing is typed in by hand.')} />
        {drawer.isLoading ? (
          <Loading />
        ) : drawer.isError ? (
          <ErrorState error={drawer.error} onRetry={() => drawer.refetch()} />
        ) : (
          <DataTable
            rows={drawer.data!.branches}
            rowKey={(r) => r.branchId}
            exportName="expected-cash"
            emptyTitle={t('No branches')}
            columns={[
              { key: 'branchName', header: t('Branch'), render: (r) => L(r.branchName, r.branchNameAr) },
              { key: 'expectedCash', header: t('Cash drawer'), align: 'end', render: (r) => <span className="font-semibold num">{money(r.expectedCash, false)}</span>, footer: money(drawer.data!.branches.reduce((s, r) => s + r.expectedCash, 0), false) },
              { key: 'bank', header: t('Bank'), align: 'end', render: (r) => <span className="num">{money(r.bank, false)}</span>, footer: money(drawer.data!.branches.reduce((s, r) => s + r.bank, 0), false) },
              // Sales paid through Hasad are held here until Hasad's bank transfer is recorded (D-4-14).
              { key: 'hasadReceivable', header: t('Hasad receivable'), align: 'end', render: (r) => <span className="num">{money(r.hasadReceivable, false)}</span>, footer: money(drawer.data!.branches.reduce((s, r) => s + r.hasadReceivable, 0), false) },
              ...(can('cash.settle_hasad')
                ? [
                    {
                      key: 'settle',
                      header: '',
                      align: 'end' as const,
                      render: (r: Drawer['branches'][number]) =>
                        r.hasadReceivable > 0 ? (
                          <Button size="sm" icon={<ArrowRightLeft className="size-4" />} onClick={() => setSettling(r)} data-testid={`settle-hasad-${r.branchCode}`}>
                            {t('Settle Hasad receivable')}
                          </Button>
                        ) : null,
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Card>

      {settling && <HasadSettleDialog row={settling} onClose={() => setSettling(null)} />}
      {selected != null && <HasadTransfers branchId={selected} />}

      <Card padded={false}>
        <CardHeader
          title={t('Daily reconciliation')}
          subtitle={t('Opening cash + the day’s cash movements = expected cash. Count the drawer and record the amount to see the difference.')}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {isGlobal && (
                <Select value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : undefined)} className="h-8 w-44 text-[13px]" aria-label={t('Branch')}>
                  <option value="">{t('Select…')}</option>
                  {branches.data?.map((b) => <option key={b.id} value={b.id}>{L(b.name, b.nameAr)}</option>)}
                </Select>
              )}
              <Input type="date" value={day} max={todayKey()} onChange={(e) => setDay(e.target.value || todayKey())} className="h-8 w-40 text-[13px]" aria-label={t('Date')} />
            </div>
          }
        />
        <div className="p-5">
          {selected == null ? (
            <Alert tone="info">{t('Select a branch')}</Alert>
          ) : rec.isLoading ? (
            <Loading />
          ) : rec.isError ? (
            <ErrorState error={rec.error} onRetry={() => rec.refetch()} />
          ) : (
            <ReconciliationView r={rec.data!} canCount={can('cash.count')} />
          )}
        </div>
      </Card>
    </div>
  );
}

function ReconciliationView({ r, canCount }: { r: Reconciliation; canCount: boolean }) {
  const { t } = useI18n();
  const diffTone = r.difference == null ? 'default' : r.difference === 0 ? 'default' : 'gold';
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label={t('Opening cash')} value={money(r.openingCash, false)} icon={<Banknote className="size-4" />} />
        <Kpi label={t('Cash movements of the day')} value={signed(r.cashMovement)} icon={<Calculator className="size-4" />} />
        <Kpi label={t('Expected cash')} value={money(r.expectedCash, false)} tone="dark" icon={<Landmark className="size-4" />} />
        <Kpi
          label={t('Counted cash')}
          value={r.counted ? money(r.counted.amount, false) : '—'}
          tone={diffTone}
          sub={r.difference == null ? t('Not counted yet') : r.difference === 0 ? t('Matches the expected cash') : t('Difference: {amount}', { amount: signed(r.difference) })}
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-[13px] font-semibold text-ink-700">{t('Sales by payment method')}</h3>
          <KeyValue
            items={[
              ...r.salesByMethod.map((m) => ({ label: humanize(m.paymentMethod), value: <span className="num">{money(m.amount, false)}</span> })),
              { label: t('Cancelled sales (refunds)'), value: <span className="num">{signed(r.voidsTotal)}</span> },
            ]}
          />
        </div>
        <div className="grid gap-5">
          <LinesView title={t('Drawer (cash) movements')} lines={r.cashLines} total={r.cashMovement} testId="cash-lines" />
          <LinesView title={t('Bank movements')} lines={r.bankLines} total={r.bankMovement} testId="bank-lines" />
        </div>
      </div>

      {r.counted && (
        <p className="mt-4 text-[12.5px] text-ink-500">
          {t('Last count by {name}', { name: r.counted.countedByName ?? '—' })}
          {r.counted.note ? ` · ${r.counted.note}` : ''}
        </p>
      )}
      {canCount && <CountForm r={r} />}
    </>
  );
}

/** Lines of one account for the day; their sum is the account's movement in the ledger (SPEC §18). */
function LinesView({ title, lines, total, testId }: { title: string; lines: ReconciliationLine[]; total: number; testId: string }) {
  const { t } = useI18n();
  return (
    <div data-testid={testId}>
      <h3 className="mb-2 text-[13px] font-semibold text-ink-700">{title}</h3>
      <KeyValue
        items={[
          ...lines.map((l) => ({ label: t(LINE_LABEL[l.line] ?? l.line), value: <span className="num">{signed(l.amount)}</span> })),
          { label: <strong>{t('Total of the day')}</strong>, value: <strong className="num">{signed(total)}</strong> },
        ]}
      />
    </div>
  );
}

function CountForm({ r }: { r: Reconciliation }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const actionKeys = useActionKeys();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const scope = `count:${r.branchId}:${r.day}`;
  const m = useMutation({
    mutationFn: () => postOnce('/cash/counts', { branchId: r.branchId, day: r.day, countedAmount: Number(amount), note: note.trim() || undefined }, actionKeys.for(scope)),
    onSuccess: () => {
      actionKeys.rotate(scope);
      toast.success(t('Cash count recorded'), t('Recorded in the audit log.'));
      setAmount('');
      setNote('');
      qc.invalidateQueries({ queryKey: ['cash-reconciliation'] });
    },
    onError: (e) => toast.fromError(e),
  });
  const valid = amount !== '' && Number.isInteger(Number(amount)) && Number(amount) >= 0;
  return (
    <div className="mt-5 grid gap-3 border-t border-line pt-4 sm:grid-cols-[200px_1fr_auto] sm:items-end">
      <Field label={t('Counted cash')}>
        <Input type="number" min={0} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} className="num" />
      </Field>
      <Field label={t('Note (optional)')}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
      <Button variant="primary" disabled={!valid} loading={m.isPending} onClick={() => m.mutate()}>
        {t('Record count')}
      </Button>
    </div>
  );
}

/**
 * Hasad pays the branch by bank transfer: record the amount received; it moves from the Hasad
 * receivable to the bank in one transaction. Partial amounts are fine, never above the receivable.
 */
function HasadSettleDialog({ row, onClose }: { row: Drawer['branches'][number]; onClose: () => void }) {
  const { t, L } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const actionKeys = useActionKeys();
  const [amount, setAmount] = useState('');
  const [bankRef, setBankRef] = useState('');
  const [note, setNote] = useState('');
  const scope = `hasad-settle:${row.branchId}`;
  const value = Number(amount);
  const valid = amount !== '' && Number.isInteger(value) && value > 0 && value <= row.hasadReceivable;
  const m = useMutation({
    mutationFn: () =>
      postOnce<{ number: string; hasadReceivableBalance: number }>(
        '/cash/hasad-settlements',
        { branchId: row.branchId, amount: value, bankReference: bankRef.trim() || undefined, note: note.trim() || undefined },
        actionKeys.for(scope),
      ),
    onSuccess: (r) => {
      actionKeys.rotate(scope);
      toast.success(t('Hasad transfer {number} recorded', { number: r.number }), t('Hasad receivable left: {amount}', { amount: money(r.hasadReceivableBalance) }));
      qc.invalidateQueries({ queryKey: ['cash-drawer'] });
      qc.invalidateQueries({ queryKey: ['cash-reconciliation'] });
      qc.invalidateQueries({ queryKey: ['hasad-transfers'] });
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Settle Hasad receivable · {branch}', { branch: L(row.branchName, row.branchNameAr) })}
      subtitle={t('Hasad paid by bank transfer: the amount received moves from the Hasad receivable to the bank.')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!valid} loading={m.isPending} onClick={() => m.mutate()} data-testid="hasad-settle-submit">{t('Record transfer')}</Button>
        </>
      }
    >
      <KeyValue items={[{ label: t('Hasad receivable now'), value: <span className="font-semibold num">{money(row.hasadReceivable)}</span> }]} />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label={t('Amount received by bank transfer')} hint={amount !== '' && value > row.hasadReceivable ? t('More than the Hasad receivable') : undefined}>
          <Input type="number" min={1} max={row.hasadReceivable} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} className="num" />
        </Field>
        <Field label={t('Bank reference (optional)')}>
          <Input value={bankRef} onChange={(e) => setBankRef(e.target.value)} maxLength={80} />
        </Field>
        <Field label={t('Note (optional)')} className="sm:col-span-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Dialog>
  );
}

interface HasadTransfer {
  id: number;
  number: string;
  amount: number;
  bankReference: string | null;
  note: string | null;
  at: string;
  createdByName: string;
}

function HasadTransfers({ branchId }: { branchId: number }) {
  const { t, lang } = useI18n();
  const q = useQuery({ queryKey: ['hasad-transfers', branchId], queryFn: () => get<HasadTransfer[]>('/cash/hasad-settlements', { branchId }) });
  if (!q.data?.length) return null;
  return (
    <Card padded={false} className="mb-5">
      <CardHeader title={t('Hasad bank transfers received')} />
      <DataTable
        rows={q.data}
        rowKey={(r) => r.id}
        exportName="hasad-transfers"
        emptyTitle={t('No transfers yet')}
        columns={[
          { key: 'number', header: t('Number'), render: (r) => <Mono className="font-semibold">{r.number}</Mono> },
          { key: 'at', header: t('Date'), render: (r) => dateTime(r.at, lang) },
          { key: 'amount', header: t('Amount'), align: 'end', render: (r) => <span className="num">{money(r.amount, false)}</span> },
          { key: 'bankReference', header: t('Bank reference'), render: (r) => r.bankReference ?? '—' },
          { key: 'createdByName', header: t('Recorded by') },
          { key: 'note', header: t('Note'), render: (r) => r.note ?? '—' },
        ]}
      />
    </Card>
  );
}
