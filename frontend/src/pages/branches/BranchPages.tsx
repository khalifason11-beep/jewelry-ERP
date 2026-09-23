// Drill-down: Company → Branch → Module → Transaction → Item.

import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, ChevronRight, MapPin, Phone } from 'lucide-react';
import { get } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { grams, money, todayKey } from '../../lib/format';
import { branchColor } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import type { Branch } from '../../lib/types';
import { Card, ErrorState, Loading, Mono, PageHeader, Tabs } from '../../components/ui';
import { DateRange, useRangeParams } from '../../components/Filters';
import { BranchDashboard } from '../dashboard/BranchDashboardPage';
import { SalesTable, Crumbs } from '../sales/SalesPages';
import { ExpensesTable } from '../expenses/ExpensesPage';
import { InventoryTable } from '../inventory/InventoryPages';
import { PurchasesTable } from '../purchases/PurchasesPages';
import { HasadBranchTable } from '../hasad/HasadBranchTable';
import { SessionsTable } from '../admin/SessionsPage';

interface CompanyBranches {
  branches: { branchId: number; name: string; nameAr: string; city: string; revenue: number; grossProfit: number; expenses: number; contribution: number; availableItems: number; availableWeightMg: number; hasadCompleted: number; hasadOpen: number; salesCount: number }[];
}

export function BranchesPage() {
  const { t, L } = useI18n();
  const today = todayKey();
  const q = useQuery({ queryKey: ['dashboard', 'company', today.slice(0, 8) + '01', today], queryFn: () => get<CompanyBranches>('/dashboard/company', { from: today.slice(0, 8) + '01', to: today }) });
  return (
    <div className="p-5 lg:p-6">
      <PageHeader title={t('Branches')} subtitle="Month-to-date results. Open a branch to drill into its sales, expenses, inventory, Hasad activity and staff." />
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {q.data!.branches.map((b) => (
            <Link key={b.branchId} to={`/branches/${b.branchId}`} className="group">
              <Card className="h-full transition-colors group-hover:border-gold-400">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="grid size-10 place-items-center rounded-lg bg-ink-900">
                      <Building2 className="size-5 text-gold-400" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 text-base font-semibold">
                        <span className="size-2.5 rounded-sm" style={{ background: branchColor(b.branchId) }} />
                        {L(b.name, b.nameAr)}
                      </div>
                      <div className="text-[12.5px] text-ink-500">{b.city}</div>
                    </div>
                  </div>
                  <ChevronRight className="size-5 text-ink-300 group-hover:text-gold-600 rtl:rotate-180" />
                </div>
                <div className="mt-4 grid grid-cols-3 gap-3 text-[13px]">
                  <div><div className="text-ink-500">{t('Sales')} MTD</div><div className="font-semibold num">{money(b.revenue)}</div></div>
                  <div><div className="text-ink-500">{t('Gross Profit')}</div><div className="font-semibold num">{money(b.grossProfit)}</div></div>
                  <div><div className="text-ink-500">Contribution</div><div className="font-semibold text-emerald-700 num">{money(b.contribution)}</div></div>
                  <div><div className="text-ink-500">{t('Available')}</div><div className="font-semibold num">{b.availableItems} pcs · {grams(b.availableWeightMg)}</div></div>
                  <div><div className="text-ink-500">Hasad done</div><div className="font-semibold num">{b.hasadCompleted}</div></div>
                  <div><div className="text-ink-500">Hasad open</div><div className="font-semibold num">{b.hasadOpen}</div></div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

type Tab = 'overview' | 'sales' | 'expenses' | 'inventory' | 'purchases' | 'hasad' | 'staff';

export function BranchDetailPage() {
  const id = Number(useParams().id);
  const { t, L } = useI18n();
  const { isGlobal } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'overview';
  const setTab = (v: Tab) => {
    const n = new URLSearchParams(sp);
    n.set('tab', v);
    setSp(n, { replace: true });
  };
  const { from, to, set } = useRangeParams(30);
  const branch = useQuery({ queryKey: ['branch', id], queryFn: () => get<Branch & { staffCount: number }>(`/branches/${id}`) });
  if (branch.isLoading) return <Loading />;
  if (branch.isError) return <div className="p-6"><ErrorState error={branch.error} /></div>;
  const b = branch.data!;
  const rangeBar = (
    <DateRange from={from} to={to} onChange={(r) => set(r)} />
  );
  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        breadcrumbs={<Crumbs items={[...(isGlobal ? [{ label: 'Company', to: '/overview' }, { label: t('Branches'), to: '/branches' }] : []), { label: L(b.name, b.nameAr) }]} />}
        title={
          <span className="flex items-center gap-3">
            <span className="size-3 rounded-sm" style={{ background: branchColor(b.id) }} />
            {L(b.name, b.nameAr)}
            <Mono className="text-sm text-ink-400">{b.code}</Mono>
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" /> {b.address}</span>
            <span className="inline-flex items-center gap-1"><Phone className="size-3.5" /> {b.phone}</span>
            <span>{b.staffCount} staff · Hasad code <Mono>{b.hasadBranchCode}</Mono></span>
          </span>
        }
      />
      <Tabs<Tab>
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'sales', label: t('Sales') },
          { value: 'expenses', label: t('Expenses') },
          { value: 'inventory', label: t('Inventory') },
          { value: 'purchases', label: t('Purchases') },
          { value: 'hasad', label: t('Hasad Gold') },
          { value: 'staff', label: 'Cashiers & sessions' },
        ]}
      />
      {tab === 'overview' && <BranchDashboard branchId={id} embedded />}
      {tab === 'sales' && <Card padded={false}><SalesTable branchId={id} from={from} to={to} toolbar={rangeBar} /></Card>}
      {tab === 'expenses' && <Card padded={false}><ExpensesTable branchId={id} from={from} to={to} toolbar={rangeBar} /></Card>}
      {tab === 'inventory' && <Card padded={false}><InventoryTable branchId={id} /></Card>}
      {tab === 'purchases' && <Card padded={false}><PurchasesTable branchId={id} from={from} to={to} toolbar={rangeBar} /></Card>}
      {tab === 'hasad' && <Card padded={false}><HasadBranchTable branchId={id} /></Card>}
      {tab === 'staff' && <StaffTab branchId={id} />}
    </div>
  );
}

function StaffTab({ branchId }: { branchId: number }) {
  const [scope, setScope] = useState<'active' | 'recent'>('active');
  return (
    <Card padded={false}>
      <Tabs className="px-3" value={scope} onChange={setScope} tabs={[{ value: 'active', label: 'Signed in now' }, { value: 'recent', label: 'Last 7 days' }]} />
      <SessionsTable branchId={branchId} scope={scope} />
    </Card>
  );
}
