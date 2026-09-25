// Demo tool: plays the role of a customer using the Hasad Gold app, and shows the calls
// the ERP makes to the (mock) Hasad API. Not part of the future production scope.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Send, Smartphone } from 'lucide-react';
import { get, post } from '../../lib/api';
import { dateTime, karatLabel } from '../../lib/format';
import { useBranches } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Loading, Mono, PageHeader, Select } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';

interface Ent {
  customer: { customerId: string; fullName: string; fullNameAr?: string; phone?: string };
  balanceGrams: string;
  withdrawableGrams: string;
  minimumWithdrawalGrams: string;
  karat: number;
}
interface Call {
  id: number;
  at: string;
  operation: string;
  request: unknown;
  responseStatus: number;
  response: unknown;
  durationMs: number;
}

export function HasadSimulatorPage() {
  const { t, L, lang } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const branches = useBranches();
  const customers = useQuery({ queryKey: ['sim', 'customers'], queryFn: () => get<Ent[]>('/hasad/simulator/customers') });
  const calls = useQuery({ queryKey: ['sim', 'calls'], queryFn: () => get<Call[]>('/hasad/integration-log'), refetchInterval: 5000 });
  const [customerId, setCustomerId] = useState('');
  const [branchId, setBranchId] = useState<number | ''>(1);
  const [weight, setWeight] = useState('');
  const selected = customers.data?.find((c) => c.customer.customerId === customerId);

  const send = useMutation({
    mutationFn: () => post<{ withdrawalId: string }>('/hasad/simulator/withdrawals', { customerId, branchId, weightMg: weight ? Math.round(Number(weight) * 1000) : undefined }),
    onSuccess: (w) => {
      toast.success(t('Withdrawal {id} sent to the ERP', { id: w.withdrawalId }), t('It now appears in the branch’s Hasad queue. No inventory was reserved.'));
      qc.invalidateQueries();
      setWeight('');
    },
    onError: (e) => toast.fromError(e, t('Hasad rejected the request')),
  });

  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={<span className="flex items-center gap-2.5"><FlaskConical className="size-6 text-gold-600" /> {t('Hasad Gold simulator')}</span>}
        subtitle={t('Demo tool standing in for the Hasad Gold customer app and API. It will be replaced by the real integration.')}
      />
      <Alert tone="gold" className="mb-5">
        {t('The ERP only talks to Hasad through the HasadService interface (get / list / entitlement / complete / cancel). Today a mock service answers those calls. The log below shows every call the ERP makes.')}
      </Alert>
      <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
        <Card padded={false}>
          <CardHeader title={<span className="flex items-center gap-2"><Smartphone className="size-4" /> {t('Customer requests a withdrawal')}</span>} />
          <div className="space-y-3 p-5">
            <Field label={t('Hasad customer')}>
              <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">{t('Select…')}</option>
                {customers.data?.map((c) => (
                  <option key={c.customer.customerId} value={c.customer.customerId}>
                    {L(c.customer.fullName, c.customer.fullNameAr)} · {t('balance {weight} g', { weight: c.balanceGrams })}
                  </option>
                ))}
              </Select>
            </Field>
            {selected && (
              <div className="rounded-md bg-canvas px-3 py-2 text-[12.5px] text-ink-600">
                {t('Balance {balance} g ({karat}) · withdrawable {withdrawable} g · minimum {minimum} g', {
                  balance: selected.balanceGrams,
                  karat: karatLabel(selected.karat),
                  withdrawable: selected.withdrawableGrams,
                  minimum: selected.minimumWithdrawalGrams,
                })}
              </div>
            )}
            <Field label={t('Pickup branch')}>
              <Select value={branchId} onChange={(e) => setBranchId(Number(e.target.value))}>
                {branches.data?.map((b) => <option key={b.id} value={b.id}>{L(b.name, b.nameAr)}</option>)}
              </Select>
            </Field>
            <Field label={t('Weight to withdraw (g)')} hint={t('Leave empty to withdraw the full balance')}>
              <Input type="number" step="0.001" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder={selected?.balanceGrams} />
            </Field>
            <Button variant="gold" className="w-full" icon={<Send className="size-4" />} disabled={!customerId || !branchId} loading={send.isPending} onClick={() => send.mutate()}>
              {t('Send withdrawal request to ERP')}
            </Button>
            <p className="text-[12px] text-ink-500">
              {t('Then open')}{' '}
              <Link to="/hasad" className="text-gold-700 underline">
                {t('Hasad Withdrawals')}
              </Link>{' '}
              {t('or sign in as the branch cashier.')}
            </p>
          </div>
        </Card>
        <Card padded={false}>
          <CardHeader title={t('Integration log')} subtitle={t('Calls from the ERP to the Hasad Gold API (mock)')} />
          {calls.isLoading ? (
            <Loading />
          ) : (
            <DataTable
              rows={calls.data ?? []}
              rowKey={(r) => r.id}
              dense
              maxHeight="520px"
              emptyTitle={t('No calls yet')}
              columns={[
                { key: 'at', header: t('Time'), render: (r) => <span className="whitespace-nowrap">{dateTime(r.at, lang)}</span> },
                { key: 'operation', header: t('Operation'), render: (r) => <Mono>{r.operation}</Mono> },
                {
                  key: 'responseStatus',
                  header: t('Status'),
                  render: (r) => <Badge tone={r.responseStatus < 300 ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : 'bg-rose-50 text-rose-700 ring-rose-600/20'}>{r.responseStatus}</Badge>,
                },
                { key: 'durationMs', header: t('ms'), align: 'end' },
                { key: 'request', header: t('Payload'), sortable: false, value: (r) => JSON.stringify(r.request ?? r.response), render: (r) => <span className="line-clamp-1 max-w-[340px] font-mono text-[11px] text-ink-500">{JSON.stringify(r.request ?? r.response)}</span> },
              ]}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
