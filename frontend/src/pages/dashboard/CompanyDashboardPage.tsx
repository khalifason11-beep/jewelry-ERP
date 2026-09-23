import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeftRight, ChevronRight, Coins, Gem, MonitorSmartphone, Receipt, TrendingUp, Wallet } from 'lucide-react';
import { get } from '../../lib/api';
import { addDaysKey, grams, money, num, pct, todayKey } from '../../lib/format';
import { branchColor } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import { Card, CardHeader, ErrorState, Input, Kpi, Loading, PageHeader } from '../../components/ui';
import { CategoryBarChart, StackedMoneyBars } from '../../components/charts';

interface BranchRow {
  branchId: number;
  code: string;
  name: string;
  nameAr: string;
  city: string;
  revenue: number;
  salesCount: number;
  costOfSales: number;
  grossProfit: number;
  purchasesCost: number;
  expenses: number;
  contribution: number;
  inventoryCost: number;
  availableItems: number;
  availableWeightMg: number;
  hasadCompleted: number;
  hasadWeightMg: number;
  hasadOpen: number;
  hasadInProgress: number;
}

interface CompanyDash {
  period: { from: string; to: string };
  totals: {
    revenue: number;
    costOfSales: number;
    grossProfit: number;
    expenses: number;
    contribution: number;
    inventoryCost: number;
    inventoryRetail: number;
    availableItems: number;
    availableWeightMg: number;
    salesCount: number;
    purchasesCost: number;
    hasadCompleted: number;
    hasadWeightMg: number;
    hasadOpen: number;
    hasadPaidToCustomers: number;
    hasadCollectedFromCustomers: number;
    discounts: number;
  };
  branches: BranchRow[];
  trend: Record<string, number | string>[];
  inventoryByKarat: { karat: number; items: number; weightMg: number; cost: number }[];
  salesByCategory: { category: string; items: number; revenue: number; profit: number }[];
  attention: { pendingExpenses: number; pendingExpensesAmount: number; transfersInTransit: number; activeSessions: number };
}

type Preset = 'today' | '7d' | 'mtd' | '30d' | 'custom';

export function CompanyDashboardPage() {
  const { t, L } = useI18n();
  const navigate = useNavigate();
  const today = todayKey();
  const [preset, setPreset] = useState<Preset>('mtd');
  const [custom, setCustom] = useState({ from: addDaysKey(today, -29), to: today });
  const range =
    preset === 'today'
      ? { from: today, to: today }
      : preset === '7d'
        ? { from: addDaysKey(today, -6), to: today }
        : preset === 'mtd'
          ? { from: today.slice(0, 8) + '01', to: today }
          : preset === '30d'
            ? { from: addDaysKey(today, -29), to: today }
            : custom;

  const q = useQuery({ queryKey: ['dashboard', 'company', range.from, range.to], queryFn: () => get<CompanyDash>('/dashboard/company', range), refetchInterval: 60_000 });

  const presets: { v: Preset; label: string }[] = [
    { v: 'today', label: t('Today') },
    { v: '7d', label: '7 days' },
    { v: 'mtd', label: 'Month to date' },
    { v: '30d', label: '30 days' },
    { v: 'custom', label: 'Custom' },
  ];

  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={t('Executive Overview')}
        subtitle="Company-wide results across all branches. Click a branch to drill down."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-line-strong bg-white p-0.5" role="radiogroup" aria-label="Period">
              {presets.map((p) => (
                <button
                  key={p.v}
                  role="radio"
                  aria-checked={preset === p.v}
                  onClick={() => setPreset(p.v)}
                  className={clsx('rounded px-2.5 py-1 text-[12.5px] font-medium', preset === p.v ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-canvas')}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {preset === 'custom' && (
              <>
                <Input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="w-38" />
                <Input type="date" value={custom.to} min={custom.from} max={today} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="w-38" />
              </>
            )}
          </div>
        }
      />

      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <Body d={q.data!} onBranch={(id) => navigate(`/branches/${id}`)} L={L} />
      )}
    </div>
  );
}

function Body({ d, onBranch, L }: { d: CompanyDash; onBranch: (id: number) => void; L: (a?: string | null, b?: string | null) => string }) {
  const { t } = useI18n();
  const T = d.totals;
  const margin = T.revenue ? (T.grossProfit / T.revenue) * 100 : 0;
  const series = d.branches.map((b) => ({ key: `b${b.branchId}`, label: L(b.name, b.nameAr).replace(/ Branch$/, ''), color: branchColor(b.branchId) }));
  const q = `from=${d.period.from}&to=${d.period.to}`;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi tone="dark" label={t('Total Sales')} value={money(T.revenue, false)} sub={`${num(T.salesCount)} invoices · SDG`} icon={<Receipt className="size-4" />} />
        <Kpi label={t('Cost of Sales')} value={money(T.costOfSales, false)} sub="Item total cost · SDG" />
        <Kpi tone="gold" label={t('Gross Profit')} value={money(T.grossProfit, false)} sub={`Margin ${pct(margin)}`} icon={<TrendingUp className="size-4" />} />
        <Kpi label={t('Total Expenses')} value={money(T.expenses, false)} sub="Approved · SDG" icon={<Wallet className="size-4" />} />
        <Kpi label={t('Net Contribution')} value={money(T.contribution, false)} sub="Gross profit − expenses" />
        <Kpi label={t('Inventory Value')} value={money(T.inventoryCost, false)} sub={`${num(T.availableItems)} pcs · ${grams(T.availableWeightMg)} · at cost`} icon={<Gem className="size-4" />} />
      </div>

      <Card padded={false}>
        <CardHeader
          title={t('Branch Performance')}
          subtitle={`${d.period.from} → ${d.period.to}`}
          actions={<Link to={`/reports/branch-performance?${q}`} className="text-[13px] font-medium text-gold-700 hover:underline">Full report</Link>}
        />
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-[#f7f8fa] text-ink-500">
              <tr>
                <th className="px-5 py-2.5 text-start font-medium">{t('Branch')}</th>
                <th className="px-3 py-2.5 text-end font-medium">{t('Sales')}</th>
                <th className="px-3 py-2.5 text-end font-medium">{t('Purchases')}</th>
                <th className="px-3 py-2.5 text-end font-medium">{t('Expenses')}</th>
                <th className="px-3 py-2.5 text-end font-medium">{t('Gross Profit')}</th>
                <th className="px-3 py-2.5 text-end font-medium">Contribution</th>
                <th className="px-3 py-2.5 text-end font-medium">{t('Inventory Value')}</th>
                <th className="px-3 py-2.5 text-end font-medium">{t('Hasad Redemptions')}</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.branches.map((b) => (
                <tr key={b.branchId} onClick={() => onBranch(b.branchId)} className="group cursor-pointer hover:bg-gold-50/60">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="size-2.5 rounded-sm" style={{ background: branchColor(b.branchId) }} />
                      <div>
                        <div className="font-semibold text-ink-900">{L(b.name, b.nameAr)}</div>
                        <div className="text-[11.5px] text-ink-500">{b.city} · {b.availableItems} pcs available</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-end font-semibold num">{money(b.revenue, false)}</td>
                  <td className="px-3 py-3 text-end num">{money(b.purchasesCost, false)}</td>
                  <td className="px-3 py-3 text-end num">{money(b.expenses, false)}</td>
                  <td className="px-3 py-3 text-end num">{money(b.grossProfit, false)}</td>
                  <td className={clsx('px-3 py-3 text-end font-medium num', b.contribution < 0 ? 'text-rose-700' : 'text-emerald-700')}>{money(b.contribution, false)}</td>
                  <td className="px-3 py-3 text-end num">{money(b.inventoryCost, false)}</td>
                  <td className="px-3 py-3 text-end num">
                    {b.hasadCompleted} <span className="text-[11.5px] text-ink-500">· {grams(b.hasadWeightMg)}</span>
                  </td>
                  <td className="pe-4 text-ink-300 group-hover:text-gold-600">
                    <ChevronRight className="size-4 rtl:rotate-180" />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-line-strong bg-[#f7f8fa] font-semibold">
              <tr>
                <td className="px-5 py-2.5">{t('Total')}</td>
                <td className="px-3 py-2.5 text-end num">{money(T.revenue, false)}</td>
                <td className="px-3 py-2.5 text-end num">{money(T.purchasesCost, false)}</td>
                <td className="px-3 py-2.5 text-end num">{money(T.expenses, false)}</td>
                <td className="px-3 py-2.5 text-end num">{money(T.grossProfit, false)}</td>
                <td className="px-3 py-2.5 text-end num">{money(T.contribution, false)}</td>
                <td className="px-3 py-2.5 text-end num">{money(T.inventoryCost, false)}</td>
                <td className="px-3 py-2.5 text-end num">{T.hasadCompleted}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="border-t border-line px-5 py-2 text-[11.5px] text-ink-500">Amounts in SDG. Gross profit = selling price after discount − item total cost. Contribution = gross profit − approved branch expenses.</div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[1.5fr_1fr]">
        <Card padded={false}>
          <CardHeader title="Daily sales by branch" subtitle="Revenue per day, SDG" />
          <div className="px-3 pb-3 pt-2">
            <StackedMoneyBars data={d.trend} series={series} height={260} />
          </div>
        </Card>
        <Card padded={false}>
          <CardHeader title="Needs attention" />
          <ul className="divide-y divide-line text-[13px]">
            <Attn to="/hasad" icon={<Coins className="size-4 text-gold-600" />} label="Hasad requests awaiting customers" value={num(T.hasadOpen)} />
            <Attn to="/expenses?status=PENDING" icon={<Wallet className="size-4 text-amber-600" />} label="Expenses pending your approval" value={`${d.attention.pendingExpenses} · ${money(d.attention.pendingExpensesAmount)}`} warn={d.attention.pendingExpenses > 0} />
            <Attn to="/transfers" icon={<ArrowLeftRight className="size-4 text-sky-600" />} label="Transfers in transit" value={num(d.attention.transfersInTransit)} />
            <Attn to="/sessions" icon={<MonitorSmartphone className="size-4 text-emerald-600" />} label="Users signed in now" value={num(d.attention.activeSessions)} />
          </ul>
          <div className="border-t border-line px-5 py-3">
            <div className="mb-2 text-[12.5px] font-semibold text-ink-700">Hasad settlements in period</div>
            <div className="grid grid-cols-2 gap-2 text-[12.5px]">
              <div className="rounded-md bg-rose-50 px-3 py-2">
                <div className="text-rose-700">Paid to customers</div>
                <div className="font-semibold text-rose-800 num">{money(T.hasadPaidToCustomers)}</div>
              </div>
              <div className="rounded-md bg-emerald-50 px-3 py-2">
                <div className="text-emerald-700">Collected from customers</div>
                <div className="font-semibold text-emerald-800 num">{money(T.hasadCollectedFromCustomers)}</div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card padded={false}>
          <CardHeader title="Sales by category" subtitle="Revenue in period" actions={<Link to={`/reports/profit?group=category&${q}`} className="text-[13px] font-medium text-gold-700 hover:underline">Profit by category</Link>} />
          <div className="px-3 pb-3 pt-2">
            {d.salesByCategory.length ? (
              <CategoryBarChart data={d.salesByCategory} labelKey="category" valueKey="revenue" colorOf={() => 'var(--color-ink-700)'} layout="horizontal" height={Math.max(160, d.salesByCategory.length * 34)} />
            ) : (
              <div className="py-10 text-center text-[13px] text-ink-500">No sales in this period</div>
            )}
          </div>
        </Card>
        <Card padded={false}>
          <CardHeader title="Inventory valuation by karat" subtitle="Sellable stock at cost (available + reserved)" actions={<Link to="/reports/inventory" className="text-[13px] font-medium text-gold-700 hover:underline">Inventory report</Link>} />
          <table className="w-full text-[13px]">
            <thead className="bg-[#f7f8fa] text-ink-500">
              <tr>
                <th className="px-5 py-2 text-start font-medium">{t('Karat')}</th>
                <th className="px-3 py-2 text-end font-medium">Pieces</th>
                <th className="px-3 py-2 text-end font-medium">{t('Net weight')}</th>
                <th className="px-5 py-2 text-end font-medium">Value at cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.inventoryByKarat.map((k) => (
                <tr key={k.karat}>
                  <td className="px-5 py-2.5 font-medium">{k.karat}K</td>
                  <td className="px-3 py-2.5 text-end num">{k.items}</td>
                  <td className="px-3 py-2.5 text-end num">{grams(k.weightMg)}</td>
                  <td className="px-5 py-2.5 text-end num">{money(k.cost)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-line-strong font-semibold">
              <tr>
                <td className="px-5 py-2.5">{t('Total')}</td>
                <td className="px-3 py-2.5 text-end num">{d.inventoryByKarat.reduce((s, k) => s + k.items, 0)}</td>
                <td className="px-3 py-2.5 text-end num">{grams(d.inventoryByKarat.reduce((s, k) => s + k.weightMg, 0))}</td>
                <td className="px-5 py-2.5 text-end num">{money(d.inventoryByKarat.reduce((s, k) => s + k.cost, 0))}</td>
              </tr>
            </tfoot>
          </table>
          <div className="border-t border-line px-5 py-2 text-[11.5px] text-ink-500">Retail value of the same stock: {money(T.inventoryRetail)}</div>
        </Card>
      </div>
    </div>
  );
}

function Attn({ to, icon, label, value, warn }: { to: string; icon: React.ReactNode; label: string; value: string; warn?: boolean }) {
  return (
    <li>
      <Link to={to} className="flex items-center gap-3 px-5 py-3 hover:bg-canvas">
        {icon}
        <span className="flex-1 text-ink-700">{label}</span>
        <span className={clsx('font-semibold num', warn && 'text-amber-700')}>{value}</span>
        <ChevronRight className="size-4 text-ink-300 rtl:rotate-180" />
      </Link>
    </li>
  );
}
