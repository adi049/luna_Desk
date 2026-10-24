-- ============================================================================
-- 0014. Fixes found by attacking the fourth-round changes
--
--   1. rpc_attach_client_portal could not run any more. 0013's guard refuses
--      every role/client_id change made from an API session unless an
--      identity_change_grants row exists, and the portal-provisioning RPC
--      changes both columns. Provisioning a portal was therefore dead — the
--      same class of defect as the service-key bug in 0013 itself.
--
--   2. The guard skipped its check entirely when auth.uid() was null, which is
--      exactly the service-role / definer / cron case. "No JWT subject" was
--      being treated as "trusted". Now no writer is exempt.
--
--   3. guard_invoice_items recomputed only the NEW parent of an edited line, so
--      moving a line to another invoice left the old invoice's subtotal and
--      total stale (and printed that stale total on a receipt).
--
--   4. daily/weekly recurrence advanced with `+ interval '1 day'`, which is
--      evaluated in the *session* time zone, so a 09:00 reminder drifted by an
--      hour across a DST change in the user's zone.
--
-- Design note on (1) and (2): an identity change is authorised by one of three
-- signals, never by the absence of one.
--
--   * a one-shot public.identity_change_grants row (owner-written, 2-min TTL);
--   * the transaction-local marker set by a privileged RPC that has already
--     run assert_admin() (or, for owner-only functions, was only reachable
--     from the SQL editor);
--   * nothing else.
--
-- The marker is a GUC set with is_local := true inside a SECURITY DEFINER
-- function. A browser session cannot set an arbitrary GUC: PostgREST exposes
-- functions, not `set_config`, and no granted function takes the marker's value
-- from a caller-controlled argument.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A0. An authorisation now names the profile it applies to.
--
--     0013's grant was global: any owner-written grant authorised the next
--     identity change on *any* row. That made a lingering grant (TTL 2 minutes)
--     a standing authorisation for an unrelated update, and it made batched
--     fixtures awkward. A grant is now bound to one profile and consumed by the
--     change it was written for.
-- ---------------------------------------------------------------------------
alter table public.identity_change_grants
  add column if not exists profile_id uuid;

comment on column public.identity_change_grants.profile_id is
  'The profile this one-shot authorisation applies to. NULL rows (written by nothing in this repository) authorise nothing.';

-- ---------------------------------------------------------------------------
-- A. The guard, rewritten. Every writer is checked; the reason is recorded.
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_identity_changed boolean :=
    new.role is distinct from old.role or new.client_id is distinct from old.client_id;
  v_marker text := nullif(current_setting('lunadesk.identity_change', true), '');
  v_grant  public.identity_change_grants%rowtype;
  v_actor  uuid := auth.uid();
  v_source text;
  v_reason text;
begin
  -- Invariants that hold for every writer, including service role and SQL.
  if new.client_id is not null then
    if new.role <> 'client' then
      raise exception
        'A client-linked profile must have role ''client'' (got role % for client %)',
        new.role, new.client_id
        using errcode = '23514';
    end if;
    if not exists (select 1 from public.clients c where c.id = new.client_id) then
      raise exception 'Client % does not exist; refusing to link a profile to it', new.client_id
        using errcode = '23503';
    end if;
  end if;

  -- Not an identity change: keep the existing activation rule and stop.
  if not v_identity_changed then
    if new.is_active is distinct from old.is_active
       and v_actor is not null
       and not public.is_admin() then
      raise exception 'Only an administrator can change activation' using errcode = '42501';
    end if;
    return new;
  end if;

  -- ---- An identity change. It needs an explicit authorisation. ----
  if v_marker is not null then
    -- Set by a privileged function after it verified the caller.
    v_source := 'rpc';
    v_reason := v_marker;
  else
    select * into v_grant
      from public.identity_change_grants g
     where g.profile_id = new.id
       and g.expires_at > now()
     order by g.created_at desc
     limit 1;
    if not found then
      -- No marker, no grant: refuse. Note that this branch now also covers
      -- auth.uid() is null — the service role, a cron job, a stray definer —
      -- so "no JWT subject" can no longer mean "trusted".
      raise exception
        'Changing a profile role or client link requires an authorisation: call the sanctioned RPC (rpc_attach_client_portal / rpc_set_profile_identity) or, from the SQL editor, call rpc_authorise_identity_change() first.'
        using errcode = '42501';
    end if;

    -- A grant authorises *a* statement, not *anyone's* statement: a grant that
    -- happens to be open must not let a signed-in customer escalate. Only an
    -- administrator (or an owner/system session with no JWT subject, which is
    -- the SQL editor and the service key) may use it.
    if v_actor is not null and not public.is_admin() then
      raise exception 'Only an administrator can change a profile role or client link'
        using errcode = '42501';
    end if;

    v_source := 'grant';
    v_reason := coalesce(v_grant.reason, 'owner grant');
  end if;

  -- One authorisation, one statement: the marker and the matching grant are
  -- consumed. Grants for other profiles are left alone.
  perform set_config('lunadesk.identity_change', '', true);
  delete from public.identity_change_grants where profile_id = new.id;

  -- Always audited, whoever the caller is.
  insert into public.audit_logs (actor_id, actor_label, action, entity, entity_id, before, after)
  values (
    v_actor,
    case when v_actor is null then 'system' else 'user' end,
    'profile.identity.change',
    'profiles',
    new.id,
    jsonb_build_object('role', old.role, 'client_id', old.client_id),
    jsonb_build_object(
      'role', new.role,
      'client_id', new.client_id,
      'authorised_by', v_source,
      'reason', v_reason
    )
  );

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- B. The sanctioned portal path, fixed and hardened.
--
--    It still proves the caller is an admin, then marks its own identity write
--    as authorised. It also now refuses two things it used to do silently:
--      * turning an administrator into a portal user;
--      * moving a user from one client to another (that is a reassignment, and
--        it goes through rpc_set_profile_identity with a written reason).
-- ---------------------------------------------------------------------------
create or replace function public.rpc_attach_client_portal(
  p_client_id uuid,
  p_user_id   uuid,
  p_code      text,
  p_label     text default 'Portal access'
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_code_id uuid;
  v_profile public.profiles%rowtype;
begin
  perform public.assert_admin();

  if p_code !~ '^[A-Z0-9]{5,20}$' then
    raise exception 'Access codes must be 5–20 upper-case letters/digits' using errcode = '22023';
  end if;

  if not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'Client % does not exist', p_client_id using errcode = '23503';
  end if;

  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'Profile % does not exist', p_user_id using errcode = '23503';
  end if;

  -- An administrator is never converted into a portal user by a provisioning
  -- call. Demoting an admin is a deliberate, separately audited operation.
  if v_profile.role = 'admin' then
    raise exception
      'User % is an administrator; refusing to turn it into a client portal identity',
      p_user_id
      using errcode = '42501';
  end if;

  -- A user already attached to a *different* client is being reassigned, not
  -- provisioned. That is a cross-tenant move and needs the audited identity
  -- path with a written reason.
  if v_profile.client_id is not null and v_profile.client_id <> p_client_id then
    raise exception
      'User % already belongs to client %; move it with rpc_set_profile_identity(..., ''reason'') instead of provisioning it again',
      p_user_id, v_profile.client_id
      using errcode = '42501';
  end if;

  -- One active portal identity per client.
  update public.client_access_codes
     set is_revoked = true, rotated_at = now()
   where client_id = p_client_id and not is_revoked;

  insert into public.client_access_codes (client_id, user_id, label, code_hash, created_by)
  values (p_client_id, p_user_id, coalesce(p_label, 'Portal access'),
          crypt(p_code, gen_salt('bf', 10)), auth.uid())
  returning id into v_code_id;

  -- Authorise exactly this one identity write, for exactly this transaction.
  -- The guard consumes the marker and audits the change.
  perform set_config('lunadesk.identity_change',
    format('portal provisioning (%s)', coalesce(p_label, 'Portal access')), true);

  update public.profiles
     set role = 'client', client_id = p_client_id, is_active = true
   where id = p_user_id;

  update public.clients
     set portal_status = 'active', status = case when status = 'archived' then status else 'active' end
   where id = p_client_id;

  perform public.audit('portal.access.create', 'clients', p_client_id, null,
                       jsonb_build_object('user_id', p_user_id, 'code_id', v_code_id));
  return v_code_id;
end $$;

-- Same signature and grants as before.
revoke all on function public.rpc_attach_client_portal(uuid, uuid, text, text) from public, anon;
grant execute on function public.rpc_attach_client_portal(uuid, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- B2. The SQL-editor authorisation helper.
--
--     The guard refuses identity changes from every writer that has no
--     authorisation, including the owner typing into the SQL editor. This is
--     how an operator (or a bootstrap script, or a test fixture) authorises the
--     next statement: one grant, one statement, two minutes. Owner-only —
--     revoked from every API role below, and closed by the privilege policy.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_authorise_identity_change(
  p_profile_id uuid,
  p_reason     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_profile_id is null then
    raise exception 'An identity authorisation needs the profile it applies to'
      using errcode = '22023';
  end if;
  if p_reason is null or length(trim(p_reason)) < 8 then
    raise exception 'An identity change needs a written reason of at least 8 characters'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_profile_id) then
    raise exception 'Profile % does not exist', p_profile_id using errcode = '23503';
  end if;

  -- Replace rather than accumulate: at most one open authorisation per profile.
  delete from public.identity_change_grants where profile_id = p_profile_id;

  insert into public.identity_change_grants (profile_id, actor, reason, expires_at)
  values (p_profile_id, auth.uid(), trim(p_reason), now() + interval '2 minutes');
end $$;

revoke all on function public.rpc_authorise_identity_change(uuid, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- C. rpc_set_profile_identity marks its own write as authorised (it is already
--    owner-only and audited), and rpc_promote_admin does the same for the
--    bootstrap path. rpc_promote_admin is taken away from service_role: an
--    identity change must not be reachable with a key that carries no user.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_set_profile_identity(
  p_user_id   uuid,
  p_role      app_role,
  p_client_id uuid default null,
  p_reason    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_changed boolean := false;
  v_admins  integer;
begin
  if p_reason is null or length(trim(p_reason)) < 8 then
    raise exception 'An identity change needs a written reason of at least 8 characters'
      using errcode = '22023';
  end if;

  if p_role = 'client' and p_client_id is null then
    raise exception 'A client profile must be linked to a client' using errcode = '22023';
  end if;
  if p_role = 'admin' and p_client_id is not null then
    raise exception 'An administrator cannot be linked to a client portal' using errcode = '22023';
  end if;

  -- Lock order matters, and it must match rpc_set_admin_active() (0012).
  --
  -- The advisory lock is taken FIRST, then the row. Taking the row lock first
  -- let two transactions hold a row each and queue on the advisory lock in
  -- opposite orders: each then read the other administrator as "still active"
  -- before its own commit, and both proceeded — the workspace could end up
  -- with no administrator at all. A single constant key is used because the
  -- invariant ("at least one active admin exists") is global, not per row.
  perform pg_advisory_xact_lock(hashtext('lunadesk.admin_state'));

  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'Profile % does not exist', p_user_id using errcode = '23503';
  end if;

  -- Re-checked under the lock, against the freshly read row: an administrator
  -- may have been deactivated or promoted since this transaction started.
  if v_profile.role = 'admin' and p_role <> 'admin' then
    if not v_profile.is_active then
      -- Demoting an already-inactive admin cannot remove the last active one.
      null;
    else
      select count(*) into v_admins
        from public.profiles
       where role = 'admin' and is_active and id <> p_user_id;
      if v_admins = 0 then
        raise exception 'Refusing to remove the last active administrator'
          using errcode = '42501';
      end if;
    end if;
  end if;

  if v_profile.role is distinct from p_role or v_profile.client_id is distinct from p_client_id then
    v_changed := true;
    perform set_config('lunadesk.identity_change', format('rpc_set_profile_identity: %s', p_reason), true);

    update public.profiles
       set role = p_role,
           client_id = p_client_id,
           is_active = true
     where id = p_user_id;
  end if;

  delete from public.user_roles where user_id = p_user_id and role <> p_role;
  insert into public.user_roles (user_id, role) values (p_user_id, p_role)
  on conflict (user_id, role) do nothing;

  return jsonb_build_object(
    'ok', true,
    'changed', v_changed,
    'role', p_role,
    'client_id', p_client_id
  );
end $$;

-- Owner-only. Both grants are restated so a future `grant all` cannot quietly
-- reopen the API path.
revoke all on function public.rpc_set_profile_identity(uuid, app_role, uuid, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- D. Bootstrap promotion: authorised, owner-only, and audited like everything
--    else that touches a role.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_promote_admin(p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_email is null or position('@' in p_email) = 0 then
    raise exception 'A valid email address is required' using errcode = '22023';
  end if;

  select id into v_id from auth.users where lower(email) = lower(trim(p_email));
  if v_id is null then
    raise exception 'No auth user with email %', p_email using errcode = 'P0002';
  end if;

  -- The profile row is normally created by the handle_new_user trigger. If the
  -- auth user predates it, create it here; either way the *role* change below
  -- goes through the same audited, authorised path as every other identity
  -- change, so this function cannot smuggle in a promotion the guard never saw.
  insert into public.profiles (id, full_name, email, is_active)
  values (v_id, split_part(p_email, '@', 1), lower(trim(p_email)), true)
  on conflict (id) do nothing;

  perform public.rpc_set_profile_identity(
    v_id, 'admin', null, format('bootstrap promotion for %s', lower(trim(p_email))));

  return v_id;
end $$;

-- (0009 wrote its audit row with column names that do not exist on
-- audit_logs — actor_role/target_table/target_id/details — so the function
-- raised at runtime. The audit row is now written by rpc_set_profile_identity,
-- which uses the real columns.)
revoke all on function public.rpc_promote_admin(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- E. Line items: a move between invoices is refused, and both parents are
--    recomputed, so no ordering of edits can leave a stale total behind.
-- ---------------------------------------------------------------------------
create or replace function public.guard_invoice_items()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_invoice uuid := case when tg_op = 'INSERT' then null else old.invoice_id end;
  v_new_invoice uuid := case when tg_op = 'DELETE' then null else new.invoice_id end;
  v_parent      uuid;
begin
  -- A line belongs to the invoice it was created on. Moving it would rewrite
  -- two documents at once, and 0013's freeze would then either block it halfway
  -- through or leave the old invoice's total describing items it no longer has.
  if v_old_invoice is not null and v_new_invoice is not null
     and v_old_invoice <> v_new_invoice then
    raise exception
      'Invoice line items cannot be moved between invoices (from % to %); delete the line and add a new one',
      v_old_invoice, v_new_invoice
      using errcode = '0A000';
  end if;

  -- Recompute both sides, oldest-first, so two concurrent edits cannot deadlock
  -- by locking the same pair of invoices in opposite orders.
  for v_parent in
    select distinct id
      from unnest(array[v_old_invoice, v_new_invoice]) as id
     where id is not null
     order by id
  loop
    perform public.recompute_invoice_totals(v_parent, true);
  end loop;

  return null;
end $$;

-- The shared recomputation, so the trigger and any repair script agree.
create or replace function public.recompute_invoice_totals(
  p_invoice_id uuid,
  p_enforce_freeze boolean default true
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paid     bigint;
  v_receipt  boolean;
  v_sum      bigint;
  v_disc     bigint;
  v_tax      bigint;
  v_total    bigint;
begin
  -- Lock the parent so a concurrent payment cannot slip in between the check
  -- and the recomputation.
  select discount_minor, tax_minor into v_disc, v_tax
    from public.invoices where id = p_invoice_id for update;
  if not found then
    return;
  end if;

  select coalesce(sum(amount_minor), 0) into v_paid
    from public.payments where invoice_id = p_invoice_id and voided_at is null;

  v_receipt := exists (select 1 from public.receipts where invoice_id = p_invoice_id);

  if p_enforce_freeze and (v_paid > 0 or v_receipt) then
    raise exception
      'Invoice % already has payments or a receipt; its line items can no longer change.',
      p_invoice_id
      using errcode = 'P0001';
  end if;

  select coalesce(sum(amount_minor), 0) into v_sum
    from public.invoice_items where invoice_id = p_invoice_id;

  v_total := v_sum - coalesce(v_disc, 0) + coalesce(v_tax, 0);
  if v_total < 0 then
    raise exception 'Invoice % would have a negative total (%)', p_invoice_id, v_total
      using errcode = '22023';
  end if;

  update public.invoices
     set subtotal_minor = v_sum,
         total_minor    = v_total
   where id = p_invoice_id
     and (subtotal_minor <> v_sum or total_minor <> v_total);
end $$;

revoke all on function public.recompute_invoice_totals(uuid, boolean)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- G. Recurrence that survives a DST change.
--
--    `p_from + interval '1 day'` is evaluated in the *session* time zone, not
--    the reminder's. A 09:00 reminder in America/New_York therefore moved to
--    10:00 after the spring change (and 08:00 after the autumn one), because the
--    arithmetic happened on a UTC wall clock. Daily and weekly now step the wall
--    clock in the reminder's own zone, like monthly and yearly already did.
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
declare
  v_tz text := case
    when p_tz is null or not exists (select 1 from pg_timezone_names where name = p_tz)
      then 'Asia/Kolkata'
    else p_tz
  end;
  v_local timestamp;
begin
  if p_repeat = 'none' then
    return p_from;
  end if;

  -- Step the wall clock, then resolve it back to an instant in that zone.
  -- Ambiguous and skipped wall times (the DST edges) are resolved by Postgres:
  -- a skipped 02:30 lands on 03:30, which is the behaviour a user expects from
  -- a reminder that said "daily at 02:30".
  v_local := (p_from at time zone v_tz)
             + case p_repeat
                 when 'daily'   then interval '1 day'
                 when 'weekly'  then interval '7 days'
                 when 'monthly' then interval '1 month'
                 when 'yearly'  then interval '1 year'
               end;

  return v_local at time zone v_tz;
end $$;

revoke all on function public.next_occurrence_tz(timestamptz, reminder_repeat, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- E2. Self-check: the lock order in rpc_set_profile_identity must match
--     rpc_set_admin_active(). Row-then-advisory is the interleaving that lets
--     two transactions each believe the other administrator survives.
-- ---------------------------------------------------------------------------
do $$
declare v_body text;
begin
  select pg_get_functiondef('public.rpc_set_profile_identity(uuid, app_role, uuid, text)'::regprocedure)
    into v_body;

  if position('pg_advisory_xact_lock' in v_body) = 0 then
    raise exception 'rpc_set_profile_identity no longer serialises admin state changes';
  end if;

  if position('pg_advisory_xact_lock' in v_body) > position('for update' in v_body) then
    raise exception 'rpc_set_profile_identity must take the advisory lock before the profile row';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- F. Re-apply the privilege policy, so the two new/rewritten helper functions
--    above cannot be called from the API.
-- ---------------------------------------------------------------------------
select public.enforce_function_privileges();
