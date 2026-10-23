import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileText, Plus, Wallet, XCircle } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Money,
  PageHeader,
  SearchInput,
  Segmented,
  Select,
  SkeletonRows,
  Toolbar,
} from '@/components/ui';
import { ConfirmDialog, Drawer } from '@/components/ui/overlays';
import { InvoiceDialog, PaymentDialog } from '@/components/finance/dialogs';
import { useCollection, useData, useToast } from '@/context/app';
import { paymentStatusMeta } from '@/lib/labels';
import { fmtDate, monthLabel, todayISO } from '@/lib/dates';
import { balanceMinor, effectiveStatus, paidMinor, summariseReceivables } from '@/lib/finance';
import { formatMoney } from '@/lib/money';
import { downloadFile, toCSV } from '@/lib/utils';
import type { Client, Invoice, InvoiceItem, Payment, PaymentStatus } from '@/lib/types';

type Filter = 'all' | 'open' | 'overdue' | 'paid';

export default function InvoicesPage() {
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const toast = useToast();

  const { data: invoices, loading, refresh } = useCollection<Invoice>('invoices');
  const { data: items } = useCollection<InvoiceItem>('invoice_items');
  const { data: payments, refresh: refreshPayments } = useCollection<Payment>('payments');
  const { data: clients } = useCollection<Client>('clients');

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [clientFilter, setClientFilter] = useState('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<Invoice | null>(null);
  const [payFor, setPayFor] = useState<Invoice | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Invoice | null>(null);
  const [busy, setBusy] = useState(false);

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? 'Client';

  const enriched = useMemo(
    () =>
      invoices.map((inv) => ({
        invoice: inv,
        status: effectiveStatus(inv, payments),
        paid: paidMinor(inv.id, payments),
        balance: balanceMinor(inv, payments),
      })),
    [invoices, payments],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enriched
      .filter((row) => {
        if (clientFilter !== 'all' && row.invoice.client_id !== clientFilter) return false;
        if (filter === 'open') return row.balance > 0 && row.status !== 'cancelled';
        if (filter === 'overdue') return row.status === 'overdue';
        if (filter === 'paid') return row.status === 'paid';
        return true;
      })
      .filter(
        (row) =>
          !q ||
          `${row.invoice.invoice_number} ${clientName(row.invoice.client_id)}`.toLowerCase().includes(q),
      )
      .sort((a, b) => b.invoice.issue_date.localeCompare(a.invoice.issue_date));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enriched, search, filter, clientFilter, clients]);

  const summary = summariseReceivables(invoices, payments);
  const counts = {
    all: enriched.length,
    open: enriched.filter((r) => r.balance > 0 && r.status !== 'cancelled').length,
    overdue: enriched.filter((r) => r.status === 'overdue').length,
    paid: enriched.filter((r) => r.status === 'paid').length,
  };

  const cancelInvoice = async () => {
    if (!cancelTarget) return;
    if (paidMinor(cancelTarget.id, payments) > 0) {
      toast.error('Cannot cancel a paid invoice', 'Void the payments first so the ledger stays honest.');
      return;
    }
    setBusy(true);
    try {
      await adapter.update<Invoice>('invoices', cancelTarget.id, { status: 'cancelled' as PaymentStatus });
      toast.success('Invoice cancelled', 'It stays in your records, excluded from receivables.');
      setCancelTarget(null);
      refresh();
      invalidate();
    } catch (err) {
      toast.error('Could not cancel the invoice', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () => {
    const rows = filtered.map((r) => ({
      invoice_number: r.invoice.invoice_number,
      client: clientName(r.invoice.client_id),
      billing_period: r.invoice.billing_period_start ? `${r.invoice.billing_period_start} → ${r.invoice.billing_period_end}` : '',
      issue_date: r.invoice.issue_date,
      due_date: r.invoice.due_date ?? '',
      status: r.status,
      total_inr: (r.invoice.total_minor / 100).toFixed(2),
      paid_inr: (r.paid / 100).toFixed(2),
      balance_inr: (r.balance / 100).toFixed(2),
    }));
    downloadFile(`lunadesk-invoices-${todayISO()}.csv`, toCSV(rows));
    toast.success('Export ready', `${rows.length} invoices written to CSV.`);
  };

  return (
    <div>
      <PageHeader
        eyebrow="Money"
        title="Invoices"
        description="Invoiced is not received. Each invoice tracks its own payments, so a monthly retainer keeps a separate balance for every billing period."
        actions={
          <>
            <Button variant="ghost" onClick={exportCsv} disabled={filtered.length === 0} icon={<Download className="h-4 w-4" />}>
              Export CSV
            </Button>
            <Button variant="primary" onClick={() => setCreateOpen(true)} icon={<Plus className="h-4 w-4" />}>
              New invoice
            </Button>
          </>
        }
      />

      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <div className="surface p-3.5">
          <p className="eyebrow">Invoiced (lifetime)</p>
          <p className="num mt-1 text-xl font-semibold text-fg">{formatMoney(summary.invoiced, { compact: true })}</p>
        </div>
        <div className="surface p-3.5">
          <p className="eyebrow">Received</p>
          <p className="num mt-1 text-xl font-semibold text-mint">{formatMoney(summary.received, { compact: true })}</p>
        </div>
        <div className="surface p-3.5">
          <p className="eyebrow">Outstanding</p>
          <p className="num mt-1 text-xl font-semibold text-butter">{formatMoney(summary.outstanding, { compact: true })}</p>
        </div>
      </div>

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search invoice or client" className="w-full sm:w-64" />
        <Segmented
          size="sm"
          ariaLabel="Invoice filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'open', label: 'Open', count: counts.open },
            { value: 'overdue', label: 'Overdue', count: counts.overdue },
            { value: 'paid', label: 'Paid', count: counts.paid },
          ]}
        />
        <Select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} className="ml-auto w-40 py-1.5 text-xs" aria-label="Filter by client">
          <option value="all">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Toolbar>

      {loading ? (
        <SkeletonRows rows={6} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-6 w-6" />}
          title={invoices.length === 0 ? 'No invoices yet' : 'No invoices match'}
          description={
            invoices.length === 0
              ? 'Raise an invoice per client per billing period. Receipts are generated only when money actually arrives.'
              : 'Adjust the filters to see more.'
          }
          action={
            invoices.length === 0 ? (
              <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)} icon={<Plus className="h-3.5 w-3.5" />}>
                New invoice
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
                  <th>Invoice</th>
                  <th>Client</th>
                  <th>Period</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Paid</th>
                  <th className="text-right">Balance</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map(({ invoice, status, paid, balance }) => (
                  <tr key={invoice.id}>
                    <td>
                      <button type="button" onClick={() => setDetail(invoice)} className="font-mono text-[11px] text-fg hover:underline">
                        {invoice.invoice_number}
                      </button>
                      <span className="block text-[10px] text-faint">issued {fmtDate(invoice.issue_date)}</span>
                    </td>
                    <td className="text-[12.5px] text-fg">{clientName(invoice.client_id)}</td>
                    <td className="whitespace-nowrap text-[11px] text-muted">
                      {invoice.billing_period_start ? monthLabel(invoice.billing_period_start.slice(0, 7)) : '—'}
                    </td>
                    <td className="whitespace-nowrap text-[11px] text-muted">{fmtDate(invoice.due_date)}</td>
                    <td><Badge tone={paymentStatusMeta[status].tone}>{paymentStatusMeta[status].label}</Badge></td>
                    <td className="text-right"><Money minor={invoice.total_minor} className="text-[12px]" /></td>
                    <td className="text-right"><Money minor={paid} tone="mint" className="text-[12px]" /></td>
                    <td className="text-right">
                      <Money minor={balance} tone={balance > 0 ? (status === 'overdue' ? 'magenta' : 'butter') : 'mint'} className="text-[12px]" />
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        {balance > 0 && status !== 'cancelled' && (
                          <Button size="sm" variant="quiet" onClick={() => setPayFor(invoice)} aria-label="Record payment" icon={<Wallet className="h-3 w-3" />} />
                        )}
                        {status !== 'paid' && status !== 'cancelled' && (
                          <Button size="sm" variant="quiet" onClick={() => setCancelTarget(invoice)} aria-label="Cancel invoice" icon={<XCircle className="h-3 w-3" />} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <InvoiceDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { refresh(); invalidate(); }}
      />

      <PaymentDialog
        open={Boolean(payFor)}
        onClose={() => setPayFor(null)}
        invoice={payFor}
        onRecorded={() => { refresh(); refreshPayments(); invalidate(); }}
      />

      <Drawer open={Boolean(detail)} onClose={() => setDetail(null)} title={detail ? `Invoice ${detail.invoice_number}` : 'Invoice'} width="lg">
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={paymentStatusMeta[effectiveStatus(detail, payments)].tone}>
                {paymentStatusMeta[effectiveStatus(detail, payments)].label}
              </Badge>
              <span className="text-[11px] text-faint">
                {detail.billing_period_start ? `${fmtDate(detail.billing_period_start)} → ${fmtDate(detail.billing_period_end)}` : 'No billing period set'}
              </span>
            </div>

            <div className="rounded-xl border p-3" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
              <p className="text-[10px] uppercase tracking-[0.12em] text-faint">Client</p>
              <Link to={`/admin/clients/${detail.client_id}`} className="text-[12.5px] font-medium text-fg hover:underline">
                {clientName(detail.client_id)}
              </Link>
              <p className="mt-1 text-[10.5px] text-faint">Issued {fmtDate(detail.issue_date)} · due {fmtDate(detail.due_date)}</p>
            </div>

            <div>
              <p className="label">Line items</p>
              <ul className="space-y-1">
                {items.filter((i) => i.invoice_id === detail.id).map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2 border-b py-1.5 text-[12px] last:border-b-0">
                    <span className="text-fg">{item.description}</span>
                    <span className="num shrink-0 text-muted">×{item.quantity} · <Money minor={item.amount_minor} className="text-fg" /></span>
                  </li>
                ))}
                {items.filter((i) => i.invoice_id === detail.id).length === 0 && (
                  <li className="py-2 text-[11px] text-faint">No line items recorded.</li>
                )}
              </ul>
            </div>

            <dl className="space-y-1 text-[12px]">
              <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="num text-fg">{formatMoney(detail.subtotal_minor)}</dd></div>
              {detail.discount_minor > 0 && <div className="flex justify-between"><dt className="text-muted">Discount</dt><dd className="num text-fg">−{formatMoney(detail.discount_minor)}</dd></div>}
              {detail.tax_minor > 0 && <div className="flex justify-between"><dt className="text-muted">Tax</dt><dd className="num text-fg">{formatMoney(detail.tax_minor)}</dd></div>}
              <div className="flex justify-between border-t pt-1 font-medium"><dt className="text-fg">Total</dt><dd className="num text-fg">{formatMoney(detail.total_minor)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Paid</dt><dd className="num text-mint">{formatMoney(paidMinor(detail.id, payments))}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Balance</dt><dd className="num text-butter">{formatMoney(balanceMinor(detail, payments))}</dd></div>
            </dl>

            <div>
              <p className="label">Payments against this invoice</p>
              <ul className="space-y-1">
                {payments.filter((p) => p.invoice_id === detail.id).map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 text-[11.5px]">
                    <span className="text-muted">
                      {fmtDate(p.paid_at)} · {p.reference ?? 'no reference'}
                      {p.voided_at && <Badge tone="muted" className="ml-1.5">void</Badge>}
                    </span>
                    <Money minor={p.amount_minor} tone={p.voided_at ? 'neutral' : 'mint'} />
                  </li>
                ))}
                {payments.filter((p) => p.invoice_id === detail.id).length === 0 && (
                  <li className="text-[11px] text-faint">No payments yet.</li>
                )}
              </ul>
            </div>

            {detail.notes && <p className="rounded-lg border p-2.5 text-[11.5px] text-muted" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>{detail.notes}</p>}

            <div className="flex flex-wrap gap-2">
              {balanceMinor(detail, payments) > 0 && (
                <Button variant="primary" size="sm" onClick={() => { setPayFor(detail); setDetail(null); }} icon={<Wallet className="h-3.5 w-3.5" />}>
                  Record payment
                </Button>
              )}
              <Link to={`/admin/clients/${detail.client_id}`} className="btn btn-ghost rounded-lg px-3 py-1.5 text-[13px]">
                Client profile
              </Link>
            </div>
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={Boolean(cancelTarget)}
        onClose={() => setCancelTarget(null)}
        onConfirm={cancelInvoice}
        busy={busy}
        title="Cancel this invoice?"
        confirmLabel="Cancel invoice"
        body={
          <>
            <strong className="text-fg">{cancelTarget?.invoice_number}</strong> stays in your records but is excluded from
            receivables. This cannot be used on an invoice that already has payments.
          </>
        }
      />
    </div>
  );
}
