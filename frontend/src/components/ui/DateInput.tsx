// Date field (UX-1, D-ux1-2). A native date field shows the BROWSER's format (mm/dd/yyyy on an English-US Windows),
// whatever the page language. This one always shows dd/mm/yyyy and stores a business-day key yyyy-mm-dd:
// type the digits (the slashes are added; Arabic digits accepted) or open the browser's calendar with the button.
// `min`/`max` keep their meaning (e.g. a transfer date is never in the future); a date outside them is not passed on
// and says why inline. `onChange` receives a valid key only, or "" when the field is cleared.

import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import clsx from 'clsx';
import { CalendarDays } from 'lucide-react';
import { dayKeyToInput, inputToDayKey, sanitizeDayTyping } from '@jerp/shared';
import { useI18n } from '../../lib/i18n';
import { controlClass } from './Field';

type Native = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'>;

export function DateInput({
  value,
  onChange,
  min,
  max,
  compact,
  className,
  invalid,
  onBlur,
  ...rest
}: Native & { value: string; onChange: (key: string) => void; min?: string; max?: string; compact?: boolean; invalid?: boolean }) {
  const { t, lang } = useI18n();
  const rtl = lang === 'ar';
  const [text, setText] = useState(() => dayKeyToInput(value));
  const [problem, setProblem] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  // A new value from outside (a quick range, a reset) replaces the text, unless the text already says that day.
  useEffect(() => {
    if (inputToDayKey(text) !== value) setText(dayKeyToInput(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const accept = (next: string, final: boolean) => {
    setText(next);
    if (next === '') {
      setProblem(null);
      onChange('');
      return;
    }
    const key = inputToDayKey(next);
    if (!key) {
      setProblem(final ? (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(next) ? t('Not a real date') : t('Day/month/year, for example {example}', { example: '17/10/2026' })) : null);
      return;
    }
    if (max && key > max) return setProblem(t('Not after {date}', { date: dayKeyToInput(max) }));
    if (min && key < min) return setProblem(t('Not before {date}', { date: dayKeyToInput(min) }));
    setProblem(null);
    if (key !== value) onChange(key);
  };

  return (
    <span className={clsx('block', className)}>
      <span className="relative block">
        <input
          {...rest}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          placeholder={t('dd/mm/yyyy')}
          value={text}
          aria-invalid={invalid || !!problem || rest['aria-invalid'] || undefined}
          className={clsx(controlClass, compact ? 'h-11 md:h-8 text-[13px]' : 'h-11 md:h-10', 'num w-full')}
          // The input is left-to-right; the calendar button sits at the page's end (the left in Arabic).
          style={{ textAlign: rtl ? 'right' : 'left', ...(rtl ? { paddingLeft: '2.5rem' } : { paddingRight: '2.5rem' }) }}
          onChange={(e) => {
            const r = sanitizeDayTyping(e.target.value);
            if (r.ok) accept(r.value, false);
            else setProblem(t('Digits only'));
          }}
          onBlur={(e) => {
            accept(text, true);
            onBlur?.(e);
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          className="absolute inset-y-0 end-0 flex w-10 items-center justify-center text-ink-3 hover:text-ink"
          aria-label={t('Open calendar')}
          title={t('Open calendar')}
          onClick={() => {
            const p = picker.current;
            if (!p) return;
            p.value = value;
            try {
              p.showPicker();
            } catch {
              p.focus();
            }
          }}
        >
          <CalendarDays className="size-4" />
        </button>
        {/* The browser's calendar only: never shown or focused, its format never reaches the screen. */}
        <input
          ref={picker}
          type="date"
          tabIndex={-1}
          aria-hidden
          min={min}
          max={max}
          className="pointer-events-none absolute bottom-0 end-0 size-px opacity-0"
          onChange={(e) => e.target.value && accept(dayKeyToInput(e.target.value), true)}
        />
      </span>
      {problem && (
        <span className="mt-1 block text-meta text-crit" role="status" data-input-error>
          {problem}
        </span>
      )}
    </span>
  );
}
