// Chart building blocks (Recharts) following one visual system:
// thin marks, recessive grid, single y-axis, legend for ≥2 series, hover tooltips,
// fixed categorical colours per branch (never re-assigned by rank or filter).

import type { ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { compactMoney, money, shortDay } from '../lib/format';
import { translate } from '../lib/i18n';

const AXIS = { stroke: 'var(--color-ink-400)', fontSize: 11 };
const GRID = 'var(--color-line)';

function TooltipBox({ title, rows }: { title: ReactNode; rows: { color: string; label: string; value: string }[] }) {
  return (
    <div className="rounded-md border border-line bg-white px-3 py-2 text-[12px] shadow-lg">
      <div className="mb-1 font-medium text-ink-900">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-ink-600">
          <span className="size-2 rounded-sm" style={{ background: r.color }} />
          <span className="flex-1">{r.label}</span>
          <span className="font-medium text-ink-900 num">{r.value}</span>
        </div>
      ))}
    </div>
  );
}


export interface Series {
  key: string;
  label: string;
  color: string;
}

/** Money over time. One axis; each series is its own line. */
export function MoneyLineChart({ data, series, height = 240, xKey = 'day' }: { data: Record<string, unknown>[]; series: Series[]; height?: number; xKey?: string }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={xKey} tickFormatter={shortDay} tick={AXIS} axisLine={false} tickLine={false} minTickGap={16} />
        <YAxis tickFormatter={(v) => compactMoney(v)} tick={AXIS} axisLine={false} tickLine={false} width={48} />
        <Tooltip
          cursor={{ stroke: 'var(--color-ink-300)', strokeDasharray: '3 3' }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <TooltipBox title={shortDay(String(label))} rows={series.map((s) => ({ color: s.color, label: s.label, value: money(Number(payload.find((p) => p.dataKey === s.key)?.value ?? 0)) }))} />
            ) : null
          }
        />
        {series.length > 1 && <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, paddingTop: 4 }} />}
        {series.map((s) => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** One bar per category (e.g. per branch), each bar in its entity colour. */
export function CategoryBarChart({
  data,
  valueKey,
  labelKey,
  colorOf,
  height = 220,
  format = money,
  layout = 'vertical',
}: {
  data: Record<string, unknown>[];
  valueKey: string;
  labelKey: string;
  colorOf: (row: Record<string, unknown>, i: number) => string;
  height?: number;
  format?: (n: number) => string;
  layout?: 'vertical' | 'horizontal';
}) {
  const horizontal = layout === 'horizontal';
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 16, bottom: 0, left: 0 }} barCategoryGap="28%">
        <CartesianGrid stroke={GRID} vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" tickFormatter={(v) => compactMoney(v)} tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey={labelKey} tick={{ ...AXIS, fill: 'var(--color-ink-600)' }} axisLine={false} tickLine={false} width={110} />
          </>
        ) : (
          <>
            <XAxis dataKey={labelKey} tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v) => compactMoney(v)} tick={AXIS} axisLine={false} tickLine={false} width={48} />
          </>
        )}
        <Tooltip
          cursor={{ fill: 'rgba(13,21,38,0.04)' }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipBox
                title={String(payload[0].payload[labelKey])}
                rows={[{ color: String(payload[0].payload.__color ?? 'var(--color-ink-700)'), label: translate('Value'), value: format(Number(payload[0].value)) }]}
              />
            ) : null
          }
        />
        <Bar dataKey={valueKey} radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={36}>
          {data.map((row, i) => (
            <Cell key={i} fill={colorOf(row, i)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ChartLegend({ items }: { items: Series[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-600">
      {items.map((i) => (
        <span key={i.key} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Composition over time: one stacked bar per day, one segment per entity (e.g. branch). */
export function StackedMoneyBars(props: { data: Record<string, unknown>[]; series: Series[]; height?: number; xKey?: string }) {
  return (
    <div>
      <StackedMoneyBarsPlot {...props} />
      <div className="mt-2 flex justify-center">
        <ChartLegend items={props.series} />
      </div>
    </div>
  );
}

function StackedMoneyBarsPlot({ data, series, height = 260, xKey = 'day' }: { data: Record<string, unknown>[]; series: Series[]; height?: number; xKey?: string }) {
  const filled = data.map((d) => {
    const row: Record<string, unknown> = { ...d };
    for (const s of series) row[s.key] = Number(row[s.key] ?? 0);
    return row;
  });
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={filled} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="18%">
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={xKey} tickFormatter={shortDay} tick={AXIS} axisLine={false} tickLine={false} minTickGap={12} />
        <YAxis tickFormatter={(v) => compactMoney(v)} tick={AXIS} axisLine={false} tickLine={false} width={48} />
        <Tooltip
          cursor={{ fill: 'rgba(13,21,38,0.04)' }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <TooltipBox
                title={`${shortDay(String(label))} · ${money(series.reduce((sum, s) => sum + Number(payload.find((p) => p.dataKey === s.key)?.value ?? 0), 0))}`}
                rows={[...series].reverse().map((s) => ({ color: s.color, label: s.label, value: money(Number(payload.find((p) => p.dataKey === s.key)?.value ?? 0)) }))}
              />
            ) : null
          }
        />
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stackId="a"
            fill={s.color}
            stroke="#fff"
            strokeWidth={1}
            radius={i === series.length - 1 ? [3, 3, 0, 0] : 0}
            maxBarSize={28}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
