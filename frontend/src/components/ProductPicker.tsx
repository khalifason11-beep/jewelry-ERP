// One "pick or create a product" control for both ways a piece enters stock (UX-1 PART 4, D-ux1-5): the supplier
// order line and the sellable scrap purchase.
//   * ProductPicker: one searchable list (type to filter; أ/ا, ى/ي, digits match through the shared normalizeName),
//     products picked recently in this browser first, then by name; ↑ ↓ Enter Esc. When the typed name matches no
//     product and the user may create products (`catalog.create`), the last option is: Create "<name>".
//   * NewProductPanel: the small panel that option opens, in the form (not a dialog): Arabic name (pre-filled),
//     optional English name, karat (fixed when the scrap karat is chosen, otherwise a select), type (the last one used
//     first, or "New type" with a text field). One confirm creates the type if needed, then the product, through the
//     existing routes (unique names, length, permission and audit are the server's), and selects it.
// The Types & products page and its dialogs (Catalog.tsx) stay as they are.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, Plus } from 'lucide-react';
import { normalizeName } from '@jerp/shared';
import { ApiError, errorText, postOnce } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCategories } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { useActionKeys } from '../lib/idempotency';
import { karatLabel } from '../lib/format';
import type { Category, Product } from '../lib/types';
import { Alert, Button, Field, Input, Select, controlClass } from './ui';

const RECENT_KEY = 'jerp.recentProducts';
const LAST_TYPE_KEY = 'jerp.lastProductType';

// Browser storage is a convenience only: unavailable (private window, blocked) means no "recent" order.
function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not available */
  }
}
export function rememberProduct(id: number) {
  writeJson(RECENT_KEY, [id, ...readJson<number[]>(RECENT_KEY, []).filter((x) => x !== id)].slice(0, 30));
}

export function ProductPicker({
  products,
  value,
  onChange,
  onCreate,
  disabled,
  compact,
  invalid,
  testId,
  'aria-describedby': describedBy,
}: {
  products: Product[] | undefined;
  value: number | '';
  onChange: (id: number) => void;
  /** Called with the typed name when the person chooses Create "<name>" (absent: no create option). */
  onCreate?: (name: string) => void;
  disabled?: boolean;
  compact?: boolean;
  invalid?: boolean;
  testId: string;
  'aria-describedby'?: string;
}) {
  const { t, L } = useI18n();
  const { can } = useAuth();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // null = not typing: the field shows the chosen product and the list shows every product.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const selected = products?.find((p) => p.id === value);
  const label = (p: Product) => `${L(p.name, p.nameAr)} · ${karatLabel(p.karat)} · ${L(p.categoryName, p.categoryNameAr)}`;

  const options = useMemo(() => {
    const all = products ?? [];
    const q = normalizeName(query ?? '');
    const recent = readJson<number[]>(RECENT_KEY, []);
    const rank = (p: Product) => {
      const i = recent.indexOf(p.id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const match = (p: Product) => !q || [p.nameAr, p.name, p.categoryNameAr, p.categoryName].some((s) => normalizeName(s).includes(q));
    return all.filter(match).sort((a, b) => rank(a) - rank(b) || L(a.name, a.nameAr).localeCompare(L(b.name, b.nameAr)));
  }, [products, query, L]);
  const typed = (query ?? '').trim();
  const exact = !!typed && (products ?? []).some((p) => normalizeName(p.nameAr) === normalizeName(typed) || normalizeName(p.name) === normalizeName(typed));
  const canCreate = !!onCreate && can('catalog.create') && typed.length >= 2 && !exact;
  const count = options.length + (canCreate ? 1 : 0);

  const close = () => {
    setOpen(false);
    setQuery(null);
  };
  const choose = (p: Product) => {
    rememberProduct(p.id);
    onChange(p.id);
    close();
  };
  const create = () => {
    onCreate?.(typed);
    close();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((a) => (count ? (a + (e.key === 'ArrowDown' ? 1 : count - 1)) % count : 0));
    } else if (e.key === 'Enter' && open) {
      // Enter picks the highlighted option; with nothing to pick it falls through to the form's "next field".
      if (active < options.length) {
        e.preventDefault();
        e.stopPropagation();
        choose(options[active]);
      } else if (canCreate) {
        e.preventDefault();
        e.stopPropagation();
        create();
      }
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close();
    }
  };

  return (
    <div className="relative">
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && count ? `${listId}-${active}` : undefined}
        aria-label={t('Product')}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        disabled={disabled}
        placeholder={products?.length === 0 ? t('No products yet: type a name to create one') : t('Type to search…')}
        value={query ?? (selected ? label(selected) : '')}
        onFocus={(e) => {
          setOpen(true);
          setActive(0);
          e.currentTarget.select();
        }}
        onBlur={close}
        onChange={(e) => {
          setOpen(true);
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className={clsx(controlClass, compact ? 'h-11 md:h-9 text-[13px]' : 'h-11 md:h-10', 'w-full pe-8')}
        data-testid={testId}
        data-value={value === '' ? '' : String(value)}
      />
      <ChevronDown className="pointer-events-none absolute inset-y-0 end-2.5 my-auto size-4 text-ink-3" aria-hidden />
      {open && (
        <ul id={listId} role="listbox" className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 min-w-64 overflow-y-auto rounded-control border border-line-strong bg-surface py-1 shadow-pop" data-testid={`${testId}-list`}>
          {options.map((p, i) => (
            <li
              key={p.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(p)}
              onMouseEnter={() => setActive(i)}
              className={clsx('cursor-pointer px-3 py-2.5 text-[13px] md:py-1.5', i === active && 'bg-panel')}
            >
              {label(p)}
            </li>
          ))}
          {canCreate && (
            <li
              id={`${listId}-${options.length}`}
              role="option"
              aria-selected={active === options.length}
              onMouseDown={(e) => e.preventDefault()}
              onClick={create}
              onMouseEnter={() => setActive(options.length)}
              className={clsx('flex cursor-pointer items-center gap-1.5 border-t border-line px-3 py-2.5 text-[13px] font-medium text-gold-700 md:py-1.5', active === options.length && 'bg-panel')}
              data-testid={`${testId}-create`}
            >
              <Plus className="size-4" />
              {t('Create “{name}”', { name: typed })}
            </li>
          )}
          {count === 0 && <li className="px-3 py-2 text-[13px] text-ink-3">{typed ? t('No product matches “{name}”', { name: typed }) : t('No products yet: type a name to create one')}</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * The inline "new product" panel. `karat` fixes the karat (the scrap piece's); otherwise the allowed karats are offered.
 * Calls `onCreated` with the product (new, or the existing one the person chose to use instead).
 */
export function NewProductPanel({ name: initialName, karat: fixedKarat, onCreated, onCancel, testId = 'inline-product' }: { name: string; karat?: number; onCreated: (p: Product) => void; onCancel: () => void; testId?: string }) {
  const { t, L } = useI18n();
  const { me } = useAuth();
  const qc = useQueryClient();
  const keys = useActionKeys();
  const categories = useCategories();
  const karats = me?.allowedKarats ?? [];
  const lastType = readJson<number | null>(LAST_TYPE_KEY, null);
  const [nameAr, setNameAr] = useState(initialName);
  const [name, setName] = useState('');
  const [karat, setKarat] = useState<number | ''>(fixedKarat ?? (karats.length === 1 ? karats[0] : ''));
  const [typeId, setTypeId] = useState<number | 'new' | ''>('');
  const [typeName, setTypeName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<Product | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  // Default type: the last one used, when it still exists; "New type" when there is none yet.
  useEffect(() => {
    if (typeId !== '' || !categories.data) return;
    if (categories.data.length === 0) setTypeId('new');
    else if (lastType && categories.data.some((c) => c.id === lastType)) setTypeId(lastType);
  }, [categories.data, lastType, typeId]);
  useEffect(() => {
    if (fixedKarat != null) setKarat(fixedKarat);
  }, [fixedKarat]);

  const valid = nameAr.trim().length >= 2 && karat !== '' && (typeId === 'new' ? typeName.trim().length >= 2 : typeId !== '');
  const submit = async () => {
    setBusy(true);
    setError(null);
    setExisting(null);
    try {
      let categoryId = typeId as number;
      if (typeId === 'new') {
        try {
          const c = await postOnce<Category>('/categories', { nameAr: typeName, name: null }, keys.for('/categories'));
          keys.rotate('/categories');
          categoryId = c.id;
        } catch (e) {
          keys.rotate('/categories');
          // The type already exists under another spelling: use it (the server says which).
          const found = e instanceof ApiError && e.status === 409 ? (e.details as { existing?: Category } | undefined)?.existing : undefined;
          if (!found) throw e;
          categoryId = found.id;
        }
        await qc.invalidateQueries({ queryKey: ['categories'] });
        setTypeId(categoryId);
        setTypeName('');
      }
      const p = await postOnce<Product>('/products', { nameAr, name: name || null, karat, categoryId }, keys.for('/products'));
      keys.rotate('/products');
      writeJson(LAST_TYPE_KEY, categoryId);
      await qc.invalidateQueries({ queryKey: ['products'] });
      rememberProduct(p.id);
      onCreated(p);
    } catch (e) {
      keys.rotate('/products');
      setError(errorText(e));
      const found = e instanceof ApiError && e.status === 409 ? (e.details as { existing?: Product } | undefined)?.existing : undefined;
      if (found) setExisting(found);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-control border border-gold-300 bg-gold-50/40 p-3" data-testid={testId}>
      <p className="mb-2 text-meta font-medium text-ink-2">{t('New product')}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('Name in Arabic (required)')}>
          <Input ref={first} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} maxLength={80} data-testid={`${testId}-name-ar`} />
        </Field>
        <Field label={t('Name in English (optional)')}>
          <Input dir="ltr" lang="en" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-testid={`${testId}-name-en`} />
        </Field>
        <Field label={t('Karat')}>
          {fixedKarat != null ? (
            <Input value={karatLabel(fixedKarat)} readOnly data-testid={`${testId}-karat-fixed`} />
          ) : (
            <Select value={karat} onChange={(e) => setKarat(e.target.value ? Number(e.target.value) : '')} data-testid={`${testId}-karat`}>
              <option value="">{t('Select…')}</option>
              {karats.map((k) => <option key={k} value={k}>{karatLabel(k)}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('Type')}>
          <Select value={typeId} onChange={(e) => setTypeId(e.target.value === 'new' ? 'new' : e.target.value ? Number(e.target.value) : '')} data-testid={`${testId}-type`}>
            <option value="">{t('Select…')}</option>
            {categories.data?.map((c) => <option key={c.id} value={c.id}>{L(c.name, c.nameAr)}</option>)}
            <option value="new">{t('+ New type…')}</option>
          </Select>
        </Field>
        {typeId === 'new' && (
          <Field label={t('New type name (Arabic)')} hint={t('A kind of piece, such as rings or bracelets.')} className="sm:col-span-2">
            <Input dir="rtl" lang="ar" value={typeName} onChange={(e) => setTypeName(e.target.value)} maxLength={80} data-testid={`${testId}-type-name`} />
          </Field>
        )}
      </div>
      {error && (
        <Alert tone={existing ? 'warning' : 'danger'} className="mt-3">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>{error}</span>
            {existing && (
              <Button size="sm" onClick={() => { rememberProduct(existing.id); onCreated(existing); }} data-testid={`${testId}-use-existing`}>
                {t('Use {name}', { name: L(existing.name, existing.nameAr) })}
              </Button>
            )}
          </span>
        </Alert>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button size="sm" onClick={onCancel}>{t('Cancel')}</Button>
        <Button size="sm" variant="primary" loading={busy} disabled={!valid} onClick={submit} data-testid={`${testId}-save`}>
          {t('Create and use')}
        </Button>
      </div>
    </div>
  );
}
