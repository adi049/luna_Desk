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
-- Exactly one worker may act on a given (reminder, occurrence). The unique key
-- is the mutex, but a mutex alone is not enough: a worker can die after taking
-- the claim and before recording an outcome, which previously left that
-- occurrence unclaimable forever. The claim is therefore a *lease*.
--
-- Semantics:
--   * a claim carries `lease_expires_at` and an `attempts` counter;
--   * a live lease blocks everyone else — this is the duplicate-delivery
--     protection, and it is unchanged for the happy path;
--   * an expired lease may be reclaimed, but only while attempts remain, so a
--     poisoned occurrence retries a bounded number of times and then stops;
--   * a delivered occurrence is terminal and is never reclaimed.
--
-- Trade-off, stated plainly: if a worker pushes successfully and then crashes
-- before marking delivery, the lease expires and the occurrence can be pushed
-- once more. That is at-least-once delivery for the rare crash window, which is
-- the correct choice for a reminder (a duplicate notification is far less
-- harmful than a silently dropped one). The attempts cap bounds how often it
-- can happen, and the push payload reuses a stable `tag`, so the OS collapses
-- repeats into one notification on the device.
-- ----------------------------------------------------------------------------
create table if not exists public.reminder_deliveries (
  id               uuid primary key default gen_random_uuid(),
  reminder_id      uuid not null references public.reminders (id) on delete cascade,
  occurrence       timestamptz not null,
  worker           text,
  claimed_at       timestamptz not null default now(),
  attempts         integer not null default 1 check (attempts > 0),
  lease_expires_at timestamptz,
  last_attempt_at  timestamptz not null default now(),
  delivered        boolean not null default false,
  error            text,
  finished_at      timestamptz,
  unique (reminder_id, occurrence)
);

-- Upgrade path for a database that already ran the earlier version of this
-- migration (the table was created without lease columns).
alter table public.reminder_deliveries add column if not exists attempts integer not null default 1;
alter table public.reminder_deliveries add column if not exists lease_expires_at timestamptz;
alter table public.reminder_deliveries add column if not exists last_attempt_at timestamptz not null default now();
alter table public.reminder_deliveries add column if not exists finished_at timestamptz;

create index if not exists reminder_deliveries_recent_idx
  on public.reminder_deliveries (claimed_at desc);
-- Supports the recovery scan without walking the whole table.
create index if not exists reminder_deliveries_lease_idx
  on public.reminder_deliveries (lease_expires_at)
  where not delivered;

alter table public.reminder_deliveries enable row level security;
-- No policies: only SECURITY DEFINER functions and the service role touch it.

revoke all on public.reminder_deliveries from anon, authenticated;

-- Claim (or reclaim) one occurrence.
--
-- Returns jsonb rather than boolean so a caller can tell "somebody else is
-- working on it" from "this is poisoned and has given up". The old boolean
-- signature is dropped first.
drop function if exists public.rpc_claim_reminder(uuid, timestamptz, text);

create or replace function public.rpc_claim_reminder(
  p_reminder_id   uuid,
  p_occurrence    timestamptz,
  p_worker        text default 'scheduler',
  p_lease_seconds integer default 300,
  p_max_attempts  integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row     public.reminder_deliveries%rowtype;
  v_attempt integer;
begin
  if p_reminder_id is null or p_occurrence is null then
    raise exception 'A reminder id and occurrence are required' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 then
    raise exception 'The lease must be at least one second' using errcode = '22023';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 then
    raise exception 'The attempt budget must be at least one' using errcode = '22023';
  end if;

  -- Serialises every worker touching this occurrence, so two of them cannot
  -- both observe an expired lease and both decide to reclaim it.
  select * into v_row
    from public.reminder_deliveries
   where reminder_id = p_reminder_id
     and occurrence = p_occurrence
     for update;

  if not found then
    insert into public.reminder_deliveries
      (reminder_id, occurrence, worker, attempts, lease_expires_at, last_attempt_at)
    values
      (p_reminder_id, p_occurrence, p_worker, 1,
       now() + make_interval(secs => p_lease_seconds), now());

    return jsonb_build_object('claimed', true, 'attempt', 1, 'reason', 'new');
  end if;

  if v_row.delivered then
    return jsonb_build_object('claimed', false, 'attempt', v_row.attempts, 'reason', 'already_delivered');
  end if;

  if v_row.lease_expires_at is not null and v_row.lease_expires_at > now() then
    return jsonb_build_object('claimed', false, 'attempt', v_row.attempts, 'reason', 'lease_active');
  end if;

  if v_row.attempts >= p_max_attempts then
    return jsonb_build_object('claimed', false, 'attempt', v_row.attempts, 'reason', 'attempts_exhausted');
  end if;

  -- The previous holder died or failed without recording an outcome. Take over.
  update public.reminder_deliveries
     set attempts         = v_row.attempts + 1,
         worker           = p_worker,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         last_attempt_at  = now()
   where id = v_row.id
  returning attempts into v_attempt;

  return jsonb_build_object('claimed', true, 'attempt', v_attempt, 'reason', 'lease_expired');
exception
  when unique_violation then
    -- Another worker inserted the row between our SELECT and INSERT.
    return jsonb_build_object('claimed', false, 'attempt', 1, 'reason', 'lease_active');
end $$;

-- Record the outcome of a claimed attempt.
--
-- Success ends the occurrence permanently. Failure releases the lease so the
-- next scheduler run can retry, after a short backoff, while attempts remain —
-- the occurrence is therefore recoverable but never retried without bound.
drop function if exists public.rpc_mark_reminder_delivery(uuid, timestamptz, boolean, text);

create or replace function public.rpc_mark_reminder_delivery(
  p_reminder_id         uuid,
  p_occurrence          timestamptz,
  p_delivered           boolean,
  p_error               text default null,
  p_retry_after_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_attempt integer;
begin
  update public.reminder_deliveries
     set delivered   = p_delivered,
         error       = left(p_error, 500),
         finished_at = case when p_delivered then now() else null end,
         -- Delivered: no lease, so nothing can ever reclaim it.
         -- Failed: hand it back for a later attempt.
         lease_expires_at = case
           when p_delivered then null
           else now() + make_interval(secs => greatest(coalesce(p_retry_after_seconds, 60), 0))
         end
   where reminder_id = p_reminder_id
     and occurrence = p_occurrence
  returning attempts into v_attempt;

  if v_attempt is null then
    raise exception 'No claim exists for this occurrence' using errcode = 'P0002';
  end if;

  return jsonb_build_object('ok', true, 'delivered', p_delivered, 'attempt', v_attempt);
end $$;

revoke all on function public.rpc_claim_reminder(uuid, timestamptz, text, integer, integer) from public, anon, authenticated;
revoke all on function public.rpc_mark_reminder_delivery(uuid, timestamptz, boolean, text, integer) from public, anon, authenticated;
grant execute on function public.rpc_claim_reminder(uuid, timestamptz, text, integer, integer) to service_role;
grant execute on function public.rpc_mark_reminder_delivery(uuid, timestamptz, boolean, text, integer) to service_role;

-- Housekeeping: settled claims older than 90 days are not needed for retries.
-- Undelivered rows inside their attempt budget are kept so recovery survives.
create or replace function public.rpc_prune_reminder_deliveries()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  delete from public.reminder_deliveries
   where claimed_at < now() - interval '90 days'
     and (delivered or finished_at is not null);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.rpc_prune_reminder_deliveries() from public, anon, authenticated;
grant execute on function public.rpc_prune_reminder_deliveries() to service_role;

-- ----------------------------------------------------------------------------
-- Admin deactivation must also clear the role grants, so reactivating a profile
-- is a deliberate two-step act rather than an accidental privilege restore.
-- ----------------------------------------------------------------------------
-- Activate or deactivate an EXISTING administrator.
--
-- This function is deliberately not a general-purpose account toggle:
--
--   * it never writes profiles.role, so it cannot promote anybody. The previous
--     version ran `set is_active = p_active, role = 'admin'`, which silently
--     turned any user id passed to it into an administrator — a privilege
--     escalation reachable from a normal "reactivate account" action;
--   * the target must already be an admin account (role = 'admin') and must not
--     be linked to a client portal;
--   * deactivating the last active administrator is refused, because that would
--     strand the workspace with nobody able to sign in;
--   * both directions are audited with the before/after state.
--
-- The return type changed from void to jsonb; the old signature is dropped
-- first so this also upgrades a database that already ran the previous version.
drop function if exists public.rpc_set_admin_active(uuid, boolean);

create or replace function public.rpc_set_admin_active(p_user_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target    public.profiles%rowtype;
  v_before    jsonb;
  v_remaining integer;
begin
  perform public.assert_admin();

  if p_user_id is null or p_active is null then
    raise exception 'A user id and target state are required' using errcode = '22023';
  end if;

  if p_user_id = auth.uid() and not p_active then
    raise exception 'You cannot deactivate your own account' using errcode = 'P0001';
  end if;

  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'No such account' using errcode = 'P0002';
  end if;

  -- Only accounts that are already administrators may be touched. This is the
  -- guard that makes the RPC useless as an escalation primitive.
  if v_target.role <> 'admin' then
    raise exception
      'Account % is not an administrator (role = %). This operation only activates or deactivates existing admins.',
      p_user_id, v_target.role
      using errcode = '42501';
  end if;

  if v_target.client_id is not null then
    raise exception 'Account % is linked to a client portal and cannot be treated as an administrator',
      p_user_id using errcode = '42501';
  end if;

  -- Idempotent: activating an active account is not an error, it is a no-op.
  if v_target.is_active = p_active then
    return jsonb_build_object('ok', true, 'changed', false, 'is_active', p_active);
  end if;

  if not p_active then
    select count(*) into v_remaining
      from public.profiles p
     where p.role = 'admin'
       and p.is_active
       and p.id <> p_user_id;

    if v_remaining = 0 then
      raise exception 'Refusing to deactivate the last active administrator'
        using errcode = 'P0001';
    end if;
  end if;

  v_before := jsonb_build_object(
    'is_active', v_target.is_active,
    'role', v_target.role,
    'has_admin_grant', exists (
      select 1 from public.user_roles r
       where r.user_id = p_user_id and r.role = 'admin'
    )
  );

  -- Only is_active is written. `role` is never assigned in this function.
  update public.profiles set is_active = p_active where id = p_user_id;

  if p_active then
    -- Restore the grant that deactivation removed, so is_admin() works through
    -- both paths again. The role itself is untouched.
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
    'profiles', p_user_id,
    v_before,
    jsonb_build_object('is_active', p_active, 'role', v_target.role)
  );

  return jsonb_build_object('ok', true, 'changed', true, 'is_active', p_active);
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
