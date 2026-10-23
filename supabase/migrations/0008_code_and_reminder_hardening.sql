-- =============================================================================
-- LunaDesk · 0008 — code redemption, admin lookup, reminder claiming
--
-- Audit fixes:
--  * The admin lookup limiter used a constant hint ('ADI'), so ten bad requests
--    from anybody locked out every administrator. Limits are now per IP and
--    per code prefix, never global.
--  * Redeemed codes ignored `expires_at`.
--  * Reminder delivery had no claim step, so two scheduler runs (or a rerun
--    after a partial failure) could push the same occurrence twice.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Attempt outcomes: 'access_disabled' distinguishes a genuine code that is
-- switched off from an unknown one. Both are counted by the limiter, and the
-- API still answers them identically for unknown codes.
-- ----------------------------------------------------------------------------
alter table public.access_attempts drop constraint if exists access_attempts_outcome_check;
alter table public.access_attempts
  add constraint access_attempts_outcome_check
  check (outcome in ('ok', 'bad_code', 'revoked', 'rate_limited', 'admin_lookup', 'access_disabled'));

-- ----------------------------------------------------------------------------
-- Shared limiter
-- ----------------------------------------------------------------------------
create or replace function public.access_attempts_exceeded(
  p_ip         inet,
  p_hint       text,
  p_kind       text,
  p_ip_limit   integer,
  p_hint_limit integer,
  p_window     interval default interval '10 minutes'
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recent as (
    select ip, code_hint, outcome
    from public.access_attempts
    where created_at > now() - p_window
      and code_kind is not distinct from p_kind
      and outcome in ('bad_code', 'revoked', 'access_disabled')
  )
  select
    -- Per-caller bucket. Only applied when the caller's IP is known.
    (p_ip is not null and (
      select count(*) from recent where ip = p_ip
    ) >= p_ip_limit)
    or
    -- Per-code bucket, keyed on the prefix actually presented. High enough
    -- that one attacker cannot cheaply lock a real user out, low enough to
    -- stop distributed guessing of a single code.
    (
      select count(*) from recent where code_hint = p_hint
    ) >= p_hint_limit;
$$;

revoke all on function public.access_attempts_exceeded(inet, text, text, integer, integer, interval)
  from public, anon, authenticated;
grant execute on function public.access_attempts_exceeded(inet, text, text, integer, integer, interval)
  to service_role;

-- ----------------------------------------------------------------------------
-- Client portal codes
-- ----------------------------------------------------------------------------
create or replace function public.rpc_redeem_access_code(
  p_code       text,
  p_ip         inet default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_code   public.client_access_codes%rowtype;
  v_client public.clients%rowtype;
  v_hint   text := upper(left(regexp_replace(trim(coalesce(p_code, '')), '\s+', '', 'g'), 3));
  v_input  text := upper(regexp_replace(trim(coalesce(p_code, '')), '\s+', '', 'g'));
  v_blocked boolean;
begin
  v_blocked := public.access_attempts_exceeded(p_ip, v_hint, 'client', 8, 30);

  if v_blocked then
    insert into public.access_attempts (code_hint, ip, user_agent, outcome, code_kind)
    values (v_hint, p_ip, p_user_agent, 'rate_limited', 'client');
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  select * into v_code
  from public.client_access_codes
  where not is_revoked
    and (expires_at is null or expires_at > now())
    and code_hash = crypt(v_input, code_hash)
  order by created_at desc
  limit 1;

  if not found then
    insert into public.access_attempts (code_hint, ip, user_agent, outcome, code_kind)
    values (v_hint, p_ip, p_user_agent, 'bad_code', 'client');
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  select * into v_client from public.clients where id = v_code.client_id;

  -- A deactivated / archived client, or a revoked portal, cannot sign in even
  -- with a technically valid code.
  if v_client.id is null
     or v_client.status <> 'active'
     or v_client.portal_status <> 'active'
     or v_code.user_id is null then
    insert into public.access_attempts (code_hint, ip, user_agent, outcome, code_kind)
    values (v_hint, p_ip, p_user_agent, 'access_disabled', 'client');
    return jsonb_build_object('ok', false, 'error', 'access_disabled');
  end if;

  -- The profile must still be active: deactivating a portal identity is a
  -- revocation even if the code was never rotated.
  if not exists (
    select 1 from public.profiles p
    where p.id = v_code.user_id and p.is_active and p.role = 'client' and p.client_id = v_client.id
  ) then
    insert into public.access_attempts (code_hint, ip, user_agent, outcome, code_kind)
    values (v_hint, p_ip, p_user_agent, 'access_disabled', 'client');
    return jsonb_build_object('ok', false, 'error', 'access_disabled');
  end if;

  update public.client_access_codes
     set last_used_at = now(), uses_count = uses_count + 1
   where id = v_code.id;

  insert into public.access_attempts (code_hint, ip, user_agent, outcome, code_kind)
  values (v_hint, p_ip, p_user_agent, 'ok', 'client');

  return jsonb_build_object(
    'ok', true,
    'user_id', v_code.user_id,
    'client_id', v_client.id,
    'client_code', v_client.client_code,
    'business_name', v_client.business_name
  );
end $$;

revoke all on function public.rpc_redeem_access_code(text, inet, text) from public, anon, authenticated;
grant execute on function public.rpc_redeem_access_code(text, inet, text) to service_role;

-- ----------------------------------------------------------------------------
-- Administrator lookup
--   Still identity-only: a correct code returns an email address, nothing else.
-- ----------------------------------------------------------------------------
create or replace function public.rpc_lookup_admin_code(
  p_code       text,
  p_ip         inet default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row   public.admin_access_codes%rowtype;
  v_email text;
  v_input text := upper(regexp_replace(trim(coalesce(p_code, '')), '\s+', '', 'g'));
  v_hint  text := upper(left(regexp_replace(trim(coalesce(p_code, '')), '\s+', '', 'g'), 3));
begin
  -- Per-IP only (plus a generous per-prefix bucket). There is deliberately no
  -- global counter: one unauthenticated caller must never be able to deny
  -- every administrator their own sign-in.
  if public.access_attempts_exceeded(p_ip, v_hint, 'admin', 10, 40) then
    insert into public.access_attempts (code_hint, ip, user_agent, outcome, code_kind)
    values (v_hint, p_ip, p_user_agent, 'rate_limited', 'admin');
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  select * into v_row
  from public.admin_access_codes
  where not is_revoked
    and (expires_at is null or expires_at > now())
    and code_hash = crypt(v_input, code_hash)
  order by created_at desc
  limit 1;

  if not found then
    insert into public.access_attempts (code_hint, ip, user_agent, outcome, code_kind)
    values (v_hint, p_ip, p_user_agent, 'bad_code', 'admin');
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  select email into v_email from auth.users where id = v_row.user_id;
  if v_email is null then
    insert into public.access_attempts (code_hint, ip, user_agent, outcome, code_kind)
    values (v_hint, p_ip, p_user_agent, 'bad_code', 'admin');
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  update public.admin_access_codes set last_used_at = now() where id = v_row.id;

  insert into public.access_attempts (code_hint, ip, user_agent, outcome, code_kind)
  values (v_hint, p_ip, p_user_agent, 'admin_lookup', 'admin');

  return jsonb_build_object('ok', true, 'email', v_email, 'label', v_row.label);
end $$;

revoke all on function public.rpc_lookup_admin_code(text, inet, text) from public, anon, authenticated;
grant execute on function public.rpc_lookup_admin_code(text, inet, text) to service_role;

-- ----------------------------------------------------------------------------
-- Reminder delivery claims
--
-- Delivery is at-least-once unless it is claimed first. The unique key
-- (reminder_id, occurrence) is the mutex: exactly one caller can insert it, and
-- only that caller sends the push. The row also records the outcome so a
-- failed push is visible and retryable instead of silently lost.
-- ----------------------------------------------------------------------------
create table if not exists public.reminder_deliveries (
  id          uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references public.reminders (id) on delete cascade,
  occurrence  timestamptz not null,
  worker      text,
  claimed_at  timestamptz not null default now(),
  delivered   boolean not null default false,
  error       text,
  unique (reminder_id, occurrence)
);
create index if not exists reminder_deliveries_recent_idx
  on public.reminder_deliveries (claimed_at desc);

alter table public.reminder_deliveries enable row level security;
-- No policies: only SECURITY DEFINER functions and the service role touch it.

revoke all on public.reminder_deliveries from anon, authenticated;

-- Returns true only for the caller that wins the claim.
create or replace function public.rpc_claim_reminder(
  p_reminder_id uuid,
  p_occurrence  timestamptz,
  p_worker      text default 'scheduler'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_rows integer;
begin
  insert into public.reminder_deliveries (reminder_id, occurrence, worker)
  values (p_reminder_id, p_occurrence, p_worker)
  on conflict (reminder_id, occurrence) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $$;

create or replace function public.rpc_mark_reminder_delivery(
  p_reminder_id uuid,
  p_occurrence  timestamptz,
  p_delivered   boolean,
  p_error       text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.reminder_deliveries
     set delivered = p_delivered, error = left(p_error, 500)
   where reminder_id = p_reminder_id and occurrence = p_occurrence;
$$;

revoke all on function public.rpc_claim_reminder(uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.rpc_mark_reminder_delivery(uuid, timestamptz, boolean, text) from public, anon, authenticated;
grant execute on function public.rpc_claim_reminder(uuid, timestamptz, text) to service_role;
grant execute on function public.rpc_mark_reminder_delivery(uuid, timestamptz, boolean, text) to service_role;

-- Housekeeping: claims older than 90 days are not needed for retries.
create or replace function public.rpc_prune_reminder_deliveries()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  delete from public.reminder_deliveries where claimed_at < now() - interval '90 days';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.rpc_prune_reminder_deliveries() from public, anon, authenticated;
grant execute on function public.rpc_prune_reminder_deliveries() to service_role;

-- ----------------------------------------------------------------------------
-- Admin deactivation must also clear the role grants, so reactivating a profile
-- is a deliberate two-step act rather than an accidental privilege restore.
-- ----------------------------------------------------------------------------
create or replace function public.rpc_set_admin_active(p_user_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_admin();
  if p_user_id = auth.uid() and not p_active then
    raise exception 'You cannot deactivate your own account' using errcode = 'P0001';
  end if;

  update public.profiles set is_active = p_active, role = 'admin' where id = p_user_id;

  if p_active then
    insert into public.user_roles (user_id, role, granted_by)
    values (p_user_id, 'admin', auth.uid())
    on conflict (user_id, role) do nothing;
  else
    delete from public.user_roles where user_id = p_user_id and role = 'admin';
    -- Existing sessions keep their JWT until it expires, but is_admin() now
    -- returns false immediately, so RLS and the RPCs stop authorizing.
  end if;

  perform public.audit(
    case when p_active then 'admin.activate' else 'admin.deactivate' end,
    'profiles', p_user_id, null, jsonb_build_object('is_active', p_active)
  );
end $$;

grant execute on function public.rpc_set_admin_active(uuid, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- Portal lifecycle helpers used by the RPC bridge
-- ----------------------------------------------------------------------------

-- Re-enable a portal that was revoked, without minting a new code. Refused
-- when no usable code exists, so "reactivated" never means "still cannot sign
-- in": the admin is told to issue a fresh code instead.
create or replace function public.rpc_reactivate_client_portal(p_client_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_profile uuid;
begin
  perform public.assert_admin();

  if not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.client_access_codes
    where client_id = p_client_id
      and not is_revoked
      and (expires_at is null or expires_at > now())
      and user_id is not null
  ) then
    raise exception 'This portal has no usable access code. Issue a new code to restore access.'
      using errcode = 'P0001';
  end if;

  update public.clients set portal_status = 'active' where id = p_client_id;
  update public.profiles set is_active = true
   where client_id = p_client_id and role = 'client';

  select id into v_profile from public.profiles where client_id = p_client_id and role = 'client' limit 1;

  perform public.audit('portal.access.reactivate', 'clients', p_client_id, null,
                       jsonb_build_object('profile', v_profile));

  return jsonb_build_object('ok', true, 'client_id', p_client_id);
end $$;

grant execute on function public.rpc_reactivate_client_portal(uuid) to authenticated;

-- Deterministic status refresh for a single invoice, exposed for the client's
-- 'refresh_invoice_status' action.
create or replace function public.rpc_refresh_invoice_status(p_invoice_id uuid)
returns payment_status
language plpgsql
security definer
set search_path = public
as $$
declare v_status payment_status;
begin
  perform public.assert_admin();
  perform public.sync_invoice_status(p_invoice_id);
  select status into v_status from public.invoices where id = p_invoice_id;
  return v_status;
end $$;

grant execute on function public.rpc_refresh_invoice_status(uuid) to authenticated;
