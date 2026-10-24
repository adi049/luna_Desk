-- Round-5 defect probes (migrations 0001-0013 vs 0001-0014).
--
-- Run against a migrated database:
--   psql -d <db> -f scripts/probe-round5.sql
--
-- It prints one PROBE line per defect and rolls back, so it can be pointed at
-- a scratch database repeatedly. Used to reproduce each defect before the fix
-- and to show the same probe failing to reproduce it afterwards; the permanent
-- regression tests live in supabase/tests/rls.sql section 11.
-- Round-5 defect probes. Runs the same four checks against any database and
-- prints what actually happens, so "before" and "after" can be compared.
\set ON_ERROR_STOP off
begin;

insert into auth.users (id, email) values
  ('99999999-9999-4999-8999-999999999991', 'probe-admin@example.test'),
  ('99999999-9999-4999-8999-999999999992', 'probe-client@example.test')
on conflict do nothing;

insert into public.clients (id, name, business_name, client_code, status) values
  ('99999999-aaaa-4aaa-8aaa-99999999999a', 'Probe Co', 'Probe Co', 'PRB001', 'active')
on conflict (id) do nothing;
insert into public.clients (id, name, business_name, client_code, status) values
  ('99999999-dddd-4ddd-8ddd-99999999999d', 'Other Probe Co', 'Other Probe Co', 'PRB002', 'active')
on conflict (id) do nothing;

insert into public.user_roles (user_id, role)
select '99999999-9999-4999-8999-999999999991', 'admin'
on conflict do nothing;

-- Make the first user an administrator without relying on anything 0014 adds.
do $$
begin
  if to_regprocedure('public.rpc_authorise_identity_change(uuid, text)') is not null then
    perform public.rpc_authorise_identity_change(
      '99999999-9999-4999-8999-999999999991', 'probe fixture: promote the probe admin');
  end if;
end $$;
update public.profiles set role = 'admin', is_active = true
 where id = '99999999-9999-4999-8999-999999999991';

-- ---------------------------------------------------------------------------
-- PROBE 1: rpc_attach_client_portal as a real administrator
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999991', true);

do $$
declare v_msg text := 'SUCCESS';
begin
  begin
    perform public.rpc_attach_client_portal(
      '99999999-aaaa-4aaa-8aaa-99999999999a',
      '99999999-9999-4999-8999-999999999992', 'PROBE1');
  exception when others then v_msg := sqlstate || ' ' || sqlerrm;
  end;
  raise notice 'PROBE 1 attach_client_portal as admin -> %', v_msg;
end $$;

-- ---------------------------------------------------------------------------
-- PROBE 2: a request with no JWT subject changes a client link.
--
-- The service key cannot even reach this table (no table grants), so the
-- meaningful form of the same hole is an owner/session statement with no
-- auth.uid(): exactly the "system" case the 0013 guard skipped.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', '', true);

do $$
declare v_msg text := 'SUCCESS'; v_after uuid;
begin
  begin
    update public.profiles
       set client_id = '99999999-dddd-4ddd-8ddd-99999999999d', role = 'client'
     where id = '99999999-9999-4999-8999-999999999992';
  exception when others then v_msg := sqlstate || ' ' || sqlerrm;
  end;

  reset role;
  select client_id into v_after from public.profiles
   where id = '99999999-9999-4999-8999-999999999992';
  raise notice 'PROBE 2 no-JWT identity change -> % (client_id now %, expected 99999999-dddd-4ddd-8ddd-99999999999d to be refused)',
    v_msg, coalesce(v_after::text, 'null');
end $$;

-- ---------------------------------------------------------------------------
-- PROBE 3: move an invoice line to another invoice
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', '', true);

insert into public.invoices (id, invoice_number, client_id, issue_date, due_date, subtotal_minor, total_minor, status)
values ('99999999-bbbb-4bbb-8bbb-99999999999b', 'PROBE-INV-1', '99999999-aaaa-4aaa-8aaa-99999999999a',
        current_date, current_date + 30, 0, 0, 'pending'),
       ('99999999-cccc-4ccc-8ccc-99999999999c', 'PROBE-INV-2', '99999999-aaaa-4aaa-8aaa-99999999999a',
        current_date, current_date + 30, 0, 0, 'pending')
on conflict (id) do nothing;

do $$
declare
  v_a uuid := '99999999-bbbb-4bbb-8bbb-99999999999b';
  v_b uuid := '99999999-cccc-4ccc-8ccc-99999999999c';
  v_line uuid;
  v_msg text := 'SUCCESS';
  v_sum_a bigint; v_total_a bigint; v_sum_b bigint; v_total_b bigint;
begin
  insert into public.invoice_items (invoice_id, description, quantity, unit_price_minor, amount_minor)
  values (v_a, 'Probe line', 1, 30000, 30000) returning id into v_line;

  begin
    update public.invoice_items set invoice_id = v_b where id = v_line;
  exception when others then v_msg := sqlstate || ' ' || sqlerrm;
  end;

  select subtotal_minor, total_minor into v_sum_a, v_total_a from public.invoices where id = v_a;
  select subtotal_minor, total_minor into v_sum_b, v_total_b from public.invoices where id = v_b;
  raise notice 'PROBE 3 move line -> % | invoice A subtotal=% total=% | invoice B subtotal=% total=%',
    v_msg, v_sum_a, v_total_a, v_sum_b, v_total_b;
end $$;

-- ---------------------------------------------------------------------------
-- PROBE 4: daily recurrence across the US spring-forward change
-- ---------------------------------------------------------------------------
do $$
declare v_next timestamptz; v_local time;
begin
  v_next := public.next_occurrence_tz('2026-03-07 14:00+00', 'daily', 'America/New_York');
  v_local := (v_next at time zone 'America/New_York')::time;
  raise notice 'PROBE 4 daily step over DST -> % UTC, local % (expected 09:00:00)',
    v_next, v_local;
end $$;

rollback;
