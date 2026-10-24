-- =============================================================================
-- 0013 — identity immutability and financial integrity
--
-- Two more findings from the audit, both of the "silently wrong data" kind.
--
-- ---------------------------------------------------------------------------
-- A. Identity reassignment (profiles.role / profiles.client_id)
--
-- `profiles.client_id` is what `current_client_id()` and `is_client_of()` read,
-- so it *is* the client-isolation boundary. It was an ordinary column in an
-- ordinary table: any administrator could repoint it with a plain UPDATE from
-- the API, and the client would silently gain access to another client's
-- projects, invoices, receipts and announcements. Nothing logged it, and
-- nothing stopped an admin from also leaving `role = 'admin'` on a
-- client-linked row, producing a profile that is simultaneously staff and
-- customer.
--
-- The previous guard only stopped *non-admins* from touching these columns. It
-- said nothing to an admin, which is precisely the "accidental" case: a
-- mis-clicked dropdown in a table editor is enough to move a customer's
-- identity.
--
-- Response: an identity change now requires a grant row that only the function
-- owner can create, so it cannot be produced from an API session at all. The
-- deliberate path is `rpc_set_profile_identity()`, which is owner-only (SQL
-- editor), validates, and audits. Every identity change is audited regardless
-- of who made it, including service-role and SQL-editor changes.
--
-- Why a grant table rather than a session flag: a custom GUC
-- (`set_config('lunadesk.…')`) is settable by any role, so it would be a
-- spoofable bypass — a client could set it and promote itself. A row in a
-- table with no grants and no RLS policy cannot be written by an API session.
--
-- ---------------------------------------------------------------------------
-- B. Financial integrity
--
-- 1. Duplicate payment submissions. `rpc_record_payment` checked the balance
--    but not idempotency: a double-clicked "Record payment" button, or a retry
--    after a timeout that had actually succeeded, inserted a second payment
--    with the same reference. Verified before the fix: two payments for
--    ₹400.00 with reference 'REF-1' both landed.
-- 2. Invoice line items could be edited after money had been taken against the
--    invoice, and the parent subtotal was not re-checked. The total guard only
--    fired on the invoices row, so changing an item left subtotal ≠ sum(items),
--    and a reprint could show line items that do not add up to the amount
--    charged.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A1. Grants that sanction an identity change. Owner-only: no grant to anon,
--     authenticated, or service_role, and no RLS policy at all.
-- ---------------------------------------------------------------------------
create table if not exists public.identity_change_grants (
  token      uuid primary key default gen_random_uuid(),
  actor      uuid,
  reason     text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 minutes'
);

alter table public.identity_change_grants enable row level security;
-- 0005 installs default privileges that would otherwise hand this table to
-- `authenticated`, so the revoke is explicit and comes after the create.
revoke all on public.identity_change_grants from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A2. The guard.
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_identity_changed boolean :=
    new.role is distinct from old.role or new.client_id is distinct from old.client_id;
begin
  -- Invariants that hold for every writer, including service role and SQL.
  if new.client_id is not null then
    if new.role <> 'client' then
      raise exception
        'A client-linked profile must have role ''client'' (got role % for client %)',
        new.role, new.client_id
        using errcode = '23514';
    end if;
    if not exists (select 1 from public.clients c where c.id = new.client_id) then
      raise exception 'Client % does not exist; refusing to link a profile to it', new.client_id
        using errcode = '23503';
    end if;
  end if;

  -- Not an identity change: keep the existing activation rule and stop.
  if not v_identity_changed then
    if new.is_active is distinct from old.is_active
       and auth.uid() is not null
       and not public.is_admin() then
      raise exception 'Only an administrator can change activation' using errcode = '42501';
    end if;
    return new;
  end if;

  -- An identity change. From an API session it needs both admin rights and a
  -- grant row that only the owner can have written.
  if auth.uid() is not null then
    if not public.is_admin() then
      raise exception 'Only an administrator can change a profile role or client link'
        using errcode = '42501';
    end if;

    if not exists (select 1 from public.identity_change_grants g where g.expires_at > now()) then
      raise exception
        'Role and client-link changes must go through rpc_set_profile_identity(); direct updates are refused so a customer cannot be reassigned by accident.'
        using errcode = '42501';
    end if;
  end if;

  -- One-shot: a grant authorises exactly one update.
  delete from public.identity_change_grants;

  -- Always audited, whatever the caller.
  insert into public.audit_logs (actor_id, actor_label, action, entity, entity_id, before, after)
  values (
    auth.uid(),
    case when auth.uid() is null then 'system' else 'user' end,
    'profile.identity.change',
    'profiles',
    new.id,
    jsonb_build_object('role', old.role, 'client_id', old.client_id),
    jsonb_build_object('role', new.role, 'client_id', new.client_id)
  );

  return new;
end $$;

-- Replaces the narrower guard installed by 0002/0007 (same trigger, same
-- timing), so there is only ever one policy for these columns.
drop trigger if exists profiles_guard on public.profiles;
drop trigger if exists profiles_identity_guard on public.profiles;
create trigger profiles_identity_guard before update on public.profiles
  for each row execute function public.guard_profile_identity();

-- ---------------------------------------------------------------------------
-- A3. The deliberate, audited path. Owner-only, like rpc_promote_admin: it is
--     a SQL-editor operation, not an API endpoint. Keeping it out of the
--     privilege policy table means enforce_function_privileges() closes it.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_set_profile_identity(
  p_user_id   uuid,
  p_role      app_role,
  p_client_id uuid default null,
  p_reason    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.profiles%rowtype;
  v_after  public.profiles%rowtype;
begin
  if p_user_id is null or p_role is null then
    raise exception 'A user id and a role are required' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 8 then
    raise exception 'A reason of at least 8 characters is required for an identity change'
      using errcode = '22023';
  end if;

  select * into v_before from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'No such profile' using errcode = 'P0002';
  end if;

  if p_role = 'admin' and p_client_id is not null then
    raise exception 'An administrator cannot also be linked to a client portal'
      using errcode = '22023';
  end if;

  -- Leaving an admin role must not empty the workspace.
  if v_before.role = 'admin' and p_role <> 'admin' then
    if (select count(*) from public.profiles
         where role = 'admin' and is_active and id <> p_user_id) = 0 then
      raise exception 'Refusing to remove the last active administrator' using errcode = 'P0001';
    end if;
  end if;

  -- Serialise with rpc_set_admin_active() so the two cannot interleave.
  perform pg_advisory_xact_lock(hashtext('lunadesk.admin_state'));

  insert into public.identity_change_grants (actor, reason) values (auth.uid(), trim(p_reason));

  update public.profiles
     set role = p_role,
         client_id = p_client_id,
         -- A client-linked or demoted profile must not keep an admin grant.
         is_active = case when p_role = 'admin' then is_active else true end
   where id = p_user_id;

  if p_role = 'admin' then
    insert into public.user_roles (user_id, role) values (p_user_id, 'admin')
    on conflict (user_id, role) do nothing;
  else
    delete from public.user_roles where user_id = p_user_id and role = 'admin';
  end if;

  select * into v_after from public.profiles where id = p_user_id;

  return jsonb_build_object(
    'ok', true,
    'role', v_after.role,
    'client_id', v_after.client_id,
    'changed', v_before.role is distinct from v_after.role
               or v_before.client_id is distinct from v_after.client_id
  );
end $$;

revoke all on function public.rpc_set_profile_identity(uuid, app_role, uuid, text)
  from public, anon, authenticated, service_role;

comment on function public.rpc_set_profile_identity(uuid, app_role, uuid, text) is
  'Owner-only (SQL editor). The only sanctioned way to change profiles.role or profiles.client_id. Audited.';

-- ---------------------------------------------------------------------------
-- B1. One live payment per (invoice, reference).
--
--     The reference is the operator's own external identifier (UPI reference,
--     bank UTR, cheque number), so a repeat within one invoice is a
--     double-submit, not a second payment. Voided payments are excluded: a
--     corrected entry may reuse the reference.
-- ---------------------------------------------------------------------------
do $$
declare v_dupes text;
begin
  select string_agg(invoice_id || ' / ' || reference, ', ') into v_dupes
    from (
      select invoice_id, reference
        from public.payments
       where reference is not null and voided_at is null
       group by invoice_id, reference
      having count(*) > 1
    ) d;

  if v_dupes is not null then
    raise exception
      'Cannot enforce one payment per reference: existing duplicates must be resolved first (%).',
      v_dupes;
  end if;
end $$;

create unique index if not exists payments_invoice_reference_unique
  on public.payments (invoice_id, reference)
  where reference is not null and voided_at is null;

-- ---------------------------------------------------------------------------
-- B2. rpc_record_payment: reject a duplicate reference with a message an
--     operator can act on, and let the unique index be the race-proof backstop
--     (two concurrent submissions of the same reference).
-- ---------------------------------------------------------------------------
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
  v_reference text := nullif(trim(coalesce(p_reference, '')), '');
begin
  perform public.assert_admin();

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

  -- Idempotency. A repeated reference on the same invoice means the operator
  -- submitted the same payment twice (double click, retry after a timeout).
  if v_reference is not null then
    select * into v_payment
      from public.payments
     where invoice_id = p_invoice_id
       and reference = v_reference
       and voided_at is null
     limit 1;

    if found then
      raise exception
        'A payment of % minor units with reference % is already recorded against this invoice (payment %). Void it first if it was wrong.',
        v_payment.amount_minor, v_reference, v_payment.id
        using errcode = 'P0001';
    end if;
  end if;

  select coalesce(sum(amount_minor), 0) into v_paid
  from public.payments
  where invoice_id = p_invoice_id and voided_at is null;

  if v_paid + p_amount_minor > v_invoice.total_minor then
    raise exception 'Payment exceeds the outstanding balance of % minor units',
      v_invoice.total_minor - v_paid using errcode = '22023';
  end if;

  begin
    insert into public.payments (
      client_id, invoice_id, amount_minor, paid_at, method, reference, notes, created_by
    ) values (
      v_invoice.client_id, p_invoice_id, p_amount_minor,
      coalesce(p_paid_at, current_date), coalesce(p_method, 'upi'),
      v_reference, nullif(trim(coalesce(p_notes, '')), ''), auth.uid()
    )
    returning * into v_payment;
  exception when unique_violation then
    -- Lost a race with a concurrent identical submission.
    raise exception
      'A payment with reference % was recorded against this invoice by another request.',
      v_reference using errcode = 'P0001';
  end;

  v_status := case
    when v_paid + p_amount_minor >= v_invoice.total_minor then 'paid'
    when v_invoice.due_date is not null and v_invoice.due_date < current_date then 'overdue'
    else 'partially_paid'
  end;

  update public.invoices set status = v_status where id = p_invoice_id;

  perform public.audit('payment.record', 'payments', v_payment.id, null, to_jsonb(v_payment));
  return v_payment;
end $$;

-- ---------------------------------------------------------------------------
-- B3. Invoice line items are the source of truth for the subtotal, and they
--     freeze once money or a receipt exists.
-- ---------------------------------------------------------------------------
create or replace function public.guard_invoice_items()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
  v_paid    bigint;
  v_receipt boolean;
  v_sum     bigint;
  v_disc    bigint;
  v_tax     bigint;
  v_total   bigint;
begin
  -- Lock the parent so a concurrent payment cannot slip in between the check
  -- and the recomputation.
  select discount_minor, tax_minor into v_disc, v_tax
    from public.invoices where id = v_invoice for update;
  if not found then
    return null;
  end if;

  select coalesce(sum(amount_minor), 0) into v_paid
    from public.payments where invoice_id = v_invoice and voided_at is null;

  v_receipt := exists (select 1 from public.receipts where invoice_id = v_invoice);

  if v_paid > 0 or v_receipt then
    raise exception
      'Invoice % already has payments or a receipt; its line items can no longer change.',
      v_invoice
      using errcode = 'P0001';
  end if;

  select coalesce(sum(amount_minor), 0) into v_sum
    from public.invoice_items where invoice_id = v_invoice;

  v_total := v_sum - coalesce(v_disc, 0) + coalesce(v_tax, 0);
  if v_total < 0 then
    raise exception 'Invoice % would have a negative total (%)', v_invoice, v_total
      using errcode = '22023';
  end if;

  -- Keep the parent consistent in the same transaction, so subtotal always
  -- equals the sum of the items and the receipt snapshot can never disagree
  -- with the lines it prints.
  update public.invoices
     set subtotal_minor = v_sum,
         total_minor    = v_total
   where id = v_invoice
     and (subtotal_minor <> v_sum or total_minor <> v_total);

  return null;
end $$;

drop trigger if exists invoice_items_guard on public.invoice_items;
create trigger invoice_items_guard
  after insert or update or delete on public.invoice_items
  for each row execute function public.guard_invoice_items();

-- ---------------------------------------------------------------------------
-- C. Re-apply the privilege policy for everything above.
-- ---------------------------------------------------------------------------
select public.enforce_function_privileges();
