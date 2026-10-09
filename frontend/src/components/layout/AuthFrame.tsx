// The frame of the signed-out and first-run screens (UI-A1, owner answer Q2): a plain white page with the logo and
// the company name centred above the form. No marketing panel; the company tagline from the settings waits for UI-A2.
// Used by the sign-in, the first password change and the passkey enrolment.

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { useI18n } from '../../lib/i18n';
import { Logo } from './Sidebar';

export function AuthFrame({ children, width = 'md', languageSwitch = false }: { children: ReactNode; width?: 'md' | 'lg'; languageSwitch?: boolean }) {
  const { lang, setLang } = useI18n();
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
        <div className="mb-6 flex justify-center">
          <Logo onDark={false} />
        </div>
        {children}
      </div>
    </div>
  );
}
