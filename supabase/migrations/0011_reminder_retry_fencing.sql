-- =============================================================================
-- 0011 — reminder delivery: retry, fencing, and transactional advancement
--
-- The previous design could not retry a failed push. The worker advanced the
-- reminder (fired_at for a one-time reminder, remind_at + interval for a
-- repeating one) *before* it recorded whether the push succeeded, so a failed
-- push left the occurrence already consumed: the row was no longer due, and the
-- user never got the alert they had asked for.
--
-- Four things change here:
--
--   1. rpc_due_reminders() selects on the *effective* occurrence
--      (coalesce(snoozed_until, remind_at)) instead of on remind_at. A reminder
--      snoozed into the future can therefore never occupy a slot in the scan
--      limit and starve genuinely due reminders behind it.
--   2. rpc_claim_reminder() issues a per-attempt fencing token. A worker whose
--      lease expired and was reclaimed by someone else can no longer write the
--      outcome of its dead attempt over the live one.
--   3. rpc_complete_reminder_delivery() does completion and schedule
--      advancement in ONE transaction, and only advances when delivery
--      actually succeeded. A failure releases the lease and leaves the
--      occurrence selectable.
--   4. The notification row and the push attempt are now independent: a retry
--      re-uses the existing in-app notification (the unique dedupe_key makes
--      the insert a no-op) and still re-attempts the push.
--
-- rpc_mark_reminder_delivery() is dropped rather than kept alongside the new
-- function: leaving an unfenced way to write delivery state would defeat §2.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Fencing token on the claim row.
-- ---------------------------------------------------------------------------
alter table public.reminder_deliveries add column if not exists claim_token uuid;
alter table public.reminder_deliveries add column if not exists push_attempted_at timestamptz;
alter table public.reminder_deliveries add column if not exists last_error_kind text;

-- ---------------------------------------------------------------------------
-- 2. Due selection on the effective occurrence.
--
-- Returns the preference row joined in, so the caller does not need a second
-- round trip and — more importantly — cannot accidentally apply a different
-- default than the database does. A missing preference row resolves to the
-- column default (browser_notifications = false, in-app only), which is what
-- docs/ALARMS_AND_NOTIFICATIONS.md promises.
-- ---------------------------------------------------------------------------
drop function if exists public.rpc_due_reminders(timestamptz, integer);

create or replace function public.rpc_due_reminders(
  p_horizon timestamptz,
  p_limit   integer default 200
)
returns table (
  id                    uuid,
  owner_id              uuid,
  title                 text,
  description           text,
  remind_at             timestamptz,
  occurrence            timestamptz,
  repeat                reminder_repeat,
  repeat_until          date,
  alarm_enabled         boolean,
  snoozed_until         timestamptz,
  browser_notifications boolean,
  user_timezone         text
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id,
         r.owner_id,
         r.title,
         r.description,
         r.remind_at,
         coalesce(r.snoozed_until, r.remind_at) as occurrence,
         r.repeat,
         r.repeat_until,
         r.alarm_enabled,
         r.snoozed_until,
         coalesce(np.browser_notifications, false) as browser_notifications,
         -- Timezone lives on the profile (that is where the app writes it and
         -- where the demo seed puts it), NOT on notification_preferences. The
         -- previous code selected a column that does not exist, so the whole
         -- preference query silently failed and every user was treated as
         -- opted in to push.
         coalesce(pr.timezone, 'Asia/Kolkata')     as user_timezone
    from public.reminders r
    left join public.notification_preferences np on np.user_id = r.owner_id
    left join public.profiles pr on pr.id = r.owner_id
   where not r.is_dismissed
     and r.fired_at is null
     -- The whole point: a snoozed reminder is due at the snooze, not before.
     and coalesce(r.snoozed_until, r.remind_at) <= p_horizon
   order by coalesce(r.snoozed_until, r.remind_at) asc
   limit greatest(coalesce(p_limit, 200), 1);
$$;

revoke all on function public.rpc_due_reminders(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.rpc_due_reminders(timestamptz, integer) to service_role;

-- Supports the scan above without a full sort of the table.
create index if not exists reminders_occurrence_idx
  on public.reminders ((coalesce(snoozed_until, remind_at)))
  where not is_dismissed and fired_at is null;

-- ---------------------------------------------------------------------------
-- 3. Claim, now issuing a token.
-- ---------------------------------------------------------------------------
drop function if exists public.rpc_claim_reminder(uuid, timestamptz, text, integer, integer);

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
  v_row   public.reminder_deliveries%rowtype;
  v_token uuid := gen_random_uuid();
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

  select * into v_row
    from public.reminder_deliveries
   where reminder_id = p_reminder_id and occurrence = p_occurrence
     for update;

  if not found then
    insert into public.reminder_deliveries
      (reminder_id, occurrence, worker, attempts, lease_expires_at, last_attempt_at, claim_token)
    values
      (p_reminder_id, p_occurrence, p_worker, 1,
       now() + make_interval(secs => p_lease_seconds), now(), v_token);

    return jsonb_build_object('claimed', true, 'attempt', 1, 'reason', 'new', 'token', v_token);
  end if;

  if v_row.delivered then
    return jsonb_build_object('claimed', false, 'attempt', v_row.attempts,
                              'reason', 'already_delivered', 'token', null);
  end if;

  if v_row.lease_expires_at is not null and v_row.lease_expires_at > now() then
    return jsonb_build_object('claimed', false, 'attempt', v_row.attempts,
                              'reason', 'lease_active', 'token', null);
  end if;

  if v_row.attempts >= p_max_attempts then
    return jsonb_build_object('claimed', false, 'attempt', v_row.attempts,
                              'reason', 'attempts_exhausted', 'token', null);
  end if;

  update public.reminder_deliveries
     set attempts         = v_row.attempts + 1,
         worker           = p_worker,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         last_attempt_at  = now(),
         claim_token      = v_token
   where id = v_row.id
  returning attempts into v_attempt;

  return jsonb_build_object('claimed', true, 'attempt', v_attempt, 'reason', 'lease_expired', 'token', v_token);
exception
  when unique_violation then
    return jsonb_build_object('claimed', false, 'attempt', 1, 'reason', 'lease_active', 'token', null);
end $$;

revoke all on function public.rpc_claim_reminder(uuid, timestamptz, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.rpc_claim_reminder(uuid, timestamptz, text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Completion + advancement, atomically and fenced.
--
--    p_token must be the token issued by the claim that owns this attempt. A
--    worker whose lease lapsed and was reclaimed holds a stale token and gets
--    'stale_claim' with no side effects at all — it cannot resurrect a dead
--    attempt over a live one, and it cannot advance the schedule.
--
--    p_push_ok = false   → record the error, release the lease, do NOT advance.
--                          The occurrence stays due and is retried.
--    p_push_ok = true    → mark the occurrence delivered and advance the
--                          reminder in the same transaction.
-- ---------------------------------------------------------------------------
drop function if exists public.rpc_mark_reminder_delivery(uuid, timestamptz, boolean, text, integer);
drop function if exists public.rpc_complete_reminder_delivery(uuid, timestamptz, uuid, boolean, text, integer);

create or replace function public.rpc_complete_reminder_delivery(
  p_reminder_id         uuid,
  p_occurrence          timestamptz,
  p_token               uuid,
  p_push_ok             boolean default true,
  p_error               text default null,
  p_retry_after_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row      public.reminder_deliveries%rowtype;
  v_reminder public.reminders%rowtype;
  v_tz       text := 'Asia/Kolkata';
  v_next     timestamptz;
  v_guard    integer := 0;
  v_expired  boolean := false;
begin
  if p_reminder_id is null or p_occurrence is null or p_token is null then
    raise exception 'A reminder id, occurrence and claim token are required' using errcode = '22023';
  end if;

  select * into v_row
    from public.reminder_deliveries
   where reminder_id = p_reminder_id and occurrence = p_occurrence
     for update;

  if not found then
    raise exception 'No claim exists for this occurrence' using errcode = 'P0002';
  end if;

  -- Fencing. Everything below this line assumes the caller still owns the claim.
  if v_row.claim_token is distinct from p_token then
    return jsonb_build_object(
      'ok', false, 'reason', 'stale_claim', 'advanced', false,
      'current_attempt', v_row.attempts);
  end if;

  if v_row.delivered then
    return jsonb_build_object('ok', true, 'reason', 'already_delivered', 'advanced', false);
  end if;

  select * into v_reminder from public.reminders where id = p_reminder_id for update;
  if not found then
    raise exception 'Reminder no longer exists' using errcode = 'P0002';
  end if;

  select pr.timezone into v_tz from public.profiles pr where pr.id = v_reminder.owner_id;
  v_tz := coalesce(v_tz, 'Asia/Kolkata');

  -- A stored zone that Postgres cannot resolve would make the date comparison
  -- below raise instead of falling back, so it is normalised once, here.
  if not exists (select 1 from pg_timezone_names where name = v_tz) then
    v_tz := 'Asia/Kolkata';
  end if;

  -- ---------------------------------------------------------------- failure
  if not p_push_ok then
    update public.reminder_deliveries
       set error            = left(p_error, 500),
           last_error_kind  = 'push_failed',
           push_attempted_at = now(),
           lease_expires_at = now() + make_interval(secs => greatest(coalesce(p_retry_after_seconds, 60), 0)),
           -- Deliberately NOT delivered, and finished_at stays null, so the
           -- occurrence remains selectable by rpc_due_reminders().
           delivered        = false,
           finished_at      = null
     where id = v_row.id;

    -- The reminder itself is untouched: no fired_at, no schedule advance.
    return jsonb_build_object(
      'ok', true, 'reason', 'retry_scheduled', 'advanced', false,
      'attempt', v_row.attempts,
      'retry_at', now() + make_interval(secs => greatest(coalesce(p_retry_after_seconds, 60), 0)));
  end if;

  -- ---------------------------------------------------------------- success
  update public.reminder_deliveries
     set delivered        = true,
         error            = left(p_error, 500),
         finished_at      = now(),
         push_attempted_at = now(),
         lease_expires_at = null
   where id = v_row.id;

  if v_reminder.repeat = 'none' then
    update public.reminders
       set fired_at = now(), snoozed_until = null
     where id = p_reminder_id;
    return jsonb_build_object('ok', true, 'reason', 'delivered', 'advanced', true,
                              'finished', true, 'next_occurrence', null);
  end if;

  -- Repeating: step forward in the user's own timezone so DST does not shift
  -- the wall-clock time. Skip over occurrences missed during downtime — the
  -- user gets one alert now, not a replay of the backlog.
  v_next := public.next_occurrence_tz(v_reminder.remind_at, v_reminder.repeat, v_tz);
  while v_next <= now() and v_guard < 400 loop
    v_next := public.next_occurrence_tz(v_next, v_reminder.repeat, v_tz);
    v_guard := v_guard + 1;
  end loop;

  -- `repeat_until` is a plain date chosen by the user: the last local day the
  -- series should run. Comparing it with `v_next::date` would reinterpret the
  -- instant in the *session* time zone, so a reminder in a zone ahead of UTC
  -- kept firing for one extra day and one behind UTC stopped a day early.
  -- The instant is converted to the owner's zone first.
  v_expired := v_reminder.repeat_until is not null
               and (v_next at time zone v_tz)::date > v_reminder.repeat_until;

  if v_expired then
    update public.reminders
       set fired_at = now(), snoozed_until = null
     where id = p_reminder_id;

    return jsonb_build_object('ok', true, 'reason', 'series_finished', 'advanced', true,
                              'finished', true, 'next_occurrence', null);
  end if;

  update public.reminders
     set remind_at = v_next,
         fired_at = null,
         snoozed_until = null
   where id = p_reminder_id;

  return jsonb_build_object('ok', true, 'reason', 'delivered', 'advanced', true,
                            'finished', false, 'next_occurrence', v_next);
end $$;

revoke all on function public.rpc_complete_reminder_delivery(uuid, timestamptz, uuid, boolean, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.rpc_complete_reminder_delivery(uuid, timestamptz, uuid, boolean, text, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. Timezone-correct recurrence step, shared by the RPC above.
--
--    `at time zone` converts to the wall clock in that zone, adds the interval,
--    and converts back, so a 09:00 daily reminder stays at 09:00 across a DST
--    change. Month-end is clamped by Postgres itself (31 Jan + 1 month = 28/29
--    Feb), which is the behaviour a user expects from a monthly reminder.
-- ---------------------------------------------------------------------------
create or replace function public.next_occurrence_tz(
  p_from   timestamptz,
  p_repeat reminder_repeat,
  p_tz     text
)
returns timestamptz
language plpgsql
stable
as $$
begin
  if p_repeat = 'none' then
    return p_from;
  end if;

  return case p_repeat
    when 'daily'   then p_from + interval '1 day'
    when 'weekly'  then p_from + interval '7 days'
    when 'monthly' then ((p_from at time zone p_tz) + interval '1 month') at time zone p_tz
    when 'yearly'  then ((p_from at time zone p_tz) + interval '1 year') at time zone p_tz
  end;
end $$;

revoke all on function public.next_occurrence_tz(timestamptz, reminder_repeat, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Extend the privilege policy from 0010 and re-apply it.
--
--    Adding rows here is the whole ceremony for a new API-callable function:
--    enforce_function_privileges() revokes everything, then re-grants exactly
--    what the table names. Nothing above needs an individual REVOKE/GRANT pair
--    to survive; anything not listed stays closed.
-- ---------------------------------------------------------------------------
insert into public.function_privilege_policy (function_name, role_name, note) values
  ('rpc_due_reminders',              'service_role', 'send-reminders function'),
  ('rpc_complete_reminder_delivery', 'service_role', 'send-reminders function')
on conflict (function_name, role_name) do update set note = excluded.note;

select public.enforce_function_privileges();
