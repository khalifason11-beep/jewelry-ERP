import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, Coins, Gem, Receipt, ScaleIcon, Truck, TrendingUp, Wallet, AlertTriangle } from 'lucide-react';
import { get } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date as formatDate, dateTime, grams, humanize, money, num, relative, todayKey } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { Card, CardHeader, Empty, ErrorState, Input, Kpi, Loading, Mono, PageHeader, StatusBadge } from '../../components/ui';
import { MoneyLineChart } from '../../components/charts';

interface MovementLine {
  items: number;
  weightMg: number;
}
export interface BranchDash {
  branchId: number;
  date: string;
  kpis: {
    salesTotal: number;
    salesCount: number;
    itemsSold: number;
    purchasesCost: number;
    purchasesCount: number;
    expenses: number;
    pendingExpenses: number;
    grossProfit: number | null;
    contribution: number | null;
    availableItems: number;
    availableWeightMg: number;
    reservedItems: number;
    inventoryCost: number | null;
    hasadCompleted: number;
    hasadOpen: number;
  };
  mtd: { revenue: number; grossProfit: number | null; expenses: number; contribution: number | null; salesCount: number; hasadCompleted: number };
  movement: {
    opening: { items: number; weightMg: number; cost: number };
    lines: Record<string, MovementLine>;
    closing: { items: number; weightMg: number; cost: number };
    actual?: { items: number; weightMg: number };
  };
  hasad: {
    newRequests: number;
    waiting: number;
    inProgress: number;
    completedToday: number;
    cancelled: number;
    weightDeliveredMg: number;
    paidToCustomers: number;
    collectedFromCustomers: number;
    queue: { id: number; externalId: string; customerName: string; entitledWeightMg: number; status: string; requestedAt: string }[];
  };
  trend: { day: string; sales: number; revenue: number; profit: number | null }[];
  expenses: {
    recent: { id: number; number: string; category: string; amount: number; expenseDate: string; description: string; status: string; createdBy: string }[];
    byCategory: { category: string; amount: number }[];
  };
  cashiers: {
    userId: number;
    fullName: string;
    username: string;
    role: string;
    salesCount: number;
    salesTotal: number;
    hasadCount: number;
    voided: number;
    lastActivity: string | null;
    liveSessions: number;
    firstLogin: string | null;
  }[];
}

export function BranchDashboardPage() {
  const { me } = useAuth();
  const { t, L } = useI18n();
  return (
    <div className="p-5 lg:p-6">
      <BranchDashboard branchId={me?.user.branch?.id} title={`${L(me?.user.branch?.name, me?.user.branch?.nameAr)} · ${t('Dashboard')}`} />
    </div>
  );
}

export function BranchDashboard({ branchId, title, embedded }: { branchId?: number; title?: string; embedded?: boolean }) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [date, setDate] = useState(todayKey());
  const q = useQuery({
    queryKey: ['dashboard', 'branch', branchId, date],
    queryFn: () => get<BranchDash>('/dashboard/branch', { branchId, date }),
    refetchInterval: 30_000,
  });
  const isToday = date === todayKey();
  const dayLabel = isToday ? t('Today') : formatDate(date, lang);

  const header = (
    <PageHeader
      title={title ?? t('Dashboard')}
      subtitle={t('Operational view for {day}. All figures are calculated from transactions and the inventory ledger.', { day: isToday ? t('today') : formatDate(date, lang) })}
      actions={<Input type="date" value={date} max={todayKey()} onChange={(e) => e.target.value && setDate(e.target.value)} className="w-40" aria-label={t('Business date')} />}
    />
  );

  if (q.isLoading) return <>{!embedded && header}<Loading /></>;
  if (q.isError) return <>{!embedded && header}<ErrorState error={q.error} onRetry={() => q.refetch()} /></>;
  const d = q.data!;
  const k = d.kpis;

  return (
    <div className="space-y-5">
      {embedded ? <div className="flex justify-end"><Input type="date" value={date} max={todayKey()} onChange={(e) => e.target.value && setDate(e.target.value)} className="w-40" aria-label={t('Business date')} /></div> : header}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi tone="dark" label={`${dayLabel} · ${t('Sales')}`} value={money(k.salesTotal, false)} sub={t('{invoices} invoices · {pieces} pieces · {currency}', { invoices: k.salesCount, pieces: k.itemsSold, currency: t('SDG') })} icon={<Receipt className="size-4" />} onClick={() => navigate(`/reports/sales?from=${date}&to=${date}&branchId=${d.branchId}`)} />
        <Kpi label={`${dayLabel} · ${t('Purchases')}`} value={money(k.purchasesCost, false)} sub={t('{n} receipts · {currency}', { n: k.purchasesCount, currency: t('SDG') })} icon={<Truck className="size-4" />} onClick={() => navigate(`/reports/purchases?from=${date}&to=${date}&branchId=${d.branchId}`)} />
        <Kpi label={`${dayLabel} · ${t('Expenses')}`} value={money(k.expenses, false)} sub={k.pendingExpenses ? t('+ {amount} pending approval', { amount: money(k.pendingExpenses) }) : t('Approved · {currency}', { currency: t('SDG') })} icon={<Wallet className="size-4" />} onClick={() => navigate(`/reports/expenses?from=${date}&to=${date}&branchId=${d.branchId}`)} />
        <Kpi tone="gold" label={t('Gross Profit')} value={k.grossProfit != null ? money(k.grossProfit, false) : '—'} sub={k.contribution != null ? t('Contribution {amount}', { amount: money(k.contribution) }) : undefined} icon={<TrendingUp className="size-4" />} />
        <Kpi label={t('Available Inventory')} value={t('{n} pcs', { n: num(k.availableItems) })} sub={`${grams(k.availableWeightMg)}${k.reservedItems ? ` · ${t('{n} reserved', { n: k.reservedItems })}` : ''}`} icon={<Gem className="size-4" />} onClick={() => navigate(`/inventory?branchId=${d.branchId}`)} />
        <Kpi label={t('Hasad Withdrawals')} value={t('{n} done', { n: k.hasadCompleted })} sub={t('{n} open request(s)', { n: k.hasadOpen })} icon={<Coins className="size-4" />} onClick={() => navigate('/hasad')} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.15fr_1fr]">
        <MovementCard d={d} isToday={isToday} />
        <HasadCard d={d} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <Card padded={false}>
          <CardHeader
            title={t('Sales: last 14 days')}
            subtitle={`${t('Month to date: {amount} · {n} invoices', { amount: money(d.mtd.revenue), n: d.mtd.salesCount })}${d.mtd.contribution != null ? ` · ${t('contribution {amount}', { amount: money(d.mtd.contribution) })}` : ''}`}
          />
          <div className="px-3 pb-3 pt-2">
            <MoneyLineChart
              data={d.trend}
              series={[
                { key: 'revenue', label: t('Revenue'), color: 'var(--color-ink-800)' },
                ...(d.trend[0]?.profit != null ? [{ key: 'profit', label: t('Gross profit'), color: 'var(--color-gold-500)' }] : []),
              ]}
            />
          </div>
        </Card>
        <Card padded={false}>
          <CardHeader
            title={`${t('Expenses')} · ${t('month to date')}`}
            subtitle={t('Approved total {amount}', { amount: money(d.mtd.expenses) })}
            actions={<Link to="/expenses" className="text-[13px] font-medium text-gold-700 hover:underline">{t('All expenses')}</Link>}
          />
          {d.expenses.recent.length === 0 ? (
            <Empty title={t('No expenses this month')} />
          ) : (
            <ul className="divide-y divide-line">
              {d.expenses.recent.slice(0, 7).map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ink-800">{e.description}</div>
                    <div className="text-[11.5px] text-ink-500">
                      {humanize(e.category)} · {formatDate(e.expenseDate, lang)} · {e.createdBy}
                    </div>
                  </div>
                  {e.status !== 'APPROVED' && <StatusBadge status={e.status} />}
                  <span className="font-medium num">{money(e.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card padded={false}>
        <CardHeader
          title={t('Cashier activity')}
          subtitle={t('{day}: sales, Hasad deliveries and sessions per team member', { day: dayLabel })}
          actions={<Link to="/sessions" className="text-[13px] font-medium text-gold-700 hover:underline">{t('Active Sessions')}</Link>}
        />
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-[#f7f8fa] text-ink-500">
              <tr>
                <th className="px-5 py-2 text-start font-medium">{t('User')}</th>
                <th className="px-3 py-2 text-end font-medium">{t('Invoices')}</th>
                <th className="px-3 py-2 text-end font-medium">{t('Sales value')}</th>
                <th className="px-3 py-2 text-end font-medium">{t('Hasad')}</th>
                <th className="px-3 py-2 text-end font-medium">{t('Cancelled')}</th>
                <th className="px-3 py-2 text-start font-medium">{t('First sign-in')}</th>
                <th className="px-3 py-2 text-start font-medium">{t('Last activity')}</th>
                <th className="px-5 py-2 text-start font-medium">{t('Session')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.cashiers.map((c) => (
                <tr key={c.userId}>
                  <td className="px-5 py-2.5">
                    <div className="font-medium">{c.fullName}</div>
                    <div className="font-mono text-[11px] text-ink-500">{c.username} · {humanize(c.role)}</div>
                  </td>
                  <td className="px-3 py-2.5 text-end num">{c.salesCount}</td>
                  <td className="px-3 py-2.5 text-end font-medium num">{money(c.salesTotal)}</td>
                  <td className="px-3 py-2.5 text-end num">{c.hasadCount}</td>
                  <td className={clsx('px-3 py-2.5 text-end num', c.voided > 0 && 'text-rose-700')}>{c.voided}</td>
                  <td className="px-3 py-2.5">{c.firstLogin ? dateTime(c.firstLogin, lang) : '—'}</td>
                  <td className="px-3 py-2.5 text-ink-600">{relative(c.lastActivity)}</td>
                  <td className="px-5 py-2.5">{c.liveSessions > 0 ? <StatusBadge status="ACTIVE" /> : <span className="text-ink-400">{t('Signed out')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function MovementCard({ d, isToday }: { d: BranchDash; isToday: boolean }) {
  const { t } = useI18n();
  const m = d.movement;
  const L = (k: string) => m.lines[k] ?? { items: 0, weightMg: 0 };
  const plus = (a: MovementLine, b: MovementLine) => ({ items: a.items + b.items, weightMg: a.weightMg + b.weightMg });
  const rows: { sign: string; label: string; v: MovementLine; strong?: boolean }[] = [
    { sign: '', label: t('Opening stock'), v: m.opening, strong: true },
    { sign: '+', label: t('Purchases'), v: L('PURCHASE') },
    { sign: '+', label: t('Transfers in'), v: L('TRANSFER_IN') },
    { sign: '+', label: t('Returns & restock'), v: plus(L('RETURN'), L('ADJUSTMENT_IN')) },
    { sign: '−', label: t('Normal sales'), v: L('SALE') },
    { sign: '−', label: t('Hasad redemptions'), v: L('HASAD_REDEMPTION') },
    { sign: '−', label: t('Transfers out'), v: L('TRANSFER_OUT') },
    { sign: '−', label: t('Damaged / returned to supplier'), v: plus(L('DAMAGE'), L('ADJUSTMENT_OUT')) },
    { sign: '=', label: t('Closing stock'), v: m.closing, strong: true },
  ];
  const reconciled = !isToday || !m.actual || (m.actual.items === m.closing.items && m.actual.weightMg === m.closing.weightMg);
  return (
    <Card padded={false}>
      <CardHeader
        title={t('Inventory movement')}
        subtitle={t('Derived from the inventory ledger (pieces and net gold weight)')}
        actions={
          isToday && m.actual ? (
            <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium', reconciled ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
              {reconciled ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
              {reconciled ? t('Reconciled with item statuses') : t('Mismatch with item statuses')}
            </span>
          ) : undefined
        }
      />
      <table className="w-full text-[13px]">
        <thead className="text-ink-500">
          <tr className="border-b border-line">
            <th className="w-8 py-2" />
            <th className="py-2 text-start font-medium" />
            <th className="px-5 py-2 text-end font-medium">{t('Pieces')}</th>
            <th className="px-5 py-2 text-end font-medium">
              <span className="inline-flex items-center gap-1"><ScaleIcon className="size-3.5" /> {t('Net gold')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={clsx(r.strong ? 'bg-canvas/70 font-semibold' : 'text-ink-700', r.sign === '=' && 'border-t-2 border-ink-900/80')}>
              <td className={clsx('py-2 text-center font-mono', r.sign === '+' && 'text-emerald-700', r.sign === '−' && 'text-rose-700')}>{r.sign}</td>
              <td className="py-2">{r.label}</td>
              <td className={clsx('px-5 py-2 text-end num', !r.strong && r.v.items === 0 && 'text-ink-300')}>{num(r.v.items)}</td>
              <td className={clsx('px-5 py-2 text-end num', !r.strong && r.v.items === 0 && 'text-ink-300')}>{grams(r.v.weightMg)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function HasadCard({ d }: { d: BranchDash }) {
  const { t, lang } = useI18n();
  const h = d.hasad;
  const tile = (label: string, value: string, tone?: string) => (
    <div className="rounded-md border border-line px-3 py-2.5">
      <div className="text-[11.5px] text-ink-500">{label}</div>
      <div className={clsx('mt-0.5 text-lg font-semibold num', tone)}>{value}</div>
    </div>
  );
  return (
    <Card padded={false}>
      <CardHeader title={<span className="flex items-center gap-2"><Coins className="size-4 text-gold-600" /> {t('Hasad Gold')}</span>} subtitle={t('Withdrawal requests and weight-difference settlements')} actions={<Link to="/hasad" className="text-[13px] font-medium text-gold-700 hover:underline">{t('Open queue')}</Link>} />
      <div className="grid grid-cols-2 gap-2.5 p-4 sm:grid-cols-3">
        {tile(t('New requests'), num(h.newRequests))}
        {tile(t('Waiting for customer'), num(h.waiting + h.inProgress), h.waiting + h.inProgress > 0 ? 'text-sky-700' : undefined)}
        {tile(t('Completed'), `${h.completedToday} · ${grams(h.weightDeliveredMg)}`)}
        {tile(t('Cancelled'), num(h.cancelled))}
        {tile(t('Paid to customers'), money(h.paidToCustomers), h.paidToCustomers ? 'text-rose-700' : undefined)}
        {tile(t('Collected from customers'), money(h.collectedFromCustomers), h.collectedFromCustomers ? 'text-emerald-700' : undefined)}
      </div>
      <div className="border-t border-line">
        {h.queue.length === 0 ? (
          <div className="px-5 py-4 text-[13px] text-ink-500">{t('No open requests.')}</div>
        ) : (
          <ul className="divide-y divide-line">
            {h.queue.map((w) => (
              <li key={w.id}>
                <Link to={`/hasad/${w.id}`} className="flex items-center gap-3 px-5 py-2.5 text-[13px] hover:bg-canvas">
                  <Mono className="text-gold-700">{w.externalId}</Mono>
                  <span className="flex-1 truncate">{w.customerName}</span>
                  <span className="font-medium num">{grams(w.entitledWeightMg)}</span>
                  <StatusBadge status={w.status} />
                  <span className="hidden w-28 text-end text-[11.5px] text-ink-400 sm:block" title={dateTime(w.requestedAt, lang)}>{relative(w.requestedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
