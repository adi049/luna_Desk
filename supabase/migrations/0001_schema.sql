-- =============================================================================
-- LunaDesk · 0001 — schema
-- Managed by Luna
--
-- Design notes
--  * Money is stored as BIGINT minor units (paise). Never floats.
--  * All timestamps are TIMESTAMPTZ; dates are DATE for billing periods.
--  * Every table that a person edits carries created_at / updated_at, with an
--    updated_at trigger so application code cannot forget it.
--  * Financial rows are append-only in practice: corrections are recorded with
--    void_* columns or audit_logs rows, never by deleting history.
-- =============================================================================

create extension if not exists "pgcrypto";      -- crypt(), gen_salt(), gen_random_uuid()
create extension if not exists "pg_trgm";       -- fuzzy search on names

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
do $$ begin
  create type app_role        as enum ('admin', 'client');
  create type client_status   as enum ('active', 'inactive', 'archived');
  create type portal_status   as enum ('none', 'active', 'revoked');
  create type billing_type    as enum ('one_time', 'monthly', 'quarterly', 'yearly', 'custom');
  create type service_status  as enum ('active', 'paused', 'completed', 'cancelled');
  create type project_status  as enum ('planning', 'in_progress', 'review', 'completed', 'on_hold', 'cancelled');
  create type payment_status  as enum ('pending', 'partially_paid', 'paid', 'overdue', 'cancelled');
  create type payment_method  as enum ('upi', 'bank_transfer', 'cash', 'card', 'other');
  create type task_priority   as enum ('low', 'medium', 'high', 'urgent');
  create type task_status     as enum ('todo', 'in_progress', 'completed', 'archived');
  create type note_scope      as enum ('personal', 'agency', 'client');
  create type reminder_repeat as enum ('none', 'daily', 'weekly', 'monthly', 'yearly');
  create type event_category  as enum ('work', 'billing', 'meeting', 'deadline', 'personal');
  create type recurrence_rule as enum ('none', 'daily', 'weekly', 'monthly', 'yearly');
  create type notification_kind as enum ('deadline', 'overdue_task', 'reminder', 'payment', 'account', 'announcement');
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- updated_at trigger
-- ----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- Identity
-- ----------------------------------------------------------------------------
create table if not exists public.clients (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(trim(name)) between 2 and 120),
  business_name    text not null check (length(trim(business_name)) between 2 and 160),
  contact_person   text,
  email            text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone            text,
  -- Public identifier shown in the UI. NOT a secret and NOT used to authenticate.
  client_code      text not null check (client_code ~ '^[A-Z0-9]{3,12}$'),
  status           client_status not null default 'active',
  -- NOTE: no internal-notes column here on purpose. RLS filters rows, not
  -- columns, so a client-visible row would leak any admin-only text on it.
  -- Internal remarks live in public.internal_notes (admin-only RLS).
  portal_status    portal_status not null default 'none',
  address          text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint clients_code_unique unique (client_code)
);
create index if not exists clients_status_idx on public.clients (status);
create index if not exists clients_name_trgm_idx on public.clients using gin (name gin_trgm_ops);

drop trigger if exists clients_touch on public.clients;
create trigger clients_touch before update on public.clients
  for each row execute function public.touch_updated_at();

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  role         app_role not null default 'client',
  full_name    text not null default 'New user',
  email        text,
  phone        text,
  avatar_url   text,
  client_id    uuid references public.clients (id) on delete set null,
  theme        text not null default 'system' check (theme in ('dark', 'light', 'system')),
  timezone     text not null default 'Asia/Kolkata',
  is_active    boolean not null default true,
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Only a client profile may be linked to a client record. The link may be
  -- null while a portal invite is still being set up; until it exists
  -- current_client_id() resolves to null and RLS shows the user nothing.
  constraint profiles_client_link check (client_id is null or role = 'client')
);
create index if not exists profiles_client_idx on public.profiles (client_id);

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Extra roles for team members. profiles.role stays the primary claim; this
-- table is the supported extension point if you later add staff accounts.
create table if not exists public.user_roles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       app_role not null,
  granted_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

-- New auth users get a profile row automatically. Role defaults to client and
-- is only assigned deliberately (see scripts/bootstrap-admin.sql).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role, client_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.email,
    'client',
    null
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- Access codes
--   The user-facing code is a low-entropy credential. It is stored ONLY as a
--   bcrypt hash, verified exclusively by a SECURITY DEFINER function callable
--   by the service role (i.e. from an Edge Function), and every attempt is
--   rate limited. Rotating a code replaces the hash; history is kept.
-- ----------------------------------------------------------------------------
create table if not exists public.client_access_codes (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  user_id       uuid references auth.users (id) on delete set null,
  label         text not null default 'Portal access',
  code_hash     text not null,                 -- crypt(code, gen_salt('bf', 10))
  is_revoked    boolean not null default false,
  last_used_at  timestamptz,
  uses_count    integer not null default 0,
  created_by    uuid references auth.users (id),
  created_at    timestamptz not null default now(),
  rotated_at    timestamptz
);
create index if not exists access_codes_client_idx on public.client_access_codes (client_id) where not is_revoked;

create table if not exists public.access_attempts (
  id         bigint generated always as identity primary key,
  code_hint  text not null,             -- first 3 chars only, for support triage
  ip         inet,
  user_agent text,
  outcome    text not null check (outcome in ('ok', 'bad_code', 'revoked', 'rate_limited', 'admin_lookup')),
  created_at timestamptz not null default now()
);
create index if not exists access_attempts_recent_idx on public.access_attempts (created_at desc);
create index if not exists access_attempts_ip_idx on public.access_attempts (ip, created_at desc);

-- ----------------------------------------------------------------------------
-- Service catalogue + assignments
-- ----------------------------------------------------------------------------
create table if not exists public.services (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 2 and 80),
  description text,
  category    text not null default 'General',
  is_archived boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists services_touch on public.services;
create trigger services_touch before update on public.services
  for each row execute function public.touch_updated_at();

create table if not exists public.client_services (
  id                      uuid primary key default gen_random_uuid(),
  client_id               uuid not null references public.clients (id) on delete restrict,
  service_id              uuid not null references public.services (id) on delete restrict,
  title                   text,
  description             text,
  price_minor             bigint not null check (price_minor >= 0),
  billing_type            billing_type not null default 'monthly',
  billing_frequency_label text,
  start_date              date not null default current_date,
  end_date                date,
  status                  service_status not null default 'active',
  client_notes            text,   -- shown in the portal; internal remarks go to internal_notes
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint client_services_period check (end_date is null or end_date >= start_date)
);
create index if not exists client_services_client_idx on public.client_services (client_id);
create index if not exists client_services_status_idx on public.client_services (status);

drop trigger if exists client_services_touch on public.client_services;
create trigger client_services_touch before update on public.client_services
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- Projects
-- ----------------------------------------------------------------------------
create table if not exists public.projects (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references public.clients (id) on delete cascade,
  client_service_id uuid references public.client_services (id) on delete set null,
  name              text not null check (length(trim(name)) between 2 and 120),
  description       text,
  status            project_status not null default 'planning',
  progress          integer not null default 0 check (progress between 0 and 100),
  start_date        date,
  due_date          date,
  client_visible    boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint projects_dates check (due_date is null or start_date is null or due_date >= start_date)
);
create index if not exists projects_client_idx on public.projects (client_id);
create index if not exists projects_due_idx on public.projects (due_date) where status not in ('completed', 'cancelled');

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

create table if not exists public.project_updates (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  title          text not null check (length(trim(title)) between 2 and 160),
  body           text,
  client_visible boolean not null default false,
  author_id      uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists project_updates_project_idx on public.project_updates (project_id, created_at desc);

-- Agency-only annotations. Kept out of the parent tables so a client session
-- can never read them, whatever columns the API selects.
create table if not exists public.internal_notes (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid references public.clients (id) on delete cascade,
  client_service_id uuid references public.client_services (id) on delete cascade,
  project_id        uuid references public.projects (id) on delete cascade,
  body              text not null default '',
  author_id         uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint internal_notes_one_owner check (
    (client_id is not null)::int + (client_service_id is not null)::int + (project_id is not null)::int = 1
  )
);
create unique index if not exists internal_notes_client_idx
  on public.internal_notes (client_id) where client_id is not null;
create unique index if not exists internal_notes_service_idx
  on public.internal_notes (client_service_id) where client_service_id is not null;
create unique index if not exists internal_notes_project_idx
  on public.internal_notes (project_id) where project_id is not null;

drop trigger if exists internal_notes_touch on public.internal_notes;
create trigger internal_notes_touch before update on public.internal_notes
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- Billing
-- ----------------------------------------------------------------------------
create table if not exists public.invoices (
  id                   uuid primary key default gen_random_uuid(),
  invoice_number       text not null,
  client_id            uuid not null references public.clients (id) on delete restrict,
  client_service_id    uuid references public.client_services (id) on delete set null,
  billing_period_start date,
  billing_period_end   date,
  issue_date           date not null default current_date,
  due_date             date,
  subtotal_minor       bigint not null default 0 check (subtotal_minor >= 0),
  discount_minor       bigint not null default 0 check (discount_minor >= 0),
  tax_minor            bigint not null default 0 check (tax_minor >= 0),
  total_minor          bigint not null check (total_minor >= 0),
  status               payment_status not null default 'pending',
  notes                text,
  created_by           uuid references auth.users (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint invoices_number_unique unique (invoice_number),
  constraint invoices_period check (
    billing_period_start is null or billing_period_end is null or billing_period_end >= billing_period_start
  ),
  -- One invoice per client/service/billing period keeps recurring billing honest.
  constraint invoices_period_unique unique (client_service_id, billing_period_start, billing_period_end)
);
create index if not exists invoices_client_idx on public.invoices (client_id);
create index if not exists invoices_status_idx on public.invoices (status);
create index if not exists invoices_due_idx on public.invoices (due_date) where status <> 'paid';

drop trigger if exists invoices_touch on public.invoices;
create trigger invoices_touch before update on public.invoices
  for each row execute function public.touch_updated_at();

create table if not exists public.invoice_items (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references public.invoices (id) on delete cascade,
  description      text not null check (length(trim(description)) > 0),
  quantity         numeric(12, 2) not null default 1 check (quantity > 0),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  amount_minor     bigint not null check (amount_minor >= 0),
  position         integer not null default 0
);
create index if not exists invoice_items_invoice_idx on public.invoice_items (invoice_id, position);

create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  -- Insert order. created_at uses now(), which is constant inside a
  -- transaction, so receipts need this to know what was paid "before".
  seq          bigint generated always as identity,
  client_id    uuid not null references public.clients (id) on delete restrict,
  invoice_id   uuid not null references public.invoices (id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  paid_at      date not null default current_date,
  method       payment_method not null default 'upi',
  reference    text,
  notes        text,
  voided_at    timestamptz,
  void_reason  text,
  created_by   uuid references auth.users (id),
  created_at   timestamptz not null default now(),
  constraint payments_void_reason check (voided_at is null or length(trim(coalesce(void_reason, ''))) >= 4)
);
create index if not exists payments_invoice_idx on public.payments (invoice_id) where voided_at is null;
create index if not exists payments_client_idx on public.payments (client_id);
create index if not exists payments_paid_at_idx on public.payments (paid_at desc);

create table if not exists public.receipts (
  id             uuid primary key default gen_random_uuid(),
  receipt_number text not null unique,
  payment_id     uuid not null references public.payments (id) on delete restrict,
  client_id      uuid not null references public.clients (id) on delete restrict,
  invoice_id     uuid not null references public.invoices (id) on delete restrict,
  issued_at      date not null default current_date,
  -- Immutable document snapshot: reprints must never disagree with the
  -- transaction they document.
  snapshot       jsonb not null,
  created_at     timestamptz not null default now(),
  constraint receipts_one_per_payment unique (payment_id)
);
create index if not exists receipts_client_idx on public.receipts (client_id, issued_at desc);

-- Atomic document numbering. The row lock on document_sequences serialises
-- concurrent issuers, so two simultaneous payments can never share a number.
create table if not exists public.document_sequences (
  prefix     text not null,
  year       integer not null,
  last_value integer not null default 0,
  primary key (prefix, year)
);

create or replace function public.next_document_number(p_prefix text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year int := extract(year from current_date)::int;
  v_next int;
begin
  insert into public.document_sequences (prefix, year, last_value)
  values (p_prefix, v_year, 1)
  on conflict (prefix, year)
    do update set last_value = public.document_sequences.last_value + 1
  returning last_value into v_next;

  return format('%s-%s-%s', p_prefix, v_year, lpad(v_next::text, 4, '0'));
end $$;

-- ----------------------------------------------------------------------------
-- Personal productivity (owner-scoped; the admin cannot read these either)
-- ----------------------------------------------------------------------------
create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  client_id    uuid references public.clients (id) on delete set null,
  project_id   uuid references public.projects (id) on delete set null,
  title        text not null check (length(trim(title)) between 3 and 140),
  description  text,
  priority     task_priority not null default 'medium',
  category     text,
  status       task_status not null default 'todo',
  due_date     date,
  due_time     time,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists tasks_owner_idx on public.tasks (owner_id, status);
create index if not exists tasks_due_idx on public.tasks (owner_id, due_date) where status not in ('completed', 'archived');

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_updated_at();

create table if not exists public.task_assignments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks (id) on delete cascade,
  assignee_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (task_id, assignee_id)
);

create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  client_id   uuid references public.clients (id) on delete set null,
  scope       note_scope not null default 'personal',
  title       text not null default 'Untitled note' check (length(title) <= 160),
  body        text not null default '',
  tags        text[] not null default '{}',
  is_pinned   boolean not null default false,
  is_archived boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint notes_client_scope check (scope <> 'client' or client_id is not null)
);
create index if not exists notes_owner_idx on public.notes (owner_id, is_archived, updated_at desc);

drop trigger if exists notes_touch on public.notes;
create trigger notes_touch before update on public.notes
  for each row execute function public.touch_updated_at();

create table if not exists public.calendar_events (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  client_id        uuid references public.clients (id) on delete set null,
  project_id       uuid references public.projects (id) on delete set null,
  task_id          uuid references public.tasks (id) on delete set null,
  title            text not null check (length(trim(title)) between 2 and 140),
  description      text,
  category         event_category not null default 'work',
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  all_day          boolean not null default false,
  recurrence       recurrence_rule not null default 'none',
  recurrence_until date,
  client_visible   boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint events_order check (ends_at >= starts_at),
  -- Only agency events tied to a client may be shared with that client.
  constraint events_share_requires_client check (not client_visible or client_id is not null)
);
create index if not exists events_owner_idx on public.calendar_events (owner_id, starts_at);
create index if not exists events_client_idx on public.calendar_events (client_id, starts_at) where client_visible;

drop trigger if exists events_touch on public.calendar_events;
create trigger events_touch before update on public.calendar_events
  for each row execute function public.touch_updated_at();

create table if not exists public.reminders (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  task_id        uuid references public.tasks (id) on delete set null,
  title          text not null check (length(trim(title)) between 3 and 140),
  description    text,
  remind_at      timestamptz not null,
  repeat         reminder_repeat not null default 'none',
  repeat_until   date,
  alarm_enabled  boolean not null default true,
  is_dismissed   boolean not null default false,
  dismissed_at   timestamptz,
  snoozed_until  timestamptz,
  -- Set when the client has actually fired this occurrence, so a reload or a
  -- second tab cannot ring the same reminder twice.
  fired_at       timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists reminders_due_idx on public.reminders (owner_id, remind_at) where not is_dismissed;

drop trigger if exists reminders_touch on public.reminders;
create trigger reminders_touch before update on public.reminders
  for each row execute function public.touch_updated_at();

create table if not exists public.stopwatch_sessions (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  label       text,
  started_at  timestamptz not null,
  ended_at    timestamptz,
  duration_ms bigint not null check (duration_ms >= 0),
  laps        bigint[] not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists stopwatch_owner_idx on public.stopwatch_sessions (owner_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Notifications, preferences, announcements
-- ----------------------------------------------------------------------------
create table if not exists public.notification_preferences (
  user_id               uuid primary key references auth.users (id) on delete cascade,
  browser_notifications boolean not null default false,
  alarm_sound           boolean not null default true,
  alarm_volume          numeric(3, 2) not null default 0.60 check (alarm_volume between 0 and 1),
  alarm_sound_name      text not null default 'pulse',
  email_digest          boolean not null default false,
  quiet_hours_start     time,
  quiet_hours_end       time,
  updated_at            timestamptz not null default now()
);

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       notification_kind not null,
  title      text not null,
  body       text,
  link       text,
  -- Unique per real-world event: inserting the same alert twice is a no-op.
  dedupe_key text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists notifications_dedupe_idx
  on public.notifications (user_id, dedupe_key) where dedupe_key is not null;
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

create table if not exists public.announcements (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id) on delete cascade,
  title        text not null,
  body         text not null,
  published_at timestamptz not null default now(),
  expires_at   timestamptz
);
create index if not exists announcements_client_idx on public.announcements (client_id, published_at desc);

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Branding + audit
-- ----------------------------------------------------------------------------
create table if not exists public.branding_settings (
  id              uuid primary key default gen_random_uuid(),
  company_name    text not null default 'Managed by Luna',
  logo_url        text,
  receipt_footer  text not null default 'Thank you for working with Managed by Luna.',
  contact_email   text not null default 'hello@managedbyluna.com',
  contact_phone   text,
  address         text,
  -- Deliberately blank by default: LunaDesk must never invent tax details.
  tax_id          text,
  tax_label       text,
  receipt_prefix  text not null default 'MBL-RCP',
  invoice_prefix  text not null default 'MBL-INV',
  currency        text not null default 'INR',
  timezone        text not null default 'Asia/Kolkata',
  updated_at      timestamptz not null default now(),
  constraint branding_singleton check (id = 'b0000000-0000-4000-8000-000000000001'::uuid)
);
insert into public.branding_settings (id)
values ('b0000000-0000-4000-8000-000000000001')
on conflict (id) do nothing;

create table if not exists public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid references auth.users (id) on delete set null,
  actor_label text,
  action      text not null,
  entity      text not null,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_entity_idx on public.audit_logs (entity, entity_id, created_at desc);

create or replace function public.audit(
  p_action text,
  p_entity text,
  p_entity_id uuid,
  p_before jsonb default null,
  p_after jsonb default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_label text;
begin
  select full_name into v_label from public.profiles where id = auth.uid();
  insert into public.audit_logs (actor_id, actor_label, action, entity, entity_id, before, after)
  values (auth.uid(), coalesce(v_label, 'system'), p_action, p_entity, p_entity_id, p_before, p_after);
end $$;

-- ----------------------------------------------------------------------------
-- Convenience views (RLS is inherited from the base tables)
-- ----------------------------------------------------------------------------
create or replace view public.invoice_balances
with (security_invoker = true) as
select
  i.id                                                        as invoice_id,
  i.client_id,
  i.invoice_number,
  i.status                                                    as stored_status,
  i.total_minor,
  coalesce(p.paid_minor, 0)                                   as paid_minor,
  greatest(i.total_minor - coalesce(p.paid_minor, 0), 0)      as balance_minor,
  i.due_date,
  case
    when i.status = 'cancelled' then 'cancelled'
    when coalesce(p.paid_minor, 0) >= i.total_minor then 'paid'
    when i.due_date < current_date then 'overdue'
    when coalesce(p.paid_minor, 0) > 0 then 'partially_paid'
    else 'pending'
  end                                                         as effective_status
from public.invoices i
left join (
  select invoice_id, sum(amount_minor) as paid_minor
  from public.payments
  where voided_at is null
  group by invoice_id
) p on p.invoice_id = i.id;

grant select on public.invoice_balances to authenticated;
