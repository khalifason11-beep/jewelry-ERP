// The frame of the signed-out and first-run screens (UI-A1, owner answer Q2): a plain white page with the logo and
// the company name centred above the form. No marketing panel. UI-A2 (D-ui-14/15): on the sign-in page the
// General Manager's tagline (from the settings, public allow-list) sits under the name, in the Amiri display font.
// Used by the sign-in, the first password change and the passkey enrolment.

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { useI18n } from '../../lib/i18n';
import { useBranding } from '../../lib/branding';
import '../../assets/fonts/amiri/amiri.css';
import { Logo } from './Sidebar';

export function AuthFrame({ children, width = 'md', languageSwitch = false, tagline = false }: { children: ReactNode; width?: 'md' | 'lg'; languageSwitch?: boolean; tagline?: boolean }) {
  const { lang, setLang } = useI18n();
  const b = useBranding();
  // English falls back to the Arabic tagline, as names do. Rendered as text (React escapes it).
  const line = tagline ? (lang === 'en' ? b.tagline.en || b.tagline.ar : b.tagline.ar || b.tagline.en) : '';
  return (
    <div className="flex min-h-screen flex-col bg-surface" data-testid="auth-frame">
      <div className="flex h-16 items-center justify-end px-4">
        {languageSwitch && (
          <button
            onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}
            className="inline-flex h-9 items-center rounded-full bg-panel px-3.5 text-meta text-ink-2 hover:text-ink"
            lang={lang === 'en' ? 'ar' : 'en'}
          >
            {lang === 'en' ? 'العربية' : 'English'}
          </button>
        )}
      </div>
      <div className={clsx('mx-auto flex w-full flex-1 flex-col justify-center px-4 pb-16', width === 'md' ? 'max-w-[440px]' : 'max-w-xl')}>
        <div className="mb-6 flex flex-col items-center gap-2">
          <Logo onDark={false} />
          {line && (
            <p className="max-w-full text-center font-display text-[19px] leading-snug text-ink-2" data-testid="login-tagline" dir="auto">
              {line}
            </p>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
