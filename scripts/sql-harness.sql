-- Local harness: emulates the parts of a Supabase database that the LunaDesk
-- migrations rely on (auth schema, roles, auth.uid()). Used by
-- `scripts/verify-migrations.sh`; never run against a real project.
create schema if not exists auth;
create schema if not exists extensions;
-- Supabase installs pgcrypto into the `extensions` schema; mirror that so the
-- migrations' explicit `extensions.crypt(...)` calls resolve the same way here.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create or replace function auth.uid() returns uuid
language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
