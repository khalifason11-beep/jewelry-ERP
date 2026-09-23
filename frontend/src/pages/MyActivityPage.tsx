import { useQuery } from '@tanstack/react-query';
import { MonitorSmartphone, Receipt } from 'lucide-react';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, money, todayKey } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { Card, CardHeader, KeyValue, Kpi, Mono, PageHeader } from '../components/ui';
import { DateRange, useRangeParams } from '../components/Filters';
import { SalesTable, type SaleRow } from './sales/SalesPages';
import { SessionsTable } from './admin/SessionsPage';

/** A user's own transactions and session (cashiers cannot see anyone else's). */
export function MyActivityPage() {
  const { me } = useAuth();
  const { t, L, lang } = useI18n();
  const { from, to, set } = useRangeParams(1);
  const today = todayKey();
  const todaySales = useQuery({ queryKey: ['sales', 'mine-today', today], queryFn: () => get<SaleRow[]>('/sales', { from: today, to: today, mine: true }) });
  const done = (todaySales.data ?? []).filter((s) => s.status === 'COMPLETED');
  if (!me) return null;
  return (
    <div className="p-5 lg:p-6">
      <PageHeader title={t('My Activity')} subtitle={`${me.user.fullName} · ${L(me.user.role.name, me.user.role.nameAr)} · ${me.user.branch ? L(me.user.branch.name, me.user.branch.nameAr) : t('All branches')}`} />
      <div className="mb-5 grid gap-3 md:grid-cols-3">
        <Kpi tone="dark" label="My sales today" value={money(done.reduce((s, r) => s + r.total, 0), false)} sub={`${done.length} invoice(s) · SDG`} icon={<Receipt className="size-4" />} />
        <Card className="md:col-span-2">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold"><MonitorSmartphone className="size-4 text-ink-500" /> My current session</div>
          {me.session && (
            <KeyValue
              cols={4}
              items={[
                { label: 'Session', value: <Mono>{me.session.ref}</Mono> },
                { label: 'Signed in', value: dateTime(me.session.loginAt, lang) },
                { label: 'Device', value: me.session.device },
                { label: 'IP address', value: <Mono>{me.session.ipAddress}</Mono> },
              ]}
            />
          )}
        </Card>
      </div>
      <Card padded={false} className="mb-5">
        <CardHeader title="My transactions" />
        <SalesTable mine from={from} to={to} toolbar={<DateRange from={from} to={to} onChange={(r) => set(r)} />} />
      </Card>
      <Card padded={false}>
        <CardHeader title="My sessions (last 7 days)" subtitle="The same information administrators see about your account" />
        <SessionsTable scope="recent" mine />
      </Card>
    </div>
  );
}
