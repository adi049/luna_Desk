import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Plus, Receipt as ReceiptIcon, Undo2, Wallet } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Money,
  PageHeader,
  SearchInput,
  Select,
  SkeletonRows,
  StatCard,
  TextInput,
  Toolbar,
} from '@/components/ui';
import { Modal } from '@/components/ui/overlays';
import { PaymentDialog } from '@/components/finance/dialogs';
import { useCollection, useData, useToast } from '@/context/app';
import { paymentMethodLabel } from '@/lib/labels';
import { fmtDate, todayISO } from '@/lib/dates';
import { summariseReceivables } from '@/lib/finance';
import { formatMoney } from '@/lib/money';
import { downloadFile, toCSV } from '@/lib/utils';
import type { Client, Invoice, Payment, PaymentMethod, Receipt } from '@/lib/types';

export default function PaymentsPage() {
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const toast = useToast();

  const { data: payments, loading, refresh } = useCollection<Payment>('payments');
  const { data: invoices } = useCollection<Invoice>('invoices');
  const { data: clients } = useCollection<Client>('clients');
  const { data: receipts, refresh: refreshReceipts } = useCollection<Receipt>('receipts');

  const [search, setSearch] = useState('');
  const [clientFilter, setClientFilter] = useState('all');
  const [methodFilter, setMethodFilter] = useState<'all' | PaymentMethod>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<Payment | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [busy, setBusy] = useState(false);

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? 'Client';
  const invoiceNumber = (id: string) => invoices.find((i) => i.id === id)?.invoice_number ?? '—';

  const active = useMemo(() => payments.filter((p) => !p.voided_at), [payments]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return active
      .filter((p) => clientFilter === 'all' || p.client_id === clientFilter)
      .filter((p) => methodFilter === 'all' || p.method === methodFilter)
      .filter((p) => (!from || p.paid_at >= from) && (!to || p.paid_at <= to))
      .filter((p) => !q || `${clientName(p.client_id)} ${invoiceNumber(p.invoice_id)} ${p.reference ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => b.paid_at.localeCompare(a.paid_at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, search, clientFilter, methodFilter, from, to, clients, invoices]);

  const summary = summariseReceivables(invoices, payments);
  const thisMonth = todayISO().slice(0, 7);
  const monthTotal = active.filter((p) => p.paid_at.slice(0, 7) === thisMonth).reduce((s, p) => s + p.amount_minor, 0);
  const filteredTotal = filtered.reduce((s, p) => s + p.amount_minor, 0);

  // One in-flight request per payment: double-clicking must not fire two calls
  // (the RPC is idempotent, but two spinners and two toasts still read as a bug).
  const issuing = useRef<Set<string>>(new Set());
  const issueReceipt = async (payment: Payment) => {
    if (issuing.current.has(payment.id)) return;
    issuing.current.add(payment.id);
    try {
      const receipt = await adapter.rpc<Receipt>('issue_receipt', { payment_id: payment.id });
      toast.success('Receipt issued', receipt.receipt_number);
      refreshReceipts();
      invalidate();
    } catch (err) {
      toast.error('Could not issue a receipt', err instanceof Error ? err.message : undefined);
    } finally {
      issuing.current.delete(payment.id);
    }
  };

  const voidPayment = async () => {
    if (!voidTarget) return;
    if (voidReason.trim().length < 4) {
      toast.error('Add a reason', 'Corrections are kept in the audit trail, so a reason is required.');
      return;
    }
    setBusy(true);
    try {
      await adapter.rpc('void_payment', { payment_id: voidTarget.id, reason: voidReason.trim() });
      toast.success('Payment voided', 'The invoice balance and status were recalculated. The record is kept for audit.');
      setVoidTarget(null);
      setVoidReason('');
      refresh();
      invalidate();
    } catch (err) {
      toast.error('Could not void the payment', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () => {
    const rows = filtered.map((p) => ({
      date: p.paid_at,
      client: clientName(p.client_id),
      invoice: invoiceNumber(p.invoice_id),
      amount_inr: (p.amount_minor / 100).toFixed(2),
      method: paymentMethodLabel[p.method],
      reference: p.reference ?? '',
      notes: p.notes ?? '',
    }));
    downloadFile(`lunadesk-payments-${todayISO()}.csv`, toCSV(rows));
    toast.success('Export ready', `${rows.length} payments written to CSV.`);
  };

  const voided = payments.filter((p) => p.voided_at);

  return (
    <div>
      <PageHeader
        eyebrow="Money"
        title="Payments"
        description="Money actually received. Every payment belongs to one invoice, and voiding a payment keeps the record with an audit trail rather than erasing it."
        actions={
          <>
            <Button variant="ghost" onClick={exportCsv} disabled={filtered.length === 0} icon={<Download className="h-4 w-4" />}>
              Export CSV
            </Button>
            <Button variant="primary" onClick={() => setDialogOpen(true)} icon={<Plus className="h-4 w-4" />}>
              Record payment
            </Button>
          </>
        }
      />

      <div className="mb-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Received this month" value={formatMoney(monthTotal, { compact: true })} tone="mint" hint={thisMonth} index={0} />
        <StatCard label="Received lifetime" value={formatMoney(summary.received, { compact: true })} hint={`${active.length} payments`} index={1} />
        <StatCard label="Outstanding" value={formatMoney(summary.outstanding, { compact: true })} tone="butter" hint={`${summary.openCount} open invoices`} index={2} />
        <StatCard label="Overdue" value={formatMoney(summary.overdue, { compact: true })} tone={summary.overdue ? 'magenta' : 'neutral'} hint={`${summary.overdueCount} invoices past due`} index={3} />
      </div>

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search client, invoice, reference" className="w-full sm:w-64" />
        <Select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} className="w-40 py-1.5 text-xs" aria-label="Filter by client">
          <option value="all">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select value={methodFilter} onChange={(e) => setMethodFilter(e.target.value as typeof methodFilter)} className="w-36 py-1.5 text-xs" aria-label="Filter by method">
          <option value="all">All methods</option>
          {Object.entries(paymentMethodLabel).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" className="w-36 py-1.5 text-xs" />
          <span className="text-xs text-faint">to</span>
          <TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" className="w-36 py-1.5 text-xs" />
        </div>
      </Toolbar>

      {loading ? (
        <SkeletonRows rows={6} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Wallet className="h-6 w-6" />}
          title={active.length === 0 ? 'No payments recorded' : 'No payments match'}
          description={
            active.length === 0
              ? 'Record a payment against an invoice and LunaDesk will issue a receipt you can print or reprint.'
              : 'Adjust the filters or date range.'
          }
          action={
            active.length === 0 ? (
              <Button variant="primary" size="sm" onClick={() => setDialogOpen(true)} icon={<Plus className="h-3.5 w-3.5" />}>
                Record payment
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="surface overflow-hidden p-0">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Client</th>
                  <th>Invoice</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Receipt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const receipt = receipts.find((r) => r.payment_id === p.id);
                  return (
                    <tr key={p.id}>
                      <td className="whitespace-nowrap text-[11.5px] text-muted">{fmtDate(p.paid_at)}</td>
                      <td>
                        <Link to={`/admin/clients/${p.client_id}`} className="text-[12.5px] font-medium text-fg hover:underline">
                          {clientName(p.client_id)}
                        </Link>
                      </td>
                      <td className="font-mono text-[10.5px] text-muted">{invoiceNumber(p.invoice_id)}</td>
                      <td className="text-[11.5px] text-muted">{paymentMethodLabel[p.method]}</td>
                      <td className="font-mono text-[10.5px] text-faint">{p.reference ?? '—'}</td>
                      <td className="text-right"><Money minor={p.amount_minor} tone="mint" className="text-[12.5px]" /></td>
                      <td className="text-right">
                        {receipt ? (
                          <Link to={`/admin/receipts/${receipt.id}`} className="font-mono text-[10px] text-magenta hover:underline">
                            {receipt.receipt_number}
                          </Link>
                        ) : (
                          <Button size="sm" variant="quiet" onClick={() => void issueReceipt(p)} icon={<ReceiptIcon className="h-3 w-3" />}>
                            Issue
                          </Button>
                        )}
                      </td>
                      <td className="text-right">
                        <Button
                          size="sm"
                          variant="quiet"
                          onClick={() => { setVoidTarget(p); setVoidReason(''); }}
                          aria-label={`Void payment of ${formatMoney(p.amount_minor)}`}
                          icon={<Undo2 className="h-3 w-3" />}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-[11px] text-faint">
            <span>{filtered.length} payments shown</span>
            <span className="num">Total {formatMoney(filteredTotal)}</span>
          </div>
        </div>
      )}

      {voided.length > 0 && (
        <section className="surface mt-3 p-4">
          <h2 className="text-xs font-semibold text-fg">Voided payments (kept for audit)</h2>
          <ul className="mt-2 space-y-1.5">
            {voided.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <Badge tone="muted">void</Badge>
                <span>{fmtDate(p.paid_at)}</span>
                <span className="text-fg">{clientName(p.client_id)}</span>
                <span className="num">{formatMoney(p.amount_minor)}</span>
                <span className="text-faint">— {p.void_reason ?? 'no reason recorded'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PaymentDialog open={dialogOpen} onClose={() => setDialogOpen(false)} invoice={null} onRecorded={() => { refresh(); invalidate(); }} />

      <Modal
        open={Boolean(voidTarget)}
        onClose={() => setVoidTarget(null)}
        title="Void this payment?"
        description="The payment stays in the record with a void flag, the invoice balance is recalculated, and the change is written to the audit log."
        size="sm"
        footer={
          <>
            <Button variant="quiet" onClick={() => setVoidTarget(null)} disabled={busy}>Cancel</Button>
            <Button variant="danger" onClick={() => void voidPayment()} loading={busy}>Void payment</Button>
          </>
        }
      >
        <div className="space-y-3">
          {voidTarget && (
            <div className="rounded-xl border p-3 text-[12px]" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
              <p className="text-fg">{clientName(voidTarget.client_id)} · {invoiceNumber(voidTarget.invoice_id)}</p>
              <p className="num mt-1 text-muted">{formatMoney(voidTarget.amount_minor)} · {fmtDate(voidTarget.paid_at)} · {paymentMethodLabel[voidTarget.method]}</p>
            </div>
          )}
          <Field label="Reason for voiding" hint="Required — this is the audit record." required>
            {(id) => (
              <TextInput
                id={id}
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder="e.g. duplicated entry, wrong invoice"
                autoFocus
              />
            )}
          </Field>
          <p className="text-[10.5px] leading-relaxed text-faint">
            Receipts already issued for this payment are kept but marked as void in the receipt history; nothing is
            deleted.
          </p>
        </div>
      </Modal>
    </div>
  );
}
