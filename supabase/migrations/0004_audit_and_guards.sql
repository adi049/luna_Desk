-- =============================================================================
-- LunaDesk · 0004 — audit triggers + integrity guards
--
-- The audit trail is written by the database, not the UI: a correction made
-- through any client (app, SQL editor, Edge Function) is still recorded.
-- =============================================================================

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity_id uuid;
  v_action    text;
begin
  v_entity_id := coalesce((to_jsonb(new) ->> 'id')::uuid, (to_jsonb(old) ->> 'id')::uuid);
  v_action := lower(tg_table_name) || '.' || lower(tg_op);

  if tg_op = 'UPDATE' then
    -- Skip no-op touches so the log stays readable.
    if to_jsonb(new) - 'updated_at' = to_jsonb(old) - 'updated_at' then
      return new;
    end if;
    perform public.audit(v_action, tg_table_name, v_entity_id, to_jsonb(old), to_jsonb(new));
    return new;
  elsif tg_op = 'INSERT' then
    perform public.audit(v_action, tg_table_name, v_entity_id, null, to_jsonb(new));
    return new;
  else
    perform public.audit(v_action, tg_table_name, v_entity_id, to_jsonb(old), null);
    return old;
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['clients', 'client_services', 'projects', 'invoices', 'branding_settings']
  loop
    execute format('drop trigger if exists %I_audit on public.%I', t, t);
    execute format(
      'create trigger %I_audit after insert or update or delete on public.%I
         for each row execute function public.audit_row_change()', t, t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Integrity guards
-- ----------------------------------------------------------------------------

-- Re-derive the stored invoice status whenever its payments change. This keeps
-- list views and reports honest even if a RPC is bypassed.
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

  -- Precedence matches src/lib/finance.ts#effectiveStatus: an unpaid balance
  -- that is past its due date is 'overdue', whether or not it was part-paid.
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

create or replace function public.payments_sync_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_invoice_status(coalesce(new.invoice_id, old.invoice_id));
  return coalesce(new, old);
end $$;

drop trigger if exists payments_sync on public.payments;
create trigger payments_sync after insert or update or delete on public.payments
  for each row execute function public.payments_sync_invoice();

-- Invoice totals must equal the sum of their items (when items exist).
create or replace function public.guard_invoice_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items bigint;
  v_sum   bigint;
begin
  select count(*), coalesce(sum(amount_minor), 0) into v_items, v_sum
  from public.invoice_items where invoice_id = new.id;
  if v_items > 0 and new.subtotal_minor <> v_sum then
    raise exception 'Invoice subtotal (%) does not match its items (%)', new.subtotal_minor, v_sum
      using errcode = '22023';
  end if;
  if new.total_minor <> new.subtotal_minor - new.discount_minor + new.tax_minor then
    raise exception 'Invoice total must equal subtotal − discount + tax' using errcode = '22023';
  end if;
  return new;
end $$;

drop trigger if exists invoices_total_guard on public.invoices;
create trigger invoices_total_guard before insert or update of subtotal_minor, discount_minor, tax_minor, total_minor
  on public.invoices for each row execute function public.guard_invoice_total();

-- A client cannot be archived while money is still outstanding: archiving is
-- an organisational action, not a way to erase receivables.
create or replace function public.guard_client_archive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_outstanding bigint;
begin
  if new.status = 'archived' and old.status <> 'archived' then
    select coalesce(sum(greatest(i.total_minor - coalesce(p.paid, 0), 0)), 0) into v_outstanding
    from public.invoices i
    left join (
      select invoice_id, sum(amount_minor) as paid
      from public.payments where voided_at is null group by invoice_id
    ) p on p.invoice_id = i.id
    where i.client_id = new.id and i.status <> 'cancelled' and i.status <> 'paid';

    if v_outstanding > 0 then
      raise exception 'Client has % minor units outstanding; settle or cancel those invoices first',
        v_outstanding using errcode = 'P0001';
    end if;

    update public.client_access_codes set is_revoked = true, rotated_at = now()
     where client_id = new.id and not is_revoked;
    update public.profiles set is_active = false
     where client_id = new.id and role = 'client';
    new.portal_status := 'revoked';
  end if;
  return new;
end $$;

drop trigger if exists clients_archive_guard on public.clients;
create trigger clients_archive_guard before update of status on public.clients
  for each row execute function public.guard_client_archive();

-- Completing a task stamps its completion time; reopening clears it.
create or replace function public.guard_task_completion()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'completed' and old.status <> 'completed' then
    new.completed_at := coalesce(new.completed_at, now());
  elsif new.status <> 'completed' then
    new.completed_at := null;
  end if;
  return new;
end $$;

drop trigger if exists tasks_completion on public.tasks;
create trigger tasks_completion before update on public.tasks
  for each row execute function public.guard_task_completion();
