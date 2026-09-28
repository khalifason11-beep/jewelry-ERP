// Drill-down: Company → Branch → Module → Transaction → Item.

import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, ChevronRight, MapPin, Pencil, Phone, Plus } from 'lucide-react';
import { get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { grams, money, todayKey } from '../../lib/format';
import { branchColor, useBranches } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { useI18n } from '../../lib/i18n';
import type { Branch } from '../../lib/types';
import { Button, Card, CardHeader, Dialog, ErrorState, Field, Input, Loading, Mono, PageHeader, StatusBadge, Tabs } from '../../components/ui';
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
  const { can } = useAuth();
  const [editing, setEditing] = useState<Branch | 'new' | null>(null);
  const today = todayKey();
  const q = useQuery({ queryKey: ['dashboard', 'company', today.slice(0, 8) + '01', today], queryFn: () => get<CompanyBranches>('/dashboard/company', { from: today.slice(0, 8) + '01', to: today }) });
  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={t('Branches')}
        subtitle={t('Month-to-date results. Open a branch to drill into its sales, expenses, inventory, Hasad activity and staff.')}
        actions={can('branches.manage') ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>{t('New branch')}</Button> : undefined}
      />
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
                      <div className="text-[12.5px] text-ink-500">{t(b.city)}</div>
                    </div>
                  </div>
                  <ChevronRight className="size-5 text-ink-300 group-hover:text-gold-600 rtl:rotate-180" />
                </div>
                <div className="mt-4 grid grid-cols-3 gap-3 text-[13px]">
                  <div><div className="text-ink-500">{t('Sales')} · {t('MTD')}</div><div className="font-semibold num">{money(b.revenue)}</div></div>
                  <div><div className="text-ink-500">{t('Gross Profit')}</div><div className="font-semibold num">{money(b.grossProfit)}</div></div>
                  <div><div className="text-ink-500">{t('Contribution')}</div><div className="font-semibold text-emerald-700 num">{money(b.contribution)}</div></div>
                  <div><div className="text-ink-500">{t('Available')}</div><div className="font-semibold num">{t('{n} pcs', { n: b.availableItems })} · {grams(b.availableWeightMg)}</div></div>
                  <div><div className="text-ink-500">{t('Hasad done')}</div><div className="font-semibold num">{b.hasadCompleted}</div></div>
                  <div><div className="text-ink-500">{t('Hasad open')}</div><div className="font-semibold num">{b.hasadOpen}</div></div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
      {can('branches.manage') && <BranchRegister onEdit={setEditing} />}
      {editing && <BranchDialog branch={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** All branches with their master data (General Manager). */
function BranchRegister({ onEdit }: { onEdit: (b: Branch) => void }) {
  const { t, L } = useI18n();
  const q = useBranches();
  return (
    <Card padded={false} className="mt-5">
      <CardHeader title={t('Branch register')} subtitle={t('Branch codes are permanent: they appear in every document number.')} />
      <table className="w-full text-[13px]">
        <thead className="bg-[#f7f8fa] text-ink-500">
          <tr>
            <th className="px-5 py-2 text-start font-medium">{t('Code')}</th>
            <th className="px-3 py-2 text-start font-medium">{t('Branch')}</th>
            <th className="px-3 py-2 text-start font-medium">{t('City')}</th>
            <th className="px-3 py-2 text-start font-medium">{t('Phone')}</th>
            <th className="px-3 py-2 text-start font-medium">{t('Status')}</th>
            <th className="px-5 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {(q.data ?? []).map((b) => (
            <tr key={b.id}>
              <td className="px-5 py-2.5"><Mono className="font-semibold">{b.code}</Mono></td>
              <td className="px-3 py-2.5">{L(b.name, b.nameAr)}</td>
              <td className="px-3 py-2.5">{t(b.city)}</td>
              <td className="px-3 py-2.5 num">{b.phone ?? '—'}</td>
              <td className="px-3 py-2.5"><StatusBadge status={b.isActive === false ? 'DISABLED' : 'ACTIVE'} /></td>
              <td className="px-5 py-2.5 text-end">
                <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => onEdit(b)}>{t('Edit')}</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function BranchDialog({ branch, onClose }: { branch: Branch | null; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({
    code: branch?.code ?? '',
    name: branch?.name ?? '',
    nameAr: branch?.nameAr ?? '',
    city: branch?.city ?? '',
    address: branch?.address ?? '',
    phone: branch?.phone ?? '',
    isActive: branch?.isActive !== false,
  });
  const m = useMutation({
    mutationFn: () => {
      const common = { name: f.name.trim(), nameAr: f.nameAr.trim(), city: f.city.trim(), ...(f.address.trim() ? { address: f.address.trim() } : {}), ...(f.phone.trim() ? { phone: f.phone.trim() } : {}) };
      return branch ? patch(`/branches/${branch.id}`, { ...common, isActive: f.isActive }) : post('/branches', { code: f.code.trim().toUpperCase(), ...common });
    },
    onSuccess: () => {
      toast.success(branch ? t('Branch updated') : t('Branch created'), t('Recorded in the audit log.'));
      qc.invalidateQueries();
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  const valid = /^[A-Z]{2,6}$/.test(f.code.trim().toUpperCase()) && f.name.trim().length >= 2 && f.nameAr.trim().length >= 2 && f.city.trim().length >= 2;
  return (
    <Dialog
      open
      onClose={onClose}
      title={branch ? t('Edit branch {code}', { code: branch.code }) : t('New branch')}
      footer={<><Button onClick={onClose}>{t('Cancel')}</Button><Button variant="primary" disabled={!valid} loading={m.isPending} onClick={() => m.mutate()}>{t('Save')}</Button></>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Code')} hint={branch ? t('The code cannot be changed.') : t('2–6 capital letters, e.g. KRT. It can never be changed later.')}>
          <Input value={f.code} disabled={!!branch} maxLength={6} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} className="font-mono" />
        </Field>
        <Field label={t('City')}>
          <Input value={f.city} maxLength={60} onChange={(e) => setF({ ...f, city: e.target.value })} />
        </Field>
        <Field label={t('Name (English)')}>
          <Input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label={t('Name (Arabic)')}>
          <Input value={f.nameAr} maxLength={80} onChange={(e) => setF({ ...f, nameAr: e.target.value })} />
        </Field>
        <Field label={t('Address')} className="sm:col-span-2">
          <Input value={f.address} maxLength={200} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </Field>
        <Field label={t('Phone')}>
          <Input value={f.phone} maxLength={30} onChange={(e) => setF({ ...f, phone: e.target.value })} className="num" />
        </Field>
        {branch && (
          <label className="flex items-center gap-2 self-end pb-2 text-[13px]">
            <input type="checkbox" className="size-4 accent-ink-900" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
            {t('Branch is active')}
          </label>
        )}
      </div>
    </Dialog>
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
        breadcrumbs={<Crumbs items={[...(isGlobal ? [{ label: t('Company'), to: '/overview' }, { label: t('Branches'), to: '/branches' }] : []), { label: L(b.name, b.nameAr) }]} />}
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
            <span>{t('{n} staff', { n: b.staffCount })} · {t('Hasad code')} <Mono>{b.hasadBranchCode}</Mono></span>
          </span>
        }
      />
      <Tabs<Tab>
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: t('Overview') },
          { value: 'sales', label: t('Sales') },
          { value: 'expenses', label: t('Expenses') },
          { value: 'inventory', label: t('Inventory') },
          { value: 'purchases', label: t('Purchases') },
          { value: 'hasad', label: t('Hasad Gold') },
          { value: 'staff', label: t('Cashiers & sessions') },
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
  const { t } = useI18n();
  const [scope, setScope] = useState<'active' | 'recent'>('active');
  return (
    <Card padded={false}>
      <Tabs className="px-3" value={scope} onChange={setScope} tabs={[{ value: 'active', label: t('Signed in now') }, { value: 'recent', label: t('Last 7 days') }]} />
      <SessionsTable branchId={branchId} scope={scope} />
    </Card>
  );
}
