import {
  BarChart3,
  Bell,
  Calculator,
  CalendarDays,
  Clock,
  CreditCard,
  FileText,
  FolderKanban,
  LayoutDashboard,
  ListChecks,
  Receipt,
  Settings,
  ShieldCheck,
  Sparkles,
  StickyNote,
  Timer,
  Users,
  Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  badge?: 'notifications' | 'overdueTasks' | 'dueReminders';
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const adminNav: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/admin/clients', label: 'Clients', icon: Users },
      { to: '/admin/services', label: 'Services', icon: Sparkles },
      { to: '/admin/projects', label: 'Projects', icon: FolderKanban },
    ],
  },
  {
    label: 'Money',
    items: [
      { to: '/admin/payments', label: 'Payments', icon: Wallet },
      { to: '/admin/invoices', label: 'Invoices', icon: FileText },
      { to: '/admin/receipts', label: 'Receipts', icon: Receipt },
      { to: '/admin/reports', label: 'Reports', icon: BarChart3 },
    ],
  },
  {
    label: 'Productivity',
    items: [
      { to: '/admin/tasks', label: 'Tasks', icon: ListChecks, badge: 'overdueTasks' },
      { to: '/admin/calendar', label: 'Calendar', icon: CalendarDays },
      { to: '/admin/notes', label: 'Notes', icon: StickyNote },
      { to: '/admin/reminders', label: 'Reminders', icon: Bell, badge: 'dueReminders' },
      { to: '/admin/stopwatch', label: 'Stopwatch', icon: Timer },
      { to: '/admin/calculator', label: 'Calculator', icon: Calculator },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/admin/notifications', label: 'Notifications', icon: Bell, badge: 'notifications' },
      { to: '/admin/settings', label: 'Settings', icon: Settings },
      { to: '/admin/security', label: 'Account & Security', icon: ShieldCheck },
    ],
  },
];

export const clientNav: NavGroup[] = [
  {
    label: 'Your account',
    items: [
      { to: '/portal', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/portal/services', label: 'Services', icon: Sparkles },
      { to: '/portal/projects', label: 'Projects', icon: FolderKanban },
    ],
  },
  {
    label: 'Billing',
    items: [
      { to: '/portal/billing', label: 'Invoices & payments', icon: CreditCard },
      { to: '/portal/receipts', label: 'Receipts', icon: Receipt },
    ],
  },
  {
    label: 'Your workspace',
    items: [
      { to: '/portal/tasks', label: 'My tasks', icon: ListChecks },
      { to: '/portal/notes', label: 'My notes', icon: StickyNote },
      { to: '/portal/reminders', label: 'My reminders', icon: Bell },
      { to: '/portal/tools', label: 'Stopwatch & calculator', icon: Clock },
    ],
  },
];
