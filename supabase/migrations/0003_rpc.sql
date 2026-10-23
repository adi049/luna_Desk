-- =============================================================================
-- LunaDesk · 0003 — transactional RPCs
--
-- Everything that touches money or access is a SECURITY DEFINER function:
--   * it re-checks the caller's role (never trusts the client),
--   * it runs in one transaction, so a half-written payment cannot exist,
--   * it writes the audit row itself.
-- =============================================================================

-- Receipts can be cancelled by voiding the payment they document; the document
-- stays in the table (never delete financial history) with a void marker.
alter table public.receipts add column if not exists voided_at   timestamptz;
alter table public.receipts add column if not exists void_reason text;

create or replace function public.assert_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator role required' using errcode = '42501';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Payments
-- ----------------------------------------------------------------------------
create or replace function public.rpc_record_payment(
  p_invoice_id   uuid,
  p_amount_minor bigint,
  p_paid_at      date,
  p_method       payment_method,
  p_reference    text default null,
  p_notes        text default null
)
returns public.payments
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_invoice   public.invoices%rowtype;
  v_paid      bigint;
  v_payment   public.payments;
  v_status    payment_status;
begin
  perform public.assert_admin();

  -- Lock the invoice: two concurrent payments must serialise, otherwise both
  -- could pass the balance check and overpay the invoice.
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  if v_invoice.status = 'cancelled' then
    raise exception 'Cannot record a payment against a cancelled invoice' using errcode = 'P0001';
  end if;
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Payment amount must be greater than zero' using errcode = '22023';
  end if;

  select coalesce(sum(amount_minor), 0) into v_paid
  from public.payments
  where invoice_id = p_invoice_id and voided_at is null;

  if v_paid + p_amount_minor > v_invoice.total_minor then
    raise exception 'Payment exceeds the outstanding balance of % minor units',
      v_invoice.total_minor - v_paid using errcode = '22023';
  end if;

  insert into public.payments (
    client_id, invoice_id, amount_minor, paid_at, method, reference, notes, created_by
  ) values (
    v_invoice.client_id, p_invoice_id, p_amount_minor,
    coalesce(p_paid_at, current_date), coalesce(p_method, 'upi'),
    nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_notes, '')), ''), auth.uid()
  )
  returning * into v_payment;

  v_status := case
    when v_paid + p_amount_minor >= v_invoice.total_minor then 'paid'
    when v_invoice.due_date is not null and v_invoice.due_date < current_date then 'overdue'
    else 'partially_paid'
  end;

  update public.invoices
     set status = v_status
   where id = p_invoice_id;

  perform public.audit('payment.record', 'payments', v_payment.id, null, to_jsonb(v_payment));
  return v_payment;
end $$;

create or replace function public.rpc_void_payment(
  p_payment_id uuid,
  p_reason     text
)
returns public.payments
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_payment public.payments;
  v_paid    bigint;
  v_total   bigint;
begin
  perform public.assert_admin();

  if length(trim(coalesce(p_reason, ''))) < 4 then
    raise exception 'A void reason is required' using errcode = '22023';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;
  if v_payment.voided_at is not null then
    raise exception 'Payment is already void' using errcode = 'P0001';
  end if;

  update public.payments
     set voided_at = now(), void_reason = trim(p_reason)
   where id = p_payment_id
  returning * into v_payment;

  -- A receipt that documents a voided payment is void too, but never deleted.
  update public.receipts
     set voided_at = now(), void_reason = trim(p_reason)
   where payment_id = p_payment_id and voided_at is null;

  select coalesce(sum(amount_minor), 0) into v_paid
  from public.payments
  where invoice_id = v_payment.invoice_id and voided_at is null;

  select total_minor into v_total from public.invoices where id = v_payment.invoice_id;

  update public.invoices i
     set status = (case
       when v_paid >= v_total then 'paid'
       when i.due_date is not null and i.due_date < current_date then 'overdue'
       when v_paid > 0 then 'partially_paid'
       else 'pending'
     end)::payment_status
   where i.id = v_payment.invoice_id;

  perform public.audit('payment.void', 'payments', v_payment.id, null,
                       jsonb_build_object('reason', trim(p_reason)));

  return v_payment;
end $$;

-- ----------------------------------------------------------------------------
-- Receipts
-- ----------------------------------------------------------------------------
-- The snapshot is assembled on the server from authoritative rows so a reprint
-- can never disagree with what the client was billed.
create or replace function public.rpc_issue_receipt(
  p_payment_id uuid,
  p_notes      text default null
)
returns public.receipts
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pay      public.payments%rowtype;
  v_inv      public.invoices%rowtype;
  v_client   public.clients%rowtype;
  v_brand    public.branding_settings%rowtype;
  v_prev     bigint;
  v_receipt  public.receipts;
  v_snapshot jsonb;
  v_number   text;
begin
  perform public.assert_admin();

  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;
  if v_pay.voided_at is not null then
    raise exception 'Cannot issue a receipt for a voided payment' using errcode = 'P0001';
  end if;

  -- Idempotent by design: a double-submit (or a retry after a timeout that
  -- actually succeeded) returns the existing document instead of erroring or
  -- minting a second number for one payment.
  select * into v_receipt from public.receipts where payment_id = p_payment_id;
  if found then
    return v_receipt;
  end if;

  select * into v_inv from public.invoices where id = v_pay.invoice_id;
  select * into v_client from public.clients where id = v_pay.client_id;
  select * into v_brand from public.branding_settings limit 1;

  -- Paid before this payment, excluding voids: the receipt shows what was
  -- already settled so the remaining balance on the document is truthful.
  select coalesce(sum(amount_minor), 0) into v_prev
  from public.payments
  where invoice_id = v_pay.invoice_id
    and voided_at is null
    -- Strict insert order: payments recorded in one transaction share
    -- created_at, so the sequence column is the only reliable cursor.
    and seq < v_pay.seq;

  v_number := public.next_document_number(coalesce(v_brand.receipt_prefix, 'MBL-RCP'));

  v_snapshot := jsonb_build_object(
    'company_name',   v_brand.company_name,
    'logo_url',       v_brand.logo_url,
    'receipt_footer', v_brand.receipt_footer,
    'contact_email',  v_brand.contact_email,
    'contact_phone',  v_brand.contact_phone,
    'address',        v_brand.address,
    'tax_id',         v_brand.tax_id,
    'tax_label',      v_brand.tax_label,
    'client_name',    v_client.name,
    'business_name',  v_client.business_name,
    'client_code',    v_client.client_code,
    'contact_person', v_client.contact_person,
    'client_email',   v_client.email,
    'client_phone',   v_client.phone,
    'invoice_number', v_inv.invoice_number,
    'billing_period_start', v_inv.billing_period_start,
    'billing_period_end',   v_inv.billing_period_end,
    'invoice_total_minor',  v_inv.total_minor,
    'previous_minor', v_prev,
    'amount_minor',   v_pay.amount_minor,
    'balance_minor',  greatest(v_inv.total_minor - v_prev - v_pay.amount_minor, 0),
    'method',         v_pay.method,
    'reference',      v_pay.reference,
    'payment_date',   v_pay.paid_at,
    'issue_date',     current_date,
    'notes',          coalesce(p_notes, v_pay.notes),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'description', ii.description,
               'quantity', ii.quantity,
               'unit_price_minor', ii.unit_price_minor,
               'amount_minor', ii.amount_minor
             ) order by ii.position, ii.description), '[]'::jsonb)
      from public.invoice_items ii
      where ii.invoice_id = v_inv.id
    )
  );

  insert into public.receipts (receipt_number, payment_id, client_id, invoice_id, issued_at, snapshot)
  values (v_number, v_pay.id, v_pay.client_id, v_pay.invoice_id, current_date, v_snapshot)
  returning * into v_receipt;

  perform public.audit('receipt.issue', 'receipts', v_receipt.id, null,
                       jsonb_build_object('receipt_number', v_number, 'payment_id', v_pay.id));
  return v_receipt;
end $$;

-- ----------------------------------------------------------------------------
-- Client portal access
-- ----------------------------------------------------------------------------
create or replace function public.rpc_attach_client_portal(
  p_client_id uuid,
  p_user_id   uuid,
  p_code      text,
  p_label     text default 'Portal access'
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_code_id uuid;
begin
  perform public.assert_admin();

  if p_code !~ '^[A-Z0-9]{5,20}$' then
    raise exception 'Access codes must be 5–20 upper-case letters/digits' using errcode = '22023';
  end if;

  -- One active portal identity per client.
  update public.client_access_codes
     set is_revoked = true, rotated_at = now()
   where client_id = p_client_id and not is_revoked;

  insert into public.client_access_codes (client_id, user_id, label, code_hash, created_by)
  values (p_client_id, p_user_id, coalesce(p_label, 'Portal access'),
          crypt(p_code, gen_salt('bf', 10)), auth.uid())
  returning id into v_code_id;

  update public.profiles
     set role = 'client', client_id = p_client_id, is_active = true
   where id = p_user_id;

  update public.clients
     set portal_status = 'active', status = case when status = 'archived' then status else 'active' end
   where id = p_client_id;

  perform public.audit('portal.access.create', 'clients', p_client_id, null,
                       jsonb_build_object('user_id', p_user_id, 'code_id', v_code_id));
  return v_code_id;
end $$;

create or replace function public.rpc_change_client_access_code(
  p_client_id uuid,
  p_code      text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_code_id uuid;
  v_user_id uuid;
begin
  perform public.assert_admin();

  if p_code !~ '^[A-Z0-9]{5,20}$' then
    raise exception 'Access codes must be 5–20 upper-case letters/digits' using errcode = '22023';
  end if;

  select user_id into v_user_id
  from public.client_access_codes
  where client_id = p_client_id and not is_revoked
  order by created_at desc
  limit 1;

  update public.client_access_codes
     set is_revoked = true, rotated_at = now()
   where client_id = p_client_id and not is_revoked;

  insert into public.client_access_codes (client_id, user_id, label, code_hash, created_by)
  values (p_client_id, v_user_id, 'Portal access', crypt(p_code, gen_salt('bf', 10)), auth.uid())
  returning id into v_code_id;

  update public.clients set portal_status = 'active' where id = p_client_id;

  perform public.audit('portal.access.rotate', 'clients', p_client_id, null,
                       jsonb_build_object('code_id', v_code_id));
  return v_code_id;
end $$;

create or replace function public.rpc_revoke_client_access(
  p_client_id uuid,
  p_reason    text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.assert_admin();

  update public.client_access_codes
     set is_revoked = true, rotated_at = now()
   where client_id = p_client_id and not is_revoked;

  update public.clients set portal_status = 'revoked' where id = p_client_id;

  -- Sign-out on the auth side is immediate for new requests; existing JWTs
  -- expire naturally. `current_client_id()` also returns null when the portal
  -- is revoked, so every RLS policy stops matching at once.
  update public.profiles
     set is_active = false
   where client_id = p_client_id and role = 'client';

  perform public.audit('portal.access.revoke', 'clients', p_client_id, null,
                       jsonb_build_object('reason', p_reason));
end $$;

-- ----------------------------------------------------------------------------
-- Code → session exchange.
--   Callable by the SERVICE ROLE only (the `login-with-code` Edge Function).
--   The client never learns whether a code exists for another tenant; the
--   response carries a session-ready user id for the matching client.
-- ----------------------------------------------------------------------------
create or replace function public.rpc_redeem_access_code(
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
  v_code    public.client_access_codes%rowtype;
  v_client  public.clients%rowtype;
  v_hint    text := upper(left(trim(coalesce(p_code, '')), 3));
  v_recent  integer;
begin
  -- Rate limit: 8 failed attempts per IP per 10 minutes, and 8 per code hint
  -- globally, which stops a single hot code from being hammered.
  select count(*) into v_recent
  from public.access_attempts
  where created_at > now() - interval '10 minutes'
    and outcome in ('bad_code', 'revoked')
    and (ip = p_ip or code_hint = v_hint);

  if v_recent >= 8 then
    insert into public.access_attempts (code_hint, ip, user_agent, outcome)
    values (v_hint, p_ip, p_user_agent, 'rate_limited');
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  select * into v_code
  from public.client_access_codes
  where code_hash = crypt(upper(trim(coalesce(p_code, ''))), code_hash)
    and not is_revoked
  order by created_at desc
  limit 1;

  if not found then
    insert into public.access_attempts (code_hint, ip, user_agent, outcome)
    values (v_hint, p_ip, p_user_agent, 'bad_code');
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  select * into v_client from public.clients where id = v_code.client_id;
  if v_client.status <> 'active' or v_client.portal_status <> 'active' then
    insert into public.access_attempts (code_hint, ip, user_agent, outcome)
    values (v_hint, p_ip, p_user_agent, 'revoked');
    return jsonb_build_object('ok', false, 'error', 'access_disabled');
  end if;

  update public.client_access_codes
     set last_used_at = now(), uses_count = uses_count + 1
   where id = v_code.id;

  insert into public.access_attempts (code_hint, ip, user_agent, outcome)
  values (v_hint, p_ip, p_user_agent, 'ok');

  return jsonb_build_object(
    'ok', true,
    'user_id', v_code.user_id,
    'client_id', v_client.id,
    'client_code', v_client.client_code,
    'business_name', v_client.business_name
  );
end $$;

-- Admin bootstrap: promote an existing auth user. Called from
-- scripts/bootstrap-admin.sql via the SQL editor, never from the browser.
create or replace function public.rpc_promote_admin(p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  select id into v_id from auth.users where lower(email) = lower(trim(p_email));
  if v_id is null then
    raise exception 'No auth user with email %', p_email;
  end if;
  insert into public.profiles (id, full_name, email, role)
  values (v_id, split_part(p_email, '@', 1), p_email, 'admin')
  on conflict (id) do update set role = 'admin', is_active = true;
  insert into public.user_roles (user_id, role) values (v_id, 'admin')
  on conflict (user_id, role) do nothing;
  return v_id;
end $$;

-- ----------------------------------------------------------------------------
-- Privileges: RPCs are executable by signed-in users; the redeemer and the
-- bootstrap are service-role / owner only.
-- ----------------------------------------------------------------------------
grant execute on function public.rpc_record_payment(uuid, bigint, date, payment_method, text, text) to authenticated;
grant execute on function public.rpc_void_payment(uuid, text) to authenticated;
grant execute on function public.rpc_issue_receipt(uuid, text) to authenticated;
grant execute on function public.rpc_attach_client_portal(uuid, uuid, text, text) to authenticated;
grant execute on function public.rpc_change_client_access_code(uuid, text) to authenticated;
grant execute on function public.rpc_revoke_client_access(uuid, text) to authenticated;

revoke all on function public.rpc_redeem_access_code(text, inet, text) from public, anon, authenticated;
grant execute on function public.rpc_redeem_access_code(text, inet, text) to service_role;

revoke all on function public.rpc_promote_admin(text) from public, anon, authenticated;
grant execute on function public.rpc_promote_admin(text) to service_role;
