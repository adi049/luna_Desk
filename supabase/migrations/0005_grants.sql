-- =============================================================================
-- LunaDesk · 0005 — privileges
--
-- Table privileges are granted to `authenticated` only; every row is then
-- filtered by RLS. `anon` gets no table access at all: the login page talks to
-- the `login-with-code` Edge Function, never to PostgREST directly.
-- =============================================================================

grant usage on schema public to anon, authenticated, service_role;

revoke all on all tables in schema public from anon;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Future migrations inherit the same shape.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;

-- Belt and braces: these objects are service-role only, whatever a later
-- migration says.
revoke all on public.client_access_codes from anon;
revoke all on public.access_attempts from anon;
