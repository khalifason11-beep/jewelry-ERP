// Types & products (CAT-0): every item type and product, with the dialogs to create them. A branch
// manager creates; only the General Manager deactivates or reactivates (with a reason). A deactivated
// product receives no new stock, but pieces already in stock still sell. Nothing is ever deleted.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { karatLabel } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import type { Category, Product } from '../../lib/types';
import { Badge, Button, Card, Dialog, ErrorState, Field, Input, Loading, Mono, PageHeader, Tabs } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';
import { NewProductDialog, NewTypeDialog } from '../../components/Catalog';

type Target = { kind: 'categories' | 'products'; id: number; label: string; active: boolean };

export function CatalogPage() {
  const { t, L } = useI18n();
  const { can } = useAuth();
  const manage = can('catalog.manage');
  const [tab, setTab] = useState<'products' | 'types'>('products');
  const [newType, setNewType] = useState(false);
  const [newProduct, setNewProduct] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  // The General Manager also sees deactivated rows, to reactivate them.
  const types = useQuery({ queryKey: ['categories', 'all', manage], queryFn: () => get<Category[]>('/categories', manage ? { includeInactive: 'true' } : {}) });
  const products = useQuery({ queryKey: ['products', 'all', manage], queryFn: () => get<Product[]>('/products', manage ? { includeInactive: 'true' } : {}) });

  const state = (active: boolean) => (active ? <Badge tone="ok">{t('Active')}</Badge> : <Badge>{t('Deactivated')}</Badge>);
  const toggle = (r: Target) =>
    manage && (
      <Button size="sm" variant="ghost" onClick={() => setTarget(r)} data-testid={`toggle-${r.kind}-${r.id}`}>
        {r.active ? t('Deactivate') : t('Reactivate')}
      </Button>
    );

  const q = tab === 'products' ? products : types;
  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={t('Types & products')}
        subtitle={t('What you stock. A type groups pieces (rings, bracelets…); a product is one design in one karat.')}
        actions={
          <>
            <Button icon={<Plus className="size-4" />} onClick={() => setNewType(true)} data-testid="new-type">{t('New type')}</Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setNewProduct(true)} data-testid="new-product">{t('New product')}</Button>
          </>
        }
      />
      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'products', label: t('Products'), count: products.data?.length },
          { value: 'types', label: t('Types'), count: types.data?.length },
        ]}
      />
      <Card padded={false}>
        {q.isLoading ? (
          <Loading />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : tab === 'products' ? (
          <DataTable
            rows={products.data!}
            rowKey={(r) => r.id}
            exportName="products"
            emptyTitle={t('No products yet')}
            columns={[
              { key: 'sku', header: t('Code'), render: (r) => <Mono>{r.sku}</Mono> },
              { key: 'name', header: t('Product'), value: (r) => L(r.name, r.nameAr), render: (r) => L(r.name, r.nameAr) },
              { key: 'karat', header: t('Karat'), render: (r) => karatLabel(r.karat) },
              { key: 'categoryName', header: t('Type'), value: (r) => L(r.categoryName, r.categoryNameAr), render: (r) => L(r.categoryName, r.categoryNameAr) },
              { key: 'isActive', header: t('Status'), value: (r) => (r.isActive ? t('Active') : t('Deactivated')), render: (r) => state(r.isActive) },
              ...(manage ? [{ key: 'actions', header: '', sortable: false, render: (r: Product) => toggle({ kind: 'products', id: r.id, label: L(r.name, r.nameAr), active: r.isActive }) }] : []),
            ]}
          />
        ) : (
          <DataTable
            rows={types.data!}
            rowKey={(r) => r.id}
            exportName="types"
            emptyTitle={t('No types yet')}
            columns={[
              { key: 'code', header: t('Code'), render: (r) => <Mono>{r.code}</Mono> },
              { key: 'name', header: t('Type'), value: (r) => L(r.name, r.nameAr), render: (r) => L(r.name, r.nameAr) },
              { key: 'isActive', header: t('Status'), value: (r) => (r.isActive ? t('Active') : t('Deactivated')), render: (r) => state(r.isActive) },
              ...(manage ? [{ key: 'actions', header: '', sortable: false, render: (r: Category) => toggle({ kind: 'categories', id: r.id, label: L(r.name, r.nameAr), active: r.isActive }) }] : []),
            ]}
          />
        )}
      </Card>
      {newType && <NewTypeDialog onClose={() => setNewType(false)} onCreated={() => setNewType(false)} />}
      {newProduct && <NewProductDialog onClose={() => setNewProduct(false)} onCreated={() => setNewProduct(false)} />}
      {target && <ActiveDialog target={target} onClose={() => setTarget(null)} />}
    </div>
  );
}

function ActiveDialog({ target, onClose }: { target: Target; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => post(`/${target.kind}/${target.id}/${target.active ? 'deactivate' : 'reactivate'}`, { reason }),
    onSuccess: () => {
      toast.success(target.active ? t('{name} deactivated', { name: target.label }) : t('{name} reactivated', { name: target.label }));
      qc.invalidateQueries({ queryKey: [target.kind] });
      qc.invalidateQueries({ queryKey: ['products'] });
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={target.active ? t('Deactivate {name}', { name: target.label }) : t('Reactivate {name}', { name: target.label })}
      subtitle={
        target.active
          ? target.kind === 'products'
            ? t('No new stock can be received for it. Pieces already in stock still sell.')
            : t('Its products disappear from the purchase forms. Pieces already in stock still sell.')
          : t('It can receive new stock again.')
      }
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant={target.active ? 'danger-solid' : 'primary'} disabled={reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate()} data-testid="confirm-toggle">
            {target.active ? t('Deactivate') : t('Reactivate')}
          </Button>
        </>
      }
    >
      <Field label={t('Reason')}>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} data-testid="toggle-reason" />
      </Field>
    </Dialog>
  );
}

