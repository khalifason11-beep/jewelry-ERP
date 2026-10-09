// Sidebar (UI-A1, mockup `.side`): a navy panel with rounded corners, floating 16 px from the page edge, 232 px wide
// (64 px as icons). Groups and items per role come from nav.ts. The active item is navy-2 with a gold marker on the
// start side (in both directions). The cashier always sees the icon form, with no expand button.

import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import clsx from 'clsx';
import {
  ArrowLeftRight,
  Banknote,
  BarChart3,
  Building2,
  ChevronsLeft,
  ChevronsRight,
  ClipboardList,
  Home,
  MonitorSmartphone,
  Package,
  Receipt,
  Recycle,
  ScrollText,
  Settings,
  ShoppingCart,
  Tags,
  Truck,
  Users,
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useBranding } from '../../lib/branding';
import { useI18n } from '../../lib/i18n';
import { isCounterOnly, navFor, type NavIcon } from './nav';

// One distinct icon per item (D-ux-6); the diamond is only the logo.
const ICONS: Record<NavIcon, ReactNode> = {
  home: <Home />,
  pos: <ShoppingCart />,
  'my-activity': <ClipboardList />,
  sales: <Receipt />,
  inventory: <Package />,
  transfers: <ArrowLeftRight />,
  scrap: <Recycle />,
  catalog: <Tags />,
  purchases: <Truck />,
  cash: <Banknote />,
  branches: <Building2 />,
  reports: <BarChart3 />,
  users: <Users />,
  sessions: <MonitorSmartphone />,
  audit: <ScrollText />,
  settings: <Settings />,
};

export function Logo({ compact = false, onDark = true }: { compact?: boolean; onDark?: boolean }) {
  const branding = useBranding();
  const { L } = useI18n();
  return (
    <div className="flex items-center gap-2.5">
      <div className={clsx('grid size-8 shrink-0 place-items-center overflow-hidden rounded-[9px] border-[1.5px] border-gold', onDark ? 'bg-navy' : 'bg-surface')}>
        {branding.logoUrl ? <img src={branding.logoUrl} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-[14px] leading-none text-gold">◆</span>}
      </div>
      {!compact && (
        <div className="min-w-0 truncate text-[15px] font-semibold leading-tight" style={{ color: onDark ? '#fff' : undefined }}>
          {L(branding.company.nameEn, branding.company.nameAr)}
        </div>
      )}
    </div>
  );
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { can } = useAuth();
  const { t } = useI18n();
  const counterOnly = isCounterOnly(can);
  const iconsOnly = collapsed || counterOnly;
  const groups = navFor(can);
  return (
    <aside
      data-testid="sidebar"
      className={clsx('no-print flex h-full shrink-0 flex-col rounded-panel bg-navy py-3.5 text-on-navy transition-[width] duration-150', iconsOnly ? 'w-16 px-2' : 'w-[232px] px-2.5')}
    >
      <div className={clsx('pb-2.5', iconsOnly ? 'flex justify-center' : 'px-2')}>
        <Logo compact={iconsOnly} />
      </div>
      <nav className="scroll-thin min-h-0 flex-1 overflow-y-auto" aria-label={t('Main menu')}>
        {groups.map((g, gi) => (
          <div key={g.title ?? `g${gi}`}>
            {g.title && !iconsOnly && <div className="mx-2.5 mb-0.5 mt-2.5 text-meta text-on-navy-muted">{t(g.title)}</div>}
            {g.title && iconsOnly && gi > 0 && <div className="mx-3 my-2 border-t border-white/10" aria-hidden />}
            {g.items.map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                title={iconsOnly ? t(i.label) : undefined}
                aria-label={iconsOnly ? t(i.label) : undefined}
                data-testid={`nav-${i.to.slice(1)}`}
                className={({ isActive }) =>
                  clsx(
                    'relative flex h-8 items-center gap-2.5 rounded-control text-[15px] transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
                    iconsOnly ? 'justify-center' : 'px-2.5',
                    isActive ? 'bg-navy-2 text-white' : 'hover:bg-navy-3/60 hover:text-white',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute inset-y-1.5 start-0 w-[3px] rounded-full bg-gold" aria-hidden />}
                    <span className={clsx(isActive ? 'text-white' : 'opacity-85')}>{ICONS[i.icon]}</span>
                    {!iconsOnly && <span className="flex-1 truncate">{t(i.label)}</span>}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      {!counterOnly && (
        <button
          onClick={onToggle}
          className="mt-2 flex h-8 w-full items-center justify-center gap-2 rounded-control text-meta text-on-navy-muted hover:bg-navy-3/60 hover:text-white"
          aria-label={collapsed ? t('Expand menu') : t('Collapse')}
          data-testid="sidebar-toggle"
        >
          {collapsed ? <ChevronsRight className="size-4 rtl:rotate-180" /> : <><ChevronsLeft className="size-4 rtl:rotate-180" /> {t('Collapse')}</>}
        </button>
      )}
    </aside>
  );
}
