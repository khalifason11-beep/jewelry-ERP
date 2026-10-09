// Pills (UI-A1): the language pill, the rate chip and (UI-B) period chips. Light = panel grey; dark = navy.
// A selected pill in a group gets a navy outline (mockup `.seg span.on`).

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

export function Pill({
  tone = 'light',
  selected,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'light' | 'dark'; selected?: boolean }) {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-full px-3.5 text-meta transition-colors',
        tone === 'light' && !selected && 'bg-panel text-ink-2 hover:text-ink',
        tone === 'light' && selected && 'bg-surface font-medium text-ink shadow-[0_0_0_1.5px_var(--color-navy)]',
        tone === 'dark' && 'bg-navy text-white',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** One choice out of a few (e.g. the period). Arrow keys are not needed: each pill is a button in the tab order. */
export function PillGroup<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <Pill key={o.value} role="radio" aria-checked={value === o.value} selected={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </Pill>
      ))}
    </div>
  );
}
