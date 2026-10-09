// Panels (UI-A1, mockup `.panel` / `.ph`): flat grey surface, radius 20, section title 17 px, optional count and a
// "View all" style link. Rows inside a panel are white (`PanelRow`, UI-B).

import type { ReactNode } from 'react';
import clsx from 'clsx';

export function Panel({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label} className={clsx('rounded-panel bg-panel px-3.5 py-3', className)}>
      {children}
    </section>
  );
}

export function PanelHeader({ title, count, action }: { title: ReactNode; count?: number; action?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-1 pb-1.5">
      <h2 className="text-section font-semibold text-ink">
        {title}
        {count != null && <span className="num ms-1.5 text-[15px] font-normal text-ink-3">({count})</span>}
      </h2>
      {action && <div className="text-meta text-ink-2">{action}</div>}
    </div>
  );
}
