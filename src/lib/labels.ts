import type {
  AppRole, ClientStatus, PaymentMethod, PaymentStatus, ProjectStatus,
  ServiceStatus, TaskPriority, TaskStatus, NoteScope,
} from './types';
import type { Tone } from '@/components/ui';

export const paymentStatusMeta: Record<PaymentStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'neutral' },
  partially_paid: { label: 'Partially paid', tone: 'sky' },
  paid: { label: 'Paid', tone: 'mint' },
  overdue: { label: 'Overdue', tone: 'magenta' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

export const paymentMethodLabel: Record<PaymentMethod, string> = {
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  card: 'Card',
  other: 'Other',
};

export const clientStatusMeta: Record<ClientStatus, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'mint' },
  inactive: { label: 'Inactive', tone: 'butter' },
  archived: { label: 'Archived', tone: 'muted' },
};

export const serviceStatusMeta: Record<ServiceStatus, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'mint' },
  paused: { label: 'Paused', tone: 'butter' },
  completed: { label: 'Completed', tone: 'sky' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

export const projectStatusMeta: Record<ProjectStatus, { label: string; tone: Tone }> = {
  planning: { label: 'Planning', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'sky' },
  review: { label: 'In review', tone: 'blush' },
  completed: { label: 'Completed', tone: 'mint' },
  on_hold: { label: 'On hold', tone: 'butter' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

export const taskPriorityMeta: Record<TaskPriority, { label: string; tone: Tone; weight: number }> = {
  low: { label: 'Low', tone: 'muted', weight: 0 },
  medium: { label: 'Medium', tone: 'sky', weight: 1 },
  high: { label: 'High', tone: 'butter', weight: 2 },
  urgent: { label: 'Urgent', tone: 'magenta', weight: 3 },
};

export const taskStatusMeta: Record<TaskStatus, { label: string; tone: Tone }> = {
  todo: { label: 'To do', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'sky' },
  completed: { label: 'Completed', tone: 'mint' },
  archived: { label: 'Archived', tone: 'muted' },
};

export const noteScopeMeta: Record<NoteScope, { label: string; tone: Tone }> = {
  personal: { label: 'Personal', tone: 'neutral' },
  agency: { label: 'Agency', tone: 'blush' },
  client: { label: 'Client', tone: 'sky' },
};

export const roleLabel: Record<AppRole, string> = { admin: 'Administrator', client: 'Client' };

export const eventCategoryTone: Record<string, Tone> = {
  work: 'sky',
  billing: 'butter',
  meeting: 'blush',
  deadline: 'magenta',
  personal: 'neutral',
};
