import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Command,
  Database,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sun,
  UserRound,
  X,
} from 'lucide-react';
import { adminNav, clientNav, type NavGroup } from './nav';
import { Wordmark } from '@/components/brand/Logo';
import { useAuth } from '@/context/auth';
import { useCollection, useData, useTheme, type ThemeChoice } from '@/context/app';
import { cn } from '@/lib/utils';
import { NotificationBell } from './NotificationBell';
import { GlobalCommandPalette } from './CommandPalette';
import { ReminderWatcher } from '@/components/reminders/ReminderWatcher';
import type { BrandingSettings, NotificationPreferences, Reminder, Task } from '@/lib/types';
import { roleLabel } from '@/lib/labels';
import { useOnlineStatus } from '@/hooks';

export function AppShell({ children }: { children: ReactNode }) {
  const { profile, isAdmin, signOut } = useAuth();
  const { adapters } = useData();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('lunadesk.sidebar') === 'collapsed');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const { choice, setChoice } = useTheme();
  // navigator.onLine only tells us the browser has a network interface; the
  // banner therefore says "offline", never "your data is saved".
  const online = useOnlineStatus();

  const groups: NavGroup[] = isAdmin ? adminNav : clientNav;

  const { data: brandingRows } = useCollection<BrandingSettings>('branding_settings');
  const branding = brandingRows[0];

  const { data: tasks } = useCollection<Task>('tasks');
  const { data: reminders } = useCollection<Reminder>('reminders');
  const { data: prefsRows } = useCollection<NotificationPreferences>('notification_preferences');

  const badges = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    return {
      notifications: 0, // filled by the bell's own query
      overdueTasks: tasks.filter(
        (t) => t.status !== 'completed' && t.status !== 'archived' && t.due_date && t.due_date < today,
      ).length,
      dueReminders: reminders.filter(
        (r) => !r.is_dismissed && new Date(r.snoozed_until ?? r.remind_at).getTime() <= now,
      ).length,
    };
  }, [tasks, reminders]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    localStorage.setItem('lunadesk.sidebar', collapsed ? 'collapsed' : 'expanded');
  }, [collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const initials = (profile?.full_name ?? 'L')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const themeOrder: ThemeChoice[] = ['dark', 'light', 'system'];
  const nextTheme = themeOrder[(themeOrder.indexOf(choice) + 1) % themeOrder.length];

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className={cn('flex items-center justify-between gap-2 px-4 pb-4 pt-5', collapsed && 'px-3')}>
        <Link to={isAdmin ? '/admin' : '/portal'} className="min-w-0">
          <Wordmark compact={collapsed} logoUrl={branding?.logo_url} companyName={branding?.company_name} />
        </Link>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="hidden rounded-lg p-1.5 text-faint transition hover:bg-raised hover:text-fg lg:block"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Main">
        {groups.map((group) => (
          <div key={group.label} className="mb-4">
            {!collapsed && <p className="eyebrow px-2.5 pb-1.5">{group.label}</p>}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const badgeCount = item.badge ? badges[item.badge] : 0;
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      title={collapsed ? item.label : undefined}
                      className={({ isActive }) =>
                        cn(
                          'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition',
                          collapsed && 'justify-center px-0',
                          isActive ? 'text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && (
                            <motion.span
                              layoutId="nav-active"
                              className="absolute inset-0 rounded-lg border bg-[rgb(var(--line)/0.09)]"
                              style={{ borderColor: 'rgb(var(--line) / 0.14)' }}
                              transition={{ type: 'spring', stiffness: 520, damping: 40 }}
                            />
                          )}
                          <Icon
                            className={cn('relative h-4 w-4 shrink-0', isActive ? 'text-magenta' : 'text-faint group-hover:text-muted')}
                            aria-hidden
                          />
                          {!collapsed && <span className="relative flex-1 truncate">{item.label}</span>}
                          {!collapsed && badgeCount > 0 && (
                            <span className="num relative rounded-full bg-magenta/15 px-1.5 py-0.5 text-[10px] font-semibold text-magenta">
                              {badgeCount}
                            </span>
                          )}
                          {collapsed && badgeCount > 0 && (
                            <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-magenta" aria-hidden />
                          )}
                        </>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t p-2" style={{ borderColor: 'rgb(var(--line) / 0.12)' }}>
        {adapters.mode === 'demo' && !collapsed && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-butter/25 bg-butter/[0.06] px-2.5 py-2">
            <Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-butter" aria-hidden />
            <p className="text-[10.5px] leading-snug text-muted">
              <span className="font-semibold text-butter">Demo data</span> — not connected to Supabase. Changes stay in
              this browser.
            </p>
          </div>
        )}
        <div className={cn('flex items-center gap-2 rounded-lg p-1.5', collapsed && 'justify-center')}>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-magenta/15 text-[11px] font-semibold text-magenta">
            {initials}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-medium text-fg">{profile?.full_name}</p>
              <p className="truncate text-[10px] text-faint">{profile ? roleLabel[profile.role] : ''}</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-md p-1.5 text-faint transition hover:bg-raised hover:text-fg"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="relative z-10 flex min-h-dvh">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-magenta focus:px-4 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 border-r bg-surface/40 backdrop-blur-sm transition-[width] duration-300 lg:block no-print',
          collapsed ? 'w-[68px]' : 'w-[248px]',
        )}
        style={{ borderColor: 'rgb(var(--line) / 0.1)' }}
      >
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <div className="fixed inset-0 z-[70] lg:hidden no-print">
            <motion.div
              className="absolute inset-0 bg-black/60"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
              aria-hidden
            />
            <motion.aside
              className="absolute left-0 top-0 h-full w-[270px] border-r bg-canvas"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 340, damping: 34 }}
              aria-label="Navigation"
            >
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="absolute right-3 top-4 rounded-lg p-1.5 text-faint hover:bg-raised hover:text-fg"
                aria-label="Close navigation"
              >
                <X className="h-4 w-4" />
              </button>
              {sidebar}
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-canvas/80 px-3 backdrop-blur-md sm:px-5 no-print"
          style={{ borderColor: 'rgb(var(--line) / 0.1)' }}
        >
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-lg p-2 text-muted transition hover:bg-raised hover:text-fg lg:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="group flex h-9 items-center gap-2 rounded-xl border bg-raised/50 px-3 text-[12px] text-faint transition hover:border-[rgb(var(--line)/0.28)] hover:text-muted sm:w-64"
            style={{ borderColor: 'rgb(var(--line) / 0.14)' }}
          >
            <Search className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden flex-1 text-left sm:block">Search or jump to…</span>
            <kbd className="hidden items-center gap-0.5 rounded border px-1 py-0.5 text-[10px] sm:flex" style={{ borderColor: 'rgb(var(--line) / 0.18)' }}>
              <Command className="h-2.5 w-2.5" />K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setChoice(nextTheme)}
              className="rounded-lg p-2 text-muted transition hover:bg-raised hover:text-fg"
              aria-label={`Theme: ${choice}. Switch to ${nextTheme}.`}
              title={`Theme: ${choice}`}
            >
              {choice === 'light' ? <Sun className="h-4 w-4" /> : choice === 'dark' ? <Moon className="h-4 w-4" /> : <span className="text-[11px] font-semibold">A</span>}
            </button>
            <NotificationBell prefs={prefsRows[0]} />
            <div className="mx-1 h-5 w-px" style={{ background: 'rgb(var(--line) / 0.14)' }} aria-hidden />
            <Link
              to={isAdmin ? '/admin/security' : '/portal/settings'}
              className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-xs text-muted transition hover:bg-raised hover:text-fg"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[rgb(var(--line)/0.12)] text-[10px] font-semibold">
                {initials}
              </span>
              <span className="hidden max-w-[9rem] truncate sm:block">{profile?.full_name}</span>
              <UserRound className="hidden h-3 w-3 sm:block" aria-hidden />
            </Link>
          </div>
        </header>

        {!online && (
          <div
            role="status"
            className="border-b bg-butter/10 px-3 py-2 text-center text-[12px] text-butter sm:px-6 no-print"
            style={{ borderColor: 'rgb(var(--line) / 0.14)' }}
          >
            You are offline. LunaDesk will retry when the connection returns — anything you change
            now is not saved until it does.
          </div>
        )}

        <main id="main-content" className="min-w-0 flex-1 px-3 py-5 sm:px-6 sm:py-7">
          {/* Page transition: enter-only, keyed by route. No exit phase, so a
              lazily-loaded page can suspend without stalling the transition. */}
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
            className="mx-auto w-full max-w-[1400px]"
          >
            {children}
          </motion.div>
        </main>
      </div>

      <GlobalCommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} isAdmin={Boolean(isAdmin)} />
      <ReminderWatcher prefs={prefsRows[0]} />
    </div>
  );
}
