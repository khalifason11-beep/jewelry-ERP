// App shell (UI-A1, mockups docs/ux/mockups/*-home.html): white page, a floating navy sidebar 16 px from the edges, a
// 44 px top bar without background, then the notice area (UI-A2, D-ui-13: security and system notices, one line
// each, above the page) and the page. Role-aware navigation: nav.ts; top bar: TopBar.tsx.

import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { post, setCurrentModule } from '../../lib/api';
import { homePath, useAuth } from '../../lib/auth';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { PageErrorBoundary } from './PageErrorBoundary';
import { Notices } from './Notices';

export function AppShell() {
  const { me, logout } = useAuth();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const focusMode = location.pathname.startsWith('/pos');
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

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <div className="no-print shrink-0 py-4 ps-4">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="px-5 pt-4 lg:px-6">
          <TopBar
            onLogout={async () => {
              await logout();
              navigate('/login');
            }}
          />
        </div>
        <main className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <Notices />
          <PageErrorBoundary
            key={location.pathname}
            home={homePath(me)}
            // Data no screen still shows may be what broke the page: the next page loads it fresh.
            onCrash={() => queryClient.removeQueries({ type: 'inactive' })}
          >
            <Outlet />
          </PageErrorBoundary>
        </main>
      </div>
    </div>
  );
}
