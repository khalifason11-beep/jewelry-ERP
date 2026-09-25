import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Coins, Info, RefreshCw, WifiOff } from 'lucide-react';
import { get } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, grams, money, relative, signedGrams } from '../../lib/format';
import { useBranches } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import type { WithdrawalList } from '../../lib/types';
import { Alert, Button, Card, ErrorState, Loading, Mono, PageHeader, Select, StatusBadge, Tabs } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';

type Tab = 'open' | 'COMPLETED' | 'CANCELLED' | 'all';

export function HasadListPage() {
  const { t, L, lang } = useI18n();
  const { isGlobal } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('open');
  const [branchId, setBranchId] = useState<number | ''>('');
  const branches = useBranches();

  const q = useQuery({
    queryKey: ['hasad', 'list', branchId],
    queryFn: () => get<WithdrawalList>('/hasad/withdrawals', { branchId }),
    refetchInterval: 15_000,
  });
  const all = q.data?.withdrawals ?? [];
  const rows = all.filter((w) => (tab === 'all' ? true : tab === 'open' ? w.status === 'READY_FOR_PICKUP' || w.status === 'IN_PROGRESS' : w.status === tab));

  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <Coins className="size-6 text-gold-600" /> {t('Hasad Withdrawals')}
          </span>
        }
        subtitle={t('Gold withdrawal requests sent by the Hasad Gold app. The customer chooses the actual piece at the counter.')}
        actions={
          <>
            {isGlobal && (
              <Select value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : '')} className="w-44">
                <option value="">{t('All branches')}</option>
                {branches.data?.map((b) => (
                  <option key={b.id} value={b.id}>{L(b.name, b.nameAr)}</option>
                ))}
              </Select>
            )}
            <Button icon={<RefreshCw className="size-4" />} onClick={() => q.refetch()} loading={q.isFetching}>
              {t('Refresh')}
            </Button>
          </>
        }
      />

      <Alert tone="gold" icon={<Info className="size-4 text-gold-700" />} className="mb-4">
        <b>{t('Receiving a withdrawal request never touches inventory.')}</b>{' '}
        {t('A piece is only reserved when the customer, at the counter, picks it. The weight difference against the entitlement is then settled in cash.')}
      </Alert>

      {q.data?.syncError && (
        <Alert tone="warning" icon={<WifiOff className="size-4" />} className="mb-4" title={t('Hasad Gold is not reachable')}>
          {t(q.data.syncError)}. {t('Showing requests already received. New requests will appear when the connection is restored.')}
        </Alert>
      )}

      <Card padded={false}>
        <Tabs<Tab>
          className="px-3"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'open', label: t('Waiting for customer'), count: all.filter((w) => w.status === 'READY_FOR_PICKUP' || w.status === 'IN_PROGRESS').length },
            { value: 'COMPLETED', label: t('COMPLETED'), count: all.filter((w) => w.status === 'COMPLETED').length },
            { value: 'CANCELLED', label: t('CANCELLED'), count: all.filter((w) => w.status === 'CANCELLED').length },
            { value: 'all', label: t('All'), count: all.length },
          ]}
        />
        {q.isLoading ? (
          <Loading />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/hasad/${r.id}`)}
            exportName="hasad-withdrawals"
            emptyTitle={tab === 'open' ? t('No customers waiting') : t('Nothing to show')}
            emptyBody={tab === 'open' ? t('New Hasad Gold requests for this branch appear here automatically.') : undefined}
            initialSort={undefined}
            columns={[
              { key: 'externalId', header: t('Withdrawal'), render: (r) => <Mono className="font-semibold text-ink-900">{r.externalId}</Mono> },
              {
                key: 'customerName',
                header: t('Customer'),
                render: (r) => (
                  <div>
                    <div className="font-medium">{L(r.customerName, r.customerNameAr)}</div>
                    <div className="font-mono text-[11px] text-ink-500">{r.hasadCustomerId}</div>
                  </div>
                ),
              },
              ...(isGlobal ? [{ key: 'branchName', header: t('Branch'), render: (r: (typeof rows)[number]) => L(r.branchName, r.branchNameAr) }] : []),
              { key: 'entitledWeightMg', header: t('Entitled weight'), align: 'end' as const, render: (r) => <span className="font-semibold num">{grams(r.entitledWeightMg)}</span> },
              { key: 'requestedAt', header: t('Requested'), value: (r) => r.requestedAt, render: (r) => <span title={dateTime(r.requestedAt, lang)}>{relative(r.requestedAt)}</span> },
              {
                key: 'inventory',
                header: t('Inventory impact'),
                sortable: false,
                value: (r) => r.reservedCount,
                render: (r) =>
                  r.status === 'COMPLETED' ? (
                    <span className="text-ink-600">{t('Delivered {weight}', { weight: grams(r.deliveredWeightMg) })}</span>
                  ) : r.reservedCount > 0 ? (
                    <span className="text-amber-700">{t('{n} piece(s) reserved', { n: r.reservedCount })}</span>
                  ) : (
                    <span className="text-ink-400">{t('None')}</span>
                  ),
              },
              {
                key: 'settlementAmount',
                header: t('Settlement'),
                align: 'end' as const,
                render: (r) =>
                  r.status === 'COMPLETED' && r.deliveredWeightMg != null ? (
                    <div>
                      <div className="text-[12px] text-ink-500 num">{signedGrams(r.deliveredWeightMg - r.entitledWeightMg)}</div>
                      <div className={r.settlementDirection === 'BRANCH_PAYS_CUSTOMER' ? 'text-rose-700 num' : 'text-emerald-700 num'}>
                        {r.settlementDirection === 'NONE' ? '—' : `${r.settlementDirection === 'BRANCH_PAYS_CUSTOMER' ? '−' : '+'}${money(r.settlementAmount)}`}
                      </div>
                    </div>
                  ) : (
                    '—'
                  ),
              },
              { key: 'status', header: t('Status'), render: (r) => <StatusBadge status={r.status} /> },
            ]}
          />
        )}
      </Card>
      {q.data && (
        <div className="mt-2 text-end text-[11.5px] text-ink-400">
          {t('Source: Hasad Gold API ({mode}) · last synced {when}', { mode: q.data.mode === 'MOCK' ? t('mock service') : t('live'), when: relative(q.data.syncedAt) })}
        </div>
      )}
    </div>
  );
}
