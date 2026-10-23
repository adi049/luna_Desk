-- =============================================================================
-- LunaDesk · 0002 — Row Level Security
--
-- Threat model
--  * Anyone with the publishable key can call PostgREST directly. RLS is the
--    only thing standing between a signed-in client and another client's data.
--  * "role" lives in profiles / user_roles and is read through SECURITY DEFINER
--    helpers, so a client cannot spoof it with a request parameter.
--  * Personal productivity rows (tasks, notes, reminders, calendar events the
--    user owns, stopwatch) are visible ONLY to their owner — admins included.
-- =============================================================================

alter table public.clients                  enable row level security;
alter table public.profiles                 enable row level security;
alter table public.user_roles               enable row level security;
alter table public.client_access_codes      enable row level security;
alter table public.access_attempts          enable row level security;
alter table public.services                 enable row level security;
alter table public.client_services          enable row level security;
alter table public.internal_notes           enable row level security;
alter table public.projects                 enable row level security;
alter table public.project_updates          enable row level security;
alter table public.invoices                 enable row level security;
alter table public.invoice_items            enable row level security;
alter table public.payments                 enable row level security;
alter table public.receipts                 enable row level security;
alter table public.document_sequences       enable row level security;
alter table public.tasks                    enable row level security;
alter table public.task_assignments         enable row level security;
alter table public.notes                    enable row level security;
alter table public.calendar_events          enable row level security;
alter table public.reminders                enable row level security;
alter table public.stopwatch_sessions       enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notifications            enable row level security;
alter table public.announcements            enable row level security;
alter table public.push_subscriptions       enable row level security;
alter table public.branding_settings        enable row level security;
alter table public.audit_logs               enable row level security;

-- ----------------------------------------------------------------------------
-- Role helpers (SECURITY DEFINER so policy evaluation cannot be tricked by
-- row-level visibility of profiles itself).
-- ----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin' and p.is_active
  ) or exists (
    select 1 from public.user_roles r
    where r.user_id = auth.uid() and r.role = 'admin'
  );
$$;

create or replace function public.current_client_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.client_id
  from public.profiles p
  join public.clients c on c.id = p.client_id
  where p.id = auth.uid()
    and p.role = 'client'
    and p.is_active
    and c.status = 'active'
    and c.portal_status = 'active';
$$;

create or replace function public.is_client_of(p_client_id uuid)
returns boolean
language sql
stable
as $$
  select p_client_id is not null and p_client_id = public.current_client_id();
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.current_client_id() from public;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.current_client_id() to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Profile self-service guard: a user may edit their own profile, but may not
-- change their role, their client link, or reactivate a disabled account.
-- ----------------------------------------------------------------------------
create or replace function public.guard_profile_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- auth.uid() is null for service-role / migration statements (bootstrap,
  -- backfills); those are trusted. Everything else must be an admin.
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  if new.role is distinct from old.role
     or new.client_id is distinct from old.client_id
     or new.is_active is distinct from old.is_active then
    raise exception 'Only an administrator can change role, client link or activation';
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_update();

-- ----------------------------------------------------------------------------
-- Policies
-- ----------------------------------------------------------------------------
drop policy if exists "clients: admin all" on public.clients;
create policy "clients: admin all" on public.clients
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "clients: client reads own" on public.clients;
create policy "clients: client reads own" on public.clients
  for select to authenticated using (id = public.current_client_id());

drop policy if exists "profiles: own" on public.profiles;
create policy "profiles: own" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles: self update" on public.profiles;
create policy "profiles: self update" on public.profiles
  for update to authenticated using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

drop policy if exists "user_roles: admin" on public.user_roles;
create policy "user_roles: admin" on public.user_roles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Access codes: no client-readable policy at all. Only the service role (from
-- the Edge Function) may touch this table; the RPC below exposes verification.
create policy "access_codes: admin read" on public.client_access_codes
  for select to authenticated using (public.is_admin());

drop policy if exists "access_attempts: admin read" on public.access_attempts;
create policy "access_attempts: admin read" on public.access_attempts
  for select to authenticated using (public.is_admin());

drop policy if exists "services: read" on public.services;
create policy "services: read" on public.services
  for select to authenticated using (true);

drop policy if exists "services: admin write" on public.services;
create policy "services: admin write" on public.services
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "client_services: read" on public.client_services;
create policy "client_services: read" on public.client_services
  for select to authenticated using (public.is_admin() or public.is_client_of(client_id));

drop policy if exists "client_services: admin write" on public.client_services;
create policy "client_services: admin write" on public.client_services
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Internal notes: admins only, no client policy exists at all.
drop policy if exists "internal_notes: admin" on public.internal_notes;
create policy "internal_notes: admin" on public.internal_notes
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "projects: read" on public.projects;
create policy "projects: read" on public.projects
  for select to authenticated using (
    public.is_admin() or (client_visible and public.is_client_of(client_id))
  );

drop policy if exists "projects: admin write" on public.projects;
create policy "projects: admin write" on public.projects
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "project_updates: read" on public.project_updates;
create policy "project_updates: read" on public.project_updates
  for select to authenticated using (
    public.is_admin()
    or (
      client_visible
      and exists (
        select 1 from public.projects p
        where p.id = project_updates.project_id
          and p.client_visible
          and public.is_client_of(p.client_id)
      )
    )
  );

drop policy if exists "project_updates: admin write" on public.project_updates;
create policy "project_updates: admin write" on public.project_updates
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "invoices: read" on public.invoices;
create policy "invoices: read" on public.invoices
  for select to authenticated using (public.is_admin() or public.is_client_of(client_id));

drop policy if exists "invoices: admin write" on public.invoices;
create policy "invoices: admin write" on public.invoices
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "invoice_items: read" on public.invoice_items;
create policy "invoice_items: read" on public.invoice_items
  for select to authenticated using (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_items.invoice_id
        and (public.is_admin() or public.is_client_of(i.client_id))
    )
  );

drop policy if exists "invoice_items: admin write" on public.invoice_items;
create policy "invoice_items: admin write" on public.invoice_items
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "payments: read" on public.payments;
create policy "payments: read" on public.payments
  for select to authenticated using (public.is_admin() or public.is_client_of(client_id));

-- Payments are written only through security-definer RPCs, never by direct
-- insert, so the amount/overpayment checks cannot be bypassed.
drop policy if exists "payments: admin write" on public.payments;
create policy "payments: admin write" on public.payments
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "receipts: read" on public.receipts;
create policy "receipts: read" on public.receipts
  for select to authenticated using (public.is_admin() or public.is_client_of(client_id));

drop policy if exists "receipts: admin write" on public.receipts;
create policy "receipts: admin write" on public.receipts
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "sequences: admin" on public.document_sequences;
create policy "sequences: admin" on public.document_sequences
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Owner-scoped productivity tables -------------------------------------------
drop policy if exists "tasks: owner" on public.tasks;
create policy "tasks: owner" on public.tasks
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "task_assignments: owner" on public.task_assignments;
create policy "task_assignments: owner" on public.task_assignments
  for all to authenticated using (
    exists (select 1 from public.tasks t where t.id = task_id and t.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.tasks t where t.id = task_id and t.owner_id = auth.uid())
  );

drop policy if exists "notes: owner" on public.notes;
create policy "notes: owner" on public.notes
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "events: read" on public.calendar_events;
create policy "events: read" on public.calendar_events
  for select to authenticated using (
    owner_id = auth.uid()
    or (client_visible and public.is_client_of(client_id))
  );

drop policy if exists "events: owner write" on public.calendar_events;
create policy "events: owner write" on public.calendar_events
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "reminders: owner" on public.reminders;
create policy "reminders: owner" on public.reminders
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "stopwatch: owner" on public.stopwatch_sessions;
create policy "stopwatch: owner" on public.stopwatch_sessions
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "notif prefs: owner" on public.notification_preferences;
create policy "notif prefs: owner" on public.notification_preferences
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "notifications: owner" on public.notifications;
create policy "notifications: owner" on public.notifications
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "announcements: read" on public.announcements;
create policy "announcements: read" on public.announcements
  for select to authenticated using (public.is_admin() or public.is_client_of(client_id));

drop policy if exists "announcements: admin write" on public.announcements;
create policy "announcements: admin write" on public.announcements
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "push subs: owner" on public.push_subscriptions;
create policy "push subs: owner" on public.push_subscriptions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Branding is readable by any signed-in user (the logo appears on their
-- receipts) but only an admin may change it.
drop policy if exists "branding: read" on public.branding_settings;
create policy "branding: read" on public.branding_settings
  for select to authenticated using (true);

drop policy if exists "branding: admin write" on public.branding_settings;
create policy "branding: admin write" on public.branding_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "audit: admin read" on public.audit_logs;
create policy "audit: admin read" on public.audit_logs
  for select to authenticated using (public.is_admin());
