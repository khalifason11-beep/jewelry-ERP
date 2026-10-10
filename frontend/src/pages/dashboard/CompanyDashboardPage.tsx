// The General Manager's home (UI-B, mockup gm-home.html; docs/plans/UI-B.md §4; D-ui-19, D-ui-20).
// Level 1 fits a 1366×768 screen: Sales on its own dark card, one surface with gross profit, gold held and stock
// value at cost, then "Needs attention" beside the branch strips. Level 2: the sales of the last 14 days as one
// line (a deliberate deviation from the mockup's bars by branch, owner answer Q9, D-ui-20) and the gold position.
// The period (Today by default) is remembered per person. `?branchId=` turns the home into one branch's view.
// Empty versions (ANALYSIS §8): no branch or no staff yet → the first steps and the attention list only; branches
// but no sales → zeros with "No sales yet in this period", never "—".

import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronRight } from 'lucide-react';
import { get } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDaysKey, currencyLabel, date as formatDate, grams, money, num, pct, todayKey } from '../../lib/format';
import { branchColor, useBranches } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import { ErrorState, Input, Panel, PanelHeader, PillGroup, RefreshBar, Select, SkeletonRows } from '../../components/ui';
import type { StockWeight } from '../../components/StockWeight';
import { FirstSteps, useSetupStatus } from '../../components/FirstSteps';
import { useAttention, type Signal } from '../../components/Attention';
import { AttentionPanel, FigureSurface, FiguresSkeleton, KvRow, SalesCard, SalesLinePanel, useRememberedChoice } from '../../components/Home';
import { BranchDashboard } from './BranchDashboardPage';

interface BranchRow {
  branchId: number;
  code: string;
  name: string;
  nameAr: string;
  revenue: number;
  salesCount: number;
  grossProfit: number;
  availableItems: number;
  availableWeightMg: number;
  totalWeightMg: number;
}

interface CompanyDash {
  period: { from: string; to: string };
  totals: { revenue: number; grossProfit: number; inventoryCost: number; availableItems: number; availableWeightMg: number; salesCount: number };
  branches: BranchRow[];
  stockWeight: StockWeight;
  inTransit: { items: number; weightMg: number };
  goldOwed: { pureMg24: number; orders: number };
  salesLine: { day: string; sales: number; revenue: number }[];
}

const PRESETS = ['today', '7d', 'mtd', '30d', 'custom'] as const;
type Preset = (typeof PRESETS)[number];

export function CompanyDashboardPage() {
  const { t, L } = useI18n();
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  const scope = Number(params.get('branchId')) || null;
  const branches = useBranches();
  const setup = useSetupStatus();
  const today = todayKey();
  const [preset, setPreset] = useRememberedChoice<Preset>(`jerp.home.period.${me?.user.id ?? 0}`, PRESETS, 'today');
  const [custom, setCustom] = useState({ from: addDaysKey(today, -29), to: today });
  const range =
    preset === 'today'
      ? { from: today, to: today }
      : preset === '7d'
        ? { from: addDaysKey(today, -6), to: today }
        : preset === 'mtd'
          ? { from: today.slice(0, 8) + '01', to: today }
          : preset === '30d'
            ? { from: addDaysKey(today, -29), to: today }
            : custom;
  const scopeBranch = branches.data?.find((b) => b.id === scope);
  const firstRun = setup.data && setup.data.steps.some((s) => (s.key === 'branch' || s.key === 'staff') && !s.done);

  const scopePicker = (branches.data?.length ?? 0) > 0 && (
    <Select
      value={scope ?? ''}
      onChange={(e) => setParams(e.target.value ? { branchId: e.target.value } : {})}
      aria-label={t('Show')}
      className="h-8 w-auto rounded-full border-0 bg-panel py-0 text-meta"
      data-testid="home-scope"
    >
      <option value="">{t('All branches')}</option>
      {branches.data?.map((b) => (
        <option key={b.id} value={b.id}>
          {L(b.name, b.nameAr)}
        </option>
      ))}
    </Select>
  );

  if (firstRun) {
    return (
      <div className="p-5 lg:p-6">
        <div className="mb-3">
          <h1 className="text-title font-semibold text-ink">{t('Welcome. Let’s get started')}</h1>
          <div className="mt-0.5 text-meta text-ink-3">{t('The system is new and empty. A few steps before the first sale.')}</div>
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]" data-testid="home-first-run">
          <FirstSteps status={setup.data!} />
          <AttentionPanel />
        </div>
      </div>
    );
  }

  return (
    <div className="p-5 lg:p-6">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-title font-semibold text-ink">{t('Home')}</h1>
          <div className="mt-0.5 text-meta text-ink-3" data-testid="home-subtitle">
            {formatDate(today)} · {scopeBranch ? L(scopeBranch.name, scopeBranch.nameAr) : t('All branches')}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {scopePicker}
          {!scope && (
            <PillGroup
              label={t('Period')}
              value={preset}
              onChange={setPreset}
              options={[
                { value: 'today', label: t('Today') },
                { value: '7d', label: t('7 days') },
                { value: 'mtd', label: t('This month') },
                { value: '30d', label: t('30 days') },
                { value: 'custom', label: t('Custom') },
              ]}
            />
          )}
          {!scope && preset === 'custom' && (
            <>
              <Input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="w-38" aria-label={t('From')} />
              <Input type="date" value={custom.to} min={custom.from} max={today} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="w-38" aria-label={t('To')} />
            </>
          )}
        </div>
      </div>

      {setup.data && !setup.data.complete && <FirstSteps status={setup.data} />}

      {scope ? <BranchDashboard branchId={scope} embedded /> : <CompanyHome range={range} isToday={preset === 'today'} />}
    </div>
  );
}

function CompanyHome({ range, isToday }: { range: { from: string; to: string }; isToday: boolean }) {
  // A new period keeps the figures on screen with a thin bar until the new ones arrive (UI-A2).
  const q = useQuery({ queryKey: ['dashboard', 'company', range.from, range.to], queryFn: () => get<CompanyDash>('/dashboard/company', range), refetchInterval: 60_000, placeholderData: keepPreviousData });
  const attention = useAttention();
  const d = q.data;
  return (
    <div className="space-y-4">
      <RefreshBar active={!!q.isPlaceholderData && q.isFetching} />
      {q.isLoading ? (
        <FiguresSkeleton />
      ) : q.isError && !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : d ? (
        <Figures d={d} isToday={isToday} />
      ) : null}
      <div className="grid gap-4 xl:grid-cols-[1fr_1.25fr]">
        <AttentionPanel />
        <BranchStrips d={d} loading={q.isLoading} signals={attention.data?.signals ?? []} />
      </div>
      {d && <Level2 d={d} />}
    </div>
  );
}

function Figures({ d, isToday }: { d: CompanyDash; isToday: boolean }) {
  const { t } = useI18n();
  const T = d.totals;
  const sw = d.stockWeight;
  const margin = T.revenue ? (T.grossProfit / T.revenue) * 100 : 0;
  const period = d.period.from === d.period.to ? formatDate(d.period.from) : `${formatDate(d.period.from)} – ${formatDate(d.period.to)}`;
  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_3fr]" aria-label={t('Key figures')}>
      <SalesCard
        label={isToday ? t('Sales today') : t('Sales · {period}', { period })}
        value={money(T.revenue, false)}
        sub={T.salesCount === 0 ? t('No sales yet in this period') : t('{n} invoices · {currency}', { n: num(T.salesCount), currency: currencyLabel() })}
      />
      <FigureSurface
        figures={[
          { testId: 'home-profit', label: t('Gross profit'), value: money(T.grossProfit, false), sub: t('Margin {pct}', { pct: pct(margin) }) },
          {
            testId: 'home-gold',
            label: t('Gold held'),
            value: grams(sw.totalWeightMg),
            sub:
              d.inTransit.items > 0
                ? t('of which scrap {scrap} · plus {transit} in transit', { scrap: grams(sw.brokenScrap.weightMg), transit: grams(d.inTransit.weightMg) })
                : t('of which scrap {scrap}', { scrap: grams(sw.brokenScrap.weightMg) }),
          },
          { testId: 'home-stock-value', label: t('Stock at cost'), value: money(T.inventoryCost, false), sub: t('{n} pcs · {weight}', { n: num(T.availableItems), weight: grams(T.availableWeightMg) }) },
        ]}
      />
    </section>
  );
}

/** Branch strips: sorted by sales, a branch with a critical line first; the dot = any warning or critical line. */
function BranchStrips({ d, loading, signals }: { d?: CompanyDash; loading: boolean; signals: Signal[] }) {
  const { t, L } = useI18n();
  const navigate = useNavigate();
  const worst = (id: number) => (signals.some((s) => s.branchId === id && s.severity === 'critical') ? 2 : signals.some((s) => s.branchId === id && s.severity === 'warning') ? 1 : 0);
  const rows = [...(d?.branches ?? [])].sort((a, z) => (worst(z.branchId) === 2 ? 1 : 0) - (worst(a.branchId) === 2 ? 1 : 0) || z.revenue - a.revenue || a.branchId - z.branchId);
  const cols = 'grid grid-cols-[10px_1.5fr_1fr_1fr_1fr_16px] items-center gap-2.5';
  return (
    <Panel label={t('Branches')}>
      <div data-testid="home-branches">
        <PanelHeader
          title={t('Branches')}
          action={
            d && (
              <Link to={`/reports/branch-performance?from=${d.period.from}&to=${d.period.to}`} className="hover:text-ink">
                {t('Branch performance report')}
              </Link>
            )
          }
        />
        {loading ? (
          <SkeletonRows rows={4} />
        ) : (
          <>
            <div className={clsx(cols, 'px-3 text-meta text-ink-3')} aria-hidden>
              <span />
              <span>{t('Branch')}</span>
              <span className="text-end">{t('Sales')}</span>
              <span className="text-end">{t('Profit')}</span>
              <span className="text-end">{t('Gold (g)')}</span>
              <span />
            </div>
            <ul className="mt-1 grid gap-1.5">
              {rows.map((b) => {
                const w = worst(b.branchId);
                return (
                  <li key={b.branchId}>
                    <button
                      onClick={() => navigate(`/overview?branchId=${b.branchId}`)}
                      className={clsx(cols, 'w-full rounded-row bg-surface px-3 py-2 text-start hover:bg-neutral-bg')}
                      data-testid="home-branch-strip"
                      data-branch={b.code}
                      data-flag={w ? (w === 2 ? 'critical' : 'warning') : 'none'}
                    >
                      <span className="size-2.5 rounded-[3px]" style={{ background: branchColor(b.branchId) }} aria-hidden />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 truncate font-semibold text-ink">
                          {L(b.name, b.nameAr)}
                          {w > 0 && <span className={clsx('inline-block size-2 shrink-0 rounded-full', w === 2 ? 'bg-crit' : 'bg-warn')} title={t('Needs attention')} aria-label={t('Needs attention')} />}
                        </span>
                        <span className="block truncate text-meta text-ink-3">{t('{n} pcs available', { n: b.availableItems })}</span>
                      </span>
                      <span className="text-end num">{money(b.revenue, false)}</span>
                      <span className="text-end num">{money(b.grossProfit, false)}</span>
                      <span className="text-end num">{grams(b.totalWeightMg, false)}</span>
                      <ChevronRight className="size-4 text-ink-3 rtl:rotate-180" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Panel>
  );
}

function Level2({ d }: { d: CompanyDash }) {
  const { t } = useI18n();
  const sw = d.stockWeight;
  const piecesPct = sw.totalWeightMg ? (sw.items.weightMg / sw.totalWeightMg) * 100 : 0;
  return (
    <div className="grid gap-4 pt-4 xl:grid-cols-[1.4fr_1fr]">
      <SalesLinePanel
        title={t('Sales: last 14 days')}
        data={d.salesLine}
        action={
          <Link to={`/reports/sales?from=${d.salesLine[0]?.day ?? d.period.from}&to=${d.period.to}`} className="hover:text-ink">
            {t('Sales report')}
          </Link>
        }
      />
      <Panel label={t('Gold position')}>
        <div data-testid="home-gold-position">
          <PanelHeader
            title={t('Gold position')}
            action={
              <Link to="/reports/stock-weight" className="hover:text-ink">
                {t('Stock Weight')}
              </Link>
            }
          />
          <div className="px-1">
            <span className="text-[22px] font-semibold num">{grams(sw.totalWeightMg)}</span>{' '}
            <span className="text-meta text-ink-3">= {t('{weight} as 24K', { weight: grams(sw.totalPureMg24) })}</span>
          </div>
          <div className="mx-1 my-2.5 flex h-2.5 overflow-hidden rounded-full bg-line" aria-hidden>
            <span className="h-full bg-navy" style={{ width: `${piecesPct}%` }} />
            <span className="h-full bg-ink-3" style={{ width: `${100 - piecesPct}%` }} />
          </div>
          <KvRow label={t('Sellable pieces')} value={grams(sw.items.weightMg)} />
          <KvRow label={t('Broken scrap')} value={grams(sw.brokenScrap.weightMg)} />
          <KvRow label={t('In transit between branches')} value={t('{n} pcs · {weight}', { n: num(d.inTransit.items), weight: grams(d.inTransit.weightMg) })} testId="home-in-transit" />
          <KvRow label={t('Gold owed to suppliers (24K)')} value={grams(d.goldOwed.pureMg24)} testId="home-gold-owed" />
        </div>
      </Panel>
    </div>
  );
}
