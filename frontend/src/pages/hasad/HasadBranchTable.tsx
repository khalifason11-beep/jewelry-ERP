import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import { dateTime, grams, money } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import type { WithdrawalList } from '../../lib/types';
import { ErrorState, Loading, Mono, StatusBadge } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';

/** All Hasad withdrawals of one branch (used in the branch drill-down). */
export function HasadBranchTable({ branchId }: { branchId: number }) {
  const { t, L, lang } = useI18n();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['hasad', 'list', branchId], queryFn: () => get<WithdrawalList>('/hasad/withdrawals', { branchId }) });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} />;
  const rows = q.data!.withdrawals;
  const done = rows.filter((r) => r.status === 'COMPLETED');
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.id}
      onRowClick={(r) => navigate(`/hasad/${r.id}`)}
      exportName="hasad"
      columns={[
        { key: 'externalId', header: 'Withdrawal', render: (r) => <Mono className="font-semibold">{r.externalId}</Mono> },
        { key: 'customerName', header: t('Customer'), render: (r) => L(r.customerName, r.customerNameAr) },
        { key: 'requestedAt', header: 'Requested', render: (r) => dateTime(r.requestedAt, lang) },
        { key: 'entitledWeightMg', header: t('Entitled weight'), align: 'end', render: (r) => <span className="num">{grams(r.entitledWeightMg)}</span> },
        { key: 'deliveredWeightMg', header: t('Delivered weight'), align: 'end', render: (r) => <span className="num">{grams(r.deliveredWeightMg)}</span>, footer: grams(done.reduce((s, r) => s + (r.deliveredWeightMg ?? 0), 0)) },
        { key: 'settlementDirection', header: t('Settlement'), render: (r) => (r.settlementDirection ? <StatusBadge status={r.settlementDirection} /> : '—') },
        { key: 'settlementAmount', header: t('Amount'), align: 'end', render: (r) => <span className="num">{r.settlementAmount != null ? money(r.settlementAmount, false) : '—'}</span> },
        { key: 'completedByName', header: t('Cashier'), render: (r) => r.completedByName ?? r.openedByName ?? '—' },
        { key: 'status', header: t('Status'), render: (r) => <StatusBadge status={r.status} /> },
      ]}
    />
  );
}
