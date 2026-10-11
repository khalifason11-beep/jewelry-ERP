// Top bar (UI-A1, mockup `.top`): 44 px, no bar background. Start side: the rate chip (navy pill with the gold dot).
// End side: the Demo badge (demo mode only), the attention control (UI-B; it replaced the bell), the language pill
// and the avatar menu. No clock (owner answer Q4). Shows the public selling rate only: no cost or profit figure.

import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CircleAlert, ClipboardList, Fingerprint, LogOut } from 'lucide-react';
import { get } from '../../lib/api';
import { homePath, useAuth } from '../../lib/auth';
import { AttentionLines, topSeverity, urgentCount, useAttention } from '../Attention';
import { deviceText, money, relative } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useNotices } from './Notices';

function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onOutside();
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onOutside]);
  return ref;
}

/** Today's 21K selling rate (public reference price; never a cost). REM-3: "Set today's rate" when none exists. */
export function RateChip() {
  const { t } = useI18n();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['gold-rates'], queryFn: () => get<{ current: Record<string, { pricePerGram: number }> }>('/gold-rates'), refetchInterval: 120_000 });
  const r = q.data?.current['21']?.pricePerGram;
  const missing = q.isSuccess && !r;
  const chip = (
    <div className="flex h-9 items-center gap-2 rounded-full bg-navy px-3.5 text-meta text-white" title={t('Reference gold price per gram (set by the General Manager)')} data-testid="rate-chip">
      <span className="size-2 rounded-full bg-gold" aria-hidden />
      <span className="text-on-navy-soft">{t('Gold 21K')}</span>
      {missing ? (
        <span className="font-semibold">{can('settings.manage') ? t('Set today’s rate') : t('No rate set yet')}</span>
      ) : (
        <span className="font-semibold num">
          {r ? money(r) : '—'}/{t('g')}
        </span>
      )}
    </div>
  );
  return missing && can('settings.manage') ? (
    <Link to="/settings" className="rounded-full hover:opacity-90">
      {chip}
    </Link>
  ) : (
    chip
  );
}

/**
 * The attention control (UI-B §3, D-ui-18), in the bell's old place: the badge counts the warning and critical lines
 * of `/api/attention` and takes the colour of the highest one (a missing or old backup is critical for the GM, so it
 * shows on every page). The popover lists up to five lines, then "Open the list on my home". On the home itself the
 * list is on the page, so the control only shows the count and scrolls to it. A cashier has no control (D-ux-14).
 */
function AttentionControl() {
  const { t } = useI18n();
  const { me, can } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const q = useAttention();
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open]);
  if (!me || !(can('dashboard.company') || can('dashboard.branch'))) return null;
  const home = homePath(me);
  const onHome = pathname === home;
  const urgent = urgentCount(q.data);
  const top = topSeverity(q.data);
  const signals = q.data?.signals ?? [];
  const label = urgent ? t('Needs attention: {n} items', { n: urgent }) : t('Needs attention');
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => (onHome ? document.getElementById('attention')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : setOpen((o) => !o))}
        className="relative grid size-9 place-items-center rounded-full text-ink-2 hover:bg-panel hover:text-ink"
        aria-label={label}
        aria-expanded={onHome ? undefined : open}
        data-testid="attention-button"
        data-count={urgent}
        data-severity={top ?? 'none'}
      >
        <CircleAlert className="size-[18px]" />
        {urgent > 0 && (
          <span
            className={clsx('absolute -end-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold text-white num', top === 'critical' ? 'bg-crit' : 'bg-warn')}
            data-testid="attention-count"
          >
            {urgent}
          </span>
        )}
      </button>
      {open && !onHome && (
        <div className="absolute end-0 top-11 z-40 w-[360px] max-w-[calc(100vw-32px)] overflow-hidden rounded-card border border-line bg-surface shadow-pop" data-testid="attention-menu">
          <div className="border-b border-line px-4 py-2.5 text-[15px] font-semibold">{t('Needs attention')}</div>
          <div className="scroll-thin max-h-[420px] overflow-y-auto">
            {q.isError ? (
              <div className="px-4 py-6 text-center text-meta text-crit" role="alert" data-testid="attention-error">{t('The list could not be loaded. It retries by itself.')}</div>
            ) : q.isLoading ? (
              <div className="px-4 py-6 text-center text-meta text-ink-3">{t('Loading…')}</div>
            ) : signals.length === 0 ? (
              <div className="px-4 py-8 text-center text-meta text-ink-3" data-testid="attention-empty">{t('No urgent actions.')}</div>
            ) : (
              <AttentionLines
                signals={signals.slice(0, 5)}
                onOpen={(s) => {
                  setOpen(false);
                  navigate(s.link);
                }}
              />
            )}
          </div>
          <button
            onClick={() => {
              setOpen(false);
              navigate(`${home}#attention`);
            }}
            className="block w-full border-t border-line px-4 py-2.5 text-start text-meta font-medium text-ink-2 hover:bg-panel hover:text-ink"
            data-testid="attention-open-home"
          >
            {signals.length > 5 ? t('Open the full list on my home ({n})', { n: signals.length }) : t('Open the list on my home')}
          </button>
        </div>
      )}
    </div>
  );
}

function UserMenu({ onLogout }: { onLogout: () => void }) {
  const { me } = useAuth();
  const { t, L } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const navigate = useNavigate();
  // UI-A2: a dot on the avatar while any notice is open (they are listed above the page).
  const notices = useNotices(() => undefined, () => undefined).length;
  if (!me) return null;
  const name = L(me.user.fullName, me.user.fullNameAr);
  // First letters of the first two words that start with a letter (skips marks such as "[Sample]").
  const initials = (name.match(/\p{L}\S*/gu) ?? []).map((w) => w[0]).slice(0, 2).join(' ');
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative grid size-9 place-items-center rounded-full bg-panel text-meta font-semibold text-ink hover:bg-neutral-bg"
        aria-label={notices ? `${t('Account menu: {name}', { name })} · ${t('{n} open notices', { n: notices })}` : t('Account menu: {name}', { name })}
        aria-expanded={open}
        data-testid="user-menu"
      >
        {initials}
        {notices > 0 && <span className="absolute -end-0.5 -top-0.5 size-2.5 rounded-full border-2 border-surface bg-crit" aria-hidden data-testid="notice-dot" />}
      </button>
      {open && (
        <div className="absolute end-0 top-11 z-40 w-72 rounded-card border border-line bg-surface p-1.5 shadow-pop">
          <div className="px-3 py-2.5">
            <div className="font-medium text-ink">{name}</div>
            <div className="text-meta text-ink-3">
              {L(me.user.role.name, me.user.role.nameAr)}
              {me.user.branch ? ` · ${L(me.user.branch.name, me.user.branch.nameAr)}` : ''}
            </div>
            <div className="font-mono text-[12px] text-ink-3">{me.user.username}</div>
            {me.session && (
              <div className="mt-2 rounded-row bg-panel px-2.5 py-2 text-[12px] text-ink-2">
                {t('Session')} <span className="font-mono">{me.session.ref}</span> · {deviceText(me.session.device)}
                <br />
                {t('Signed in {when}', { when: relative(me.session.loginAt) })} · {t('IP')} <span className="font-mono">{me.session.ipAddress}</span>
                <br />
                <span className="text-ink-3">{t('Sessions are visible to your administrators.')}</span>
              </div>
            )}
          </div>
          <button onClick={() => { setOpen(false); navigate('/me'); }} className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-[15px] hover:bg-panel">
            <ClipboardList className="size-4 text-ink-3" /> {t('My Activity')}
          </button>
          <button onClick={() => { setOpen(false); navigate('/security'); }} className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-[15px] hover:bg-panel" data-testid="menu-security">
            <Fingerprint className="size-4 text-ink-3" /> <span className="flex-1 text-start">{t('Sign-in security')}</span>
            {notices > 0 && <span className="rounded-badge bg-crit-bg px-1.5 text-[12px] font-semibold text-crit num">{notices}</span>}
          </button>
          <button onClick={onLogout} className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-[15px] text-crit hover:bg-crit-bg">
            <LogOut className="size-4" /> {t('Sign out')}
          </button>
        </div>
      )}
    </div>
  );
}

export function TopBar({ onLogout }: { onLogout: () => void }) {
  const { me } = useAuth();
  const { t, lang, setLang } = useI18n();
  return (
    <header className="no-print flex h-11 shrink-0 items-center gap-2.5" data-testid="topbar">
      <RateChip />
      <div className="flex-1" />
      {me?.appMode === 'demo' && (
        // REM-3: a small neutral marker so a local copy is never mistaken for production (never shown there).
        <span className="rounded-badge border border-line-strong px-2 py-0.5 text-meta text-ink-2" title={t('Demo mode: not the production system')} data-testid="demo-badge">
          {t('Demo')}
        </span>
      )}
      <AttentionControl />
      <button
        onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}
        className="inline-flex h-9 items-center rounded-full bg-panel px-3.5 text-meta text-ink-2 hover:text-ink"
        aria-label={t('Switch language')}
        lang={lang === 'en' ? 'ar' : 'en'}
        data-testid="language-switch"
      >
        {lang === 'en' ? 'العربية' : 'English'}
      </button>
      <UserMenu onLogout={onLogout} />
    </header>
  );
}
