import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Eye, MonitorSmartphone, PowerOff } from 'lucide-react';
import { get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, humanize, relative, time } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { Alert, Badge, Button, Card, Dialog, ErrorState, Kpi, Loading, Mono, PageHeader, StatusBadge, Tabs } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';
import { BranchSelect } from '../../components/Filters';

export interface SessionRow {
  key: string;
  ref: string;
  userId: number;
  username: string;
  fullName: string;
  roleCode: string;
  roleName: string;
  branchId: number | null;
  branchName: string | null;
  loginAt: string;
  lastActivityAt: string;
  device: string;
  userAgent: string;
  ipAddress: string;
  currentModule: string | null;
  status: string;
  endedAt: string | null;
  endedReason: string | null;
  isSimulated: boolean;
  isCurrent: boolean;
  presence: 'ACTIVE' | 'IDLE' | 'ENDED';
  concurrentSessions: number;
}

export function SessionsTable({ branchId, scope, mine }: { branchId?: number; scope: 'active' | 'recent'; mine?: boolean }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [revoke, setRevoke] = useState<SessionRow | null>(null);
  const q = useQuery({ queryKey: ['sessions', scope, branchId, mine], queryFn: () => get<SessionRow[]>('/sessions', { scope, branchId, mine }), refetchInterval: 15_000 });
  const m = useMutation({
    mutationFn: (s: SessionRow) => post(`/sessions/${s.key}/revoke`),
    onSuccess: () => {
      toast.success('Session terminated', 'The user has been signed out on that device.');
      setRevoke(null);
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e) => toast.fromError(e),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} />;
  return (
    <>
      <DataTable
        rows={q.data!}
        rowKey={(r) => r.key}
        exportName="sessions"
        emptyTitle={scope === 'active' ? 'Nobody is signed in' : 'No sessions'}
        rowClassName={(r) => (r.concurrentSessions > 1 ? 'bg-amber-50/50' : undefined)}
        columns={[
          {
            key: 'fullName',
            header: 'Account signed in',
            render: (r) => (
              <div>
                <div className="flex items-center gap-1.5 font-medium">
                  {r.fullName}
                  {r.isCurrent && <Badge>this session</Badge>}
                </div>
                <div className="font-mono text-[11.5px] text-ink-500">{r.username}</div>
              </div>
            ),
          },
          { key: 'roleName', header: t('Role') },
          { key: 'branchName', header: t('Branch'), render: (r) => r.branchName ?? 'All branches' },
          { key: 'loginAt', header: 'Logged in', render: (r) => <span title={dateTime(r.loginAt, lang)}>{time(r.loginAt, lang)} <span className="text-ink-400">· {dateTime(r.loginAt, lang).split(',')[0]}</span></span> },
          { key: 'lastActivityAt', header: 'Last activity', render: (r) => <span title={dateTime(r.lastActivityAt, lang)}>{relative(r.lastActivityAt)}</span> },
          { key: 'currentModule', header: 'Current module', render: (r) => (r.status === 'ACTIVE' ? <span className="rounded bg-canvas px-1.5 py-0.5 text-[12px]">{humanize(r.currentModule)}</span> : '—') },
          {
            key: 'device',
            header: 'Device / browser',
            render: (r) => (
              <div className="text-[12.5px]">
                {r.device}
                {r.isSimulated && <div className="text-[10.5px] text-ink-400">demo presence (simulated)</div>}
              </div>
            ),
          },
          { key: 'ipAddress', header: 'IP address', render: (r) => <Mono className="text-ink-600">{r.ipAddress}</Mono> },
          {
            key: 'presence',
            header: t('Status'),
            render: (r) => (
              <div className="flex flex-col items-start gap-1">
                {r.presence === 'ENDED' ? <StatusBadge status={r.status} /> : <StatusBadge status={r.presence} />}
                {r.concurrentSessions > 1 && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-800" title="The same account is signed in on more than one device">
                    <AlertTriangle className="size-3" /> {r.concurrentSessions} concurrent
                  </span>
                )}
              </div>
            ),
          },
          { key: 'ref', header: 'Session', render: (r) => <Mono className="text-[11.5px] text-ink-500">{r.ref}</Mono> },
          ...(can('sessions.revoke') && scope === 'active'
            ? [
                {
                  key: 'act',
                  header: '',
                  sortable: false,
                  render: (r: SessionRow) =>
                    !r.isCurrent && r.status === 'ACTIVE' ? (
                      <Button size="sm" variant="ghost" className="text-rose-700" icon={<PowerOff className="size-4" />} onClick={() => setRevoke(r)}>
                        End
                      </Button>
                    ) : null,
                },
              ]
            : []),
        ]}
      />
      <Dialog
        open={!!revoke}
        onClose={() => setRevoke(null)}
        title={`End session of ${revoke?.username}?`}
        subtitle={`${revoke?.device} · ${revoke?.ipAddress}. The user will be signed out on that device.`}
        footer={<><Button onClick={() => setRevoke(null)}>{t('Cancel')}</Button><Button variant="danger" loading={m.isPending} onClick={() => revoke && m.mutate(revoke)}>End session</Button></>}
      >
        <p className="text-[13px] text-ink-600">Recorded as SESSION_REVOKED in the audit log.</p>
      </Dialog>
    </>
  );
}

export function SessionsPage() {
  const { t } = useI18n();
  const [scope, setScope] = useState<'active' | 'recent'>('active');
  const [branchId, setBranchId] = useState<number | undefined>();
  const summary = useQuery({ queryKey: ['sessions', 'active', branchId, undefined], queryFn: () => get<SessionRow[]>('/sessions', { scope: 'active', branchId }), refetchInterval: 15_000 });
  const s = summary.data ?? [];
  const concurrent = new Set(s.filter((x) => x.concurrentSessions > 1).map((x) => x.username));
  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={<span className="flex items-center gap-2.5"><MonitorSmartphone className="size-6 text-ink-500" /> {t('Active Users')}</span>}
        subtitle="Who is signed in right now, from which device, and what they are working on. Always shows the account that actually signed in."
        actions={<BranchSelect value={branchId} onChange={setBranchId} className="w-44" />}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Signed in now" value={s.length} icon={<MonitorSmartphone className="size-4" />} />
        <Kpi label="Active (last few min)" value={s.filter((x) => x.presence === 'ACTIVE').length} />
        <Kpi label="Idle" value={s.filter((x) => x.presence === 'IDLE').length} />
        <Kpi label="Accounts on 2+ devices" value={concurrent.size} tone={concurrent.size ? 'gold' : 'default'} />
      </div>
      {concurrent.size > 0 && (
        <Alert tone="warning" icon={<AlertTriangle className="size-4" />} className="mb-4" title="Same account signed in on multiple devices">
          {[...concurrent].join(', ')}: this may indicate shared credentials. Every action is attributed to the account that performed it.
        </Alert>
      )}
      <Card padded={false}>
        <Tabs className="px-3" value={scope} onChange={setScope} tabs={[{ value: 'active', label: t('Active Sessions') }, { value: 'recent', label: 'Last 7 days' }]} />
        <SessionsTable branchId={branchId} scope={scope} />
      </Card>
      <p className={clsx('mt-3 flex items-center gap-1.5 text-[12px] text-ink-500')}>
        <Eye className="size-3.5" /> Transparent monitoring: every user can see their own session details in the user menu. Only sign-in metadata and the current module are recorded. No screen or keystroke capture.
      </p>
    </div>
  );
}
