// Form controls (UI-A1): 40 px high, radius 10, white on any surface. Focus shows the global ring (index.css);
// an invalid control (aria-invalid) gets a critical border. `Field` ties its label, hint and error to the control.

import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import clsx from 'clsx';

const hasWidth = (c?: string) => !!c && /(^|\s)(w-|min-w-|max-w-|flex-1)/.test(c);
export const controlClass =
  'h-10 rounded-control border border-line-strong bg-surface px-3 text-[15px] text-ink placeholder:text-ink-3 hover:border-ink-400 focus:border-navy disabled:cursor-not-allowed disabled:bg-panel disabled:text-ink-3 read-only:bg-panel aria-[invalid=true]:border-crit';

type Invalid = { invalid?: boolean };

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & Invalid>(({ className, invalid, ...rest }, ref) => (
  <input ref={ref} aria-invalid={invalid || rest['aria-invalid'] || undefined} className={clsx(controlClass, !hasWidth(className) && 'w-full', className)} {...rest} />
));
Input.displayName = 'Input';

export function Textarea({ className, invalid, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & Invalid) {
  return <textarea aria-invalid={invalid || rest['aria-invalid'] || undefined} className={clsx(controlClass, 'h-auto min-h-20 w-full py-2', className)} {...rest} />;
}

export function Select({ className, children, invalid, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & Invalid) {
  return (
    <select aria-invalid={invalid || rest['aria-invalid'] || undefined} className={clsx(controlClass, 'pe-8', !hasWidth(className) && 'w-full', className)} {...rest}>
      {children}
    </select>
  );
}

/**
 * A labelled control. The label wraps the control (so clicking it focuses the control); `hint` and `error` are linked
 * through aria-describedby, and `error` marks the control invalid.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const only = Children.count(children) === 1 && isValidElement(children) ? (children as ReactElement<Record<string, unknown>>) : null;
  const control =
    only && (describedBy || error)
      ? cloneElement(only, {
          'aria-describedby': [only.props['aria-describedby'], describedBy].filter(Boolean).join(' ') || undefined,
          ...(error ? { 'aria-invalid': true } : {}),
        })
      : children;
  return (
    <label className={clsx('block', className)}>
      <span className="mb-1.5 block text-meta font-medium text-ink-2">
        {label}
        {required && (
          <span className="text-crit" aria-hidden>
            {' '}*
          </span>
        )}
      </span>
      {control}
      {hint && (
        <span id={hintId} className="mt-1 block text-meta text-ink-3">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} className="mt-1 block text-meta text-crit">
          {error}
        </span>
      )}
    </label>
  );
}
