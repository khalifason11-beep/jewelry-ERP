import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { AUDIT_ACTIONS } from '@jerp/shared';
import { get } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, humanize } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import type { AuditParams } from '@jerp/shared';
import { auditText } from '../../lib/audit';
import { useI18n } from '../../lib/i18n';
import { Card, ErrorState, Input, Loading, Mono, PageHeader, Select, StatusBadge } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';
import { BranchSelect, DateRange, useRangeParams } from '../../components/Filters';

interface AuditRow {
  id: number;
  at: string;
  userId: number | null;
  username: string;
  userFullName: string;
  role: string;
  branchId: number | null;
  branchName: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  description: string;
  descriptionKey: string | null;
  descriptionParams: AuditParams | null;
  ipAddress: string | null;
  sessionRef: string | null;
}

export function AuditPage() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [sp0] = useSearchParams();
  const { from, to, branchId, sp, set } = useRangeParams(7);
  const [action, setAction] = useState(sp0.get('action') ?? '');
  const userId = sp.get('userId') ?? '';
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const users = useQuery({ queryKey: ['users', branchId], queryFn: () => get<{ id: number; fullName: string }[]>('/users', { branchId }), enabled: can('users.view') });
  const data = useQuery({
    queryKey: ['audit', from, to, branchId, action, userId, dq],
    queryFn: () => get<AuditRow[]>('/audit', { from, to, branchId, action, userId, q: dq }),
  });
  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={<span className="flex items-center gap-2.5"><ScrollText className="size-6 text-ink-500" /> {t('Audit Log')}</span>}
        subtitle={t('Append-only record of every important action: who, when, where, and on what.')}
      />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <DateRange from={from} to={to} onChange={(r) => set(r)} />
          <BranchSelect value={branchId} onChange={(v) => set({ branchId: v })} />
          <Select value={userId} onChange={(e) => set({ userId: e.target.value || undefined })} className="h-8 w-44 text-[13px]" aria-label={t('User')}>
            <option value="">{t('All users')}</option>
            {users.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </Select>
          <Select value={action} onChange={(e) => setAction(e.target.value)} className="h-8 w-56 text-[13px]" aria-label={t('Action')}>
            <option value="">{t('All actions')}</option>
            {AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search description, ID, user…')} className="h-8 w-56 text-[13px]" />
        </div>
        {data.isLoading ? (
          <Loading />
        ) : data.isError ? (
          <ErrorState error={data.error} />
        ) : (
          <DataTable
            rows={data.data!}
            rowKey={(r) => r.id}
            searchable={false}
            exportName="audit-log"
            maxHeight="calc(100vh - 290px)"
            dense
            emptyTitle={t('No audit events match these filters')}
            columns={[
              { key: 'at', header: t('Time'), render: (r) => <span className="whitespace-nowrap num">{dateTime(r.at, lang)}</span> },
              { key: 'userFullName', header: t('User'), render: (r) => <div><div>{r.username === 'system' ? t('System') : r.userFullName}</div><div className="font-mono text-[11px] text-ink-500">{r.username}</div></div> },
              { key: 'role', header: t('Role'), render: (r) => <span className="text-[12px] text-ink-600">{humanize(r.role)}</span> },
              { key: 'branchName', header: t('Branch'), render: (r) => (r.branchName ? t(r.branchName) : null) ?? <span className="text-ink-400">{t('Company')}</span> },
              { key: 'action', header: t('Action'), render: (r) => <StatusBadge status={r.action} className="font-mono !text-[10.5px]" /> },
              { key: 'entityId', header: t('Entity'), render: (r) => (r.entityId ? <span className="text-[12px]"><span className="text-ink-500">{humanize(r.entityType)}</span> <Mono>{r.entityId}</Mono></span> : '—') },
              { key: 'description', header: t('Description'), className: 'min-w-[320px]', value: (r) => auditText(r), render: (r) => auditText(r) },
              { key: 'ipAddress', header: t('IP / session'), render: (r) => <div className="font-mono text-[11px] text-ink-500">{r.ipAddress ?? '—'}<br />{r.sessionRef}</div> },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
