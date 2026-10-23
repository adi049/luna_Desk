-- =============================================================================
-- LunaDesk — first-run bootstrap
--
-- Run this ONCE, in the Supabase SQL editor, with your own values. It is never
-- executed by the app and is never needed by the browser.
--
--   1. Create the admin account in Authentication → Users → "Add user"
--      (email + strong password, "Auto confirm user" ticked).
--   2. Replace the two placeholders below with that email and a lookup code of
--      your own choosing (5–20 letters or digits).
--   3. Run the script. If you forget step 2 it refuses to run.
--   4. Sign in at /#/login with the code + password, then rotate the lookup
--      code from Settings → Account & Security.
--
-- The placeholders are deliberately invalid so the script cannot be run by
-- accident, and the script deliberately never prints the code: SQL editor
-- output is often kept in screenshots, tickets and transcripts, and a lookup
-- code is half of the admin credential.
-- =============================================================================

do $$
declare
  -- ↓↓↓ REPLACE BOTH PLACEHOLDERS ↓↓↓
  v_admin_email text := 'REPLACE-WITH-THE-ADMIN-EMAIL';
  v_admin_code  text := 'REPLACE-WITH-YOUR-OWN-CODE';
  -- ↑↑↑ REPLACE BOTH PLACEHOLDERS ↑↑↑

  -- Built by concatenation on purpose: a global find-and-replace over this file
  -- rewrites the two assignments above but cannot produce this expression, so
  -- the sentinel still matches an untouched run and never matches an edited
  -- one. Hard-coding the literal here would make the check fire on a correctly
  -- edited file.
  v_placeholder_email constant text := 'REPLACE' || '-WITH-THE-ADMIN-EMAIL';
  v_placeholder_code  constant text := 'REPLACE' || '-WITH-YOUR-OWN-CODE';
  v_user_id   uuid;
  v_duplicate integer;
begin
  ---------------------------------------------------------------------------
  -- 0. Refuse to run with the placeholders still in place.
  ---------------------------------------------------------------------------
  if v_admin_email = v_placeholder_email or v_admin_code = v_placeholder_code then
    raise exception
      'Bootstrap aborted: the placeholder values are still in place. Edit v_admin_email and v_admin_code first.'
      using errcode = 'P0001';
  end if;

  if position('@' in v_admin_email) = 0
     or v_admin_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Bootstrap aborted: % is not a valid email address.', v_admin_email
      using errcode = '22023';
  end if;

  if v_admin_code !~ '^[A-Z0-9]{5,20}$' then
    raise exception
      'Bootstrap aborted: the access code must be 5–20 upper-case letters or digits (got % characters).',
      length(v_admin_code)
      using errcode = '22023';
  end if;

  ---------------------------------------------------------------------------
  -- 1. The auth user must already exist.
  ---------------------------------------------------------------------------
  select id into v_user_id from auth.users where lower(email) = lower(v_admin_email);

  if v_user_id is null then
    raise exception
      'Bootstrap aborted: no auth user with email %. Create it in Authentication → Users first, then re-run.',
      v_admin_email
      using errcode = 'P0002';
  end if;

  ---------------------------------------------------------------------------
  -- 2. Role, through both authorisation paths.
  --
  --    profiles.role is what the UI reads; user_roles is the second path
  --    is_admin() honours. Writing both means deactivation has to clear both,
  --    which rpc_set_admin_active() does.
  ---------------------------------------------------------------------------
  insert into public.profiles (id, full_name, email, role, is_active)
  values (v_user_id, 'Workspace admin', v_admin_email, 'admin', true)
  on conflict (id) do update set role = 'admin', is_active = true, email = excluded.email;

  insert into public.user_roles (user_id, role)
  values (v_user_id, 'admin')
  on conflict (user_id, role) do nothing;

  ---------------------------------------------------------------------------
  -- 3. Lookup code.
  --
  --    One live code per account: a second bootstrap run would otherwise leave
  --    two working codes and no record of which is current. Existing unused
  --    codes for this account are revoked first.
  ---------------------------------------------------------------------------
  update public.admin_access_codes
     set is_revoked = true
   where user_id = v_user_id and not is_revoked;

  -- pgcrypto lives in the `extensions` schema on Supabase, so it is referenced
  -- explicitly rather than relying on the session search_path.
  insert into public.admin_access_codes (user_id, label, code_hash)
  values (v_user_id, 'Workspace admin',
          extensions.crypt(v_admin_code, extensions.gen_salt('bf', 10)));

  ---------------------------------------------------------------------------
  -- 4. Audit the bootstrap, so a later "who made this account an admin?"
  --    question has an answer.
  ---------------------------------------------------------------------------
  insert into public.audit_logs (actor_id, actor_label, action, entity, entity_id, after)
  values (null, 'bootstrap-sql', 'admin.bootstrap', 'profiles', v_user_id,
          jsonb_build_object('email', lower(v_admin_email), 'code_rotated', true));

  ---------------------------------------------------------------------------
  -- 5. Report success WITHOUT the code.
  ---------------------------------------------------------------------------
  raise notice
    'Admin ready: % (lookup code set; it is deliberately not printed — retrieve it from where you stored it).',
    v_admin_email;

  -- Guard against the common mistake of running this twice by accident.
  select count(*) into v_duplicate
    from public.admin_access_codes
   where user_id = v_user_id and not is_revoked;
  if v_duplicate <> 1 then
    raise exception 'Bootstrap finished with % live codes for this account; expected exactly one.',
      v_duplicate;
  end if;

  -- 6. Branding defaults are already seeded by migration 0001; adjust them in
  --    Settings → Branding. No company details are invented here.
end $$;

-- Optional: bind a portal code to a client account (after creating that
-- client's auth user via the admin-clients Edge Function or the Clients page):
--
--   select public.rpc_attach_client_portal('<client_id>', '<auth_user_id>', 'YOUR-CODE');
