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
  perform public.test_assert((v_second ->> 'claimed')::boolean = false,
    'a concurrent second run cannot claim the same occurrence');
  perform public.test_assert(v_second ->> 'reason' = 'lease_active',
    'the refusal is explained as a live lease, not as success');
  perform public.test_assert(
    (select count(*) from public.reminder_deliveries where reminder_id = v_reminder) = 1,
    'exactly one delivery row exists for one occurrence');

  -- The next occurrence of a repeating reminder is claimable again.
  perform public.test_assert(
    (public.rpc_claim_reminder(v_reminder, v_occ + interval '1 day', 'worker-a') ->> 'claimed')::boolean,
    'a later occurrence gets its own claim');

  perform public.rpc_mark_reminder_delivery(v_reminder, v_occ, false, 'push 500');
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
  v_res      jsonb;
begin
  insert into public.reminders (owner_id, title, remind_at)
  values ('44444444-4444-4444-8444-444444444444', 'Retry after failure', v_occ)
  returning id into v_reminder;

  perform public.rpc_claim_reminder(v_reminder, v_occ, 'w1', 300, 5);
  -- A push failure is reported immediately, with no retry delay.
  perform public.rpc_mark_reminder_delivery(v_reminder, v_occ, false, 'push 500', 0);

  v_res := public.rpc_claim_reminder(v_reminder, v_occ, 'w2', 300, 5);
  perform public.test_assert((v_res ->> 'claimed')::boolean = true,
    'a recorded failure hands the occurrence back for an immediate retry');
  perform public.test_assert((v_res ->> 'attempt')::int = 2,
    'the retry after failure is attempt 2');

  -- Successful delivery ends it.
  perform public.rpc_mark_reminder_delivery(v_reminder, v_occ, true, null);
  perform public.test_assert(
    (select delivered from public.reminder_deliveries where reminder_id = v_reminder and occurrence = v_occ) = true,
    'successful delivery is recorded as delivered');
  perform public.test_assert(
    (select lease_expires_at from public.reminder_deliveries where reminder_id = v_reminder and occurrence = v_occ) is null,
    'a delivered occurrence holds no lease, so nothing can reclaim it');
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


rollback;

drop function if exists public.test_assert(boolean, text);
\echo 'ALL TESTS PASSED'
