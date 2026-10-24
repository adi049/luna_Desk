-- =============================================================================
-- LunaDesk — RLS & RPC test suite
--
-- Plain-SQL asserts (no pgTAP needed). Every test runs inside one transaction
-- that is rolled back, so it is safe to point at a scratch database.
--
--   psql -v ON_ERROR_STOP=1 -d lunadesk_test -f supabase/tests/rls.sql
--
-- The suite impersonates users the same way PostgREST does: SET ROLE
-- authenticated + request.jwt.claim.sub.
-- =============================================================================

\set ON_ERROR_STOP on
\pset pager off

create or replace function public.test_assert(p_ok boolean, p_label text)
returns void language plpgsql as $$
begin
  if p_ok is not true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'ok — %', p_label;
end $$;

-- Migration 0010 removes the implicit PUBLIC execute grant from new functions,
-- which is exactly what we want for application functions. This helper is
-- called from test blocks that run as `authenticated` / `anon`, so it opts back
-- in explicitly. It exists only in the throwaway test database.
grant execute on function public.test_assert(boolean, text) to public, anon, authenticated, service_role;

begin;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin uuid := '11111111-1111-4111-8111-111111111111';
  v_ua    uuid := '22222222-2222-4222-8222-222222222222';
  v_ub    uuid := '33333333-3333-4333-8333-333333333333';
  v_ca    uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_cb    uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  v_svc   uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  v_inv_a uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  v_inv_b uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  v_task  uuid;
begin
  insert into auth.users (id, email) values
    (v_admin, 'admin@example.test'),
    (v_ua,    'a@example.test'),
    (v_ub,    'b@example.test');

  update public.profiles set role = 'admin', full_name = 'Studio Admin' where id = v_admin;

  insert into public.clients (id, name, business_name, client_code, email, status, portal_status)
  values (v_ca, 'Priya', 'Prism Studio LLP', 'PR103', 'priya@example.test', 'active', 'active'),
         (v_cb, 'Ananya', 'Ansel & Co.',   'ANS005', 'ananya@example.test', 'active', 'active');

  update public.profiles set role = 'client', client_id = v_ca where id = v_ua;
  update public.profiles set role = 'client', client_id = v_cb where id = v_ub;

  insert into public.services (id, name, category) values (v_svc, 'Social Media Marketing', 'Marketing');

  insert into public.invoices (id, invoice_number, client_id, issue_date, due_date, subtotal_minor, total_minor, status)
  values (v_inv_a, 'TEST-INV-0001', v_ca, current_date - 40, current_date + 10, 500000, 500000, 'pending'),
         (v_inv_b, 'TEST-INV-0002', v_cb, current_date - 5, current_date + 10, 900000, 900000, 'pending');

  insert into public.invoice_items (invoice_id, description, quantity, unit_price_minor, amount_minor)
  values (v_inv_a, 'Social retainer — October 2026', 1, 500000, 500000),
         (v_inv_b, 'Brand campaign', 1, 900000, 900000);

  insert into public.internal_notes (client_id, body) values (v_ca, 'Prefers WhatsApp approvals.');

  -- Client-visible and internal events for client A.
  insert into public.calendar_events (owner_id, client_id, title, starts_at, ends_at, client_visible)
  values (v_admin, v_ca, 'Monthly review call', now() + interval '2 days', now() + interval '2 days 1 hour', true),
         (v_admin, v_ca, 'Internal margin review', now() + interval '3 days', now() + interval '3 days 1 hour', false);

  insert into public.tasks (owner_id, title, status) values (v_admin, 'Admin private task', 'todo')
  returning id into v_task;

  insert into public.tasks (owner_id, title, status) values (v_ua, 'Client A private task', 'todo');

  -- Portal identity for client A.
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform public.rpc_attach_client_portal(v_ca, v_ua, 'PR103', 'Portal access');
end $$;

-- ---------------------------------------------------------------------------
-- 1. Client isolation
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);

select public.test_assert(
  (select count(*) from public.clients) = 1, 'client sees exactly one client row (their own)');
select public.test_assert(
  (select business_name from public.clients) = 'Prism Studio LLP', 'that row is their business');
select public.test_assert(
  (select count(*) from public.invoices) = 1, 'client sees only their own invoice');
select public.test_assert(
  (select count(*) from public.payments where client_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') = 0,
  'client cannot see another tenant''s payments');

select public.test_assert(
  (select count(*) from public.internal_notes) = 0, 'internal notes are invisible to clients');

select public.test_assert(
  (select count(*) from public.tasks) = 1 and (select title from public.tasks) = 'Client A private task',
  'personal tasks are owner-scoped, not role-scoped');

select public.test_assert(
  (select count(*) from public.calendar_events) = 1
  and (select title from public.calendar_events) = 'Monthly review call',
  'client sees only client_visible events');

select public.test_assert(
  (select count(*) from public.client_access_codes) = 0, 'clients cannot read access-code hashes');

-- Writes must be refused.
do $$
declare v_blocked boolean := false;
begin
  begin
    insert into public.clients (name, business_name, client_code)
    values ('Fake', 'Fake Co', 'FAKE1');
  exception when insufficient_privilege then v_blocked := true;
  end;
  perform public.test_assert(v_blocked, 'client cannot insert a client row');
end $$;

do $$
declare v_blocked boolean := false;
begin
  begin
    update public.profiles set role = 'admin'
    where id = '22222222-2222-4222-8222-222222222222';
  exception when others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked, 'client cannot escalate their own role');
end $$;

do $$
declare v_blocked boolean := false;
begin
  begin
    perform public.rpc_record_payment(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 1000, current_date, 'upi');
  exception when others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked, 'client cannot record a payment');
end $$;

-- ---------------------------------------------------------------------------
-- 2. Admin financial flows
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

select public.test_assert((select count(*) from public.clients) = 2, 'admin sees every client');

-- Partial payment: Oct 2026 billed 5,000 / received 3,000 / outstanding 2,000.
select public.rpc_record_payment('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 300000, current_date, 'upi', 'UPI-9931');

select public.test_assert(
  (select status from public.invoices where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') = 'partially_paid',
  'partial payment marks the invoice partially_paid');
select public.test_assert(
  (select balance_minor from public.invoice_balances where invoice_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') = 200000,
  'outstanding is per period (₹2,000), not lifetime');

-- Overdue takes precedence once the due date has passed (matching the UI).
do $$
begin
  update public.invoices set due_date = current_date - 1
  where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  -- The status guard recomputes the stored value on any write that could
  -- affect it, so stored and effective status agree once the due date passes.
  perform public.test_assert(
    (select status from public.invoices where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') = 'overdue',
    'stored status is recomputed by the guard when the due date passes');
  perform public.test_assert(
    (select effective_status from public.invoice_balances
      where invoice_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') = 'overdue',
    'a past-due part-paid invoice reads as overdue but keeps its balance');
  update public.invoices set due_date = current_date + 10
  where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
end $$;

-- Overpayment is impossible.
do $$
declare v_blocked boolean := false;
begin
  begin
    perform public.rpc_record_payment('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 250000, current_date, 'upi');
  exception when others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked, 'a payment cannot exceed the outstanding balance');
end $$;

-- Second payment settles it.
select public.rpc_record_payment('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 200000, current_date, 'bank_transfer', 'NEFT-7734');
select public.test_assert(
  (select status from public.invoices where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') = 'paid',
  'invoice flips to paid when fully settled');

-- Receipts: unique numbering, one per payment, snapshot frozen.
select public.rpc_issue_receipt(
  (select id from public.payments
    where invoice_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' and amount_minor = 300000), null);

select public.test_assert(
  (select receipt_number from public.receipts limit 1) like 'MBL-RCP-%',
  'receipt numbering follows the configured prefix');

select public.test_assert(
  (select (snapshot ->> 'previous_minor')::bigint from public.receipts limit 1) = 0
  and (select (snapshot ->> 'balance_minor')::bigint from public.receipts limit 1) = 200000,
  'first receipt snapshot: paid 3,000 against a 5,000 invoice → 2,000 remaining');

do $$
declare
  v_first  uuid;
  v_second uuid;
  v_count  integer;
begin
  select id into v_first from public.receipts
   where payment_id = (select id from public.payments
                        where invoice_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' and amount_minor = 300000);

  v_second := (public.rpc_issue_receipt(
    (select id from public.payments
      where invoice_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' and amount_minor = 300000), null)).id;

  select count(*) into v_count from public.receipts
   where payment_id = (select id from public.payments
                        where invoice_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' and amount_minor = 300000);

  perform public.test_assert(v_second = v_first,
    'issuing a receipt twice is idempotent — it returns the original document');
  perform public.test_assert(v_count = 1,
    'one payment still maps to exactly one receipt');
end $$;

-- Snapshot is immutable in spirit: the second receipt must reflect payment 1.
select public.rpc_issue_receipt(
  (select id from public.payments
    where invoice_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' and amount_minor = 200000), 'Settled in full');
select public.test_assert(
  (select (snapshot ->> 'previous_minor')::bigint from public.receipts order by receipt_number desc limit 1) = 300000,
  'later receipt records previous payments instead of restating the total');

select public.test_assert(
  (select count(distinct receipt_number) from public.receipts) = (select count(*) from public.receipts),
  'receipt numbers are unique');

-- Voiding a payment keeps history and reverts the invoice.
select public.rpc_void_payment(
  (select id from public.payments
    where invoice_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' and amount_minor = 200000),
  'Bounced cheque');

select public.test_assert(
  (select status from public.invoices where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') = 'partially_paid',
  'voiding the settling payment returns the invoice to partially_paid');
select public.test_assert(
  (select count(*) from public.payments where invoice_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') = 2,
  'voided payments are retained, never deleted');
select public.test_assert(
  (select count(*) from public.receipts where voided_at is not null) = 1,
  'the receipt of a voided payment is marked void, not removed');

-- Invoice totals must agree with their items.
do $$
declare v_blocked boolean := false;
begin
  begin
    update public.invoices set subtotal_minor = 1, total_minor = 1
    where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  exception when others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked, 'an invoice total cannot drift from its line items');
end $$;

-- A client with money outstanding cannot be archived.
do $$
declare v_blocked boolean := false;
begin
  begin
    update public.clients set status = 'archived'
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  exception when others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked, 'archive guard rejects a client with outstanding invoices');
end $$;

select public.test_assert(
  (select count(*) from public.internal_notes) = 1, 'admin can read internal notes');

select public.test_assert(
  (select count(*) from public.tasks) = 1, 'admin cannot read another user''s personal tasks');

select public.test_assert(
  (select count(*) from public.audit_logs) > 0, 'financial actions are written to the audit log');

-- ---------------------------------------------------------------------------
-- 3. Access codes: verification, rate limiting, revocation
-- ---------------------------------------------------------------------------
reset role;

select public.test_assert(
  (public.rpc_redeem_access_code('PR103', '10.0.0.1'::inet, 'test')) ->> 'ok' = 'true',
  'a valid portal code resolves to a session identity');
select public.test_assert(
  (public.rpc_redeem_access_code('PR103', '10.0.0.1'::inet, 'test')) ->> 'business_name' = 'Prism Studio LLP',
  'the resolved identity belongs to the right tenant');
select public.test_assert(
  (public.rpc_redeem_access_code('WRONG1', '10.0.0.2'::inet, 'test')) ->> 'error' = 'invalid_code',
  'a wrong code is rejected');
select public.test_assert(
  (select code_hash from public.client_access_codes limit 1) !~ 'PR103',
  'codes are stored hashed, never in plain text');

-- Eight bad attempts trigger the limiter.
do $$
declare i int; v_res jsonb;
begin
  for i in 1..9 loop
    v_res := public.rpc_redeem_access_code('BAD' || i, '10.9.9.9'::inet, 'test');
  end loop;
  perform public.test_assert(v_res ->> 'error' = 'rate_limited', 'repeated bad attempts are rate limited');
end $$;

select public.rpc_revoke_client_access('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Contract ended');

set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select public.test_assert(
  (select count(*) from public.clients) = 0, 'a revoked portal session loses all row access');
select public.test_assert(public.current_client_id() is null, 'current_client_id() returns null once revoked');

reset role;
-- A revoked code is indistinguishable from a wrong one: no tenant enumeration.
select public.test_assert(
  (public.rpc_redeem_access_code('PR103', '10.0.0.3'::inet, 'test')) ->> 'error' = 'invalid_code',
  'a revoked code no longer authenticates anyone');

-- A valid code for a client the agency has deactivated is refused explicitly.
do $$
declare v_disabled text;
begin
  insert into public.clients (id, name, business_name, client_code, status, portal_status)
  values ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'Vikram', 'Vellum Legal', 'VEL009', 'inactive', 'active');
  insert into public.client_access_codes (client_id, code_hash)
  values ('ffffffff-ffff-4fff-8fff-ffffffffffff', extensions.crypt('VEL009', extensions.gen_salt('bf', 10)));
  v_disabled := public.rpc_redeem_access_code('VEL009', '10.0.0.4'::inet, 'test') ->> 'error';
  perform public.test_assert(v_disabled = 'access_disabled',
    'a deactivated client''s code is refused with access_disabled');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Admin lookup codes identify, they never authenticate
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select public.rpc_set_admin_code('admin@example.test', 'ADI000');
select set_config('request.jwt.claim.sub', '', true);

select public.test_assert(
  (public.rpc_lookup_admin_code('ADI000', '10.0.0.5'::inet, 'test')) ->> 'email' = 'admin@example.test',
  'the admin code resolves to the staff account');
select public.test_assert(
  (public.rpc_lookup_admin_code('ADI000', '10.0.0.5'::inet, 'test')) ->> 'ok' = 'true'
  and (select jsonb_object_keys_count from (select count(*) as jsonb_object_keys_count
        from jsonb_object_keys(public.rpc_lookup_admin_code('ADI000', '10.0.0.5'::inet, 'test'))
        where jsonb_object_keys like '%password%') k) = 0,
  'the lookup returns identity only — no credential, no session');
select public.test_assert(
  (public.rpc_lookup_admin_code('ADI999', '10.0.0.6'::inet, 'test')) ->> 'error' = 'invalid_code',
  'a wrong admin code is rejected');
select public.test_assert(
  (select count(*) from public.access_attempts where outcome = 'admin_lookup') >= 2,
  'admin lookups are recorded in the attempt ledger');
select public.test_assert(
  (select count(*) from public.admin_access_codes where code_hash like '%ADI000%') = 0,
  'admin codes are stored hashed');

-- Clients still cannot call the lookup RPC (service role only).
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
do $$
declare v_blocked boolean := false;
begin
  begin
    perform public.rpc_lookup_admin_code('ADI000', null, 'test');
  exception when insufficient_privilege or others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked, 'the admin lookup RPC is not executable by clients');
end $$;
reset role;


-- ===========================================================================
-- 5. Pre-deployment hardening (migration 0007 / 0008)
-- ===========================================================================

-- 5a. Deactivating an admin revokes authorization through BOTH paths --------
reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select public.test_assert(public.is_admin(), 'the admin is authorized while active');

-- Grant the role through the alternative table too, then deactivate.
select public.rpc_set_admin_active('11111111-1111-4111-8111-111111111111', true);
update public.profiles set is_active = false
 where id = '11111111-1111-4111-8111-111111111111';
insert into public.user_roles (user_id, role)
values ('11111111-1111-4111-8111-111111111111', 'admin')
on conflict do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select public.test_assert(
  not public.is_admin(),
  'a deactivated admin is not authorized even with a user_roles grant');
select public.test_assert(
  (select count(*) from public.clients) = 0,
  'a deactivated admin cannot read client rows through RLS');
do $$
declare v_blocked boolean := false;
begin
  begin
    perform public.rpc_record_payment('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 1000, current_date, 'upi');
  exception when others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked, 'a deactivated admin cannot call financial RPCs');
end $$;

-- Reactivate for the remaining tests. Clear the JWT claim first: the profile
-- guard deliberately refuses privileged edits from a non-admin session, and an
-- inactive admin is exactly that.
reset role;
select set_config('request.jwt.claim.sub', '', true);
update public.profiles set is_active = true, role = 'admin'
 where id = '11111111-1111-4111-8111-111111111111';
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

-- 5b. Financial history cannot be written through the REST surface ----------
do $$
declare v_blocked boolean := false;
begin
  begin
    insert into public.payments (client_id, invoice_id, amount_minor, paid_at, method)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 999999, current_date, 'cash');
  exception when insufficient_privilege then v_blocked := true;
  end;
  perform public.test_assert(v_blocked, 'an admin cannot INSERT a payment directly (table privilege revoked)');
end $$;

do $$
declare v_blocked boolean = false;
begin
  begin
    update public.payments set amount_minor = 1 where invoice_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  exception when insufficient_privilege then v_blocked := true;
  end;
  perform public.test_assert(v_blocked, 'an admin cannot UPDATE a recorded payment directly');
end $$;

do $$
declare v_blocked boolean := false;
begin
  begin
    delete from public.payments where invoice_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  exception when insufficient_privilege then v_blocked := true;
  end;
  perform public.test_assert(v_blocked, 'an admin cannot DELETE a payment (financial history is append-only)');
end $$;

do $$
declare v_blocked boolean := false;
begin
  begin
    update public.receipts set snapshot = '{}'::jsonb, receipt_number = 'FORGED-1';
  exception when insufficient_privilege then v_blocked := true;
  end;
  perform public.test_assert(v_blocked, 'a receipt snapshot cannot be rewritten through the API');
end $$;

do $$
declare v_blocked boolean := false;
begin
  begin
    insert into public.document_sequences (prefix, year, last_value) values ('MBL-RCP', 2026, 9000);
  exception when insufficient_privilege or unique_violation then v_blocked := true;
  end;
  perform public.test_assert(v_blocked, 'receipt numbering cannot be seeded from the client');
end $$;

-- 5c. Invoice status cannot be forged --------------------------------------
do $$
declare v_status public.payment_status;
begin
  update public.invoices set status = 'paid'
   where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  select status into v_status from public.invoices
   where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  perform public.test_assert(v_status <> 'paid',
    'marking an unpaid invoice as paid is corrected to its derived status');

  -- Cancelling is still an explicit, allowed action.
  update public.invoices set status = 'cancelled'
   where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  select status into v_status from public.invoices
   where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  perform public.test_assert(v_status = 'cancelled', 'an invoice can still be cancelled deliberately');
  update public.invoices set status = 'pending'
   where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
end $$;

-- 5d. Access-code expiry ----------------------------------------------------
reset role;
insert into public.client_access_codes (client_id, user_id, code_hash, expires_at)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        '33333333-3333-4333-8333-333333333333',
        extensions.crypt('EXP001', extensions.gen_salt('bf', 4)),
        now() - interval '1 day');

select public.test_assert(
  (public.rpc_redeem_access_code('EXP001', '10.1.0.1'::inet, 'test')) ->> 'error' = 'invalid_code',
  'an expired access code is rejected');

insert into public.client_access_codes (client_id, user_id, code_hash, expires_at)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        '33333333-3333-4333-8333-333333333333',
        extensions.crypt('FUT001', extensions.gen_salt('bf', 4)),
        now() + interval '30 days');
select public.test_assert(
  (public.rpc_redeem_access_code('FUT001', '10.1.0.2'::inet, 'test')) ->> 'ok' = 'true',
  'an unexpired code still works');

-- 5e. Admin-code limiter is per-IP, never global ----------------------------
do $$
declare i int; v_res jsonb; v_other jsonb;
begin
  -- Exhaust one attacker IP.
  for i in 1..12 loop
    v_res := public.rpc_lookup_admin_code('WRONG' || i, '10.66.66.66'::inet, 'test');
  end loop;
  perform public.test_assert(v_res ->> 'error' = 'rate_limited',
    'a single IP is rate limited after repeated bad admin codes');

  -- A legitimate admin on a different IP must still get through.
  v_other := public.rpc_lookup_admin_code('ADI000', '10.77.77.77'::inet, 'test');
  perform public.test_assert(v_other ->> 'ok' = 'true',
    'a different IP is NOT locked out by another caller''s failures (no global lockout)');
end $$;

-- 5f. Revoked portal profile blocks a still-valid code ---------------------
reset role;
insert into public.client_access_codes (client_id, user_id, code_hash)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        '33333333-3333-4333-8333-333333333333',
        extensions.crypt('LIVE01', extensions.gen_salt('bf', 4)));
update public.profiles set is_active = false
 where id = '33333333-3333-4333-8333-333333333333';
select public.test_assert(
  (public.rpc_redeem_access_code('LIVE01', '10.1.0.3'::inet, 'test')) ->> 'error' = 'access_disabled',
  'a deactivated portal profile cannot sign in even with a valid code');
update public.profiles set is_active = true
 where id = '33333333-3333-4333-8333-333333333333';

-- 5g. Reminder claiming is atomic -----------------------------------------
do $$
declare
  v_reminder uuid;
  v_occ      timestamptz := date_trunc('minute', now());
  v_first    jsonb;
  v_second   jsonb;
begin
  insert into auth.users (id, email) values ('44444444-4444-4444-8444-444444444444', 'worker@example.test')
  on conflict do nothing;
  insert into public.reminders (owner_id, title, remind_at)
  values ('44444444-4444-4444-8444-444444444444', 'Claim test', v_occ)
  returning id into v_reminder;

  v_first  := public.rpc_claim_reminder(v_reminder, v_occ, 'worker-a');
  v_second := public.rpc_claim_reminder(v_reminder, v_occ, 'worker-b');

  perform public.test_assert((v_first ->> 'claimed')::boolean,
    'the first scheduler run claims the occurrence');
  perform public.test_assert((v_first ->> 'token') is not null,
    'the winning claim is issued a fencing token');
  perform public.test_assert((v_second ->> 'claimed')::boolean = false,
    'a concurrent second run cannot claim the same occurrence');
  perform public.test_assert(v_second ->> 'reason' = 'lease_active',
    'the refusal is explained as a live lease, not as success');
  perform public.test_assert((v_second ->> 'token') is null,
    'a losing claim receives no token');
  perform public.test_assert(
    (select count(*) from public.reminder_deliveries where reminder_id = v_reminder) = 1,
    'exactly one delivery row exists for one occurrence');

  -- The next occurrence of a repeating reminder is claimable again.
  perform public.test_assert(
    (public.rpc_claim_reminder(v_reminder, v_occ + interval '1 day', 'worker-a') ->> 'claimed')::boolean,
    'a later occurrence gets its own claim');

  perform public.rpc_complete_reminder_delivery(
    v_reminder, v_occ, (v_first ->> 'token')::uuid, false, 'push 500', 0);
  perform public.test_assert(
    (select error from public.reminder_deliveries where reminder_id = v_reminder and occurrence = v_occ) = 'push 500',
    'delivery failures are recorded instead of being lost');
end $$;

-- 5i. A crashed worker must not make an occurrence permanently unclaimable ---
do $$
declare
  v_reminder uuid;
  v_occ      timestamptz := date_trunc('minute', now()) + interval '1 hour';
  v_first    jsonb;
  v_blocked  jsonb;
  v_recovered jsonb;
begin
  insert into public.reminders (owner_id, title, remind_at)
  values ('44444444-4444-4444-8444-444444444444', 'Crash recovery', v_occ)
  returning id into v_reminder;

  -- Worker A takes the claim and then "crashes": it never records an outcome.
  v_first := public.rpc_claim_reminder(v_reminder, v_occ, 'worker-a', 300);

  -- Immediately afterwards the lease is still live, so nobody else may send.
  v_blocked := public.rpc_claim_reminder(v_reminder, v_occ, 'worker-b', 300);
  perform public.test_assert((v_blocked ->> 'claimed')::boolean = false,
    'a live lease still blocks a second worker (duplicate-delivery protection)');
  perform public.test_assert(v_blocked ->> 'reason' = 'lease_active',
    'the block is reported as lease_active');

  -- Simulate the lease running out.
  update public.reminder_deliveries
     set lease_expires_at = now() - interval '1 second'
   where reminder_id = v_reminder and occurrence = v_occ;

  v_recovered := public.rpc_claim_reminder(v_reminder, v_occ, 'worker-b', 300, 5);
  perform public.test_assert((v_recovered ->> 'claimed')::boolean = true,
    'an expired lease is reclaimable, so a crashed worker does not strand the occurrence');
  perform public.test_assert(v_recovered ->> 'reason' = 'lease_expired',
    'the recovery is reported as lease_expired');
  perform public.test_assert((v_recovered ->> 'attempt')::int = 2,
    'the retry is counted as attempt 2');
  perform public.test_assert(
    (v_recovered ->> 'token') is distinct from (v_first ->> 'token'),
    'the reclaiming worker gets a different fencing token');
  perform public.test_assert(
    (select count(*) from public.reminder_deliveries where reminder_id = v_reminder) = 1,
    'recovery reuses the single delivery row rather than creating a second one');
end $$;

-- 5j. Retries are bounded, and delivered occurrences are terminal -------------
do $$
declare
  v_reminder uuid;
  v_occ      timestamptz := date_trunc('minute', now()) + interval '2 hours';
  v_res      jsonb;
  i          integer;
begin
  insert into public.reminders (owner_id, title, remind_at)
  values ('44444444-4444-4444-8444-444444444444', 'Bounded retries', v_occ)
  returning id into v_reminder;

  -- Three permitted attempts (max_attempts = 3).
  perform public.rpc_claim_reminder(v_reminder, v_occ, 'w1', 300, 3);
  for i in 2..3 loop
    update public.reminder_deliveries set lease_expires_at = now() - interval '1 second'
     where reminder_id = v_reminder and occurrence = v_occ;
    perform public.rpc_claim_reminder(v_reminder, v_occ, 'w' || i, 300, 3);
  end loop;

  update public.reminder_deliveries set lease_expires_at = now() - interval '1 second'
   where reminder_id = v_reminder and occurrence = v_occ;
  v_res := public.rpc_claim_reminder(v_reminder, v_occ, 'w4', 300, 3);

  perform public.test_assert((v_res ->> 'claimed')::boolean = false,
    'the attempt budget stops a permanently failing occurrence from retrying forever');
  perform public.test_assert(v_res ->> 'reason' = 'attempts_exhausted',
    'exhaustion is reported distinctly from an active lease');

  -- A delivered occurrence is never reclaimed, even after its lease would expire.
  update public.reminder_deliveries
     set delivered = true, finished_at = now(), lease_expires_at = null
   where reminder_id = v_reminder and occurrence = v_occ;
  v_res := public.rpc_claim_reminder(v_reminder, v_occ, 'w5', 300, 10);
  perform public.test_assert((v_res ->> 'claimed')::boolean = false,
    'a delivered occurrence can never be claimed again');
  perform public.test_assert(v_res ->> 'reason' = 'already_delivered',
    'the refusal is reported as already_delivered');
end $$;

-- 5k. A failed delivery releases the lease so the next run can retry ----------
do $$
declare
  v_reminder uuid;
  v_occ      timestamptz := date_trunc('minute', now()) + interval '3 hours';
  v_claim    jsonb;
  v_res      jsonb;
begin
  insert into public.reminders (owner_id, title, remind_at)
  values ('44444444-4444-4444-8444-444444444444', 'Retry after failure', v_occ)
  returning id into v_reminder;

  v_claim := public.rpc_claim_reminder(v_reminder, v_occ, 'w1', 300, 5);
  -- A push failure is reported immediately, with no retry delay.
  perform public.rpc_complete_reminder_delivery(
    v_reminder, v_occ, (v_claim ->> 'token')::uuid, false, 'push 500', 0);

  v_res := public.rpc_claim_reminder(v_reminder, v_occ, 'w2', 300, 5);
  perform public.test_assert((v_res ->> 'claimed')::boolean = true,
    'a recorded failure hands the occurrence back for an immediate retry');
  perform public.test_assert((v_res ->> 'attempt')::int = 2,
    'the retry after failure is attempt 2');

  -- Successful delivery ends it.
  perform public.rpc_complete_reminder_delivery(
    v_reminder, v_occ, (v_res ->> 'token')::uuid, true, null);
  perform public.test_assert(
    (select delivered from public.reminder_deliveries where reminder_id = v_reminder and occurrence = v_occ) = true,
    'successful delivery is recorded as delivered');
  perform public.test_assert(
    (select lease_expires_at from public.reminder_deliveries where reminder_id = v_reminder and occurrence = v_occ) is null,
    'a delivered occurrence holds no lease, so nothing can reclaim it');
end $$;

-- ===========================================================================
-- 5L–5P. Retry correctness: the failures a scheduler actually hits
-- ===========================================================================

-- 5L. A failed push must leave the occurrence due, so it is retried ----------
--     (the original bug: the reminder was marked fired before the push result
--      was known, so the failed occurrence was never selectable again)
do $$
declare
  v_reminder uuid;
  v_occ      timestamptz := now() - interval '1 minute';
  v_claim    jsonb;
  v_due      integer;
  v_fired    timestamptz;
begin
  insert into public.reminders (owner_id, title, remind_at, repeat)
  values ('44444444-4444-4444-8444-444444444444', 'Failed push retry', v_occ, 'none')
  returning id into v_reminder;

  v_claim := public.rpc_claim_reminder(v_reminder, v_occ, 'w1', 300, 5);
  perform public.rpc_complete_reminder_delivery(
    v_reminder, v_occ, (v_claim ->> 'token')::uuid, false, 'push 410', 0);

  select fired_at into v_fired from public.reminders where id = v_reminder;
  select count(*) into v_due
    from public.rpc_due_reminders(now() + interval '1 minute', 200) d
   where d.id = v_reminder;

  perform public.test_assert(v_fired is null,
    'a failed one-time delivery does not set fired_at');
  perform public.test_assert(v_due = 1,
    'a failed one-time reminder is still selected by the next due scan');
  perform public.test_assert(
    (select delivered from public.reminder_deliveries
      where reminder_id = v_reminder and occurrence = v_occ) = false,
    'the delivery row is left undelivered so the retry is visible');
end $$;

-- 5M. A repeating reminder must not advance past a failed occurrence ---------
do $$
declare
  v_reminder uuid;
  v_occ      timestamptz := now() - interval '1 minute';
  v_claim    jsonb;
  v_after    timestamptz;
  v_due      integer;
begin
  insert into public.reminders (owner_id, title, remind_at, repeat)
  values ('44444444-4444-4444-8444-444444444444', 'Repeating failure', v_occ, 'daily')
  returning id into v_reminder;

  v_claim := public.rpc_claim_reminder(v_reminder, v_occ, 'w1', 300, 5);
  perform public.rpc_complete_reminder_delivery(
    v_reminder, v_occ, (v_claim ->> 'token')::uuid, false, 'push 500', 0);

  select remind_at into v_after from public.reminders where id = v_reminder;
  select count(*) into v_due
    from public.rpc_due_reminders(now() + interval '1 minute', 200) d
   where d.id = v_reminder;

  perform public.test_assert(v_after = v_occ,
    'a failed repeating delivery does not advance remind_at');
  perform public.test_assert(v_due = 1,
    'the failed repeating occurrence is still due');
end $$;

-- 5N. Duplicate in-app notification, push retried ---------------------------
--     The notification row is written before the push, so a retry finds it
--     already there. Delivery must still re-attempt the push instead of
--     treating "notification exists" as "fully delivered".
do $$
declare
  v_reminder uuid;
  v_occ      timestamptz := now() - interval '2 minutes';
  v_claim    jsonb;
  v_key      text;
  v_notifs   integer;
  v_push_retried boolean := false;
begin
  insert into public.reminders (owner_id, title, remind_at, repeat)
  values ('44444444-4444-4444-8444-444444444444', 'Duplicate notification', v_occ, 'none')
  returning id into v_reminder;
  v_key := 'reminder:' || v_reminder || ':' || v_occ;

  -- First attempt: in-app notification written, push fails.
  insert into public.notifications (user_id, kind, title, dedupe_key)
  values ('44444444-4444-4444-8444-444444444444', 'reminder', 'Duplicate notification', v_key);
  v_claim := public.rpc_claim_reminder(v_reminder, v_occ, 'w1', 300, 5);
  perform public.rpc_complete_reminder_delivery(
    v_reminder, v_occ, (v_claim ->> 'token')::uuid, false, 'push 500', 0);

  -- Second attempt: the same dedupe_key is inserted again and is a no-op.
  begin
    insert into public.notifications (user_id, kind, title, dedupe_key)
    values ('44444444-4444-4444-8444-444444444444', 'reminder', 'Duplicate notification', v_key);
  exception when unique_violation then
    v_push_retried := true;   -- the insert was a duplicate, so the push is what must run
  end;

  select count(*) into v_notifs from public.notifications
   where user_id = '44444444-4444-4444-8444-444444444444' and dedupe_key = v_key;

  perform public.test_assert(v_push_retried,
    'the in-app notification dedupe_key rejects the duplicate row');
  perform public.test_assert(v_notifs = 1,
    'exactly one in-app notification exists after the duplicate attempt');

  -- And the occurrence is still retryable, i.e. the push will actually run.
  v_claim := public.rpc_claim_reminder(v_reminder, v_occ, 'w2', 300, 5);
  perform public.test_assert((v_claim ->> 'claimed')::boolean,
    'the occurrence is reclaimable so the push can be retried');

  perform public.rpc_complete_reminder_delivery(
    v_reminder, v_occ, (v_claim ->> 'token')::uuid, true, null);
  perform public.test_assert(
    (select count(*) from public.notifications
      where user_id = '44444444-4444-4444-8444-444444444444' and dedupe_key = v_key) = 1,
    'the successful retry adds no second in-app notification');
  perform public.test_assert(
    (select fired_at from public.reminders where id = v_reminder) is not null,
    'the successful retry finishes the one-time reminder');
end $$;

-- 5O. Fencing: a stale worker cannot write over a reclaimed claim -----------
do $$
declare
  v_reminder uuid;
  v_occ      timestamptz := now() - interval '3 minutes';
  v_a        jsonb;
  v_b        jsonb;
  v_res      jsonb;
  v_fired    timestamptz;
begin
  insert into public.reminders (owner_id, title, remind_at, repeat)
  values ('44444444-4444-4444-8444-444444444444', 'Stale worker', v_occ, 'none')
  returning id into v_reminder;

  v_a := public.rpc_claim_reminder(v_reminder, v_occ, 'worker-a', 300, 5);

  -- Worker A stalls; its lease expires and worker B takes over.
  update public.reminder_deliveries set lease_expires_at = now() - interval '1 second'
   where reminder_id = v_reminder and occurrence = v_occ;
  v_b := public.rpc_claim_reminder(v_reminder, v_occ, 'worker-b', 300, 5);
  perform public.test_assert((v_b ->> 'claimed')::boolean,
    'worker B reclaims the expired lease');

  -- Worker A wakes up and tries to report success with its dead token.
  v_res := public.rpc_complete_reminder_delivery(
    v_reminder, v_occ, (v_a ->> 'token')::uuid, true, null);

  perform public.test_assert((v_res ->> 'ok')::boolean = false,
    'a stale worker is refused');
  perform public.test_assert(v_res ->> 'reason' = 'stale_claim',
    'the refusal is reported as a stale claim');

  select fired_at into v_fired from public.reminders where id = v_reminder;
  perform public.test_assert(v_fired is null,
    'the stale worker cannot advance the reminder schedule');
  perform public.test_assert(
    (select delivered from public.reminder_deliveries
      where reminder_id = v_reminder and occurrence = v_occ) = false,
    'the stale worker cannot mark the occurrence delivered');

  -- The live worker still completes normally.
  v_res := public.rpc_complete_reminder_delivery(
    v_reminder, v_occ, (v_b ->> 'token')::uuid, true, null);
  perform public.test_assert((v_res ->> 'ok')::boolean and (v_res ->> 'advanced')::boolean,
    'the worker that actually owns the claim can complete it');
  perform public.test_assert(
    (select fired_at from public.reminders where id = v_reminder) is not null,
    'the owning worker finishes the one-time reminder');
end $$;

-- 5P. A future snooze cannot starve the due queue ---------------------------
--     The old scan filtered on remind_at and ordered by remind_at, so rows
--     snoozed far into the future consumed the row limit and hid reminders that
--     were genuinely due. The scan now selects on the effective occurrence.
do $$
declare
  v_due_ids    uuid[] := '{}';
  v_snoozed    uuid;
  v_real       uuid;
  v_scan       uuid[];
  i            integer;
  v_pad        uuid;
begin
  -- 25 reminders snoozed two days out, plus one genuinely due now.
  for i in 1..25 loop
    insert into public.reminders (owner_id, title, remind_at, snoozed_until)
    values ('44444444-4444-4444-8444-444444444444',
            'Snoozed into the future ' || i,
            now() - interval '10 days',
            now() + interval '2 days')
    returning id into v_pad;
    if i = 1 then
      v_snoozed := v_pad;
    end if;
  end loop;

  insert into public.reminders (owner_id, title, remind_at)
  values ('44444444-4444-4444-8444-444444444444', 'Genuinely due now', now() - interval '5 minutes')
  returning id into v_real;

  -- A small limit is the point: the future snoozes must not occupy slots.
  select array_agg(d.id) into v_scan
    from public.rpc_due_reminders(now() + interval '1 minute', 10) d;

  perform public.test_assert(v_real = any (v_scan),
    'a due reminder is selected even when many others are snoozed into the future');
  perform public.test_assert(not (v_snoozed = any (v_scan)),
    'a reminder snoozed into the future is not selected at all');

  -- And once the snooze elapses it becomes due at its snoozed time.
  update public.reminders set snoozed_until = now() - interval '1 second' where id = v_snoozed;
  select array_agg(d.id) into v_scan
    from public.rpc_due_reminders(now(), 50) d;
  perform public.test_assert(v_snoozed = any (v_scan),
    'the snoozed reminder becomes due when its snooze elapses');
end $$;

-- 5Q. Recurring reminders advance only on success, in the user's timezone ----
do $$
declare
  v_reminder uuid;
  v_occ      timestamptz;
  v_claim    jsonb;
  v_res      jsonb;
  v_next     timestamptz;
  v_local_before text;
  v_local_after  text;
begin
  insert into auth.users (id, email) values ('66666666-6666-4666-8666-666666666666', 'tz@example.test')
  on conflict do nothing;
  insert into public.profiles (id, full_name, email, role, timezone)
  values ('66666666-6666-4666-8666-666666666666', 'TZ user', 'tz@example.test', 'admin', 'Asia/Kolkata')
  on conflict (id) do update set timezone = 'Asia/Kolkata';

  -- 09:00 local yesterday.
  v_occ := (date_trunc('day', now() at time zone 'Asia/Kolkata') - interval '1 day' + interval '9 hours')
             at time zone 'Asia/Kolkata';

  insert into public.reminders (owner_id, title, remind_at, repeat)
  values ('66666666-6666-4666-8666-666666666666', 'Daily standup', v_occ, 'daily')
  returning id into v_reminder;

  v_local_before := to_char(v_occ at time zone 'Asia/Kolkata', 'HH24:MI');

  v_claim := public.rpc_claim_reminder(v_reminder, v_occ, 'w1', 300, 5);
  v_res := public.rpc_complete_reminder_delivery(
    v_reminder, v_occ, (v_claim ->> 'token')::uuid, true, null);

  select remind_at into v_next from public.reminders where id = v_reminder;
  v_local_after := to_char(v_next at time zone 'Asia/Kolkata', 'HH24:MI');

  perform public.test_assert((v_res ->> 'advanced')::boolean,
    'a successful recurring delivery advances the reminder');
  perform public.test_assert(v_next > now(),
    'the next occurrence is in the future, not a backlog replay');
  perform public.test_assert(v_local_after = v_local_before,
    'the local wall-clock time is preserved across the advance');
  perform public.test_assert(
    (select fired_at from public.reminders where id = v_reminder) is null,
    'a recurring reminder is not marked finished after one occurrence');

  -- repeat_until ends the series.
  update public.reminders set repeat_until = current_date where id = v_reminder;
  v_claim := public.rpc_claim_reminder(v_reminder, (select remind_at from public.reminders where id = v_reminder), 'w2', 300, 5);
  v_res := public.rpc_complete_reminder_delivery(
    v_reminder,
    (select remind_at from public.reminders where id = v_reminder),
    (v_claim ->> 'token')::uuid, true, null);
  perform public.test_assert(v_res ->> 'reason' = 'series_finished',
    'a recurrence past repeat_until finishes instead of rescheduling');
  perform public.test_assert(
    (select fired_at from public.reminders where id = v_reminder) is not null,
    'the finished series is terminal');
end $$;

-- 5R. Notification preferences are honoured, and the default matches the docs -
do $$
declare
  v_reminder uuid;
  v_occ      timestamptz := now() + interval '30 minutes';
  v_default  boolean;
  v_explicit boolean;
begin
  insert into public.reminders (owner_id, title, remind_at)
  values ('66666666-6666-4666-8666-666666666666', 'Preference default', v_occ)
  returning id into v_reminder;

  -- No preference row: the documented default is in-app only (no push).
  select d.browser_notifications into v_default
    from public.rpc_due_reminders(now() + interval '1 hour', 500) d
   where d.id = v_reminder;
  perform public.test_assert(v_default = false,
    'a user with no preference row defaults to in-app only, as documented');

  -- An explicit opt-in is reported as such.
  insert into public.notification_preferences (user_id, browser_notifications)
  values ('66666666-6666-4666-8666-666666666666', true)
  on conflict (user_id) do update set browser_notifications = true;

  select d.browser_notifications into v_explicit
    from public.rpc_due_reminders(now() + interval '1 hour', 500) d
   where d.id = v_reminder;
  perform public.test_assert(v_explicit = true,
    'an explicit browser_notifications = true is reported to the scheduler');

  -- The scheduler also receives alarm_enabled so it can honour it.
  perform public.test_assert(
    (select d.alarm_enabled from public.rpc_due_reminders(now() + interval '1 hour', 500) d
      where d.id = v_reminder) = true,
    'alarm_enabled is carried to the scheduler');
end $$;

-- 5h. Internal notes upsert path (what the Supabase adapter actually sends) ---
reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
do $$
declare v_count integer;
begin
  -- The adapter uses ON CONFLICT (client_id); this only works when the unique
  -- index PostgREST infers is a real constraint target.
  insert into public.internal_notes (client_id, body)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'first note')
  on conflict (client_id) do update set body = excluded.body;

  insert into public.internal_notes (client_id, body)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'second note')
  on conflict (client_id) do update set body = excluded.body;

  select count(*) into v_count from public.internal_notes
   where client_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  perform public.test_assert(v_count = 1,
    'internal notes upsert on (client_id) updates in place instead of failing or duplicating');
  perform public.test_assert(
    (select body from public.internal_notes where client_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 'second note',
    'the upserted internal note keeps the newest body');
end $$;

-- ===========================================================================
-- 6. rpc_set_admin_active() is an admin-account toggle, not a promotion path
-- ===========================================================================
reset role;
select set_config('request.jwt.claim.sub', '', true);

-- Extra fixtures: a client-linked profile and a plain user with no role.
insert into auth.users (id, email) values
  ('55555555-5555-4555-8555-555555555551', 'client-target@example.test'),
  ('55555555-5555-4555-8555-555555555552', 'plain-target@example.test'),
  ('55555555-5555-4555-8555-555555555553', 'second-admin@example.test')
on conflict do nothing;

update public.profiles set role = 'client', client_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 where id = '55555555-5555-4555-8555-555555555551';
update public.profiles set role = 'client', client_id = null
 where id = '55555555-5555-4555-8555-555555555552';
update public.profiles set role = 'admin', is_active = true
 where id = '55555555-5555-4555-8555-555555555553';

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

-- 6a. A client-linked account cannot be promoted by "activation".
do $$
declare v_blocked boolean := false;
begin
  begin
    perform public.rpc_set_admin_active('55555555-5555-4555-8555-555555555551', true);
  exception when others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked,
    'a client-linked account cannot be activated as an admin');
end $$;

-- 6b. An ordinary user cannot be promoted either — and must stay untouched.
do $$
declare v_blocked boolean := false; v_role text; v_active boolean; v_grants int;
begin
  begin
    perform public.rpc_set_admin_active('55555555-5555-4555-8555-555555555552', true);
  exception when others then v_blocked := true;
  end;

  select role, is_active into v_role, v_active
    from public.profiles where id = '55555555-5555-4555-8555-555555555552';
  select count(*) into v_grants
    from public.user_roles where user_id = '55555555-5555-4555-8555-555555555552';

  perform public.test_assert(v_blocked,
    'an ordinary user cannot be promoted to admin through rpc_set_admin_active');
  perform public.test_assert(v_role = 'client',
    'the rejected promotion leaves the target role unchanged');
  perform public.test_assert(v_grants = 0,
    'the rejected promotion grants no admin role row');

  -- Deactivation is equally refused for a non-admin.
  v_blocked := false;
  begin
    perform public.rpc_set_admin_active('55555555-5555-4555-8555-555555555552', false);
  exception when others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked,
    'a non-admin cannot be deactivated through the admin RPC either');
end $$;

-- 6c. A real admin is toggled, and the role is preserved, not re-assigned.
do $$
declare
  v_blocked boolean;
  v_res     jsonb;
  v_role    text;
  v_active  boolean;
  v_audit   int;
begin
  select count(*) into v_audit from public.audit_logs where action = 'admin.deactivate';

  -- With a second active admin present, deactivation is allowed.
  v_res := public.rpc_set_admin_active('55555555-5555-4555-8555-555555555553', false);
  select role, is_active into v_role, v_active
    from public.profiles where id = '55555555-5555-4555-8555-555555555553';

  perform public.test_assert((v_res ->> 'changed')::boolean,
    'deactivating an existing admin succeeds when another admin remains');
  perform public.test_assert(v_active = false, 'the target is deactivated');
  perform public.test_assert(v_role = 'admin',
    'deactivation preserves the admin role instead of rewriting it');
  perform public.test_assert(
    (select count(*) from public.audit_logs where action = 'admin.deactivate') = v_audit + 1,
    'the deactivation is audited');

  -- Reactivation restores the grant and still never rewrites the role.
  v_res := public.rpc_set_admin_active('55555555-5555-4555-8555-555555555553', true);
  select role, is_active into v_role, v_active
    from public.profiles where id = '55555555-5555-4555-8555-555555555553';
  perform public.test_assert((v_res ->> 'changed')::boolean, 'reactivation succeeds');
  perform public.test_assert(v_active = true, 'the admin is active again');
  perform public.test_assert(v_role = 'admin', 'reactivation preserves the admin role');
  perform public.test_assert(
    exists (select 1 from public.user_roles where user_id = '55555555-5555-4555-8555-555555555553' and role = 'admin'),
    'reactivation restores the admin grant so is_admin() works through both paths');

  -- Idempotent: activating an already-active admin is a no-op, not an error.
  v_res := public.rpc_set_admin_active('55555555-5555-4555-8555-555555555553', true);
  perform public.test_assert((v_res ->> 'changed')::boolean = false,
    'activating an already-active admin is a no-op');
end $$;

-- 6d. The workspace can never be left without an active administrator.
--
-- With the caller itself being the only active admin, the self-deactivation
-- guard fires first and the count-based "last admin" check behind it is a
-- defensive second gate. Both exist so that neither alone can lock the
-- workspace out, so the assertion below checks the reachable path (self) by
-- its message and verifies the end state (an active admin always survives).
do $$
declare
  v_msg     text;
  v_blocked boolean := false;
  v_res     jsonb;
  v_active  int;
begin
  -- Leave exactly one active admin: the caller.
  perform public.rpc_set_admin_active('55555555-5555-4555-8555-555555555553', false);

  select count(*) into v_active from public.profiles where role = 'admin' and is_active;
  perform public.test_assert(v_active = 1,
    'the fixture really leaves a single active administrator');

  begin
    perform public.rpc_set_admin_active('11111111-1111-4111-8111-111111111111', false);
  exception when others then
    v_msg := sqlerrm;
    v_blocked := true;
  end;

  perform public.test_assert(v_blocked,
    'the sole remaining administrator cannot deactivate themselves');
  perform public.test_assert(v_msg ilike '%your own account%',
    'the refusal names the self-deactivation rule rather than failing obscurely');

  select count(*) into v_active from public.profiles where role = 'admin' and is_active;
  perform public.test_assert(v_active = 1,
    'a failed attempt leaves the workspace with an active administrator');

  -- Restore the second admin so later tests see the original fixture.
  v_res := public.rpc_set_admin_active('55555555-5555-4555-8555-555555555553', true);
  perform public.test_assert((v_res ->> 'changed')::boolean,
    'the second admin can be restored afterwards');
end $$;

-- 6e. A client session cannot call the RPC at all.
do $$
declare v_blocked boolean := false;
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  begin
    perform public.rpc_set_admin_active('55555555-5555-4555-8555-555555555552', true);
  exception when others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked,
    'a client session cannot invoke rpc_set_admin_active');
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
end $$;


-- ===========================================================================
-- 7. Admin role grants are audited and unreachable from the API
-- ===========================================================================
reset role;
select set_config('request.jwt.claim.sub', '', true);

-- 7a. The bootstrap RPC is not executable over the API by anyone.
do $$
begin
  perform public.test_assert(
    not has_function_privilege('anon', 'public.rpc_promote_admin(text)', 'execute'),
    'anon cannot execute rpc_promote_admin');
  perform public.test_assert(
    not has_function_privilege('authenticated', 'public.rpc_promote_admin(text)', 'execute'),
    'authenticated cannot execute rpc_promote_admin');
  perform public.test_assert(
    not has_function_privilege('service_role', 'public.rpc_promote_admin(text)', 'execute'),
    'even service_role cannot mint an admin through the REST API');
end $$;

-- 7b. The privilege-escalation tripwire really fires. A function that assigns
--     the admin role is planted, the same query used by migration 0009 is run
--     against it, and the function is rolled back with the transaction. Without
--     this the guard in 0009 could silently stop matching anything.
do $$
declare
  v_found boolean := false;
begin
  create function public.tmp_escalating_function(p_user uuid)
  returns void language plpgsql as $tmp$
  begin
    update public.profiles set is_active = true, role = 'admin' where id = p_user;
  end $tmp$;

  select exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'tmp_escalating_function'
       and pg_get_functiondef(p.oid) ~* 'update[^;]{0,200}set[^;]{0,200}role[[:space:]]*=[[:space:]]*''admin'''
  ) into v_found;

  perform public.test_assert(v_found,
    'the escalation tripwire detects a function that assigns the admin role');

  -- The legitimate authorisation helper must not be flagged.
  select exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'is_admin'
       and pg_get_functiondef(p.oid) ~* 'update[^;]{0,200}set[^;]{0,200}role[[:space:]]*=[[:space:]]*''admin'''
  ) into v_found;

  perform public.test_assert(not v_found,
    'the tripwire does not flag is_admin(), which only reads the role');

  drop function public.tmp_escalating_function(uuid);
end $$;


-- ===========================================================================
-- 8. Function privileges (migration 0010)
-- ===========================================================================
reset role;
select set_config('request.jwt.claim.sub', '', true);

-- 8a. The helpers that were world-executable are now internal.
do $$
declare
  v_names text[] := array[
    'audit', 'next_document_number', 'sync_invoice_status',
    'derive_invoice_status', 'assert_admin', 'access_attempts_exceeded'
  ];
  v_name text;
  v_leak text;
begin
  foreach v_name in array v_names loop
    perform public.test_assert(
      not exists (
        select 1 from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = v_name
           and (has_function_privilege('anon', p.oid, 'execute')
             or has_function_privilege('authenticated', p.oid, 'execute'))
      ),
      format('%s() is not executable by anon or authenticated', v_name));
  end loop;

  -- Nothing in public is world-executable any more.
  select string_agg(p.proname, ', ') into v_leak
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname <> 'test_assert'
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute'))
     and p.proname not in (
       'is_admin', 'current_client_id', 'is_client_of',
       'rpc_record_payment', 'rpc_void_payment', 'rpc_issue_receipt',
       'rpc_refresh_invoice_status', 'rpc_attach_client_portal',
       'rpc_change_client_access_code', 'rpc_revoke_client_access',
       'rpc_reactivate_client_portal', 'rpc_set_admin_active',
       'rpc_set_admin_code', 'rpc_set_client_code_expiry'
     );
  perform public.test_assert(v_leak is null,
    format('no function outside the allowlist is API-executable (leaked: %s)', coalesce(v_leak, 'none')));

  -- is_admin() must stay executable: RLS policies evaluate it as the caller.
  perform public.test_assert(
    has_function_privilege('authenticated', 'public.is_admin()', 'execute'),
    'is_admin() remains executable by authenticated because RLS policies call it');

  -- Nor may anything be executable by PUBLIC (which is how anon leaked before).
  select string_agg(p.proname, ', ') into v_leak
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname <> 'test_assert'
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0));
  perform public.test_assert(v_leak is null,
    format('no function in public keeps an implicit PUBLIC grant (leaked: %s)', coalesce(v_leak, 'none')));
end $$;

-- 8b. Default privileges: a function created later is not world-executable.
do $$
declare v_anon boolean; v_authn boolean;
begin
  create function public.privilege_drift_probe() returns integer language sql as 'select 1';
  v_anon := has_function_privilege('anon', 'public.privilege_drift_probe()', 'execute');
  v_authn := has_function_privilege('authenticated', 'public.privilege_drift_probe()', 'execute');
  drop function public.privilege_drift_probe();

  perform public.test_assert(not v_anon,
    'a function created after 0010 is not executable by anon by default');
  perform public.test_assert(not v_authn,
    'a function created after 0010 is not executable by authenticated by default');
end $$;

-- 8c. Unauthorised callers cannot reach the audit trail, the number
--     sequences or invoice status through the helper RPCs.
--
-- State is captured into a temp table *before* dropping to `authenticated`,
-- because RLS would hide these rows from the client and every "before" and
-- "after" read would then be 0 — a test that always passes.
create temp table priv_snapshot (
  inv          uuid,
  seq_before   text,
  audit_before integer,
  status_before text
) on commit drop;

insert into priv_snapshot
select (select id from public.invoices limit 1),
       (select coalesce(sum(last_value), 0)::text from public.document_sequences where prefix like 'LD-RCP%'),
       (select count(*) from public.audit_logs),
       (select status::text from public.invoices limit 1);

-- The snapshot table holds only fixture state, so the roles doing the probing
-- may read it; the privilege checks below are what matters.
grant select on priv_snapshot to authenticated, anon;

-- The role switch has to happen outside the DO block: a block runs as whoever
-- is current, and `set local role` inside plpgsql would not change the role the
-- privilege checks are evaluated against.
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);

do $$
declare
  v_inv uuid := (select inv from priv_snapshot);
  v_blocked int := 0;
begin
  begin perform public.next_document_number('LD-RCP-'); exception when others then v_blocked := v_blocked + 1; end;
  begin perform public.sync_invoice_status(v_inv); exception when others then v_blocked := v_blocked + 1; end;
  begin perform public.audit('forged.action', 'profiles', null, null, '{}'::jsonb); exception when others then v_blocked := v_blocked + 1; end;
  begin perform public.derive_invoice_status(v_inv); exception when others then v_blocked := v_blocked + 1; end;
  begin perform public.assert_admin(); exception when others then v_blocked := v_blocked + 1; end;

  perform public.test_assert(v_blocked = 5,
    format('a signed-in client is refused all five internal helpers (refused %s of 5)', v_blocked));
end $$;

reset role;

do $$
declare
  v_seq_after text;
  v_audit_after int;
  v_status_after text;
  v_inv uuid := (select inv from priv_snapshot);
begin
  select coalesce(sum(last_value), 0)::text into v_seq_after
    from public.document_sequences where prefix like 'LD-RCP%';
  select count(*) into v_audit_after from public.audit_logs;
  select status::text into v_status_after from public.invoices where id = v_inv;

  perform public.test_assert(v_seq_after = (select seq_before from priv_snapshot),
    'no document number was consumed by a refused caller');
  perform public.test_assert(v_audit_after = (select audit_before from priv_snapshot),
    'no audit row was forged by a refused caller');
  perform public.test_assert(v_status_after = (select status_before from priv_snapshot),
    'invoice status is unchanged after the refused calls');

  perform public.test_assert(
    not has_function_privilege('anon', 'public.next_document_number(text)', 'execute'),
    'anon cannot even attempt to consume a document number');
  perform public.test_assert(
    not has_function_privilege('anon', 'public.audit(text, text, uuid, jsonb, jsonb)', 'execute'),
    'anon cannot even attempt to write to the audit log');
end $$;

-- 8d. The allowlisted RPCs still work for an admin, i.e. the lockdown did not
--     break the application.
do $$
declare v_before text; v_after text;
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  select coalesce(sum(last_value),0)::text into v_before from public.document_sequences where prefix like 'LD-RCP%';
  select public.next_document_number('LD-RCP-') into v_after;
  perform public.test_assert(v_after is not null and v_after like 'LD-RCP-%',
    'an RPC can still draw a receipt number through its internal call');
  perform public.test_assert(
    (select coalesce(sum(last_value),0)::text from public.document_sequences where prefix like 'LD-RCP%') <> v_before,
    'the sequence advanced for the trusted internal call');
end $$;


-- ===========================================================================
-- 9. Identity immutability (migration 0013)
-- ===========================================================================
reset role;
select set_config('request.jwt.claim.sub', '', true);

insert into auth.users (id, email) values
  ('77777777-7777-4777-8777-777777777771', 'id-client@example.test'),
  ('77777777-7777-4777-8777-777777777772', 'id-admin2@example.test')
on conflict do nothing;

-- auth.users has a handle_new_user trigger, so the profile may already exist
-- with a null client link; upsert to make the fixture deterministic.
insert into public.profiles (id, full_name, email, role, is_active, client_id) values
  ('77777777-7777-4777-8777-777777777771', 'Linked client', 'id-client@example.test', 'client', true,
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
on conflict (id) do update
  set full_name = excluded.full_name,
      role      = excluded.role,
      client_id = excluded.client_id,
      is_active = true;

insert into public.profiles (id, full_name, email, role, is_active) values
  ('77777777-7777-4777-8777-777777777772', 'Second admin', 'id-admin2@example.test', 'admin', true)
on conflict (id) do update set role = 'admin', is_active = true;
insert into public.user_roles (user_id, role) values ('77777777-7777-4777-8777-777777777772', 'admin')
on conflict do nothing;

insert into public.clients (id, name, business_name, client_code, status) values
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Other Co', 'Other Co', 'OTH001', 'active')
on conflict (id) do nothing;

-- 9a. A client cannot repoint their own client_id, even with a valid session.
set local role authenticated;
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777771', true);
do $$
declare v_blocked boolean := false;
begin
  begin
    update public.profiles set client_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
     where id = '77777777-7777-4777-8777-777777777771';
  exception when others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked,
    'a client cannot repoint their own client_id (cross-client data access)');
end $$;

-- 9b. A client cannot promote themselves.
do $$
declare v_blocked boolean := false; v_role text;
begin
  begin
    update public.profiles set role = 'admin' where id = '77777777-7777-4777-8777-777777777771';
  exception when others then v_blocked := true;
  end;
  reset role;
  select role into v_role from public.profiles where id = '77777777-7777-4777-8777-777777777771';
  perform public.test_assert(v_blocked, 'a client cannot set their own role to admin');
  perform public.test_assert(v_role = 'client', 'the refused self-promotion changed nothing');
end $$;

-- 9c. An ADMIN cannot accidentally reassign a client either: identity changes
--     are refused without the owner-only grant, which no API session can write.
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
do $$
declare v_blocked boolean := false; v_client uuid;
begin
  begin
    update public.profiles set client_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
     where id = '77777777-7777-4777-8777-777777777771';
  exception when others then v_blocked := true;
  end;
  reset role;
  select client_id into v_client from public.profiles where id = '77777777-7777-4777-8777-777777777771';
  perform public.test_assert(v_blocked,
    'an administrator cannot repoint a client link by a plain UPDATE');
  perform public.test_assert(v_client = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'the client link is unchanged after the refused reassignment');
end $$;

-- 9d. An admin cannot forge an admin role on a client-linked profile.
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
do $$
declare v_blocked boolean := false; v_role text; v_grant int;
begin
  begin
    update public.profiles set role = 'admin' where id = '77777777-7777-4777-8777-777777777771';
  exception when others then v_blocked := true;
  end;
  reset role;
  select role into v_role from public.profiles where id = '77777777-7777-4777-8777-777777777771';
  select count(*) into v_grant from public.user_roles where user_id = '77777777-7777-4777-8777-777777777771';
  perform public.test_assert(v_blocked,
    'a client-linked profile cannot be turned into an administrator');
  perform public.test_assert(v_role = 'client', 'the profile is still a client');
  perform public.test_assert(v_grant = 0, 'no admin grant was created');
end $$;

-- 9e. The invariant holds even for a trusted writer: client_id requires role.
reset role;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare v_blocked boolean := false;
begin
  begin
    update public.profiles set role = 'admin'
     where id = '77777777-7777-4777-8777-777777777771';
  exception when others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked,
    'even a service-role statement cannot leave an admin linked to a client portal');
end $$;

-- 9f. The sanctioned path works, is audited, and is not callable from the API.
do $$
declare
  v_res   jsonb;
  v_role  text;
  v_audit int;
begin
  select count(*) into v_audit from public.audit_logs where action = 'profile.identity.change';

  v_res := public.rpc_set_profile_identity(
    '77777777-7777-4777-8777-777777777771', 'client',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'client moved to a different account');

  select role into v_role from public.profiles where id = '77777777-7777-4777-8777-777777777771';

  perform public.test_assert((v_res ->> 'ok')::boolean and (v_res ->> 'changed')::boolean,
    'the sanctioned identity RPC reassigns the client link');
  perform public.test_assert(v_role = 'client', 'the role is preserved as client');
  perform public.test_assert(
    (select count(*) from public.audit_logs where action = 'profile.identity.change') = v_audit + 1,
    'an identity change is audited');

  perform public.test_assert(
    not has_function_privilege('authenticated',
      'public.rpc_set_profile_identity(uuid, app_role, uuid, text)', 'execute'),
    'rpc_set_profile_identity is not callable from the API');
  perform public.test_assert(
    not has_function_privilege('service_role',
      'public.rpc_set_profile_identity(uuid, app_role, uuid, text)', 'execute'),
    'rpc_set_profile_identity is not callable with the service key either');
  perform public.test_assert(
    not has_function_privilege('authenticated', 'public.guard_profile_identity()', 'execute'),
    'the identity guard trigger function is not callable directly');
end $$;

-- 9g. The sanctioned path refuses to empty the workspace of administrators.
reset role;
do $$
declare v_blocked boolean := false;
begin
  -- Leave exactly one active admin other than the demotion target.
  update public.profiles set is_active = false
   where role = 'admin' and id <> '11111111-1111-4111-8111-111111111111';
  begin
    perform public.rpc_set_profile_identity(
      '11111111-1111-4111-8111-111111111111', 'client', null, 'accidental demotion attempt');
  exception when others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked,
    'the sanctioned path refuses to remove the last active administrator');
  update public.profiles set is_active = true
   where id = '77777777-7777-4777-8777-777777777772';
end $$;

-- ===========================================================================
-- 10. Financial integrity end to end (migration 0013 + 0003/0007)
-- ===========================================================================
reset role;
select set_config('request.jwt.claim.sub', '', true);

insert into public.clients (id, name, business_name, client_code, status) values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Money Co', 'Money Co', 'MON001', 'active')
on conflict (id) do nothing;

insert into public.invoices (id, invoice_number, client_id, subtotal_minor, total_minor, due_date, status)
values ('eeeeeeee-1111-4111-8111-eeeeeeeeeeee', 'MONEY-INV-1',
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 100000, 100000, current_date - 1, 'pending')
on conflict (id) do nothing;

-- 10a. Line items drive the subtotal, and freeze once money arrives.
do $$
declare v_sum bigint; v_total bigint; v_blocked boolean := false;
begin
  insert into public.invoice_items (invoice_id, description, quantity, unit_price_minor, amount_minor)
  values ('eeeeeeee-1111-4111-8111-eeeeeeeeeeee', 'Retainer', 1, 60000, 60000),
         ('eeeeeeee-1111-4111-8111-eeeeeeeeeeee', 'Ad spend', 1, 40000, 40000);

  select subtotal_minor, total_minor into v_sum, v_total
    from public.invoices where id = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';

  perform public.test_assert(v_sum = 100000,
    'the invoice subtotal follows its line items');
  perform public.test_assert(v_total = 100000,
    'the invoice total follows its line items');

  insert into public.payments (client_id, invoice_id, amount_minor, method)
  values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee', 25000, 'upi');

  begin
    update public.invoice_items set amount_minor = 1
     where invoice_id = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
  exception when others then v_blocked := true;
  end;

  perform public.test_assert(v_blocked,
    'line items cannot be edited once a payment exists');
  perform public.test_assert(
    (select sum(amount_minor) from public.invoice_items
      where invoice_id = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee') = 100000,
    'the refused edit left the line items intact');
end $$;

-- 10b. Overpayment, zero and negative are refused; the balance is exact.
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
do $$
declare
  v_inv uuid := 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
  v_msg text; v_blocked int := 0; v_pay public.payments;
begin
  begin perform public.rpc_record_payment(v_inv, 75001, current_date, 'upi', 'OVP-1', null);
  exception when others then v_blocked := v_blocked + 1; end;
  begin perform public.rpc_record_payment(v_inv, 0, current_date, 'upi', 'ZERO-1', null);
  exception when others then v_blocked := v_blocked + 1; end;
  begin perform public.rpc_record_payment(v_inv, -100, current_date, 'upi', 'NEG-1', null);
  exception when others then v_blocked := v_blocked + 1; end;

  perform public.test_assert(v_blocked = 3,
    format('overpayment, zero and negative amounts are all refused (%s of 3)', v_blocked));

  -- The exact remaining balance is accepted and settles the invoice.
  v_pay := public.rpc_record_payment(v_inv, 75000, current_date, 'upi', 'EXACT-1', null);
  perform public.test_assert(
    (select status from public.invoices where id = v_inv) = 'paid',
    'paying the exact balance marks the invoice paid');
  perform public.test_assert(v_pay.amount_minor = 75000, 'the recorded amount is exact');

  -- Nothing further can be added to a settled invoice.
  begin perform public.rpc_record_payment(v_inv, 1, current_date, 'upi', 'ONE-MORE', null);
        raise exception 'unreachable';
  exception when others then null; end;
  perform public.test_assert(
    (select coalesce(sum(amount_minor),0) from public.payments
      where invoice_id = v_inv and voided_at is null) = 100000,
    'a settled invoice cannot be paid past its total');
end $$;

-- 10c. Duplicate submissions are refused, and a void frees the reference.
do $$
declare
  v_inv uuid := 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
  v_pay public.payments;
  v_blocked boolean := false;
  v_count int;
begin
  select * into v_pay from public.payments
   where invoice_id = v_inv and reference = 'EXACT-1' and voided_at is null;

  begin
    perform public.rpc_record_payment(v_inv, 1, current_date, 'upi', 'EXACT-1', null);
  exception when others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked,
    'a second payment with the same reference on the same invoice is refused');

  select count(*) into v_count from public.payments
   where invoice_id = v_inv and reference = 'EXACT-1';
  perform public.test_assert(v_count = 1, 'the double-submit created no second row');

  -- After a void, the reference may be reused: the correction is a new row.
  perform public.rpc_void_payment(v_pay.id, 'entered against the wrong invoice');
  perform public.rpc_record_payment(v_inv, 20000, current_date, 'upi', 'EXACT-1', null);

  perform public.test_assert(
    (select count(*) from public.payments
      where invoice_id = v_inv and reference = 'EXACT-1' and voided_at is null) = 1,
    'a voided payment frees its reference for a corrected entry');
  -- This invoice is past its due date, and the documented precedence is
  -- cancelled > paid > overdue > partially_paid > pending, so "overdue" is the
  -- correct recomputed status; the balance is what proves the void reopened it.
  perform public.test_assert(
    (select status from public.invoices where id = v_inv) = 'overdue',
    'voiding recomputes status and keeps the overdue ranking');
  perform public.test_assert(
    (select coalesce(sum(amount_minor), 0) from public.payments
      where invoice_id = v_inv and voided_at is null) = 45000,
    'voiding leaves only the non-voided balance on the invoice');
end $$;

-- 10d. Receipts are idempotent, immutable, and follow their payment.
do $$
declare
  v_inv uuid := 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
  v_pay uuid;
  v_r1 public.receipts;
  v_r2 public.receipts;
  v_blocked boolean;
  v_snapshot_before jsonb;
begin
  -- Deterministic: the corrected 20000 entry, recorded after the 25000 one.
  select id into v_pay from public.payments
   where invoice_id = v_inv and voided_at is null and amount_minor = 20000;

  v_r1 := public.rpc_issue_receipt(v_pay, 'first issue');
  v_r2 := public.rpc_issue_receipt(v_pay, 'second issue');

  perform public.test_assert(v_r1.id = v_r2.id,
    'issuing a receipt twice returns the same document');
  perform public.test_assert(
    (select count(*) from public.receipts where payment_id = v_pay) = 1,
    'a double-submitted receipt does not mint a second number');
  perform public.test_assert(v_r1.receipt_number is not null,
    'the receipt carries a number');

  -- The snapshot is the authority for a reprint, and matches the payment.
  v_snapshot_before := v_r1.snapshot;
  perform public.test_assert(
    (v_snapshot_before ->> 'amount_minor')::bigint = 20000,
    'the receipt snapshot records the payment amount');
  -- 100000 total, 25000 paid earlier, 20000 on this receipt.
  perform public.test_assert(
    (v_snapshot_before ->> 'previous_minor')::bigint = 25000
      and (v_snapshot_before ->> 'balance_minor')::bigint = 55000,
    'the receipt snapshot records the remaining balance');
  perform public.test_assert(
    (v_snapshot_before -> 'items') is not null
      and jsonb_array_length(v_snapshot_before -> 'items') = 2,
    'the receipt snapshot carries the invoice line items');

  -- A voided payment voids its receipt rather than deleting it.
  perform public.rpc_void_payment(v_pay, 'refunded in full');
  perform public.test_assert(
    (select voided_at is not null from public.receipts where payment_id = v_pay),
    'voiding the payment voids the receipt but keeps the record');

  -- The number is never reused or renumbered.
  perform public.test_assert(
    (select receipt_number from public.receipts where payment_id = v_pay) = v_r1.receipt_number,
    'the receipt number is unchanged by the void');
end $$;

-- 10e. Archive workflows respect outstanding money.
reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
set local role authenticated;
do $$
declare v_blocked boolean := false;
begin
  begin
    update public.clients set status = 'archived'
     where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  exception when others then v_blocked := true;
  end;
  perform public.test_assert(v_blocked,
    'a client with an unpaid balance cannot be archived');
end $$;

-- Settle the remaining balance for real (archiving checks payments, not the
-- status label).
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
do $$
begin
  perform public.rpc_record_payment(
    'eeeeeeee-1111-4111-8111-eeeeeeeeeeee', 75000, current_date, 'upi', 'SETTLE-1',
    'final settlement');
  perform public.test_assert(
    (select status from public.invoices where id = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee') = 'paid',
    'the settlement payment closes the invoice');
end $$;

-- The portal code is issued by the system (extensions schema is owner-only).
reset role;
select set_config('request.jwt.claim.sub', '', true);
insert into public.client_access_codes (client_id, code_hash)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        extensions.crypt('MONEY01', extensions.gen_salt('bf', 4)));

-- Archiving revokes portal access and flips the portal status.
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
do $$
declare v_code_revoked boolean; v_portal text;
begin
  update public.clients set status = 'archived'
   where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  reset role;
  select coalesce(bool_and(is_revoked), true) into v_code_revoked
    from public.client_access_codes where client_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  select portal_status into v_portal
    from public.clients where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  perform public.test_assert(v_code_revoked,
    'archiving a settled client revokes its portal codes');
  perform public.test_assert(v_portal = 'revoked',
    'archiving sets the portal status to revoked');
end $$;


rollback;

drop function if exists public.test_assert(boolean, text);
\echo 'ALL TESTS PASSED'
