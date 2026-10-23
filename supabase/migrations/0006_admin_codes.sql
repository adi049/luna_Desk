-- =============================================================================
-- LunaDesk · 0006 — administrator lookup codes
--
-- The access code is NOT an admin credential. It only *identifies* which staff
-- account is being claimed; a password (or magic link / MFA) is still required.
-- `ADI000` on its own therefore never produces a session.
--
-- Codes are stored as bcrypt hashes, are revocable, and are rate limited by the
-- same access_attempts ledger used for client codes.
-- =============================================================================

create table if not exists public.admin_access_codes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  label        text not null default 'Workspace admin',
  code_hash    text not null,
  is_revoked   boolean not null default false,
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists admin_codes_active_idx on public.admin_access_codes (user_id) where not is_revoked;

alter table public.admin_access_codes enable row level security;

drop policy if exists "admin_codes: admin" on public.admin_access_codes;
create policy "admin_codes: admin" on public.admin_access_codes
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Service-role only: called by the access-code-login Edge Function.
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
  v_row    public.admin_access_codes%rowtype;
  v_email  text;
  v_hint   text := 'ADI';
  v_recent integer;
begin
  select count(*) into v_recent
  from public.access_attempts
  where created_at > now() - interval '10 minutes'
    and code_hint = v_hint
    and outcome in ('bad_code', 'admin_lookup');

  if v_recent >= 10 then
    insert into public.access_attempts (code_hint, ip, user_agent, outcome)
    values (v_hint, p_ip, p_user_agent, 'rate_limited');
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  select * into v_row
  from public.admin_access_codes
  where code_hash = crypt(upper(trim(coalesce(p_code, ''))), code_hash)
    and not is_revoked
  limit 1;

  if not found then
    insert into public.access_attempts (code_hint, ip, user_agent, outcome)
    values (v_hint, p_ip, p_user_agent, 'bad_code');
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  select email into v_email from auth.users where id = v_row.user_id;
  if v_email is null then
    insert into public.access_attempts (code_hint, ip, user_agent, outcome)
    values (v_hint, p_ip, p_user_agent, 'bad_code');
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  update public.admin_access_codes set last_used_at = now() where id = v_row.id;
  insert into public.access_attempts (code_hint, ip, user_agent, outcome)
  values (v_hint, p_ip, p_user_agent, 'admin_lookup');

  -- Only the identity is returned. Authentication still requires the password.
  return jsonb_build_object('ok', true, 'email', v_email, 'label', v_row.label);
end $$;

revoke all on function public.rpc_lookup_admin_code(text, inet, text) from public, anon, authenticated;
grant execute on function public.rpc_lookup_admin_code(text, inet, text) to service_role;

-- Admin helper: bind (or rebind) a lookup code to a staff account.
create or replace function public.rpc_set_admin_code(p_email text, p_code text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid;
  v_id   uuid;
begin
  perform public.assert_admin();
  if p_code !~ '^[A-Z0-9]{5,20}$' then
    raise exception 'Access codes must be 5–20 upper-case letters/digits' using errcode = '22023';
  end if;

  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'No auth user with email %', p_email;
  end if;

  update public.admin_access_codes set is_revoked = true where user_id = v_user and not is_revoked;

  insert into public.admin_access_codes (user_id, code_hash)
  values (v_user, crypt(p_code, gen_salt('bf', 10)))
  returning id into v_id;

  perform public.audit('admin.code.set', 'admin_access_codes', v_id, null,
                       jsonb_build_object('email', p_email));
  return v_id;
end $$;

grant execute on function public.rpc_set_admin_code(text, text) to authenticated;
