import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  Building2,
  ChevronsLeft,
  ChevronsRight,
  ClipboardList,
  Coins,
  FlaskConical,
  Gem,
  Globe,
  LayoutDashboard,
  LogOut,
  MonitorSmartphone,
  Package,
  Receipt,
  ScrollText,
  Settings,
  ShoppingCart,
  Truck,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import type { Permission } from '@jerp/shared';
import { get, post, setCurrentModule, translateParams } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { deviceText, money, relative } from '../../lib/format';
import { useI18n } from '../../lib/i18n';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  show: (can: (p: Permission) => boolean) => boolean;
  badge?: number;
}

export function Logo({ compact = false }: { compact?: boolean }) {
  const { me } = useAuth();
  const { t, L } = useI18n();
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-gold-600/40 bg-ink-850">
        <Gem className="size-[18px] text-gold-400" strokeWidth={1.75} />
      </div>
      {!compact && (
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[14px] font-semibold text-white">{L(me?.company.name ?? 'Loai Tabeede', me?.company.nameAr ?? 'لؤي تبيدي')}</div>
          <div className="text-[11px] tracking-wide text-gold-400/90">{t('ERP · Prototype')}</div>
        </div>
      )}
    </div>
  );
}

function useHasadQueueCount() {
  const { can } = useAuth();
  const enabled = can('hasad.process') || can('hasad.view');
  const q = useQuery({
    queryKey: ['hasad', 'queue-count'],
    queryFn: () => get<{ withdrawals: { status: string }[] }>('/hasad/withdrawals', { status: 'READY_FOR_PICKUP,IN_PROGRESS' }),
    enabled,
    refetchInterval: 20_000,
  });
  return q.data?.withdrawals.length ?? 0;
}

export function AppShell() {
  const { me, can, logout } = useAuth();
  const { t, L, lang, setLang } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const hasadCount = useHasadQueueCount();
  const focusMode = location.pathname.startsWith('/pos') || /^\/hasad\/\d+/.test(location.pathname);
  const [collapsed, setCollapsed] = useState(focusMode);
  useEffect(() => setCollapsed(focusMode), [focusMode]);

  // Report the module the user is in (visible to administrators in Active Sessions).
  // Set during render so the page's own requests already carry it.
  setCurrentModule(location.pathname.split('/')[1] || 'home');
  useEffect(() => {
    post('/sessions/heartbeat').catch(() => undefined);
  }, [location.pathname]);
  useEffect(() => {
    const id = setInterval(() => post('/sessions/heartbeat').catch(() => undefined), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!me) return null;

  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: t('Counter'),
      items: [
        { to: '/pos', label: t('Point of Sale'), icon: <ShoppingCart />, show: (c) => c('pos.access') },
        { to: '/hasad', label: t('Hasad Withdrawals'), icon: <Coins />, show: (c) => c('hasad.process') || c('hasad.view'), badge: hasadCount },
        { to: '/me', label: t('My Activity'), icon: <UserRound />, show: (c) => c('sales.view_own') && !c('sales.view') },
      ],
    },
    {
      title: t('Management'),
      items: [
        { to: '/overview', label: t('Executive Overview'), icon: <LayoutDashboard />, show: (c) => c('dashboard.company') },
        { to: '/dashboard', label: t('Dashboard'), icon: <LayoutDashboard />, show: (c) => c('dashboard.branch') && !c('dashboard.company') },
        { to: '/branches', label: t('Branches'), icon: <Building2 />, show: (c) => c('scope.all_branches') },
        { to: '/sales', label: t('Sales'), icon: <Receipt />, show: (c) => c('sales.view') },
        { to: '/inventory', label: t('Inventory'), icon: <Package />, show: (c) => c('inventory.view') },
        { to: '/purchases', label: t('Purchases'), icon: <Truck />, show: (c) => c('purchases.view') },
        { to: '/expenses', label: t('Expenses'), icon: <Wallet />, show: (c) => c('expenses.view') },
        { to: '/transfers', label: t('Transfers'), icon: <ArrowLeftRight />, show: (c) => c('inventory.transfer') && c('inventory.view') },
        { to: '/reports', label: t('Reports'), icon: <BarChart3 />, show: (c) => c('reports.view') },
      ],
    },
    {
      title: t('Administration'),
      items: [
        { to: '/users', label: t('Users'), icon: <Users />, show: (c) => c('users.view') },
        { to: '/sessions', label: t('Active Users'), icon: <MonitorSmartphone />, show: (c) => c('sessions.view') },
        { to: '/audit', label: t('Audit Log'), icon: <ScrollText />, show: (c) => c('audit.view') },
        { to: '/hasad-simulator', label: t('Hasad Simulator'), icon: <FlaskConical />, show: (c) => c('hasad.simulate') },
        { to: '/settings', label: t('Settings'), icon: <Settings />, show: (c) => c('settings.manage') },
      ],
    },
  ];

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className={clsx('no-print flex shrink-0 flex-col bg-ink-900 text-ink-300 transition-[width] duration-150', collapsed ? 'w-[64px]' : 'w-[236px]')}>
        <div className={clsx('flex h-14 items-center border-b border-white/5', collapsed ? 'justify-center px-2' : 'px-4')}>
          <Logo compact={collapsed} />
        </div>
        <nav className="scroll-thin flex-1 overflow-y-auto px-2 py-3" aria-label={t('Main menu')}>
          {groups.map((g) => {
            const items = g.items.filter((i) => i.show(can));
            if (!items.length) return null;
            return (
              <div key={g.title} className="mb-4">
                {!collapsed && <div className="px-2.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-500">{g.title}</div>}
                {items.map((i) => (
                  <NavLink
                    key={i.to}
                    to={i.to}
                    title={collapsed ? i.label : undefined}
                    className={({ isActive }) =>
                      clsx(
                        'group relative mb-0.5 flex h-9 items-center gap-3 rounded-md text-[13.5px] transition-colors [&_svg]:size-[18px] [&_svg]:shrink-0',
                        collapsed ? 'justify-center' : 'px-2.5',
                        isActive ? 'bg-white/[0.07] text-white' : 'hover:bg-white/[0.04] hover:text-white',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="absolute inset-y-1.5 start-0 w-[3px] rounded-full bg-gold-500" />}
                        <span className={clsx(isActive ? 'text-gold-400' : 'text-ink-400 group-hover:text-ink-300')}>{i.icon}</span>
                        {!collapsed && <span className="flex-1 truncate">{i.label}</span>}
                        {!!i.badge && (
                          <span className={clsx('rounded-full bg-gold-500 px-1.5 text-[10.5px] font-semibold text-ink-950 num', collapsed && 'absolute end-1 top-0.5')}>{i.badge}</span>
                        )}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="border-t border-white/5 p-2">
          <button onClick={() => setCollapsed((c) => !c)} className="flex h-8 w-full items-center justify-center gap-2 rounded-md text-xs text-ink-400 hover:bg-white/5 hover:text-white">
            {collapsed ? <ChevronsRight className="size-4 rtl:rotate-180" /> : <><ChevronsLeft className="size-4 rtl:rotate-180" /> {t('Collapse')}</>}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex h-14 shrink-0 items-center gap-3 border-b border-line bg-white px-4 lg:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-canvas px-2.5 py-1 text-[13px] font-medium text-ink-800">
              <Building2 className="size-3.5 text-ink-500" />
              {me.user.branch ? L(me.user.branch.name, me.user.branch.nameAr) : t('All branches')}
            </span>
            <span className="hidden rounded border border-dashed border-gold-500/60 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-gold-700 md:inline" title={t('Demo data · Hasad Gold is simulated by a mock service')}>
              {me.hasadMode === 'MOCK' ? t('Demo · Hasad mock') : t('Demo · Hasad live')}
            </span>
          </div>
          <div className="ms-auto flex items-center gap-1.5 sm:gap-3">
            <GoldRate />
            <Clock />
            <Notifications />
            <button
              onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-600 hover:bg-canvas"
              aria-label={t('Switch language')}
            >
              <Globe className="size-4" /> {lang === 'en' ? 'العربية' : 'English'}
            </button>
            <UserMenu onLogout={async () => { await logout(); navigate('/login'); }} />
          </div>
        </header>
        <main className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function GoldRate() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['gold-rates'], queryFn: () => get<{ current: Record<string, { pricePerGram: number }> }>('/gold-rates'), refetchInterval: 120_000 });
  const r = q.data?.current['21']?.pricePerGram;
  return (
    <div className="hidden items-center gap-2 rounded-md bg-ink-900 px-2.5 py-1 text-[12.5px] lg:flex" title={t('Reference gold price per gram (set by the General Manager)')}>
      <span className="size-1.5 rounded-full bg-gold-400" />
      <span className="text-ink-300">{t('Gold 21K')}</span>
      <span className="font-semibold text-gold-300 num">{r ? money(r) : '—'}/{t('g')}</span>
    </div>
  );
}

function Clock() {
  const { lang } = useI18n();
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  const loc = lang === 'ar' ? 'ar-SD-u-nu-latn' : 'en-GB';
  return (
    <div className="hidden text-end leading-tight md:block">
      <div className="text-[13px] font-medium text-ink-800 num">{now.toLocaleTimeString(loc, { timeZone: 'Africa/Khartoum', hour: '2-digit', minute: '2-digit' })}</div>
      <div className="text-[11px] text-ink-500">{now.toLocaleDateString(loc, { timeZone: 'Africa/Khartoum', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div>
    </div>
  );
}

interface Notif {
  id: string;
  kind: string;
  /** Translation keys filled with `params`. */
  title: string;
  body: string;
  params?: Record<string, string | number>;
  link: string;
  at: string;
  severity: 'info' | 'warning';
}

function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onOutside();
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onOutside]);
  return ref;
}

function Notifications() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => get<Notif[]>('/notifications'), refetchInterval: 30_000 });
  const items = q.data ?? [];
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="relative grid size-8 place-items-center rounded-md text-ink-600 hover:bg-canvas" aria-label={t('Notifications')}>
        <Bell className="size-[18px]" />
        {items.length > 0 && <span className="absolute -end-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-gold-500 px-1 text-[10px] font-bold text-ink-950 num">{items.length}</span>}
      </button>
      {open && (
        <div className="absolute end-0 top-10 z-40 w-[360px] overflow-hidden rounded-lg border border-line bg-white shadow-xl">
          <div className="border-b border-line px-4 py-2.5 text-sm font-semibold">{t('Notifications')}</div>
          <div className="scroll-thin max-h-[420px] overflow-y-auto">
            {items.length === 0 && <div className="px-4 py-8 text-center text-[13px] text-ink-500">{t('No notifications')}</div>}
            {items.map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  setOpen(false);
                  navigate(n.link);
                }}
                className="flex w-full gap-3 border-b border-line/70 px-4 py-3 text-start last:border-0 hover:bg-canvas"
              >
                <span className={clsx('mt-1.5 size-2 shrink-0 rounded-full', n.severity === 'warning' ? 'bg-amber-500' : n.kind === 'HASAD' ? 'bg-gold-500' : 'bg-sky-500')} />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-ink-900">{t(n.title, translateParams(n.params))}</span>
                  <span className="block truncate text-xs text-ink-500">{t(n.body, translateParams(n.params))}</span>
                  <span className="mt-0.5 block text-[11px] text-ink-400">{relative(n.at)}</span>
                </span>
              </button>
            ))}
          </div>
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
  if (!me) return null;
  const initials = me.user.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('');
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-md py-1 pe-1 ps-1 hover:bg-canvas sm:pe-2">
        <span className="grid size-8 place-items-center rounded-full bg-ink-900 text-[12px] font-semibold text-gold-300">{initials}</span>
        <span className="hidden text-start leading-tight sm:block">
          <span className="block max-w-36 truncate text-[13px] font-medium text-ink-900">{L(me.user.fullName, me.user.fullNameAr)}</span>
          <span className="block text-[11px] text-ink-500">{L(me.user.role.name, me.user.role.nameAr)}</span>
        </span>
      </button>
      {open && (
        <div className="absolute end-0 top-11 z-40 w-72 rounded-lg border border-line bg-white p-1.5 shadow-xl">
          <div className="px-3 py-2.5">
            <div className="font-medium text-ink-900">{me.user.fullName}</div>
            <div className="font-mono text-xs text-ink-500">{me.user.username}</div>
            {me.session && (
              <div className="mt-2 rounded-md bg-canvas px-2.5 py-2 text-[11.5px] text-ink-600">
                {t('Session')} <span className="font-mono">{me.session.ref}</span> · {deviceText(me.session.device)}
                <br />
                {t('Signed in {when}', { when: relative(me.session.loginAt) })} · {t('IP')} <span className="font-mono">{me.session.ipAddress}</span>
                <br />
                <span className="text-ink-400">{t('Sessions are visible to your administrators.')}</span>
              </div>
            )}
          </div>
          <button onClick={() => { setOpen(false); navigate('/me'); }} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-[13px] hover:bg-canvas">
            <ClipboardList className="size-4 text-ink-500" /> {t('My Activity')}
          </button>
          <button onClick={onLogout} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-[13px] text-rose-700 hover:bg-rose-50">
            <LogOut className="size-4" /> {t('Sign out')}
          </button>
        </div>
      )}
    </div>
  );
}
