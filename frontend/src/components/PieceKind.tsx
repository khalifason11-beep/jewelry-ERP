// CAT-1 (D-dec1-2, plan docs/plans/OPN-1.md §3): what a piece is, without a product: its type (required, active), its
// karat (one this shop sells) and a free-text description (at most 120 characters; an old shop number may go there)
// with suggestions of the descriptions already used for the type. Used under a supplier-order line, in the sellable
// scrap form and in the opening's keyboard entry. When a product is chosen, the type and the karat are the product's
// (shown, not editable) and the description stays free.

import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCategories, useDebounced } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { karatLabel } from '../lib/format';
import { Field, Input, Select } from './ui';

export interface PieceKindValue {
  categoryId: number | '';
  karat: number | '';
  description: string;
}
export const emptyKind = (): PieceKindValue => ({ categoryId: '', karat: '', description: '' });

/** The description's length as the server counts it (code points). */
export const descriptionTooLong = (d: string) => [...d.trim()].length > 120;

/** The API fields of a piece: the product when chosen, otherwise the type and the karat; the description if any. */
export function kindBody(productId: number | '', v: PieceKindValue) {
  const description = v.description.trim() || undefined;
  return productId ? { productId: Number(productId), description } : { categoryId: Number(v.categoryId), karat: Number(v.karat), description };
}

export function useDescriptionSuggestions(categoryId: number | '', q: string) {
  const query = useDebounced(q.trim(), 250);
  return useQuery({
    queryKey: ['catalog-descriptions', categoryId, query],
    queryFn: () => get<string[]>('/catalog/descriptions', { ...(categoryId ? { categoryId: String(categoryId) } : {}), ...(query ? { q: query } : {}) }),
    enabled: categoryId !== '',
    staleTime: 30_000,
  });
}

export function PieceKindFields({
  value,
  onChange,
  fixed,
  karats,
  testId,
  compact,
}: {
  value: PieceKindValue;
  onChange: (v: PieceKindValue) => void;
  /** The chosen product's type and karat: shown, not editable. */
  fixed?: { categoryId: number; karat: number } | null;
  /** The karats offered (default: the karats this shop sells). */
  karats?: number[];
  testId: string;
  compact?: boolean;
}) {
  const { t, L } = useI18n();
  const { me } = useAuth();
  const types = useCategories();
  const listId = useId();
  const categoryId = fixed ? fixed.categoryId : value.categoryId;
  const suggestions = useDescriptionSuggestions(categoryId, value.description);
  const offered = karats ?? me?.allowedKarats ?? [];
  const set = (patch: Partial<PieceKindValue>) => onChange({ ...value, ...patch });
  const tooLong = descriptionTooLong(value.description);
  const size = compact ? 'h-9 text-[13px]' : undefined;
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1.6fr)]" data-testid={testId}>
      <Field label={t('Type')}>
        <Select
          className={size}
          value={categoryId}
          disabled={!!fixed}
          onChange={(e) => set({ categoryId: e.target.value ? Number(e.target.value) : '' })}
          data-testid={`${testId}-type`}
        >
          <option value="">{t('Choose…')}</option>
          {(types.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {L(c.name, c.nameAr)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('Karat')}>
        <Select
          className={size}
          value={fixed ? fixed.karat : value.karat}
          disabled={!!fixed}
          onChange={(e) => set({ karat: e.target.value ? Number(e.target.value) : '' })}
          data-testid={`${testId}-karat`}
        >
          <option value="">{t('Choose…')}</option>
          {(fixed && !offered.includes(fixed.karat) ? [fixed.karat, ...offered] : offered).map((k) => (
            <option key={k} value={k}>
              {karatLabel(k)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('Description (optional)')} hint={tooLong ? t('A description can have at most 120 characters') : undefined}>
        <Input
          className={size}
          value={value.description}
          list={listId}
          invalid={tooLong}
          onChange={(e) => set({ description: e.target.value })}
          placeholder={t('e.g. plain ring, or an old shop number')}
          data-testid={`${testId}-description`}
        />
        <datalist id={listId}>
          {(suggestions.data ?? []).map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
      </Field>
    </div>
  );
}
