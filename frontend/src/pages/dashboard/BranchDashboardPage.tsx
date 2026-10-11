// The branch manager's home (UI-B, mockup bm-home.html; docs/plans/UI-B.md §5; D-ui-19), also the General Manager's
// view of one branch (`/overview?branchId=` and the branch page's overview tab), which adds gross profit and stock
// value at cost to the surface (the server sends them only with `profit.view`).
// Level 1: Sales of the day on the dark card; one surface with the expected cash in the drawer (and the last count),
// the available stock and the gold owed to suppliers (24K grams, never money); then "Needs attention" beside
// "Team today". Level 2: the 14-day sales line with month-to-date, and the stock movement of the day.
// No cost or profit for the branch manager anywhere: the server leaves them out and REH-1 checks the page.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { get } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { currencyLabel, date as formatDate, grams, money, num, pct, signedMoney, todayKey } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { ErrorState, Input, Panel, PanelHeader, Pill, RefreshBar } from '../../components/ui';
import type { StockWeight } from '../../components/StockWeight';
import { AttentionPanel, FigureSurface, FiguresSkeleton, KvRow, SalesCard, SalesLinePanel, type Figure } from '../../components/Home';

interface MovementLine {
  items: number;
  weightMg: number;
}
export interface BranchDash {
  branchId: number;
  date: string;
  kpis: {
    salesTotal: number;
    salesCount: number;
    itemsSold: number;
    purchasesCount: number;
    grossProfit: number | null;
    availableItems: number;
    availableWeightMg: number;
    inventoryCost: number | null;
  };
  stockWeight: StockWeight;
  mtd: { revenue: number; grossProfit: number | null; salesCount: number };
  movement: {
    opening: { items: number; weightMg: number };
    lines: Record<string, MovementLine>;
    closing: { items: number; weightMg: number };
    actual?: { items: number; weightMg: number };
  };
  trend: { day: string; sales: number; revenue: number }[];
  cashiers: {
    userId: number;
    fullName: string;
    fullNameAr: string | null;
    username: string;
    role: string;
    salesCount: number;
    salesTotal: number;
    voided: number;
    liveSessions: number;
  }[];
  expectedCash: number;
  lastCount: { day: string; countedAmount: number; expectedAmount: number; difference: number; at: string } | null;
  goldOwed: { pureMg24: number; orders: number };
}

export function BranchDashboardPage() {
  const { me } = useAuth();
  const { L } = useI18n();
  return (
    <div className="p-5 lg:p-6">
      <BranchDashboard branchId={me?.user.branch?.id} branchName={L(me?.user.branch?.name, me?.user.branch?.nameAr)} />
    </div>
  );
}

/** The branch home. `embedded`: inside the GM's home or the branch page (their own header is above it). */
export function BranchDashboard({ branchId, branchName, embedded }: { branchId?: number; branchName?: string; embedded?: boolean }) {
  const { t, lang } = useI18n();
  const today = todayKey();
  const [date, setDate] = useState(today);
  const [picking, setPicking] = useState(false);
  const q = useQuery({
    queryKey: ['dashboard', 'branch', branchId, date],
    queryFn: () => get<BranchDash>('/dashboard/branch', { branchId, date }),
    refetchInterval: 60_000,
    // Another day keeps today's figures on screen (thin bar) until the new ones arrive (UI-A2).
    placeholderData: keepPreviousData,
  });
  const isToday = date === today;
  const d = q.data;

  const dayChoice = (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('Business date')}>
      <Pill selected={isToday && !picking} onClick={() => { setDate(today); setPicking(false); }} data-testid="day-today">
        {t('Today')}
      </Pill>
      {picking || !isToday ? (
        <Input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-8 w-40" aria-label={t('Business date')} autoFocus={picking} data-testid="day-input" />
      ) : (
        <Pill onClick={() => setPicking(true)} data-testid="day-other">
          {t('Another day…')}
        </Pill>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {embedded ? (
        <div className="flex justify-end">{dayChoice}</div>
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-title font-semibold text-ink">
              {branchName} · {isToday ? t('Today') : formatDate(date, lang)}
            </h1>
            <div className="mt-0.5 text-meta text-ink-3">{formatDate(today, lang)}</div>
          </div>
          {dayChoice}
        </div>
      )}
      <RefreshBar active={!!q.isPlaceholderData && q.isFetching} />
      {q.isLoading ? <FiguresSkeleton /> : q.isError && !d ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : d ? <Figures d={d} isToday={isToday} /> : null}
      <div className="grid gap-4 xl:grid-cols-2">
        <AttentionPanel branchId={embedded ? branchId : undefined} />
        {d && <Team d={d} isToday={isToday} />}
      </div>
      {d && (d.kpis.availableItems === 0 && d.stockWeight.totalWeightMg === 0 && d.kpis.salesCount === 0 ? <NoStockYet /> : <Level2 d={d} isToday={isToday} />)}
    </div>
  );
}

function Figures({ d, isToday }: { d: BranchDash; isToday: boolean }) {
  const { t, lang } = useI18n();
  const k = d.kpis;
  const c = d.lastCount;
  const countDay = (day: string) => (day === todayKey() ? t('today') : formatDate(day, lang));
  const countText = !c
    ? t('No count recorded yet')
    : c.difference === 0
      ? t('Last count: {day}, matches', { day: countDay(c.day) })
      : c.difference < 0
        ? t('Last count: {day}, short {amount}', { day: countDay(c.day), amount: money(-c.difference, false) })
        : t('Last count: {day}, over {amount}', { day: countDay(c.day), amount: money(c.difference, false) });
  const figures: Figure[] = [
    { testId: 'home-expected-cash', label: t('Expected cash in the drawer'), value: signedMoney(d.expectedCash), sub: countText },
    {
      testId: 'home-stock',
      label: t('Available stock'),
      value: grams(k.availableWeightMg),
      sub: t('{n} pcs · scrap {scrap}', { n: num(k.availableItems), scrap: grams(d.stockWeight.brokenScrap.weightMg) }),
    },
    {
      testId: 'home-gold-owed',
      label: t('Gold owed to suppliers'),
      value: grams(d.goldOwed.pureMg24),
      sub: t('24K · {n} order(s)', { n: d.goldOwed.orders }),
    },
  ];
  // The General Manager's view of the branch adds profit and stock value (never sent to a branch manager).
  if (k.grossProfit != null) figures.splice(1, 0, { testId: 'home-profit', label: t('Gross profit'), value: money(k.grossProfit, false), sub: t('Margin {pct}', { pct: pct(k.salesTotal ? (k.grossProfit / k.salesTotal) * 100 : 0) }) });
  if (k.inventoryCost != null) figures.push({ testId: 'home-stock-value', label: t('Stock at cost'), value: money(k.inventoryCost, false), sub: t('{n} pcs', { n: num(k.availableItems) }) });
  return (
    <section className={clsx('grid gap-4', figures.length > 3 ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,3fr)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,5fr)]' : 'lg:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]')} aria-label={t('Key figures')}>
      <SalesCard
        label={isToday ? t('Sales today') : t('Sales · {period}', { period: formatDate(d.date, lang) })}
        value={money(k.salesTotal, false)}
        sub={
          k.salesCount === 0
            ? isToday
              ? t('No sales yet today')
              : t('No sales on this day')
            : t('{invoices} invoices · {pieces} pieces · {currency}', { invoices: k.salesCount, pieces: k.itemsSold, currency: currencyLabel() })
        }
      />
      <FigureSurface figures={figures} />
    </section>
  );
}

/** Team of the day: seller, invoices, sales, voids (a count, no colour: voids are normal work) and presence. */
function Team({ d, isToday }: { d: BranchDash; isToday: boolean }) {
  const { t, L } = useI18n();
  const cols = 'grid grid-cols-[1.6fr_.8fr_1.1fr_.7fr_1fr] items-center gap-2.5';
  return (
    <Panel label={isToday ? t('Team today') : t('Team')}>
      <div data-testid="home-team">
        <PanelHeader
          title={isToday ? t('Team today') : t('Team')}
          action={
            <Link to="/sessions" className="hover:text-ink">
              {t('Active Sessions')}
            </Link>
          }
        />
        <div className={clsx(cols, 'px-3 text-meta text-ink-3')} aria-hidden>
          <span>{t('Seller')}</span>
          <span className="text-end">{t('Invoices')}</span>
          <span className="text-end">{t('Sales')}</span>
          <span className="text-end">{t('Voids')}</span>
          <span>{t('Status')}</span>
        </div>
        <ul className="mt-1 grid grid-cols-1 gap-1.5">
          {d.cashiers.map((c) => (
            <li key={c.userId} className={clsx(cols, 'rounded-row bg-surface px-3 py-2 text-meta')} data-testid="home-team-row">
              <span className="min-w-0">
                <span className="block truncate font-semibold text-ink">{L(c.fullName, c.fullNameAr)}</span>
                <span className="block truncate text-ink-3">{t(c.role)}</span>
              </span>
              <span className="text-end num">{c.salesCount}</span>
              <span className="text-end num">{money(c.salesTotal, false)}</span>
              <span className="text-end num">{c.voided}</span>
              <span>
                {c.liveSessions > 0 ? (
                  <span className="rounded-badge bg-ok-bg px-1.5 font-semibold text-ok">{t('Online')}</span>
                ) : (
                  <span className="text-ink-3">{t('Offline')}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function Level2({ d, isToday }: { d: BranchDash; isToday: boolean }) {
  const { t } = useI18n();
  const m = d.movement;
  const line = (k: string) => m.lines[k] ?? { items: 0, weightMg: 0 };
  const sum = (...ks: string[]) => ks.map(line).reduce((a, b) => ({ items: a.items + b.items, weightMg: a.weightMg + b.weightMg }), { items: 0, weightMg: 0 });
  const inn = sum('PURCHASE', 'TRANSFER_IN', 'RETURN', 'ADJUSTMENT_IN');
  const out = sum('SALE', 'TRANSFER_OUT', 'DAMAGE', 'ADJUSTMENT_OUT');
  const reconciled = !m.actual || (m.actual.items === m.closing.items && m.actual.weightMg === m.closing.weightMg);
  return (
    <div className="grid gap-4 pt-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <SalesLinePanel
        title={t('Sales: last 14 days')}
        data={d.trend}
        action={
          <Link to={`/reports/sales?branchId=${d.branchId}&from=${d.trend[0]?.day ?? d.date}&to=${d.date}`} className="hover:text-ink">
            {t('Sales report')}
          </Link>
        }
        footer={t('Month to date: {amount} · {n} invoices', { amount: money(d.mtd.revenue), n: d.mtd.salesCount })}
      />
      <Panel label={isToday ? t('Stock today') : t('Stock movement')}>
        <div data-testid="home-stock-today">
          <PanelHeader
            title={isToday ? t('Stock today') : t('Stock movement')}
            action={
              <Link to={`/reports/inventory-movement?branchId=${d.branchId}&from=${d.date}&to=${d.date}`} className="hover:text-ink">
                {t('Details')}
              </Link>
            }
          />
          <KvRow label={t('In (purchases, transfers, returns)')} value={t('+{n} pcs · {weight}', { n: num(inn.items), weight: grams(inn.weightMg) })} />
          <KvRow label={t('Out (sales, transfers, damaged)')} value={t('−{n} pcs · {weight}', { n: num(out.items), weight: grams(out.weightMg) })} />
          <KvRow label={isToday ? t('Stock now') : t('Closing stock')} value={t('{n} pcs · {weight}', { n: num(m.closing.items), weight: grams(m.closing.weightMg) })} className="font-semibold" />
          {isToday && m.actual && (
            <KvRow
              label={reconciled ? `✓ ${t('Matches the pieces’ statuses')}` : `⚠ ${t('Does not match the pieces’ statuses')}`}
              value=""
              className={reconciled ? '[&>span:first-child]:text-ok' : '[&>span:first-child]:text-crit'}
              testId="home-stock-check"
            />
          )}
        </div>
      </Panel>
    </div>
  );
}

function NoStockYet() {
  const { t } = useI18n();
  const { can } = useAuth();
  return (
    <Panel label={t('Your branch has no stock yet')} className="mt-4">
      <div className="flex flex-wrap items-center gap-4 px-1 py-1" data-testid="no-stock-yet">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-ink">{t('Your branch has no stock yet')}</div>
          <div className="text-meta text-ink-3">{t('Receive a supplier order or buy scrap to start. Types and products can be created on the same screens.')}</div>
        </div>
        {can('purchases.create') && (
          <Link to="/purchases" className="inline-flex h-8 items-center rounded-control bg-navy px-3 text-meta font-medium text-white hover:bg-navy-2">
            {t('New purchase')}
          </Link>
        )}
        {can('scrap.buy') && (
          <Link to="/scrap" className="inline-flex h-8 items-center rounded-control border border-line bg-surface px-3 text-meta font-medium text-ink hover:bg-neutral-bg">
            {t('Buy scrap')}
          </Link>
        )}
      </div>
    </Panel>
  );
}
