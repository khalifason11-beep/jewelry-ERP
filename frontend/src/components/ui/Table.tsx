// Table primitives (UI-A1). Header 13 px meta, cells 15 px, numbers end-aligned with tabular digits and kept LTR
// inside Arabic text; sticky header (R9). Screens move their native tables onto these in UI-B/C.

import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import clsx from 'clsx';

export function Table({ children, className, density = 'comfortable', ...rest }: HTMLAttributes<HTMLTableElement> & { density?: 'comfortable' | 'compact' }) {
  return (
    <div className="overflow-x-auto">
      <table data-density={density} className={clsx('group/table w-full border-collapse text-start text-[15px]', className)} {...rest}>
        {children}
      </table>
    </div>
  );
}

export function THead({ children, sticky = true }: { children: ReactNode; sticky?: boolean }) {
  return <thead className={clsx(sticky && 'sticky top-0 z-10', 'bg-surface')}>{children}</thead>;
}

export function TH({ numeric, className, children, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th scope="col" className={clsx('border-b border-line px-3 py-2 text-meta font-medium text-ink-3', numeric ? 'text-end' : 'text-start', className)} {...rest}>
      {children}
    </th>
  );
}

export function TR({ className, children, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={clsx('border-b border-line last:border-b-0 hover:bg-panel/60', className)} {...rest}>
      {children}
    </tr>
  );
}

export function TD({ numeric, className, children, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td className={clsx('px-3 py-2 align-middle group-data-[density=compact]/table:py-1', numeric ? 'num text-end' : 'text-start', className)} {...rest}>
      {numeric ? (
        <span dir="ltr" className="[unicode-bidi:isolate]">
          {children}
        </span>
      ) : (
        children
      )}
    </td>
  );
}
