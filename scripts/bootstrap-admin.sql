-- =============================================================================
-- LunaDesk — first-run bootstrap
--
-- Run this ONCE, in the Supabase SQL editor, with your own values. It is never
-- executed by the app and is never needed by the browser.
--
--   1. Create the admin account in Authentication → Users → "Add user"
--      (email + strong password, "Auto confirm user" ticked).
--   2. Fill in the two values below and run the script.
--   3. Sign in at /#/login with the code + password.
--   4. Delete or rotate the lookup code afterwards from
--      Settings → Account & Security (or run rpc_set_admin_code again).
--
-- Replace the placeholders. Nothing here is a default credential.
-- =============================================================================

do $$
declare
  v_admin_email text := 'owner@managedbyluna.com';  -- ← the email you created
  v_admin_code  text := 'ADI000';                   -- ← change this to your own
  v_user_id     uuid;
begin
  select id into v_user_id from auth.users where lower(email) = lower(v_admin_email);

  if v_user_id is null then
    raise exception
      'No auth user with email %. Create it in Authentication → Users first.', v_admin_email;
  end if;

  -- 1. Role
  insert into public.profiles (id, full_name, email, role, is_active)
  values (v_user_id, 'Workspace admin', v_admin_email, 'admin', true)
  on conflict (id) do update set role = 'admin', is_active = true;

  insert into public.user_roles (user_id, role)
  values (v_user_id, 'admin')
  on conflict (user_id, role) do nothing;

  -- 2. Lookup code. The code identifies the account; the password (or magic
  --    link / MFA) is still required to sign in.
  -- pgcrypto lives in the `extensions` schema on Supabase, so it is referenced
  -- explicitly rather than relying on the session search_path.
  insert into public.admin_access_codes (user_id, label, code_hash)
  values (v_user_id, 'Workspace admin',
          extensions.crypt(v_admin_code, extensions.gen_salt('bf', 10)));

  -- 3. Branding defaults are already seeded by migration 0001; adjust them in
  --    Settings → Branding. No company details are invented here.
  raise notice 'Admin ready: % (code %)', v_admin_email, v_admin_code;
end $$;

-- Optional: bind a portal code to a client account (after creating that
-- client's auth user via the admin-clients Edge Function or the Clients page):
--
--   select public.rpc_attach_client_portal('<client_id>', '<auth_user_id>', 'PR103');
