import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, X } from 'lucide-react';
import { EXPENSE_CATEGORIES } from '@jerp/shared';
import { get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, humanize, money, todayKey } from '../../lib/format';
import { useBranches } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { Alert, Button, Card, Dialog, ErrorState, Field, Input, Loading, Mono, PageHeader, Select, StatusBadge, Textarea } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';
import { BranchSelect, DateRange, useRangeParams } from '../../components/Filters';

interface ExpenseRow {
  id: number;
  number: string;
  branchId: number;
  branchName: string;
  category: string;
  amount: number;
  expenseDate: string;
  description: string;
  status: string;
  createdByName: string;
  reviewNote: string | null;
}

export function ExpensesTable({ branchId, from, to, toolbar, status }: { branchId?: number; from: string; to: string; toolbar?: React.ReactNode; status?: string }) {
  const { t, lang } = useI18n();
  const { can, isGlobal } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['expenses', branchId, from, to, status], queryFn: () => get<ExpenseRow[]>('/expenses', { branchId, from, to, status }) });
  const review = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: 'APPROVED' | 'REJECTED' }) => post(`/expenses/${id}/review`, { decision }),
    onSuccess: (_d, v) => {
      toast.success(`Expense ${v.decision.toLowerCase()}`);
      qc.invalidateQueries();
    },
    onError: (e) => toast.fromError(e),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rows = q.data!;
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.id}
      exportName="expenses"
      toolbar={toolbar}
      emptyTitle="No expenses in this period"
      columns={[
        { key: 'number', header: 'Expense', render: (r) => <Mono className="text-ink-900">{r.number}</Mono> },
        { key: 'expenseDate', header: t('Date'), render: (r) => date(r.expenseDate, lang) },
        ...(isGlobal && !branchId ? [{ key: 'branchName', header: t('Branch') }] : []),
        { key: 'category', header: t('Category'), render: (r) => humanize(r.category) },
        { key: 'description', header: t('Description'), className: 'max-w-[320px] truncate' },
        { key: 'amount', header: t('Amount'), align: 'end', render: (r) => <span className="font-medium num">{money(r.amount, false)}</span>, footer: money(rows.filter((r) => r.status === 'APPROVED').reduce((s, r) => s + r.amount, 0), false) },
        { key: 'createdByName', header: 'Created by' },
        {
          key: 'status',
          header: t('Status'),
          render: (r) =>
            r.status === 'PENDING' && can('expenses.approve') ? (
              <div className="flex items-center gap-1">
                <StatusBadge status="PENDING" />
                <Button size="sm" variant="ghost" className="h-7 px-2 text-emerald-700" onClick={() => review.mutate({ id: r.id, decision: 'APPROVED' })} aria-label="Approve"><Check className="size-4" /></Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-rose-700" onClick={() => review.mutate({ id: r.id, decision: 'REJECTED' })} aria-label="Reject"><X className="size-4" /></Button>
              </div>
            ) : (
              <StatusBadge status={r.status} />
            ),
        },
      ]}
    />
  );
}

export function ExpensesPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const { from, to, branchId, set } = useRangeParams(30);
  const [status, setStatus] = useState(sp.get('status') ?? '');
  const [open, setOpen] = useState(false);
  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={t('Expenses')}
        subtitle="Branch operating expenses. Approved expenses reduce branch contribution in all reports."
        actions={can('expenses.create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>New expense</Button>}
      />
      <Card padded={false}>
        <ExpensesTable
          branchId={branchId}
          from={status === 'PENDING' ? '2000-01-01' : from}
          to={to}
          status={status || undefined}
          toolbar={
            <>
              <DateRange from={from} to={to} onChange={(r) => set(r)} />
              <BranchSelect value={branchId} onChange={(v) => set({ branchId: v })} />
              <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-36 text-[13px]" aria-label={t('Status')}>
                <option value="">All statuses</option>
                {['APPROVED', 'PENDING', 'REJECTED'].map((s) => <option key={s} value={s}>{t(s)}</option>)}
              </Select>
            </>
          }
        />
      </Card>
      {open && <NewExpenseDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function NewExpenseDialog({ onClose }: { onClose: () => void }) {
  const { me, isGlobal, can } = useAuth();
  const { L } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const branches = useBranches();
  const [f, setF] = useState({ branchId: me?.user.branch?.id ?? ('' as number | ''), category: 'OTHER', amount: '', expenseDate: todayKey(), description: '' });
  const m = useMutation({
    mutationFn: () => post<{ number: string; status: string }>('/expenses', { ...f, branchId: f.branchId || undefined, amount: Number(f.amount) }),
    onSuccess: (e) => {
      toast.success(`Expense ${e.number} recorded`, e.status === 'PENDING' ? 'Above the approval threshold: waiting for General Manager approval.' : undefined);
      qc.invalidateQueries();
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="New expense"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!Number(f.amount) || f.description.trim().length < 2 || (isGlobal && !f.branchId)} onClick={() => m.mutate()}>Save expense</Button></>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {isGlobal && (
          <Field label="Branch" className="sm:col-span-2">
            <Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value ? Number(e.target.value) : '' })}>
              <option value="">Select…</option>
              {branches.data?.map((b) => <option key={b.id} value={b.id}>{L(b.name, b.nameAr)}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Category">
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
          </Select>
        </Field>
        <Field label="Date">
          <Input type="date" value={f.expenseDate} max={todayKey()} onChange={(e) => setF({ ...f, expenseDate: e.target.value })} />
        </Field>
        <Field label="Amount (SDG)" className="sm:col-span-2">
          <Input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className="num" />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
      </div>
      {!can('expenses.approve') && <Alert tone="info" className="mt-3">Expenses above the approval threshold are sent to the General Manager for approval.</Alert>}
    </Dialog>
  );
}
