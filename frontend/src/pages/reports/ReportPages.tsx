import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  BarChart3,
  Boxes,
  Building2,
  Coins,
  Info,
  Receipt,
  ScrollText,
  TrendingUp,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@jerp/shared';
import { get } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, dateTime, grams, humanize, karatLabel, money, num, pct } from '../../lib/format';
import { tk, useI18n } from '../../lib/i18n';
import type { Report } from '../../lib/types';
import { Alert, Card, ErrorState, Loading, Mono, PageHeader, Select, StatusBadge } from '../../components/ui';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { BranchSelect, DateRange, useRangeParams } from '../../components/Filters';
import { Crumbs } from '../sales/SalesPages';

const REPORTS: { key: string; title: string; desc: string; icon: LucideIcon; perm?: Permission }[] = [
  { key: 'sales', title: tk('Sales Report'), desc: tk('Invoices, discounts, cost and gross profit'), icon: Receipt },
  { key: 'purchases', title: tk('Purchases Report'), desc: tk('Stock received from suppliers'), icon: Truck, perm: 'purchases.view' },
  { key: 'expenses', title: tk('Expenses Report'), desc: tk('Operating expenses by branch and category'), icon: Wallet, perm: 'expenses.view' },
  { key: 'inventory', title: tk('Inventory Report'), desc: tk('Every piece with weights, costs and status'), icon: Boxes, perm: 'inventory.view' },
  { key: 'inventory-movement', title: tk('Inventory Movement'), desc: tk('Opening → movements → closing, pieces & grams'), icon: ArrowLeftRight, perm: 'inventory.view' },
  { key: 'profit', title: tk('Profit Report'), desc: tk('Gross profit and contribution by branch, category, karat'), icon: TrendingUp, perm: 'profit.view' },
  { key: 'hasad', title: tk('Hasad Withdrawal Report'), desc: tk('Entitlement vs delivered weight and settlements'), icon: Coins, perm: 'hasad.view' },
  { key: 'branch-performance', title: tk('Branch Performance'), desc: tk('Branches side by side'), icon: Building2 },
  { key: 'user-activity', title: tk('User Activity'), desc: tk('Sign-ins, transactions and actions per user'), icon: Users, perm: 'users.view' },
  { key: 'audit', title: tk('Audit Log'), desc: tk('Every important action, filterable'), icon: ScrollText, perm: 'audit.view' },
  { key: 'inventory-ledger', title: tk('Inventory Ledger'), desc: tk('Line-by-line stock movements with references'), icon: BarChart3, perm: 'inventory.view' },
];

export function ReportsHubPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  return (
    <div className="p-5 lg:p-6">
      <PageHeader title={t('Reports')} subtitle={t('Every report supports date range, branch and user filters, search, sorting and CSV export.')} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {REPORTS.filter((r) => !r.perm || can(r.perm)).map((r) => (
          <Link key={r.key} to={`/reports/${r.key}`} className="group">
            <Card className="flex h-full gap-4 transition-colors group-hover:border-gold-400">
              <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-canvas text-ink-600 group-hover:bg-ink-900 group-hover:text-gold-400">
                <r.icon className="size-5" />
              </div>
              <div>
                <div className="font-semibold text-ink-900">{t(r.title)}</div>
                <div className="mt-0.5 text-[13px] text-ink-500">{t(r.desc)}</div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

function fillLink(pattern: string, row: Record<string, unknown>) {
  return pattern.replace(/:(\w+)/g, (_, k) => String(row[k] ?? ''));
}

export function ReportPage() {
  const key = useParams().key!;
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const navigate = useNavigate();
  const { from, to, branchId, sp, set } = useRangeParams(key === 'audit' ? 1 : 30);
  const userId = sp.get('userId') ?? '';
  const status = sp.get('status') ?? '';
  const group = sp.get('group') ?? 'branch';

  const q = useQuery({
    queryKey: ['report', key, from, to, branchId, userId, status, group],
    queryFn: () => get<Report>(`/reports/${key}`, { from, to, branchId, userId, status, group: key === 'profit' ? group : undefined }),
  });
  const users = useQuery({
    queryKey: ['users', branchId],
    queryFn: () => get<{ id: number; fullName: string; username: string }[]>('/users', { branchId }),
    enabled: can('users.view'),
  });

  const r = q.data;
  const fmt = (type: string, v: unknown) => {
    if (v == null || v === '') return <span className="text-ink-300">—</span>;
    switch (type) {
      case 'money':
        return <span className="num">{money(Number(v), false)}</span>;
      case 'weight':
        return <span className="num">{grams(Number(v))}</span>;
      case 'number':
        return <span className="num">{num(Number(v))}</span>;
      case 'percent':
        return <span className="num">{pct(Number(v))}</span>;
      case 'date':
        return date(String(v), lang);
      case 'datetime':
        return <span className="whitespace-nowrap">{dateTime(String(v), lang)}</span>;
      case 'status':
        return <StatusBadge status={String(v)} />;
      case 'code':
        return <Mono>{String(v)}</Mono>;
      default: {
        // Text cells: translate known terms (branch names, roles, categories), karats and day keys.
        const str = String(v);
        if (/^\d{2}K$/.test(str)) return karatLabel(Number(str.slice(0, 2)));
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return date(str, lang);
        return t(str);
      }
    }
  };

  const columns: Column<Record<string, unknown>>[] = (r?.columns ?? []).map((c) => ({
    key: c.key,
    header: t(c.label),
    csvHeader: t(c.label),
    align: ['money', 'weight', 'number', 'percent'].includes(c.type) ? 'end' : 'start',
    value: (row) => row[c.key] as unknown,
    render: (row) =>
      c.link ? (
        <Link to={fillLink(c.link, row)} onClick={(e) => e.stopPropagation()} className="font-medium text-gold-700 hover:underline">
          {fmt(c.type, row[c.key])}
        </Link>
      ) : (
        fmt(c.type, row[c.key])
      ),
    footer: r?.totals && c.key in r.totals ? fmt(c.type, r.totals[c.key]) : undefined,
  }));

  const meta = REPORTS.find((x) => x.key === key);
  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        breadcrumbs={<Crumbs items={[{ label: t('Reports'), to: '/reports' }, { label: t(r?.title ?? meta?.title ?? key) }]} />}
        title={t(r?.title ?? meta?.title ?? 'Report')}
        subtitle={r?.description ? t(r.description) : undefined}
      />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          {(r?.filters.dateRange ?? true) && <DateRange from={from} to={to} onChange={(x) => set(x)} />}
          {(r?.filters.branch ?? true) && <BranchSelect value={branchId} onChange={(v) => set({ branchId: v, userId: undefined })} />}
          {r?.filters.user && can('users.view') && (
            <Select value={userId} onChange={(e) => set({ userId: e.target.value || undefined })} className="h-8 w-44 text-[13px]" aria-label={t('User')}>
              <option value="">{t('All users')}</option>
              {users.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </Select>
          )}
          {r?.filters.status && (
            <Select value={status} onChange={(e) => set({ status: e.target.value || undefined })} className="h-8 w-40 text-[13px]" aria-label={t('Status')}>
              <option value="">{t('All')}</option>
              {r.filters.status.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </Select>
          )}
          {key === 'profit' && (
            <Select value={group} onChange={(e) => set({ group: e.target.value })} className="h-8 w-40 text-[13px]" aria-label={t('Group by')}>
              <option value="branch">{t('By branch')}</option>
              <option value="category">{t('By category')}</option>
              <option value="karat">{t('By karat')}</option>
              <option value="cashier">{t('By cashier')}</option>
              <option value="day">{t('By day')}</option>
            </Select>
          )}
        </div>
        {q.isLoading ? (
          <Loading />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <DataTable
            rows={r!.rows}
            rowKey={(_row, i) => i}
            columns={columns}
            exportName={`report-${key}`}
            maxHeight="calc(100vh - 330px)"
            onRowClick={(() => {
              const link = r!.columns.find((c) => c.link)?.link;
              return link ? (row: Record<string, unknown>) => navigate(fillLink(link, row)) : undefined;
            })()}
          />
        )}
      </Card>
      {r?.notes?.length ? (
        <Alert tone="info" icon={<Info className="size-4" />} className="mt-3">
          {r.notes.map((n) => <div key={n}>{t(n)}</div>)}
        </Alert>
      ) : null}
    </div>
  );
}
