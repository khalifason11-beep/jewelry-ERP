// Buttons (UI-A1, tokens.md, R4): one filled navy primary per screen; secondary and ghost for the rest; danger is
// red-OUTLINED everywhere, and filled red (`danger-solid`) only for the final confirm button inside a dialog.
// Gold is never a button fill (R5).

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid';
export type ButtonSize = 'sm' | 'md' | 'lg';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner in place of the icon, keeps the width, and blocks clicks (aria-busy). */
  loading?: boolean;
  icon?: ReactNode;
  iconEnd?: ReactNode;
  fullWidth?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', loading, icon, iconEnd, fullWidth, className, children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' && 'h-8 px-3 text-meta',
        size === 'md' && 'h-9 px-4 text-[15px]',
        size === 'lg' && 'h-11 px-5 text-[15px]',
        variant === 'primary' && 'bg-navy text-white hover:bg-navy-2 disabled:hover:bg-navy',
        variant === 'secondary' && 'border border-line-strong bg-surface text-ink hover:bg-panel',
        variant === 'ghost' && 'text-ink-2 hover:bg-panel hover:text-ink',
        variant === 'danger' && 'border border-crit bg-surface text-crit hover:bg-crit-bg',
        variant === 'danger-solid' && 'bg-crit text-white hover:bg-[#991b1b]',
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
      {!loading && iconEnd}
    </button>
  ),
);
Button.displayName = 'Button';
