// WSL-1 (D-wsl1-2, D-wsl1-5): grains (حبات) of broken scrap at the POS. One product per karat that has weight in the
// branch's broken-scrap pool ("كسر مكسر 21 — متاح X جم"); added to the cart, the cashier types a whole number of grains
// (1 grain = 0.1 g). The line shows the grains, their grams, the rate per gram and the line's price (the whole weight
// at the rate, rounded once: grainLinePrice). More than the pool holds is said under the field and blocks the sale.

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Trash2 } from 'lucide-react';
import { grainLinePrice, grainsToMg, parseIntegerInput } from '@jerp/shared';
import { get } from '../../lib/api';
import { grams, karatLabel, money } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { IntegerInput } from '../../components/ui';

export interface GrainOffer {
  karat: number;
  weightMg: number;
  grains: number;
  pricePerGram: number | null;
}

/** A grain line of the cart: the grains as typed (FIX-NUM-1: the field holds only what was typed). */
export interface GrainLine {
  karat: number;
  grainsText: string;
  pricePerGram: number;
  availableMg: number;
}

/** The grains as a number (null while empty or not a whole number above 0). */
export const grainsOf = (l: GrainLine) => {
  const n = parseIntegerInput(l.grainsText);
  return n != null && n > 0 ? n : null;
};
export const grainWeightOf = (l: GrainLine) => {
  const n = grainsOf(l);
  return n == null ? 0 : grainsToMg(n);
};
export const grainPriceOf = (l: GrainLine) => {
  const n = grainsOf(l);
  return n == null ? 0 : grainLinePrice(n, l.pricePerGram);
};
/** A line can be sold: a whole number of grains above 0, no more than the pool holds. */
export const grainLineOk = (l: GrainLine) => grainsOf(l) != null && grainWeightOf(l) <= l.availableMg;

export function useScrapGrains(branchId: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['pos-scrap-grains', branchId],
    queryFn: () => get<{ branchId: number; rows: GrainOffer[] }>('/pos/scrap-grains', { branchId }),
    enabled: enabled && !!branchId,
  });
}

/** The strip above the pieces: one product per karat with pool weight. */
export function GrainCards({ offers, inCart, onAdd }: { offers: GrainOffer[]; inCart: (karat: number) => boolean; onAdd: (o: GrainOffer) => void }) {
  const { t } = useI18n();
  if (!offers.length) return null;
  return (
    <div className="mb-4" data-testid="pos-grains">
      <div className="mb-2 text-xs text-ink-500">{t('Broken scrap by the grain (1 grain = 0.1 g)')}</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(178px,1fr))] gap-3">
        {offers.map((o) => {
          const sellable = o.pricePerGram != null && o.grains > 0;
          return (
            <button
              key={o.karat}
              type="button"
              onClick={() => onAdd(o)}
              disabled={!sellable}
              data-testid={`pos-grains-${o.karat}`}
              className={clsx(
                'flex min-h-11 flex-col rounded-lg border bg-white p-3 text-start transition-all disabled:cursor-not-allowed disabled:opacity-70',
                inCart(o.karat) ? 'border-gold-500 ring-2 ring-gold-500/30' : 'border-line hover:border-gold-400 hover:shadow-md',
              )}
            >
              <span className="text-[13.5px] font-medium text-ink-900">{t('Broken scrap {karat} — {weight} available', { karat: o.karat, weight: grams(o.weightMg) })}</span>
              <span className="mt-1 text-[12px] text-ink-600 num">{t('{n} grain(s) available', { n: o.grains })}</span>
              <span className="mt-auto pt-2">
                {o.pricePerGram == null ? (
                  <span className="rounded bg-crit-bg px-1.5 py-0.5 text-[11.5px] font-medium text-crit">{t('No rate')}</span>
                ) : (
                  <span className="text-[13px] font-semibold text-ink-950 num">{t('{rate} per gram', { rate: money(o.pricePerGram, false) })}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A grain line in the cart: the grains typed, their grams, the rate and the price; more than available is said. */
export function GrainCartLine({ line, onChange, onRemove, autoFocus }: { line: GrainLine; onChange: (text: string) => void; onRemove: () => void; autoFocus?: boolean }) {
  const { t } = useI18n();
  const n = grainsOf(line);
  const over = n != null && grainWeightOf(line) > line.availableMg;
  const maxGrains = Math.floor(line.availableMg / 100);
  return (
    <li className="px-4 py-3" data-testid={`pos-grain-line-${line.karat}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">{t('Broken scrap {karat}', { karat: line.karat })}</div>
          <div className="text-[11.5px] text-ink-500 num">
            {karatLabel(line.karat)} · {t('{n} grain(s) available', { n: maxGrains })}
          </div>
        </div>
        <button onClick={onRemove} className="rounded p-1 text-ink-400 hover:bg-rose-50 hover:text-rose-600" aria-label={t('Remove broken scrap {karat}', { karat: line.karat })} data-testid={`pos-grain-remove-${line.karat}`}>
          <Trash2 className="size-4" />
        </button>
      </div>
      <div className="mt-2 flex items-start justify-between gap-2">
        <label className="flex flex-col gap-1 text-xs text-ink-500">
          {t('Grains')}
          <IntegerInput
            compact
            min={1}
            value={line.grainsText}
            onValueChange={onChange}
            autoFocus={autoFocus}
            invalid={over}
            className="w-32"
            aria-label={t('Grains of broken scrap {karat}', { karat: line.karat })}
            data-testid={`pos-grains-qty-${line.karat}`}
          />
        </label>
        <div className="text-end">
          <div className="font-semibold num" data-testid={`pos-grain-price-${line.karat}`}>{n != null ? money(grainPriceOf(line)) : '—'}</div>
          <div className="text-[11px] text-ink-500 num" data-testid={`pos-grain-grams-${line.karat}`}>{n != null ? t('{n} grain(s) = {weight}', { n, weight: grams(grainWeightOf(line)) }) : t('1 grain = 0.1 g')}</div>
          <div className="text-[11px] text-ink-500 num">{t('{rate} per gram', { rate: money(line.pricePerGram, false) })}</div>
        </div>
      </div>
      {over && (
        <p className="mt-1 text-[11.5px] text-crit" role="status" data-testid={`pos-grains-over-${line.karat}`}>
          {t('More than available: the pool holds {n} grain(s) ({weight})', { n: maxGrains, weight: grams(line.availableMg) })}
        </p>
      )}
    </li>
  );
}
