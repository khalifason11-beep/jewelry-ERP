// Catalog entry (CAT-0): the "New type", "New product" and "New supplier" dialogs. They open on top of
// the form that needs them (a supplier purchase line, a sellable scrap purchase, the supplier select)
// and hand the created row back, so an empty database can receive stock without leaving the form.
// The Arabic name is required and the English name optional (shown as the Arabic one when missing).
// A name that already exists — spelled differently (أ/ا, ى/ي, tatweel, digits…) — is refused by
// the server with the existing row, which the dialog offers to use instead.

import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { ApiError, errorText, get, postOnce } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCategories } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { useActionKeys } from '../lib/idempotency';
import { karatLabel } from '../lib/format';
import type { Category, Product, Supplier } from '../lib/types';
import { Alert, Button, Dialog, Field, Input, Select } from './ui';

export function useProducts() {
  return useQuery({ queryKey: ['products'], queryFn: () => get<Product[]>('/products'), staleTime: 60_000 });
}

export function useSuppliers(enabled = true) {
  return useQuery({ queryKey: ['suppliers'], queryFn: () => get<Supplier[]>('/suppliers'), staleTime: 60_000, enabled });
}

/** A small "+ New …" link-button placed next to a select. */
export function NewButton({ onClick, children, testId }: { onClick: () => void; children: ReactNode; testId?: string }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-gold-700 hover:underline">
      <Plus className="size-3.5" />
      {children}
    </button>
  );
}

/** Shared state of the three dialogs: submit once (idempotent), surface "already exists" with the row. */
function useCreate<T>(path: string, onCreated: (row: T) => void) {
  const qc = useQueryClient();
  const keys = useActionKeys();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<T | null>(null);
  const submit = async (body: unknown) => {
    setBusy(true);
    setError(null);
    setExisting(null);
    try {
      const row = await postOnce<T>(path, body, keys.for(path));
      keys.rotate(path);
      await qc.invalidateQueries({ queryKey: [path.slice(1)] });
      onCreated(row);
    } catch (e) {
      // A refused request changes nothing: the next attempt (corrected name) needs a new key.
      keys.rotate(path);
      setError(errorText(e));
      const found = e instanceof ApiError && e.status === 409 ? (e.details as { existing?: T } | undefined)?.existing : undefined;
      if (found) setExisting(found);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, existing, submit };
}

function NameFields({ nameAr, name, setNameAr, setName }: { nameAr: string; name: string; setNameAr: (v: string) => void; setName: (v: string) => void }) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t('Name in Arabic (required)')}>
        <Input dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} maxLength={80} required data-testid="name-ar" />
      </Field>
      <Field label={t('Name in English (optional)')} hint={t('Left empty, the Arabic name is shown everywhere.')}>
        <Input dir="ltr" lang="en" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-testid="name-en" />
      </Field>
    </>
  );
}

function Problem<T>({ error, existing, onUse, label }: { error: string | null; existing: T | null; onUse: (row: T) => void; label: string }) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <Alert tone={existing ? 'warning' : 'danger'} className="mt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{error}</span>
        {existing && (
          <Button size="sm" onClick={() => onUse(existing)} data-testid="use-existing">
            {t('Use {name}', { name: label })}
          </Button>
        )}
      </div>
    </Alert>
  );
}

export function NewTypeDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Category) => void }) {
  const { t, L } = useI18n();
  const [nameAr, setNameAr] = useState('');
  const [name, setName] = useState('');
  const c = useCreate<Category>('/categories', onCreated);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('New type')}
      subtitle={t('A kind of piece, such as rings or bracelets. Used to group stock and reports.')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" loading={c.busy} disabled={nameAr.trim().length < 2} onClick={() => c.submit({ nameAr, name: name || null })} data-testid="save-type">
            {t('Create type')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <NameFields nameAr={nameAr} name={name} setNameAr={setNameAr} setName={setName} />
      </div>
      <Problem error={c.error} existing={c.existing} onUse={onCreated} label={c.existing ? L(c.existing.name, c.existing.nameAr) : ''} />
    </Dialog>
  );
}

/**
 * New product (a sellable design): Arabic name, optional English name, karat and type. `karat` fixes the
 * karat (e.g. the karat of the scrap piece being bought); otherwise it is chosen from the karats sold.
 */
export function NewProductDialog({ onClose, onCreated, karat: fixedKarat }: { onClose: () => void; onCreated: (p: Product) => void; karat?: number }) {
  const { t, L } = useI18n();
  const { me } = useAuth();
  const categories = useCategories();
  const karats = me?.allowedKarats ?? [];
  const [nameAr, setNameAr] = useState('');
  const [name, setName] = useState('');
  const [karat, setKarat] = useState<number | ''>(fixedKarat ?? (karats.length === 1 ? karats[0] : ''));
  const [categoryId, setCategoryId] = useState<number | ''>('');
  const [newType, setNewType] = useState(false);
  const c = useCreate<Product>('/products', onCreated);
  const valid = nameAr.trim().length >= 2 && karat !== '' && categoryId !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('New product')}
      subtitle={t('A design you stock, such as “Cuban chain”. Every piece received belongs to one product.')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" loading={c.busy} disabled={!valid} onClick={() => c.submit({ nameAr, name: name || null, karat, categoryId })} data-testid="save-product">
            {t('Create product')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <NameFields nameAr={nameAr} name={name} setNameAr={setNameAr} setName={setName} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Karat')}>
            {fixedKarat != null ? (
              <Input value={karatLabel(fixedKarat)} disabled />
            ) : (
              <Select value={karat} onChange={(e) => setKarat(e.target.value ? Number(e.target.value) : '')} data-testid="product-karat">
                <option value="">{t('Select…')}</option>
                {karats.map((k) => <option key={k} value={k}>{karatLabel(k)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('Type')} hint={<NewButton testId="product-new-type" onClick={() => setNewType(true)}>{t('New type')}</NewButton>}>
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : '')} data-testid="product-type">
              <option value="">{categories.data?.length === 0 ? t('No types yet: create one') : t('Select…')}</option>
              {categories.data?.map((cat) => <option key={cat.id} value={cat.id}>{L(cat.name, cat.nameAr)}</option>)}
            </Select>
          </Field>
        </div>
      </div>
      <Problem error={c.error} existing={c.existing} onUse={onCreated} label={c.existing ? L(c.existing.name, c.existing.nameAr) : ''} />
      {newType && (
        <NewTypeDialog
          onClose={() => setNewType(false)}
          onCreated={(cat) => {
            setCategoryId(cat.id);
            setNewType(false);
          }}
        />
      )}
    </Dialog>
  );
}

export function NewSupplierDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Supplier) => void }) {
  const { t, L } = useI18n();
  const [nameAr, setNameAr] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const c = useCreate<Supplier>('/suppliers', onCreated);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('New supplier')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" loading={c.busy} disabled={nameAr.trim().length < 2} onClick={() => c.submit({ nameAr, name: name || null, phone: phone || null })} data-testid="save-supplier">
            {t('Add supplier')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <NameFields nameAr={nameAr} name={name} setNameAr={setNameAr} setName={setName} />
        <Field label={t('Phone (optional)')}>
          <Input dir="ltr" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />
        </Field>
      </div>
      <Problem error={c.error} existing={c.existing} onUse={onCreated} label={c.existing ? L(c.existing.name, c.existing.nameAr) : ''} />
    </Dialog>
  );
}
