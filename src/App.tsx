import { Suspense, lazy, type ReactNode } from 'react';
import { HashRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/context/auth';
import { Spinner } from '@/components/ui';

const LoginPage = lazy(() => import('@/pages/LoginPage'));
const AuthCallbackPage = lazy(() => import('@/pages/AuthCallbackPage'));

const OverviewPage = lazy(() => import('@/pages/admin/OverviewPage'));
const ClientsPage = lazy(() => import('@/pages/admin/ClientsPage'));
const ClientDetailPage = lazy(() => import('@/pages/admin/ClientDetailPage'));
const ServicesPage = lazy(() => import('@/pages/admin/ServicesPage'));
const ProjectsPage = lazy(() => import('@/pages/admin/ProjectsPage'));
const ProjectDetailPage = lazy(() => import('@/pages/admin/ProjectDetailPage'));
const PaymentsPage = lazy(() => import('@/pages/admin/PaymentsPage'));
const InvoicesPage = lazy(() => import('@/pages/admin/InvoicesPage'));
const ReceiptsPage = lazy(() => import('@/pages/admin/ReceiptsPage'));
const ReportsPage = lazy(() => import('@/pages/admin/ReportsPage'));
const NotificationsPage = lazy(() => import('@/pages/admin/NotificationsPage'));
const SettingsPage = lazy(() => import('@/pages/admin/SettingsPage'));
const SecurityPage = lazy(() => import('@/pages/admin/SecurityPage'));

const TasksPage = lazy(() => import('@/pages/shared/TasksPage'));
const CalendarPage = lazy(() => import('@/pages/shared/CalendarPage'));
const NotesPage = lazy(() => import('@/pages/shared/NotesPage'));
const RemindersPage = lazy(() => import('@/pages/shared/RemindersPage'));
const StopwatchPage = lazy(() => import('@/pages/shared/StopwatchPage'));
const CalculatorPage = lazy(() => import('@/pages/shared/CalculatorPage'));
const ReceiptPrintPage = lazy(() => import('@/pages/shared/ReceiptPrintPage'));

const PortalOverviewPage = lazy(() => import('@/pages/client/PortalOverviewPage'));
const PortalServicesPage = lazy(() => import('@/pages/client/PortalServicesPage'));
const PortalProjectsPage = lazy(() => import('@/pages/client/PortalProjectsPage'));
const PortalBillingPage = lazy(() => import('@/pages/client/PortalBillingPage'));
const PortalReceiptsPage = lazy(() => import('@/pages/client/PortalReceiptsPage'));

function FullScreenLoader() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Spinner label="Loading LunaDesk" />
    </div>
  );
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { status, profile } = useAuth();
  if (status === 'loading') return <FullScreenLoader />;
  if (status !== 'signedIn' || !profile) return <Navigate to="/" replace />;
  if (profile.role !== 'admin') return <Navigate to="/portal" replace />;
  return <>{children}</>;
}

function RequireClient({ children }: { children: ReactNode }) {
  const { status, profile } = useAuth();
  if (status === 'loading') return <FullScreenLoader />;
  if (status !== 'signedIn' || !profile) return <Navigate to="/" replace />;
  if (profile.role !== 'client') return <Navigate to="/admin" replace />;
  return <>{children}</>;
}

/** Shell layout: mounted once per area, so the sidebar keeps its state and
 *  animations between page changes. Only the page body animates. */
function AdminLayout() {
  return (
    <RequireAdmin>
      <AppShell>
        <Outlet />
      </AppShell>
    </RequireAdmin>
  );
}

function PortalLayout() {
  return (
    <RequireClient>
      <AppShell>
        <Outlet />
      </AppShell>
    </RequireClient>
  );
}

function ToolsPage() {
  return (
    <div className="space-y-10">
      <StopwatchPage />
      <CalculatorPage />
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="eyebrow text-magenta">404</p>
      <h1 className="display text-2xl text-fg">That page does not exist</h1>
      <p className="max-w-sm text-sm text-muted">The link may be outdated. Use the navigation to get back to your workspace.</p>
      <a href="#/" className="btn btn-ghost mt-2">
        Back to sign-in
      </a>
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Suspense fallback={<FullScreenLoader />}>
        <Routes>
          <Route path="/" element={<LoginPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />

          {/* ------------------------------- Admin ------------------------------- */}
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="clients" element={<ClientsPage />} />
            <Route path="clients/:id" element={<ClientDetailPage />} />
            <Route path="services" element={<ServicesPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/:id" element={<ProjectDetailPage />} />
            <Route path="payments" element={<PaymentsPage />} />
            <Route path="invoices" element={<InvoicesPage />} />
            <Route path="receipts" element={<ReceiptsPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="calendar" element={<CalendarPage />} />
            <Route path="notes" element={<NotesPage />} />
            <Route path="reminders" element={<RemindersPage />} />
            <Route path="stopwatch" element={<StopwatchPage />} />
            <Route path="calculator" element={<CalculatorPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="security" element={<SecurityPage />} />
          </Route>

          {/* Print views render outside the shell so print CSS is exact. */}
          <Route path="/admin/receipts/:id" element={<RequireAdmin><ReceiptPrintPage /></RequireAdmin>} />

          {/* ------------------------------- Portal ------------------------------ */}
          <Route path="/portal" element={<PortalLayout />}>
            <Route index element={<PortalOverviewPage />} />
            <Route path="services" element={<PortalServicesPage />} />
            <Route path="projects" element={<PortalProjectsPage />} />
            <Route path="billing" element={<PortalBillingPage />} />
            <Route path="receipts" element={<PortalReceiptsPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="notes" element={<NotesPage />} />
            <Route path="reminders" element={<RemindersPage />} />
            <Route path="tools" element={<ToolsPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>

          <Route path="/portal/receipts/:id" element={<RequireClient><ReceiptPrintPage /></RequireClient>} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </HashRouter>
  );
}
