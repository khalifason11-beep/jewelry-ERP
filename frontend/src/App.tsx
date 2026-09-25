import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ShieldX } from 'lucide-react';
import type { Permission } from '@jerp/shared';
import { homePath, useAuth } from './lib/auth';
import { useI18n } from './lib/i18n';
import { Empty, Loading } from './components/ui';
import { AppShell } from './components/layout/AppShell';
import { LoginPage } from './pages/LoginPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { PosPage } from './pages/pos/PosPage';
import { HasadListPage } from './pages/hasad/HasadListPage';
import { HasadWorkspacePage } from './pages/hasad/HasadWorkspacePage';
import { HasadSimulatorPage } from './pages/hasad/HasadSimulatorPage';
import { BranchDashboardPage } from './pages/dashboard/BranchDashboardPage';
import { CompanyDashboardPage } from './pages/dashboard/CompanyDashboardPage';
import { BranchesPage, BranchDetailPage } from './pages/branches/BranchPages';
import { SalesPage, SaleDetailPage } from './pages/sales/SalesPages';
import { InventoryPage, ItemDetailPage } from './pages/inventory/InventoryPages';
import { PurchasesPage, PurchaseDetailPage } from './pages/purchases/PurchasesPages';
import { ExpensesPage } from './pages/expenses/ExpensesPage';
import { TransfersPage } from './pages/transfers/TransfersPage';
import { ReportsHubPage, ReportPage } from './pages/reports/ReportPages';
import { UsersPage } from './pages/admin/UsersPage';
import { SessionsPage } from './pages/admin/SessionsPage';
import { AuditPage } from './pages/admin/AuditPage';
import { SettingsPage } from './pages/admin/SettingsPage';
import { MyActivityPage } from './pages/MyActivityPage';

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading className="h-screen" />;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (me.user.mustChangePassword) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

/** Route-level guard. The API enforces the same rule; this only avoids dead ends. */
function Guard({ perm, any, children }: { perm?: Permission; any?: Permission[]; children: ReactNode }) {
  const { can } = useAuth();
  const { t } = useI18n();
  const ok = perm ? can(perm) : any ? any.some(can) : true;
  if (!ok)
    return (
      <Empty
        className="h-full"
        icon={<ShieldX className="size-5" />}
        title={t('You do not have access to this page')}
        body={t('Your role does not include this module. Ask the General Manager if you need access.')}
      />
    );
  return <>{children}</>;
}

function NotFound() {
  const { t } = useI18n();
  return <Empty className="h-full" title={t('Page not found')} />;
}

function Home() {
  const { me } = useAuth();
  return <Navigate to={me ? homePath(me) : '/login'} replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<Home />} />
          <Route path="pos" element={<Guard perm="pos.access"><PosPage /></Guard>} />
          <Route path="hasad" element={<Guard any={['hasad.process', 'hasad.view']}><HasadListPage /></Guard>} />
          <Route path="hasad/:id" element={<Guard any={['hasad.process', 'hasad.view']}><HasadWorkspacePage /></Guard>} />
          <Route path="hasad-simulator" element={<Guard perm="hasad.simulate"><HasadSimulatorPage /></Guard>} />
          <Route path="me" element={<MyActivityPage />} />
          <Route path="overview" element={<Guard perm="dashboard.company"><CompanyDashboardPage /></Guard>} />
          <Route path="dashboard" element={<Guard perm="dashboard.branch"><BranchDashboardPage /></Guard>} />
          <Route path="branches" element={<Guard perm="scope.all_branches"><BranchesPage /></Guard>} />
          <Route path="branches/:id" element={<Guard perm="dashboard.branch"><BranchDetailPage /></Guard>} />
          <Route path="sales" element={<Guard perm="sales.view"><SalesPage /></Guard>} />
          <Route path="sales/:id" element={<Guard any={['sales.view', 'sales.view_own']}><SaleDetailPage /></Guard>} />
          <Route path="inventory" element={<Guard perm="inventory.view"><InventoryPage /></Guard>} />
          <Route path="inventory/:id" element={<Guard any={['inventory.view', 'inventory.view_available']}><ItemDetailPage /></Guard>} />
          <Route path="purchases" element={<Guard perm="purchases.view"><PurchasesPage /></Guard>} />
          <Route path="purchases/:id" element={<Guard perm="purchases.view"><PurchaseDetailPage /></Guard>} />
          <Route path="expenses" element={<Guard perm="expenses.view"><ExpensesPage /></Guard>} />
          <Route path="transfers" element={<Guard perm="inventory.transfer"><TransfersPage /></Guard>} />
          <Route path="reports" element={<Guard perm="reports.view"><ReportsHubPage /></Guard>} />
          <Route path="reports/:key" element={<Guard perm="reports.view"><ReportPage /></Guard>} />
          <Route path="users" element={<Guard perm="users.view"><UsersPage /></Guard>} />
          <Route path="sessions" element={<Guard perm="sessions.view"><SessionsPage /></Guard>} />
          <Route path="audit" element={<Guard perm="audit.view"><AuditPage /></Guard>} />
          <Route path="settings" element={<Guard perm="settings.manage"><SettingsPage /></Guard>} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
