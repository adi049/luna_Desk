-- =============================================================================
-- 0012 — serialise administrator deactivation
--
-- The last-admin guard counted the remaining active administrators, but the
-- count was taken while holding a row lock on the *target* row only. Two
-- administrators deactivating each other at the same time therefore both saw
-- "one other active admin" — each other — and both proceeded:
--
--     t0  admin A: lock row B, count others = 1 (A)   -> allowed
--     t0  admin B: lock row A, count others = 1 (B)   -> allowed
--     t1  both commit                                 -> 0 active admins
--
-- The workspace is then locked out of every admin RPC, and the only way back in
-- is the SQL editor.
--
-- Fix: one transaction-scoped advisory lock at the top of the RPC, taken before
-- the target row is read. Every deactivation (and activation) in the workspace
-- is now serialised, so the count is always evaluated against committed state.
-- The lock is `pg_advisory_xact_lock`, so it is released automatically on
-- commit *or* rollback — a failed or abandoned transaction cannot wedge the
-- workspace.
--
-- The count is additionally re-checked *after* the lock is held. It has to be:
-- the point of the lock is that the number is still true when the write happens.
--
-- scripts/test-admin-concurrency.sh proves this with two real overlapping
-- sessions. Against the previous definition it leaves zero active admins; with
-- this one, the second request is refused.
-- =============================================================================

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

  -- Serialise every administrator state change in the workspace.
  --
  -- A single constant key is used rather than one per target: the invariant is
  -- global ("at least one active admin exists"), so the lock must be global
  -- too. A per-target lock is exactly what failed before.
  perform pg_advisory_xact_lock(hashtext('lunadesk.admin_state'));

  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'No such account' using errcode = 'P0002';
  end if;

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

  if v_target.is_active = p_active then
    return jsonb_build_object('ok', true, 'changed', false, 'is_active', p_active);
  end if;

  -- Re-check under the lock. The advisory lock is what makes this number
  -- trustworthy; before it, two transactions could each see the other as the
  -- surviving administrator.
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
    insert into public.user_roles (user_id, role, granted_by)
    values (p_user_id, 'admin', auth.uid())
    on conflict (user_id, role) do nothing;
  else
    delete from public.user_roles where user_id = p_user_id and role = 'admin';
  end if;

  perform public.audit(
    case when p_active then 'admin.activate' else 'admin.deactivate' end,
    'profiles', p_user_id,
    v_before,
    jsonb_build_object('is_active', p_active, 'role', v_target.role)
  );

  return jsonb_build_object('ok', true, 'changed', true, 'is_active', p_active);
end $$;

revoke all on function public.rpc_set_admin_active(uuid, boolean)
  from public, anon, authenticated, service_role;
select public.enforce_function_privileges();

-- ----------------------------------------------------------------------------
-- Self-check: the advisory lock must be the first thing the function does after
-- validation, or the guard can be raced again.
-- ----------------------------------------------------------------------------
do $$
declare v_body text;
begin
  select pg_get_functiondef('public.rpc_set_admin_active(uuid, boolean)'::regprocedure)
    into v_body;

  if position('pg_advisory_xact_lock' in v_body) = 0 then
    raise exception 'rpc_set_admin_active no longer serialises admin state changes';
  end if;

  if position('pg_advisory_xact_lock' in v_body) > position('for update' in v_body) then
    raise exception 'the advisory lock must be taken before the target row is read';
  end if;
end $$;
