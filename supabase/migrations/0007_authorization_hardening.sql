-- =============================================================================
-- LunaDesk · 0007 — pre-Supabase hardening: authorization
--
-- Fixes found in the pre-deployment audit (see docs/AUDIT.md):
--
--  1. is_admin() trusted `user_roles` without checking the profile, so
--     deactivating an admin left them fully authorized through the role table.
--  2. `payments`, `receipts` and `document_sequences` were writable through
--     PostgREST by any admin session, bypassing the transactional RPCs that
--     enforce overpayment rules, receipt numbering and immutability.
--  3. An invoice's stored status could be set to 'paid' by hand, i.e. revenue
--     could be forged without a payment row.
--  4. Access codes had no expiry, and admin-code rate limiting was global
--     (constant hint 'ADI'), so anyone could lock every admin out with ten
--     requests.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Role check: a deactivated profile is never an admin, whichever path
--    grants the role. `user_roles` remains an additional grant, not a bypass.
-- ----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.is_active
      and (
        p.role = 'admin'
        or exists (
          select 1 from public.user_roles r
          where r.user_id = p.id and r.role = 'admin'
        )
      )
  );
$$;

-- A client profile that has been deactivated must not resolve to a tenant
-- either (this was already true, restated here so both helpers agree).
create or replace function public.current_client_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.client_id
  from public.profiles p
  join public.clients c on c.id = p.client_id
  where p.id = auth.uid()
    and p.role = 'client'
    and p.is_active
    and c.status = 'active'
    and c.portal_status = 'active';
$$;

-- ----------------------------------------------------------------------------
-- 2. Financial tables: read-only through the API.
--
--    Rows are created, corrected and voided only inside SECURITY DEFINER
--    functions (rpc_record_payment, rpc_void_payment, rpc_issue_receipt). Those
--    functions run as the schema owner, so they are unaffected by these
--    privileges; a signed-in admin using PostgREST or supabase-js directly is
--    not.
-- ----------------------------------------------------------------------------
revoke insert, update, delete, truncate on public.payments from authenticated;
revoke insert, update, delete, truncate on public.receipts from authenticated;
revoke insert, update, delete, truncate on public.document_sequences from authenticated;
revoke insert, update, delete, truncate on public.audit_logs from authenticated;
revoke insert, update, delete, truncate on public.access_attempts from authenticated;

drop policy if exists "payments: admin write" on public.payments;
drop policy if exists "receipts: admin write" on public.receipts;
drop policy if exists "sequences: admin" on public.document_sequences;

drop policy if exists "payments: admin read" on public.payments;
create policy "payments: admin read" on public.payments
  for select to authenticated using (public.is_admin() or public.is_client_of(client_id));

drop policy if exists "receipts: admin read" on public.receipts;
create policy "receipts: admin read" on public.receipts
  for select to authenticated using (public.is_admin() or public.is_client_of(client_id));

drop policy if exists "sequences: admin read" on public.document_sequences;
create policy "sequences: admin read" on public.document_sequences
  for select to authenticated using (public.is_admin());

-- Receipt snapshots are documents: no UPDATE path exists for anyone but the
-- RPCs. The audit log is append-only for the same reason.
revoke update on public.receipts from authenticated;

-- ----------------------------------------------------------------------------
-- 3. Invoice status is derived, never supplied.
--
--    A stored status of 'paid' with no payment rows is a bookkeeping lie and
--    would also be readable by the client in their portal. The guard recomputes
--    it on every write; 'cancelled' is the one status an admin may set, because
--    it expresses intent rather than arithmetic.
-- ----------------------------------------------------------------------------
create or replace function public.derive_invoice_status(p_invoice_id uuid)
returns payment_status
language sql
stable
security definer
set search_path = public
as $$
  select case
    when i.status = 'cancelled' then 'cancelled'::payment_status
    when coalesce(p.paid, 0) >= i.total_minor then 'paid'::payment_status
    when i.due_date is not null and i.due_date < current_date then 'overdue'::payment_status
    when coalesce(p.paid, 0) > 0 then 'partially_paid'::payment_status
    else 'pending'::payment_status
  end
  from public.invoices i
  left join (
    select invoice_id, sum(amount_minor) as paid
    from public.payments
    where voided_at is null
    group by invoice_id
  ) p on p.invoice_id = i.id
  where i.id = p_invoice_id;
$$;

create or replace function public.guard_invoice_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paid  bigint;
  v_state payment_status;
begin
  -- Cancelling is a deliberate act and is preserved.
  if new.status = 'cancelled' and (tg_op = 'INSERT' or old.status = 'cancelled') then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.status = 'cancelled' and old.status <> 'cancelled' then
    return new;
  end if;

  select coalesce(sum(amount_minor), 0) into v_paid
  from public.payments
  where invoice_id = new.id and voided_at is null;

  v_state := case
    when v_paid >= new.total_minor then 'paid'
    when new.due_date is not null and new.due_date < current_date then 'overdue'
    when v_paid > 0 then 'partially_paid'
    else 'pending'
  end;

  -- Silently correcting is better than rejecting: the client never sends a
  -- status on purpose, and a rejected write would surface as a confusing error.
  new.status := v_state;
  return new;
end $$;

drop trigger if exists invoices_status_guard on public.invoices;
create trigger invoices_status_guard
  before insert or update of status, total_minor, due_date on public.invoices
  for each row execute function public.guard_invoice_status();

-- Keep the existing post-payment recomputation in sync with the same rules.
create or replace function public.sync_invoice_status(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paid  bigint;
  v_total bigint;
  v_due   date;
  v_state payment_status;
  v_now   payment_status;
begin
  select total_minor, due_date, status into v_total, v_due, v_state
  from public.invoices where id = p_invoice_id;
  if not found or v_state = 'cancelled' then
    return;
  end if;

  select coalesce(sum(amount_minor), 0) into v_paid
  from public.payments where invoice_id = p_invoice_id and voided_at is null;

  v_now := case
    when v_paid >= v_total then 'paid'
    when v_due is not null and v_due < current_date then 'overdue'
    when v_paid > 0 then 'partially_paid'
    else 'pending'
  end;

  if v_now <> v_state then
    update public.invoices set status = v_now where id = p_invoice_id;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Access-code expiry
-- ----------------------------------------------------------------------------
alter table public.client_access_codes add column if not exists expires_at timestamptz;
alter table public.admin_access_codes  add column if not exists expires_at timestamptz;

comment on column public.client_access_codes.expires_at is
  'Optional hard expiry. NULL means the code lives until rotated or revoked.';

create index if not exists access_codes_expiry_idx
  on public.client_access_codes (expires_at) where not is_revoked and expires_at is not null;

-- Admin-only: set or clear the expiry on a client's current code.
create or replace function public.rpc_set_client_code_expiry(
  p_client_id  uuid,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_admin();
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'Expiry must be in the future' using errcode = '22023';
  end if;
  update public.client_access_codes
     set expires_at = p_expires_at
   where client_id = p_client_id and not is_revoked;
  perform public.audit('portal.access.expiry', 'clients', p_client_id, null,
                       jsonb_build_object('expires_at', p_expires_at));
end $$;

grant execute on function public.rpc_set_client_code_expiry(uuid, timestamptz) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Attempt ledger: allow recording the real prefix so limits are per-code
--    rather than per-constant, and keep the table service-role/write-through
--    only (a client must not be able to erase their own failed attempts).
-- ----------------------------------------------------------------------------
alter table public.access_attempts add column if not exists code_kind text
  check (code_kind is null or code_kind in ('client', 'admin'));

create index if not exists access_attempts_ip_recent_idx
  on public.access_attempts (ip, created_at desc);
create index if not exists access_attempts_hint_recent_idx
  on public.access_attempts (code_hint, created_at desc);

-- ----------------------------------------------------------------------------
-- 6. Internal-note upserts must be possible through PostgREST.
--
--    The unique indexes above are partial (`where … is not null`), and
--    PostgREST's `?on_conflict=` requires a constraint it can name. The client
--    adapter upserts one note per owner, so the indexes are made total: in
--    Postgres, NULLs are distinct in a unique index, so a row belonging to a
--    client still does not collide with service/project notes.
-- ----------------------------------------------------------------------------
drop index if exists public.internal_notes_client_idx;
drop index if exists public.internal_notes_service_idx;
drop index if exists public.internal_notes_project_idx;

create unique index if not exists internal_notes_client_idx
  on public.internal_notes (client_id);
create unique index if not exists internal_notes_service_idx
  on public.internal_notes (client_service_id);
create unique index if not exists internal_notes_project_idx
  on public.internal_notes (project_id);
