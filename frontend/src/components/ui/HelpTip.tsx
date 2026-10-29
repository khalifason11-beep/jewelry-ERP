// "?" help (UX-2): background text that is useful once but not on every visit stays out of the screen and opens from a
// small round button. A disclosure, not a hover tooltip, so it works on touch: the button toggles it; Enter/Space work
// as on any button; Escape closes it (and only it, not the dialog around it) and returns focus to the button; a click
// or tap outside closes it.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { CircleHelp } from 'lucide-react';
import { translate } from '../../lib/i18n';

export function HelpTip({ children, className }: { children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return (
    <span
      ref={root}
      className={clsx('relative inline-flex shrink-0 align-middle', className)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          // Only the help closes: the dialog it may sit in listens for Escape on the window.
          e.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        aria-label={translate('More information')}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex size-5 items-center justify-center rounded-full text-ink-3 hover:bg-panel hover:text-ink aria-expanded:text-navy"
        data-testid="help-tip"
      >
        <CircleHelp className="size-4" aria-hidden />
      </button>
      {open && (
        <span
          id={id}
          className="absolute start-0 top-full z-40 mt-1 block w-72 max-w-[80vw] rounded-control bg-navy px-3 py-2 text-meta font-normal leading-relaxed text-white shadow-pop"
          data-testid="help-tip-text"
        >
          {children}
        </span>
      )}
    </span>
  );
}
