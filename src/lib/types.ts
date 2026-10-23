/**
 * LunaDesk domain types.
 * These mirror the PostgreSQL schema in supabase/migrations. Keep them in sync:
 * every column the UI reads is declared here, and nothing else.
 *
 * Convention: all money is stored as INTEGER minor units (paise) to avoid
 * floating-point drift. The UI formats them with lib/money.ts.
 */

export type UUID = string;
export type ISODate = string; // 'YYYY-MM-DD'
export type ISOTimestamp = string; // RFC3339 with timezone

export type AppRole = 'admin' | 'client';
export type ClientStatus = 'active' | 'inactive' | 'archived';
export type BillingType = 'one_time' | 'monthly' | 'quarterly' | 'yearly' | 'custom';
export type ServiceStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export type ProjectStatus = 'planning' | 'in_progress' | 'review' | 'completed' | 'on_hold' | 'cancelled';
export type PaymentStatus = 'pending' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled';
export type PaymentMethod = 'upi' | 'bank_transfer' | 'cash' | 'card' | 'other';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskStatus = 'todo' | 'in_progress' | 'completed' | 'archived';
export type NoteScope = 'personal' | 'agency' | 'client';
export type ReminderRepeat = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Profile {
  id: UUID;
  role: AppRole;
  full_name: string;
  email: string | null;
  phone: string | null;
  avatar_url: string | null;
  client_id: UUID | null; // set for client accounts, null for admins
  theme: 'dark' | 'light' | 'system';
  timezone: string;
  is_active: boolean;
  last_seen_at: ISOTimestamp | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface Client {
  id: UUID;
  name: string;
  business_name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  client_code: string; // display identifier, e.g. PR103 — never a secret
  status: ClientStatus;
  internal_notes: string | null;
  portal_status: 'none' | 'active' | 'revoked';
  address: string | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface Service {
  id: UUID;
  name: string;
  description: string | null;
  category: string;
  is_archived: boolean;
  created_at: ISOTimestamp;
}

export interface ClientService {
  id: UUID;
  client_id: UUID;
  service_id: UUID;
  title: string | null;
  description: string | null;
  price_minor: number;
  billing_type: BillingType;
  billing_frequency_label: string | null;
  start_date: ISODate;
  end_date: ISODate | null;
  status: ServiceStatus;
  internal_notes: string | null;
  client_notes: string | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface Project {
  id: UUID;
  client_id: UUID;
  client_service_id: UUID | null;
  name: string;
  description: string | null;
  status: ProjectStatus;
  progress: number; // 0..100
  start_date: ISODate | null;
  due_date: ISODate | null;
  client_visible: boolean;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface ProjectUpdate {
  id: UUID;
  project_id: UUID;
  title: string;
  body: string | null;
  client_visible: boolean;
  author_id: UUID | null;
  created_at: ISOTimestamp;
}

export interface Invoice {
  id: UUID;
  invoice_number: string;
  client_id: UUID;
  client_service_id: UUID | null;
  billing_period_start: ISODate | null;
  billing_period_end: ISODate | null;
  issue_date: ISODate;
  due_date: ISODate | null;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  status: PaymentStatus;
  notes: string | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface InvoiceItem {
  id: UUID;
  invoice_id: UUID;
  description: string;
  quantity: number;
  unit_price_minor: number;
  amount_minor: number;
  position: number;
}

export interface Payment {
  id: UUID;
  client_id: UUID;
  invoice_id: UUID;
  amount_minor: number;
  paid_at: ISODate;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  voided_at: ISOTimestamp | null;
  void_reason: string | null;
  created_by: UUID | null;
  created_at: ISOTimestamp;
}

export interface Receipt {
  id: UUID;
  receipt_number: string;
  payment_id: UUID;
  client_id: UUID;
  invoice_id: UUID;
  issued_at: ISODate;
  snapshot: ReceiptSnapshot;
  created_at: ISOTimestamp;
}

/** The immutable record printed on a receipt. Stored at issue time so a
 *  reprint never disagrees with the transaction it documents. */
export interface ReceiptSnapshot {
  receipt_number: string;
  invoice_number: string;
  issue_date: ISODate;
  client_name: string;
  client_business: string;
  client_email: string | null;
  client_phone: string | null;
  items: { description: string; amount_minor: number }[];
  billing_period: string | null;
  invoice_total_minor: number;
  previously_paid_minor: number;
  amount_received_minor: number;
  balance_minor: number;
  method: PaymentMethod;
  reference: string | null;
  payment_date: ISODate;
  payment_status: PaymentStatus;
  notes: string | null;
  company: BrandingSnapshot;
}

export interface Task {
  id: UUID;
  owner_id: UUID;
  client_id: UUID | null;
  project_id: UUID | null;
  title: string;
  description: string | null;
  priority: TaskPriority;
  category: string | null;
  status: TaskStatus;
  due_date: ISODate | null;
  due_time: string | null;
  completed_at: ISOTimestamp | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface CalendarEvent {
  id: UUID;
  owner_id: UUID;
  client_id: UUID | null;
  project_id: UUID | null;
  task_id: UUID | null;
  title: string;
  description: string | null;
  category: 'work' | 'billing' | 'meeting' | 'deadline' | 'personal';
  starts_at: ISOTimestamp;
  ends_at: ISOTimestamp;
  all_day: boolean;
  recurrence: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  recurrence_until: ISODate | null;
  client_visible: boolean;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface Note {
  id: UUID;
  owner_id: UUID;
  client_id: UUID | null;
  scope: NoteScope;
  title: string;
  body: string;
  tags: string[];
  is_pinned: boolean;
  is_archived: boolean;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface Reminder {
  id: UUID;
  owner_id: UUID;
  task_id: UUID | null;
  title: string;
  description: string | null;
  remind_at: ISOTimestamp;
  repeat: ReminderRepeat;
  repeat_until: ISODate | null;
  alarm_enabled: boolean;
  is_dismissed: boolean;
  dismissed_at: ISOTimestamp | null;
  snoozed_until: ISOTimestamp | null;
  fired_at: ISOTimestamp | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface AppNotification {
  id: UUID;
  user_id: UUID;
  kind: 'deadline' | 'overdue_task' | 'reminder' | 'payment' | 'account' | 'announcement';
  title: string;
  body: string | null;
  link: string | null;
  dedupe_key: string | null;
  read_at: ISOTimestamp | null;
  created_at: ISOTimestamp;
}

export interface StopwatchSession {
  id: UUID;
  owner_id: UUID;
  label: string | null;
  started_at: ISOTimestamp;
  ended_at: ISOTimestamp | null;
  duration_ms: number;
  laps: number[];
  created_at: ISOTimestamp;
}

export interface BrandingSettings {
  id: UUID;
  company_name: string;
  logo_url: string | null;
  receipt_footer: string;
  contact_email: string;
  contact_phone: string;
  address: string | null;
  tax_id: string | null;
  tax_label: string | null;
  receipt_prefix: string;
  invoice_prefix: string;
  currency: string;
  timezone: string;
  updated_at: ISOTimestamp;
}

export interface BrandingSnapshot {
  company_name: string;
  logo_url: string | null;
  receipt_footer: string;
  contact_email: string;
  contact_phone: string;
  address: string | null;
  tax_id: string | null;
  tax_label: string | null;
}

export interface NotificationPreferences {
  user_id: UUID;
  browser_notifications: boolean;
  alarm_sound: boolean;
  alarm_volume: number; // 0..1
  alarm_sound_name: string;
  email_digest: boolean;
  quiet_hours_start: string | null; // 'HH:MM'
  quiet_hours_end: string | null;
  updated_at: ISOTimestamp;
}

export interface AuditLog {
  id: UUID;
  actor_id: UUID | null;
  actor_label: string | null;
  action: string;
  entity: string;
  entity_id: UUID | null;
  before: unknown;
  after: unknown;
  created_at: ISOTimestamp;
}

export interface Announcement {
  id: UUID;
  client_id: UUID;
  title: string;
  body: string;
  published_at: ISOTimestamp;
  expires_at: ISOTimestamp | null;
}
