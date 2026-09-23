import { useSearchParams } from 'react-router-dom';
import { addDaysKey, todayKey } from '../lib/format';
import { useBranches } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Input, Select } from './ui';

/** Date range + branch filter state kept in the URL (shareable, back-button friendly). */
export function useRangeParams(defaultDays = 7) {
  const [sp, setSp] = useSearchParams();
  const today = todayKey();
  const from = sp.get('from') ?? addDaysKey(today, -(defaultDays - 1));
  const to = sp.get('to') ?? today;
  const branchId = sp.get('branchId') ? Number(sp.get('branchId')) : undefined;
  const set = (patch: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    setSp(next, { replace: true });
  };
  return { from, to, branchId, sp, set };
}

export function DateRange({ from, to, onChange }: { from: string; to: string; onChange: (r: { from: string; to: string }) => void }) {
  const { t } = useI18n();
  const today = todayKey();
  const quick = [
    { label: t('Today'), from: today, to: today },
    { label: '7d', from: addDaysKey(today, -6), to: today },
    { label: 'MTD', from: today.slice(0, 8) + '01', to: today },
    { label: '30d', from: addDaysKey(today, -29), to: today },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input type="date" value={from} max={to} onChange={(e) => e.target.value && onChange({ from: e.target.value, to })} className="h-8 w-[138px] text-[13px]" aria-label={t('From')} />
      <span className="text-ink-400">→</span>
      <Input type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && onChange({ from, to: e.target.value })} className="h-8 w-[138px] text-[13px]" aria-label={t('To')} />
      <div className="flex rounded-md border border-line-strong bg-white p-0.5">
        {quick.map((q) => (
          <button
            key={q.label}
            onClick={() => onChange({ from: q.from, to: q.to })}
            className={`rounded px-2 py-0.5 text-[12px] font-medium ${from === q.from && to === q.to ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-canvas'}`}
          >
            {q.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function BranchSelect({ value, onChange, className }: { value?: number; onChange: (v: number | undefined) => void; className?: string }) {
  const { isGlobal } = useAuth();
  const { t, L } = useI18n();
  const branches = useBranches();
  if (!isGlobal) return null;
  return (
    <Select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)} className={className ?? 'h-8 w-44 text-[13px]'} aria-label={t('Branch')}>
      <option value="">{t('All branches')}</option>
      {branches.data?.map((b) => (
        <option key={b.id} value={b.id}>
          {L(b.name, b.nameAr)}
        </option>
      ))}
    </Select>
  );
}
