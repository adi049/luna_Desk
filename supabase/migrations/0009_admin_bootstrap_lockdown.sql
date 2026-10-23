-- =============================================================================
-- 0009 — administrator bootstrap is a SQL-editor operation, not an API
--
-- rpc_promote_admin() granted the admin role to any email it was given. It was
-- never called by the app or by any script (scripts/bootstrap-admin.sql does
-- the same work inline), so the only effect of keeping it executable by
-- service_role was to provide a second, unaudited way to mint administrators:
-- anything holding the service key — a leaked key, a compromised Edge Function
-- environment, a maintenance script — could create an admin through
-- /rest/v1/rpc/rpc_promote_admin without touching the audited, validating path
-- in rpc_set_admin_active().
--
-- The function is kept because the documented first-run flow uses SQL, but it
-- is now executable by nobody over the API: the grants are removed from anon,
-- authenticated AND service_role, so only a direct SQL session as the function
-- owner (the SQL editor) can run it. It also writes an audit row, which it
-- previously did not.
-- =============================================================================

create or replace function public.rpc_promote_admin(p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_before text;
  v_after  text;
begin
  if p_email is null or position('@' in p_email) = 0 then
    raise exception 'A valid email address is required' using errcode = '22023';
  end if;

  select id into v_id from auth.users where lower(email) = lower(trim(p_email));
  if v_id is null then
    raise exception 'No auth user with email %', p_email using errcode = 'P0002';
  end if;

  select role into v_before from public.profiles where id = v_id;

  insert into public.profiles (id, full_name, email, role, is_active)
  values (v_id, split_part(p_email, '@', 1), p_email, 'admin', true)
  on conflict (id) do update set role = 'admin', is_active = true;

  insert into public.user_roles (user_id, role) values (v_id, 'admin')
  on conflict (user_id, role) do nothing;

  select role into v_after from public.profiles where id = v_id;

  insert into public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
  values (
    auth.uid(),
    coalesce(public.current_role()::text, 'sql'),
    'admin.promote',
    'profiles',
    v_id,
    jsonb_build_object('email', lower(trim(p_email)), 'role_before', v_before, 'role_after', v_after)
  );

  return v_id;
end $$;

-- Executable by nobody over the API. This includes service_role: the documented
-- bootstrap runs in the SQL editor as the owner, which does not depend on these
-- grants.
revoke all on function public.rpc_promote_admin(text) from public, anon, authenticated, service_role;

comment on function public.rpc_promote_admin(text) is
  'First-run bootstrap only. Runs as the function owner in the SQL editor; not executable over the API by any role. Use rpc_set_admin_active() for changes made from the application.';

-- ----------------------------------------------------------------------------
-- Regression guard: no other function may grant the admin role directly.
--
-- Notes on the pattern (both cost me a failed migration):
--   * Postgres caps regex repetition counts at 255 (RE_DUP_MAX), so {0,300}
--     raises "invalid repetition count(s)".
--   * POSIX character classes ([:space:]) are used instead of \s / \b, which
--     behave inconsistently under case-insensitive matching.
-- Only assignment shapes are matched: a plain comparison (where role = 'admin')
-- is how every authorisation helper reads the value and must not be flagged.
-- ----------------------------------------------------------------------------
do $$
declare
  v_offenders text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v_offenders
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname not in ('rpc_promote_admin', 'rpc_set_admin_active')
     and (
       -- An UPDATE whose SET clause assigns the role. Matching a bare
       -- `set ... role = 'admin'` also catches the harmless
       -- `SET search_path TO 'public'` prologue of every SECURITY DEFINER
       -- function, so the UPDATE keyword is required.
       pg_get_functiondef(p.oid) ~* 'update[^;]{0,200}set[^;]{0,200}role[[:space:]]*=[[:space:]]*''admin''' 
       or pg_get_functiondef(p.oid) ~* 'insert[[:space:]]+into[[:space:]]+(public\.)?(profiles|user_roles)[^;]{0,200}''admin'''
     );

  if v_offenders is not null then
    raise exception 'Functions that assign the admin role must be reviewed: %', v_offenders;
  end if;
end $$;
