-- =============================================================================
-- 0010 — function privileges
--
-- Every function created without an explicit REVOKE inherits PostgreSQL's
-- built-in default: EXECUTE to PUBLIC. That includes the unauthenticated `anon`
-- role, because `anon` is a member of PUBLIC like every other role. Before this
-- migration the following were callable by anyone holding the publishable key,
-- with no session at all:
--
--   * public.next_document_number(text)   — SECURITY DEFINER; advanced the
--     document_sequences row, so an anonymous caller could burn receipt and
--     invoice numbers. Numbering gaps in financial documents are not cosmetic.
--   * public.sync_invoice_status(uuid)    — SECURITY DEFINER; rewrote
--     invoices.status.
--   * public.audit(...)                   — SECURITY DEFINER; appended to
--     audit_logs, i.e. anyone could forge or pollute the audit trail.
--   * public.derive_invoice_status(uuid)  — disclosed an invoice's status for
--     an arbitrary id.
--   * public.assert_admin()               — an internal guard, exposed needlessly.
--
-- Verified before the fix (as `anon`, no JWT):
--     select public.next_document_number('LD-RCP-');  ->  LD-RCP--2026-0001
--
-- The fix is an explicit allowlist, applied by enforce_function_privileges().
-- That function is itself the repeatable policy: it strips every grant from
-- every ordinary function in `public` and re-grants only what the allowlist
-- names, so a future migration that forgets to think about privileges fails
-- closed instead of silently re-opening the same hole.
--
-- Two things deliberately do NOT change:
--
--   * Trigger functions stay working. PostgreSQL invokes trigger functions
--     through the trigger machinery and does not perform an EXECUTE privilege
--     check, so revoking them changes nothing for the trigger while closing
--     direct calls.
--   * Internal calls stay working. Every rpc_* is SECURITY DEFINER and owned by
--     the migration role, so `perform public.next_document_number(...)` inside
--     it is checked against the *owner*, not the caller.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The same policy for functions nobody has written yet.
--
-- ALTER DEFAULT PRIVILEGES applies to objects created later by the role that
-- runs this statement — the migration role, which is also the role that creates
-- every future function in this project. Revoking from PUBLIC is the one that
-- matters: PUBLIC is implicit and includes anon.
-- ---------------------------------------------------------------------------
-- Note on the spelling: `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ...`
-- quietly records nothing here (PostgreSQL derives a per-schema entry from the
-- global one, and revoking the implicit PUBLIC grant through that path left no
-- entry at all — verified: a new function still came out world-executable).
-- The global form does record the entry, so it is used and the one schema that
-- genuinely needs PUBLIC execute is restored explicitly below.
alter default privileges revoke execute on functions from public;
alter default privileges revoke execute on functions from anon;

-- auth.uid() and friends are called from RLS policies as the *invoking* role,
-- so helper functions in the `auth` schema must keep PUBLIC execute. This is a
-- per-schema override of the global rule above, and it only affects functions
-- created later in that schema. (Harness and Supabase both create theirs before
-- this migration runs, so they are unaffected either way.)
alter default privileges in schema auth grant execute on functions to public;

-- ---------------------------------------------------------------------------
-- 2. The allowlist, as data.
--
--    Keeping the policy in a table rather than inside the function body means a
--    later migration adds one row and re-runs enforce_function_privileges() —
--    no copy of the previous list to keep in sync, and no chance of the new
--    definition silently dropping a grant the app depends on.
-- ---------------------------------------------------------------------------
create table if not exists public.function_privilege_policy (
  function_name text not null,
  role_name     text not null check (role_name in ('anon', 'authenticated', 'service_role')),
  note          text,
  primary key (function_name, role_name)
);

alter table public.function_privilege_policy enable row level security;
revoke all on public.function_privilege_policy from public, anon, authenticated;
-- Readable by the owner (which is what runs enforce_function_privileges) only.

insert into public.function_privilege_policy (function_name, role_name, note) values
  -- Authorisation helpers referenced by RLS policies. RLS expressions are
  -- evaluated as the querying role, so these genuinely need the grant.
  ('is_admin',                      'authenticated', 'used by RLS policies'),
  ('current_client_id',             'authenticated', 'used by RLS policies'),
  ('is_client_of',                  'authenticated', 'used by RLS policies'),
  -- Financial operations. Admin-only, authorised inside the function.
  ('rpc_record_payment',            'authenticated', 'admin-only, checked internally'),
  ('rpc_void_payment',              'authenticated', 'admin-only, checked internally'),
  ('rpc_issue_receipt',             'authenticated', 'admin-only, checked internally'),
  ('rpc_refresh_invoice_status',    'authenticated', 'admin-only, checked internally'),
  -- Client portal administration.
  ('rpc_attach_client_portal',      'authenticated', 'admin-only, checked internally'),
  ('rpc_change_client_access_code', 'authenticated', 'admin-only, checked internally'),
  ('rpc_revoke_client_access',      'authenticated', 'admin-only, checked internally'),
  ('rpc_reactivate_client_portal',  'authenticated', 'admin-only, checked internally'),
  -- Account administration.
  ('rpc_set_admin_active',          'authenticated', 'admin-only, checked internally'),
  ('rpc_set_admin_code',            'authenticated', 'admin-only, checked internally'),
  ('rpc_set_client_code_expiry',    'authenticated', 'admin-only, checked internally'),
  -- Trusted backend only (Edge Functions / scheduler). Never the browser.
  ('rpc_redeem_access_code',        'service_role',  'access-code-login function'),
  ('rpc_lookup_admin_code',         'service_role',  'access-code-login function'),
  ('rpc_claim_reminder',            'service_role',  'send-reminders function'),
  ('rpc_prune_reminder_deliveries', 'service_role',  'send-reminders function')
on conflict (function_name, role_name) do update set note = excluded.note;

-- The trusted backend is a superset of the browser surface: Edge Functions run
-- admin operations through the service client.
insert into public.function_privilege_policy (function_name, role_name, note)
select p.function_name, 'service_role', 'backend superset'
  from public.function_privilege_policy p
 where p.role_name = 'authenticated'
on conflict (function_name, role_name) do nothing;

create or replace function public.enforce_function_privileges()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  r record;
  v_revoked integer := 0;
  v_granted integer := 0;
begin
  -- 2a. Strip every grant from every ordinary function in public. Functions
  --     installed by an extension (pg_trgm) are skipped: they are not ours to
  --     manage and revoking them can break the index operators that use them.
  for r in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format(
      'revoke all on function public.%I(%s) from public, anon, authenticated, service_role',
      r.proname, r.args
    );
    v_revoked := v_revoked + 1;
  end loop;

  -- 2b. Re-grant exactly what the policy table names. Signatures are resolved
  --     from the catalogue rather than hard-coded, so adding a parameter to an
  --     RPC cannot leave the old signature granted and the new one closed.
  for r in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args, pol.role_name
      from public.function_privilege_policy pol
      join pg_proc p on p.proname = pol.function_name
      join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
     where p.prokind = 'f'
  loop
    execute format('grant execute on function public.%I(%s) to %I', r.proname, r.args, r.role_name);
    v_granted := v_granted + 1;
  end loop;

  return jsonb_build_object('revoked', v_revoked, 'granted', v_granted);
end $$;

-- The policy function itself is owner-only: it must not become a way for
-- anyone to re-grant privileges.
revoke all on function public.enforce_function_privileges() from public, anon, authenticated, service_role;

select public.enforce_function_privileges();

-- ---------------------------------------------------------------------------
-- 3. Fail the migration if the matrix is not what the policy claims.
--
-- Deliberately independent of the policy table: it hard-codes what each role
-- must be able to call, so a mistaken row in the table is caught here instead
-- of being "verified" against itself.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  with expected(name, role_name, allowed) as (
    select * from (values
      ('is_admin',                            'authenticated', true),
      ('is_admin',                            'anon',          false),
      ('current_client_id',                   'authenticated', true),
      ('is_client_of',                        'authenticated', true),
      ('rpc_record_payment',                  'authenticated', true),
      ('rpc_record_payment',                  'anon',          false),
      ('rpc_void_payment',                    'authenticated', true),
      ('rpc_issue_receipt',                   'authenticated', true),
      ('rpc_refresh_invoice_status',          'authenticated', true),
      ('rpc_attach_client_portal',            'authenticated', true),
      ('rpc_change_client_access_code',       'authenticated', true),
      ('rpc_revoke_client_access',            'authenticated', true),
      ('rpc_reactivate_client_portal',        'authenticated', true),
      ('rpc_set_admin_active',                'authenticated', true),
      ('rpc_set_admin_code',                  'authenticated', true),
      ('rpc_set_client_code_expiry',          'authenticated', true),
      ('rpc_redeem_access_code',              'authenticated', false),
      ('rpc_redeem_access_code',              'service_role',  true),
      ('rpc_lookup_admin_code',               'authenticated', false),
      ('rpc_lookup_admin_code',               'service_role',  true),
      ('rpc_claim_reminder',                  'service_role',  true),
      -- the four that were previously open to the world
      ('audit',                               'anon',          false),
      ('audit',                               'authenticated', false),
      ('audit',                               'service_role',  false),
      ('next_document_number',                'anon',          false),
      ('next_document_number',                'authenticated', false),
      ('next_document_number',                'service_role',  false),
      ('sync_invoice_status',                 'anon',          false),
      ('sync_invoice_status',                 'authenticated', false),
      ('sync_invoice_status',                 'service_role',  false),
      ('derive_invoice_status',               'anon',          false),
      ('derive_invoice_status',               'authenticated', false),
      ('assert_admin',                        'anon',          false),
      ('assert_admin',                        'authenticated', false),
      ('payments_sync_invoice',               'authenticated', false),
      ('handle_new_user',                     'authenticated', false),
      ('guard_invoice_status',                'authenticated', false),
      ('guard_invoice_total',                 'authenticated', false),
      ('guard_client_archive',                'authenticated', false),
      ('guard_profile_update',                'authenticated', false),
      ('enforce_function_privileges',         'authenticated', false),
      ('enforce_function_privileges',         'service_role',  false)
    ) as t(name, role_name, allowed)
  )
  select string_agg(e.name || ' for ' || e.role_name ||
                    ' (expected ' || case when e.allowed then 'granted' else 'revoked' end || ')',
                    ', ' order by e.name)
    into v_bad
    from expected e
    join pg_proc p on p.proname = e.name
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
   where has_function_privilege(e.role_name, p.oid, 'execute') is distinct from e.allowed;

  if v_bad is not null then
    raise exception 'Function privilege policy violated: %', v_bad;
  end if;
end $$;

comment on function public.enforce_function_privileges() is
  'Applies public.function_privilege_policy to every non-extension function in public. Owner-only. Re-run from a migration after adding a function that should be callable from the API.';
