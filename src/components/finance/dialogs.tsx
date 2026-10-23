import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Field, Select, TextArea, TextInput } from '@/components/ui';
import { Modal } from '@/components/ui/overlays';
import { useCollection, useData, useToast } from '@/context/app';
import { balanceMinor, paidMinor } from '@/lib/finance';
import { formatMoney, minorToInput, parseMoneyToMinor } from '@/lib/money';
import { paymentMethodLabel, paymentStatusMeta } from '@/lib/labels';
import { todayISO } from '@/lib/dates';
import type { BrandingSettings, Client, Invoice, Payment, PaymentMethod } from '@/lib/types';
import { uuid } from '@/lib/utils';

/**
 * Records a payment against a specific invoice.
 *
 * In live mode this calls the `record_payment` Postgres function, which
 * re-validates the amount server-side, refuses overpayment, and writes the
 * audit row — the browser is never trusted with the arithmetic.
 */
export function PaymentDialog({
  open,
  onClose,
  invoice,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  invoice: Invoice | null;
  onRecorded?: (paymentId: string, invoiceId: string) => void;
}) {
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const toast = useToast();
  const { data: payments, refresh } = useCollection<Payment>('payments');
  const { data: invoices } = useCollection<Invoice>('invoices');
  const { data: clients } = useCollection<Client>('clients');

  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('upi');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [issueReceipt, setIssueReceipt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openInvoices = useMemo(
    () => invoices.filter((i) => i.status !== 'cancelled' && balanceMinor(i, payments) > 0),
    [invoices, payments],
  );

  const selected = invoices.find((i) => i.id === invoiceId) ?? null;
  const outstanding = selected ? balanceMinor(selected, payments) : 0;

  useEffect(() => {
    if (!open) return;
    const initial = invoice?.id ?? openInvoices[0]?.id ?? '';
    setInvoiceId(initial);
    const inv = invoices.find((i) => i.id === initial);
    setAmount(inv ? minorToInput(balanceMinor(inv, payments)) : '');
    setMethod('upi');
    setReference('');
    setPaidAt(todayISO());
    setNotes('');
    setIssueReceipt(true);
    setError(null);
  }, [open, invoice, invoices, payments, openInvoices]);

  const amountMinor = parseMoneyToMinor(amount);

  const submit = async () => {
    setError(null);
    if (!selected) {
      setError('Choose an invoice to record this payment against.');
      return;
    }
    if (amountMinor === null || amountMinor <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (amountMinor > outstanding) {
      setError(`That is more than the ${formatMoney(outstanding)} outstanding on this invoice.`);
      return;
    }
    setBusy(true);
    try {
      const payment = await adapter.rpc<Payment>('record_payment', {
        invoice_id: selected.id,
        amount_minor: amountMinor,
        method,
        reference: reference.trim() || null,
        paid_at: paidAt,
        notes: notes.trim() || null,
      });
      let receiptId: string | null = null;
      if (issueReceipt) {
        try {
          const receipt = await adapter.rpc<{ id: string }>('issue_receipt', { payment_id: payment.id });
          receiptId = receipt.id;
        } catch (receiptError) {
          toast.warning(
            'Payment saved, receipt not issued',
            receiptError instanceof Error ? receiptError.message : undefined,
          );
        }
      }
      toast.success('Payment recorded', `${formatMoney(amountMinor)} against ${selected.invoice_number}.`);
      refresh();
      invalidate();
      onRecorded?.(payment.id, selected.id);
      if (receiptId) {
        toast.info('Receipt issued', 'Open Receipts to print or reprint it.');
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The payment could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a payment"
      description="Payments are recorded against one invoice, so recurring services stay reconciled period by period."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <p role="alert" className="rounded-lg border border-magenta/30 bg-magenta/[0.07] px-3 py-2 text-xs text-accent-danger">
            {error}
          </p>
        )}

        <Field label="Invoice" required>
          {(id) => (
            <Select
              id={id}
              value={invoiceId}
              onChange={(e) => {
                setInvoiceId(e.target.value);
                const inv = invoices.find((i) => i.id === e.target.value);
                setAmount(inv ? minorToInput(balanceMinor(inv, payments)) : '');
              }}
              autoFocus
            >
              {openInvoices.length === 0 && <option value="">No invoices with an outstanding balance</option>}
              {openInvoices.map((inv) => {
                const client = clients.find((c) => c.id === inv.client_id);
                return (
                  <option key={inv.id} value={inv.id}>
                    {inv.invoice_number} · {client?.name ?? 'Client'} · {formatMoney(balanceMinor(inv, payments))} due
                  </option>
                );
              })}
            </Select>
          )}
        </Field>

        {selected && (
          <div className="grid grid-cols-3 gap-2 rounded-xl border p-3 text-center" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
            <div>
              <p className="eyebrow">Invoice total</p>
              <p className="num mt-1 text-sm text-fg">{formatMoney(selected.total_minor)}</p>
            </div>
            <div>
              <p className="eyebrow">Already paid</p>
              <p className="num mt-1 text-sm text-mint">{formatMoney(paidMinor(selected.id, payments))}</p>
            </div>
            <div>
              <p className="eyebrow">Outstanding</p>
              <p className="num mt-1 text-sm text-magenta">{formatMoney(outstanding)}</p>
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount received" hint="Partial payments are supported">
            {(id) => (
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-faint">₹</span>
                <TextInput
                  id={id}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="num pl-7"
                />
              </div>
            )}
          </Field>
          <Field label="Payment date">
            {(id) => <TextInput id={id} type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />}
          </Field>
          <Field label="Method">
            {(id) => (
              <Select id={id} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {Object.entries(paymentMethodLabel).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Reference" hint="UTR, UPI ref, cheque number">
            {(id) => (
              <TextInput id={id} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UPI/123456789" />
            )}
          </Field>
        </div>

        <Field label="Notes">
          {(id) => (
            <TextArea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. balance promised next cycle" className="min-h-[64px]" />
          )}
        </Field>

        <label className="flex items-start gap-2.5 rounded-xl border p-3" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
          <input
            type="checkbox"
            checked={issueReceipt}
            onChange={(e) => setIssueReceipt(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded accent-[#FF2D95]"
          />
          <span>
            <span className="block text-[12.5px] font-medium text-fg">Issue a receipt now</span>
            <span className="mt-0.5 block text-[11px] text-muted">
              A receipt is only ever created alongside a real recorded payment. Its number is generated server-side.
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
}

interface DraftItem {
  key: string;
  description: string;
  quantity: string;
  unit: string;
}

/**
 * Creates an invoice. Amounts are captured in rupees and stored in paise.
 * Receipts are *not* created here — only a recorded payment can produce one.
 */
export function InvoiceDialog({
  open,
  onClose,
  defaultClientId,
  defaultServiceId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  defaultClientId?: string;
  defaultServiceId?: string;
  onCreated?: (invoice: Invoice) => void;
}) {
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const toast = useToast();
  const { data: clients } = useCollection<Client>('clients');
  const { data: branded } = useCollection<BrandingSettings>('branding_settings');
  const branding = branded[0];

  const [clientId, setClientId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [issueDate, setIssueDate] = useState(todayISO());
  const [dueDate, setDueDate] = useState(todayISO());
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [discount, setDiscount] = useState('0');
  const [tax, setTax] = useState('0');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<DraftItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const prefix = branding?.invoice_prefix ?? 'MBL-INV';
    const year = new Date().getFullYear();
    setClientId(defaultClientId ?? clients[0]?.id ?? '');
    setInvoiceNumber(`${prefix}-${year}-${String(Math.floor(Math.random() * 9000) + 1000)}`);
    setIssueDate(todayISO());
    const d = new Date();
    d.setDate(d.getDate() + 7);
    setDueDate(d.toISOString().slice(0, 10));
    const first = new Date();
    first.setDate(1);
    setPeriodStart(first.toISOString().slice(0, 10));
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    setPeriodEnd(last.toISOString().slice(0, 10));
    setDiscount('0');
    setTax('0');
    setNotes('');
    setItems([{ key: uuid(), description: '', quantity: '1', unit: '' }]);
    setError(null);
  }, [open, clients, branding, defaultClientId]);

  const subtotal = items.reduce((sum, item) => {
    const unit = parseMoneyToMinor(item.unit) ?? 0;
    const qty = Number(item.quantity) || 0;
    return sum + Math.round(unit * qty);
  }, 0);
  const discountMinor = parseMoneyToMinor(discount) ?? 0;
  const taxMinor = parseMoneyToMinor(tax) ?? 0;
  const total = Math.max(0, subtotal - discountMinor + taxMinor);

  const submit = async () => {
    setError(null);
    if (!clientId) return setError('Choose a client.');
    if (!invoiceNumber.trim()) return setError('An invoice number is required.');
    const cleanItems = items.filter((i) => i.description.trim() && (parseMoneyToMinor(i.unit) ?? 0) > 0);
    if (!cleanItems.length) return setError('Add at least one line item with a description and an amount.');

    setBusy(true);
    try {
      const invoice = await adapter.insert<Invoice>('invoices', {
        invoice_number: invoiceNumber.trim(),
        client_id: clientId,
        client_service_id: defaultServiceId ?? null,
        billing_period_start: periodStart || null,
        billing_period_end: periodEnd || null,
        issue_date: issueDate,
        due_date: dueDate,
        subtotal_minor: subtotal,
        discount_minor: discountMinor,
        tax_minor: taxMinor,
        total_minor: total,
        status: 'pending',
        notes: notes.trim() || null,
      });
      await Promise.all(
        cleanItems.map((item, index) => {
          const unit = parseMoneyToMinor(item.unit) ?? 0;
          const qty = Number(item.quantity) || 1;
          return adapter.insert('invoice_items', {
            id: uuid(),
            invoice_id: invoice.id,
            description: item.description.trim(),
            quantity: qty,
            unit_price_minor: unit,
            amount_minor: Math.round(unit * qty),
            position: index,
          });
        }),
      );
      toast.success('Invoice created', `${invoice.invoice_number} · ${formatMoney(total)}`);
      invalidate();
      onCreated?.(invoice);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The invoice could not be created.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="New invoice"
      description="Invoices drive receivables. A receipt is only generated when a payment is recorded against one."
      footer={
        <>
          <div className="mr-auto text-xs text-muted">
            Total <span className="num ml-1 text-sm font-semibold text-fg">{formatMoney(total)}</span>
          </div>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            Create invoice
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <p role="alert" className="rounded-lg border border-magenta/30 bg-magenta/[0.07] px-3 py-2 text-xs text-accent-danger">
            {error}
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client" required>
            {(id) => (
              <Select id={id} value={clientId} onChange={(e) => setClientId(e.target.value)} autoFocus>
                {clients.length === 0 && <option value="">Add a client first</option>}
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Invoice number" hint="Must be unique — generated from your prefix">
            {(id) => <TextInput id={id} value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className="font-mono text-xs" />}
          </Field>
          <Field label="Issue date">
            {(id) => <TextInput id={id} type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />}
          </Field>
          <Field label="Due date">
            {(id) => <TextInput id={id} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}
          </Field>
          <Field label="Billing period start">
            {(id) => <TextInput id={id} type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />}
          </Field>
          <Field label="Billing period end">
            {(id) => <TextInput id={id} type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />}
          </Field>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="label mb-0">Line items</p>
            <Button
              size="sm"
              variant="quiet"
              onClick={() => setItems((prev) => [...prev, { key: uuid(), description: '', quantity: '1', unit: '' }])}
              icon={<Plus className="h-3 w-3" />}
            >
              Add line
            </Button>
          </div>
          <div className="space-y-2">
            {items.map((item, index) => (
              <div key={item.key} className="grid grid-cols-[1fr_60px_100px_auto] items-center gap-2">
                <TextInput
                  value={item.description}
                  onChange={(e) => setItems((prev) => prev.map((it, i) => (i === index ? { ...it, description: e.target.value } : it)))}
                  placeholder="Service description"
                  aria-label={`Line ${index + 1} description`}
                />
                <TextInput
                  value={item.quantity}
                  onChange={(e) => setItems((prev) => prev.map((it, i) => (i === index ? { ...it, quantity: e.target.value } : it)))}
                  inputMode="decimal"
                  aria-label={`Line ${index + 1} quantity`}
                  className="num text-center"
                />
                <div className="relative">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] text-faint">₹</span>
                  <TextInput
                    value={item.unit}
                    onChange={(e) => setItems((prev) => prev.map((it, i) => (i === index ? { ...it, unit: e.target.value } : it)))}
                    inputMode="decimal"
                    aria-label={`Line ${index + 1} amount`}
                    className="num pl-6"
                    placeholder="0"
                  />
                </div>
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
                  disabled={items.length === 1}
                  aria-label={`Remove line ${index + 1}`}
                  icon={<Trash2 className="h-3 w-3" />}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Discount">
            {(id) => (
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-faint">₹</span>
                <TextInput id={id} value={discount} onChange={(e) => setDiscount(e.target.value)} inputMode="decimal" className="num pl-7" />
              </div>
            )}
          </Field>
          <Field label="Tax">
            {(id) => (
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-faint">₹</span>
                <TextInput id={id} value={tax} onChange={(e) => setTax(e.target.value)} inputMode="decimal" className="num pl-7" />
              </div>
            )}
          </Field>
          <div className="rounded-xl border p-2.5 text-xs" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
            <p className="flex justify-between text-muted">
              <span>Subtotal</span>
              <span className="num">{formatMoney(subtotal)}</span>
            </p>
            <p className="mt-1 flex justify-between text-fg">
              <span>Total</span>
              <span className="num font-semibold">{formatMoney(total)}</span>
            </p>
          </div>
        </div>

        <Field label="Notes">
          {(id) => (
            <TextArea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Payment terms, PO number, context" className="min-h-[60px]" />
          )}
        </Field>

        <p className="flex flex-wrap items-center gap-2 text-[10.5px] text-faint">
          <Badge tone="neutral">Draft status: {paymentStatusMeta.pending.label}</Badge>
          Tax is entered manually — LunaDesk never invents a GSTIN or tax rate for you.
        </p>
      </div>
    </Modal>
  );
}
