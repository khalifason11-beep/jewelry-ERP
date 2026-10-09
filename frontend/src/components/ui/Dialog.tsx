// Dialog (UI-A1). Keeps the focus fix of 5ffadaa unchanged (focus the first field at once, never steal focus from a
// field the person chose; the late retry only when nothing inside has focus) and the Escape stack (only the topmost
// dialog closes). New: Tab is trapped inside, focus returns to the opener, the title labels the dialog.

import { useEffect, useId, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { translate } from '../../lib/i18n';

const openDialogs: object[] = [];
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const SIZE = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-3xl' } as const;

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZE;
  /** Tailwind max-width class (kept for existing screens); `size` wins when given. */
  width?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    // Dialogs can open on top of each other (e.g. "New product" from a purchase line): Escape closes
    // only the topmost one, so the form underneath keeps what was typed.
    const token = {};
    openDialogs.push(token);
    const isTop = () => openDialogs[openDialogs.length - 1] === token;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTop()) closeRef.current();
      // Focus trap: Tab and Shift+Tab cycle inside the topmost dialog.
      if (e.key === 'Tab' && isTop() && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (!ref.current.contains(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    const prev = document.activeElement as HTMLElement | null;
    // Focus the first field, but never take focus away from a field the person already chose in this dialog:
    // a late timer used to move it (and the rest of the typing) into the first field on a busy PC.
    const focusFirst = () => {
      if (ref.current && !ref.current.contains(document.activeElement)) ref.current.querySelector<HTMLElement>('input,select,textarea,button[data-autofocus]')?.focus();
    };
    focusFirst();
    const late = setTimeout(focusFirst, 30); // content that mounts a moment later
    return () => {
      clearTimeout(late);
      window.removeEventListener('keydown', onKey);
      openDialogs.splice(openDialogs.indexOf(token), 1);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="no-print fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-navy/45 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={clsx('w-full overflow-hidden rounded-panel bg-surface shadow-pop', size ? SIZE[size] : width)}>
        <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-4">
          <div>
            <h2 id={titleId} className="text-section font-semibold text-ink">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-meta text-ink-3">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-control p-1.5 text-ink-3 hover:bg-panel hover:text-ink" aria-label={translate('Close')}>
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 py-3">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 bg-panel px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
