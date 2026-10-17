// Number and identifier fields (UX-1, D-ux1-1). One behaviour for every amount, weight and count in the app:
// a text field with a numeric keypad (`inputMode`), no spinner, the mouse wheel never changes it, only digits and one
// decimal separator (Arabic digits accepted and normalized), letters/e/+/- refused as you type and when pasted, a
// visible unit, thousands separators while not focused, the value kept as a string (empty stays empty), and inline
// text for a refused key or an out-of-range value. Digits stay left-to-right inside the Arabic layout.
// The rules themselves are pure functions in shared/src/inputs.ts (property-tested).

import { forwardRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  groupDigits,
  parseDecimalInput,
  parseIntegerInput,
  parseMoneyInput,
  parseWeightInput,
  rangeProblem,
  sanitizeNumber,
  sanitizePhone,
  sanitizeReference,
  type InputCheck,
  type InputRefusal,
} from '@jerp/shared';
import { currencyLabel, gramUnit } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { controlClass } from './Field';

type Native = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max' | 'step' | 'size'>;
export interface NumberFieldProps extends Native {
  /** The text as typed ("" when empty). */
  value: string;
  onValueChange: (value: string) => void;
  min?: number;
  max?: number;
  invalid?: boolean;
  /** Compact height for table rows (36 px; 44 px on a narrow screen either way). */
  compact?: boolean;
}

/** The inline text for a refused key or paste. */
export function useRefusalText() {
  const { t } = useI18n();
  return (reason: InputRefusal, decimals = 0) =>
    ({
      chars: t('Digits only'),
      whole: t('Whole numbers only'),
      decimals: t('At most {n} digits after the decimal point', { n: decimals }),
      separator: t('Only one decimal point'),
      grouping: t('Paste the number without separators'),
      length: t('Too long'),
    })[reason];
}

const sizeClass = (compact?: boolean) => (compact ? 'h-11 md:h-9 text-[13px]' : 'h-11 md:h-10');

interface CoreProps extends NumberFieldProps {
  decimals: number;
  parse: (text: string) => number | null;
  unit?: ReactNode;
  /** How a limit is written in the inline message (e.g. money with grouping). */
  showLimit?: (n: number) => string;
}

const NumberCore = forwardRef<HTMLInputElement, CoreProps>(function NumberCore(
  { value, onValueChange, decimals, parse, unit, min, max, invalid, compact, className, showLimit = (n) => groupDigits(String(n)), onFocus, onBlur, ...rest },
  ref,
) {
  const { t, lang } = useI18n();
  const refusalText = useRefusalText();
  const [focused, setFocused] = useState(false);
  const [refused, setRefused] = useState<InputRefusal | null>(null);
  const n = parse(value);
  const range = rangeProblem(n, min, max);
  const message = refused ? refusalText(refused, decimals) : range === 'min' ? t('At least {min}', { min: showLimit(min!) }) : range === 'max' ? t('At most {max}', { max: showLimit(max!) }) : null;
  const shown = focused || n == null ? value : groupDigits(value);
  const unitText = typeof unit === 'string' ? unit : '';
  const pad = unit ? `calc(${Math.max(unitText.length, 2)}ch + 1.25rem)` : undefined;
  const rtl = lang === 'ar';
  return (
    <span className={clsx('block', className)}>
      <span className="relative block">
        <input
          ref={ref}
          {...rest}
          type="text"
          inputMode={decimals > 0 ? 'decimal' : 'numeric'}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          value={shown}
          aria-invalid={invalid || !!message || rest['aria-invalid'] || undefined}
          className={clsx(controlClass, sizeClass(compact), 'num w-full')}
          style={{ textAlign: rtl ? 'right' : 'left', ...(pad ? (rtl ? { paddingLeft: pad } : { paddingRight: pad }) : {}) }}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            setRefused(null);
            onBlur?.(e);
          }}
          onChange={(e) => {
            const r = sanitizeNumber(e.target.value, decimals);
            if (r.ok) {
              setRefused(null);
              if (r.value !== value) onValueChange(r.value);
            } else setRefused(r.reason);
          }}
        />
        {unit && (
          <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-meta text-ink-3" aria-hidden>
            {unit}
          </span>
        )}
      </span>
      {message && (
        <span className="mt-1 block text-meta text-crit" role="status" data-input-error>
          {message}
        </span>
      )}
    </span>
  );
});

/** Whole currency units (the setting's currency label as the unit). */
export const MoneyInput = forwardRef<HTMLInputElement, NumberFieldProps>((props, ref) => <NumberCore ref={ref} {...props} decimals={0} parse={parseMoneyInput} unit={currencyLabel()} />);
MoneyInput.displayName = 'MoneyInput';

/** Grams with at most 3 decimals; `parseWeightInput` turns the text into integer mg. */
export const WeightInput = forwardRef<HTMLInputElement, NumberFieldProps>((props, ref) => (
  <NumberCore ref={ref} {...props} decimals={3} parse={parseWeightInput} unit={gramUnit()} showLimit={(n) => String(n / 1000)} />
));
WeightInput.displayName = 'WeightInput';

/** Karat, counts, percentages, days… (whole numbers, with limits and an optional unit such as "%"). */
export const IntegerInput = forwardRef<HTMLInputElement, NumberFieldProps & { unit?: string }>((props, ref) => <NumberCore ref={ref} {...props} decimals={0} parse={parseIntegerInput} />);
IntegerInput.displayName = 'IntegerInput';

/** A number with a few decimals (the scrap price tolerance %, the only non-integer setting). */
export const DecimalInput = forwardRef<HTMLInputElement, NumberFieldProps & { decimals: number; unit?: string }>(({ decimals, ...props }, ref) => (
  <NumberCore ref={ref} {...props} decimals={decimals} parse={(s) => parseDecimalInput(s, decimals)} />
));
DecimalInput.displayName = 'DecimalInput';

// ── identifiers typed as text: a per-field rule, refused as you type ──

interface RuleProps extends Omit<Native, 'maxLength'> {
  value: string;
  onValueChange: (value: string) => void;
  invalid?: boolean;
  compact?: boolean;
  /** At most this many characters. */
  maxChars?: number;
}

function RuleInput({ rule, refusal, value, onValueChange, invalid, compact, className, maxChars, onBlur, ...rest }: RuleProps & { rule: (raw: string) => InputCheck; refusal: string }) {
  const { t } = useI18n();
  const [refused, setRefused] = useState<InputRefusal | null>(null);
  const message = refused === 'length' ? t('At most {n} characters', { n: maxChars ?? '' }) : refused ? refusal : null;
  return (
    <span className={clsx('block', className)}>
      <input
        {...rest}
        type="text"
        autoComplete="off"
        spellCheck={false}
        dir="ltr"
        value={value}
        aria-invalid={invalid || !!message || rest['aria-invalid'] || undefined}
        className={clsx(controlClass, sizeClass(compact), 'w-full font-mono')}
        onBlur={(e) => {
          setRefused(null);
          onBlur?.(e);
        }}
        onChange={(e) => {
          const r = rule(e.target.value);
          if (r.ok) {
            setRefused(null);
            onValueChange(r.value);
          } else setRefused(r.reason);
        }}
      />
      {message && (
        <span className="mt-1 block text-meta text-crit" role="status" data-input-error>
          {message}
        </span>
      )}
    </span>
  );
}

/** Phone: digits, spaces and a leading "+". */
export function PhoneInput({ maxChars = 30, ...props }: RuleProps) {
  const { t } = useI18n();
  return <RuleInput {...props} maxChars={maxChars} inputMode="tel" rule={(s) => sanitizePhone(s, maxChars)} refusal={t('Digits, spaces and a leading + only')} />;
}

/**
 * Bank and transfer references, supplier invoice numbers, ID document numbers: Latin letters (upper-cased), digits,
 * space, "-", "/" and "." (the FIX-2 set of `validBankReference`), Arabic digits normalized as typed.
 */
export function ReferenceInput({ maxChars = 40, ...props }: RuleProps) {
  const { t } = useI18n();
  return <RuleInput {...props} maxChars={maxChars} autoCapitalize="characters" rule={(s) => sanitizeReference(s, maxChars)} refusal={t('Latin letters, digits, space, - / . only')} />;
}
