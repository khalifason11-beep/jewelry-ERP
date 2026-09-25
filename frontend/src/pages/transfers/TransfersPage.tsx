import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, PackageCheck, Plus } from 'lucide-react';
import { get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, grams } from '../../lib/format';
import { useBranchDirectory, useBranches } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import type { ItemRow } from '../../lib/types';
import { Button, Card, Dialog, Empty, ErrorState, Field, Loading, Mono, PageHeader, Select, StatusBadge, Textarea } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';

interface TransferRow {
  id: number;
  number: string;
  fromBranchId: number;
  toBranchId: number;
  fromBranchName: string;
  toBranchName: string;
  status: string;
  notes: string | null;
  createdAt: string;
  createdByName: string;
  receivedAt: string | null;
  receivedByName: string | null;
  itemCount: number;
  weightMg: number;
  items: { code: string; productName: string; netWeightMg: number }[];
}

export function TransfersPage() {
  const { t, lang } = useI18n();
  const { me, isGlobal } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['transfers'], queryFn: () => get<TransferRow[]>('/transfers') });
  const receive = useMutation({
    mutationFn: (id: number) => post(`/transfers/${id}/receive`),
    onSuccess: () => {
      toast.success(t('Transfer received'), t('Pieces are now AVAILABLE in your branch (TRANSFER_IN).'));
      qc.invalidateQueries();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={t('Transfers')}
        subtitle={t('Two-step inter-branch transfers: sent pieces are in transit (TRANSFERRED) until the receiving branch confirms.')}
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>{t('New transfer')}</Button>}
      />
      <Card padded={false}>
        {q.isLoading ? (
          <Loading />
        ) : q.isError ? (
          <ErrorState error={q.error} />
        ) : (
          <DataTable
            rows={q.data!}
            rowKey={(r) => r.id}
            exportName="transfers"
            emptyTitle={t('No transfers yet')}
            columns={[
              { key: 'number', header: t('Transfer'), render: (r) => <Mono className="font-semibold text-ink-900">{r.number}</Mono> },
              { key: 'createdAt', header: t('Sent'), render: (r) => dateTime(r.createdAt, lang) },
              { key: 'route', header: t('Route'), value: (r) => `${r.fromBranchName} → ${r.toBranchName}`, render: (r) => <span className="inline-flex items-center gap-1.5">{t(r.fromBranchName)} <ArrowRight className="size-3.5 text-ink-400 rtl:rotate-180" /> {t(r.toBranchName)}</span> },
              { key: 'items', header: t('Items'), value: (r) => r.items.map((i) => i.code).join(' '), render: (r) => <span className="text-[12px]"><Mono>{r.items.map((i) => i.code).join(', ')}</Mono></span> },
              { key: 'weightMg', header: t('Net weight'), align: 'end', render: (r) => <span className="num">{grams(r.weightMg)}</span> },
              { key: 'createdByName', header: t('Sent by') },
              { key: 'receivedAt', header: t('Received'), render: (r) => (r.receivedAt ? `${dateTime(r.receivedAt, lang)} · ${r.receivedByName}` : '—') },
              {
                key: 'status',
                header: t('Status'),
                render: (r) =>
                  r.status === 'IN_TRANSIT' && (isGlobal || me?.user.branch?.id === r.toBranchId) ? (
                    <Button size="sm" variant="success" icon={<PackageCheck className="size-4" />} loading={receive.isPending && receive.variables === r.id} onClick={() => receive.mutate(r.id)}>
                      {t('Confirm receipt')}
                    </Button>
                  ) : (
                    <StatusBadge status={r.status} />
                  ),
              },
            ]}
          />
        )}
      </Card>
      {open && <NewTransferDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function NewTransferDialog({ onClose }: { onClose: () => void }) {
  const { me, isGlobal } = useAuth();
  const { t, L } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const branches = useBranches();
  const directory = useBranchDirectory();
  const [from, setFrom] = useState<number | ''>(me?.user.branch?.id ?? '');
  const [to, setTo] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const items = useQuery({
    queryKey: ['transfer-items', from],
    queryFn: () => get<{ items: ItemRow[] }>('/inventory/items', { branchId: from, status: 'AVAILABLE', sort: 'code', limit: 500 }),
    enabled: !!from,
  });
  const m = useMutation({
    mutationFn: () => post<{ number: string }>('/transfers', { fromBranchId: from || undefined, toBranchId: to, itemIds: [...selected], notes }),
    onSuccess: (r) => {
      toast.success(t('Transfer {number} sent', { number: r.number }), t('{n} piece(s) are now in transit.', { n: selected.size }));
      qc.invalidateQueries();
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('New inter-branch transfer')}
      width="max-w-3xl"
      footer={<><span className="me-auto text-[13px] text-ink-600">{t('{n} piece(s) selected', { n: selected.size })}</span><Button onClick={onClose}>{t('Cancel')}</Button><Button variant="primary" disabled={!to || !selected.size} loading={m.isPending} onClick={() => m.mutate()}>{t('Send transfer')}</Button></>}
    >
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <Field label={t('From')}>
          <Select value={from} disabled={!isGlobal} onChange={(e) => { setFrom(e.target.value ? Number(e.target.value) : ''); setSelected(new Set()); }}>
            <option value="">{t('Select…')}</option>
            {branches.data?.map((b) => <option key={b.id} value={b.id}>{L(b.name, b.nameAr)}</option>)}
          </Select>
        </Field>
        <Field label={t('To')}>
          <Select value={to} onChange={(e) => setTo(e.target.value ? Number(e.target.value) : '')}>
            <option value="">{t('Select…')}</option>
            {directory.data?.filter((b) => b.id !== from).map((b) => <option key={b.id} value={b.id}>{L(b.name, b.nameAr)}</option>)}
          </Select>
        </Field>
      </div>
      <div className="scroll-thin max-h-72 overflow-y-auto rounded-md border border-line">
        {!from ? (
          <Empty title={t('Select the sending branch')} />
        ) : items.isLoading ? (
          <Loading />
        ) : (
          <ul className="divide-y divide-line">
            {items.data?.items.map((i) => (
              <li key={i.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[13px] hover:bg-canvas">
                  <input type="checkbox" className="size-4 accent-ink-900" checked={selected.has(i.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(i.id); else n.delete(i.id); return n; })} />
                  <Mono className="w-16">{i.code}</Mono>
                  <span className="flex-1 truncate">{L(i.productName, i.productNameAr)} · {i.karat}K</span>
                  <span className="num">{grams(i.netWeightMg)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Field label={t('Notes')} className="mt-3">
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </Dialog>
  );
}
