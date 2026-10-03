// Gold held (Phase 4, D-4-3): sellable pieces + the broken-scrap pool, raw weight by karat and the
// 24K pure-gold equivalent. Both come from the server; nothing is recomputed here.

import { Link } from 'react-router-dom';
import { grams, karatLabel } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { Card, CardHeader } from './ui';

interface Part {
  byKarat: { karat: number; weightMg: number; pureMg24: number }[];
  weightMg: number;
  pureMg24: number;
}
export interface StockWeight {
  items: Part;
  brokenScrap: Part;
  totalWeightMg: number;
  totalPureMg24: number;
}

export function StockWeightCard({ s, reportQuery = '' }: { s: StockWeight; reportQuery?: string }) {
  const { t } = useI18n();
  const karats = [...new Set([...s.items.byKarat, ...s.brokenScrap.byKarat].map((x) => x.karat))].sort((a, b) => a - b);
  const w = (p: Part, k: number) => p.byKarat.find((x) => x.karat === k)?.weightMg ?? 0;
  return (
    <Card padded={false}>
      <CardHeader
        title={t('Total stock weight')}
        subtitle={t('Sellable pieces (available + reserved) plus the broken-scrap pool')}
        actions={<Link to={`/reports/stock-weight${reportQuery}`} className="text-[13px] font-medium text-gold-700 hover:underline">{t('Stock Weight')}</Link>}
      />
      <table className="w-full text-[13px]" data-testid="stock-weight">
        <thead className="bg-[#f7f8fa] text-ink-500">
          <tr>
            <th className="px-5 py-2 text-start font-medium">{t('Karat')}</th>
            <th className="px-3 py-2 text-end font-medium">{t('Pieces')}</th>
            <th className="px-3 py-2 text-end font-medium">{t('Broken scrap')}</th>
            <th className="px-5 py-2 text-end font-medium">{t('Total weight')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {karats.map((k) => (
            <tr key={k}>
              <td className="px-5 py-2 font-medium">{karatLabel(k)}</td>
              <td className="px-3 py-2 text-end num">{grams(w(s.items, k))}</td>
              <td className="px-3 py-2 text-end num">{grams(w(s.brokenScrap, k))}</td>
              <td className="px-5 py-2 text-end num">{grams(w(s.items, k) + w(s.brokenScrap, k))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-line-strong">
          <tr className="font-semibold">
            <td className="px-5 py-2">{t('Total')}</td>
            <td className="px-3 py-2 text-end num">{grams(s.items.weightMg)}</td>
            <td className="px-3 py-2 text-end num">{grams(s.brokenScrap.weightMg)}</td>
            <td className="px-5 py-2 text-end num">{grams(s.totalWeightMg)}</td>
          </tr>
          <tr className="text-ink-600">
            <td className="px-5 py-2">{t('As 24K pure gold')}</td>
            <td className="px-3 py-2 text-end num">{grams(s.items.pureMg24)}</td>
            <td className="px-3 py-2 text-end num">{grams(s.brokenScrap.pureMg24)}</td>
            <td className="px-5 py-2 text-end font-semibold num">{grams(s.totalPureMg24)}</td>
          </tr>
        </tfoot>
      </table>
    </Card>
  );
}
