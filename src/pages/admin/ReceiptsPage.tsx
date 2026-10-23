import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, ExternalLink, Printer, Receipt as ReceiptIcon } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Money,
  PageHeader,
  SearchInput,
  Select,
  SkeletonRows,
  Toolbar,
} from '@/components/ui';
import { useCollection } from '@/context/app';
import { fmtDate, todayISO } from '@/lib/dates';
import { paymentMethodLabel } from '@/lib/labels';
import { downloadFile, toCSV } from '@/lib/utils';
import type { Client, Invoice, Payment, Receipt } from '@/lib/types';

export default function ReceiptsPage() {
  const { data: receipts, loading } = useCollection<Receipt>('receipts');
  const { data: clients } = useCollection<Client>('clients');
  const { data: payments } = useCollection<Payment>('payments');
  const { data: invoices } = useCollection<Invoice>('invoices');

  const [search, setSearch] = useState('');
  const [clientFilter, setClientFilter] = useState('all');

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? 'Client';

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return receipts
      .map((r) => {
        const payment = payments.find((p) => p.id === r.payment_id);
        return { receipt: r, payment, voided: Boolean(payment?.voided_at) };
      })
      .filter((row) => clientFilter === 'all' || row.receipt.client_id === clientFilter)
      .filter(
        (row) =>
          !q ||
          `${row.receipt.receipt_number} ${row.receipt.snapshot?.invoice_number ?? ''} ${clientName(row.receipt.client_id)}`.toLowerCase().includes(q),
      )
      .sort((a, b) => b.receipt.issued_at.localeCompare(a.receipt.issued_at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipts, payments, clients, search, clientFilter]);

  const exportCsv = () => {
    const data = rows.map((r) => ({
      receipt_number: r.receipt.receipt_number,
      invoice_number: r.receipt.snapshot?.invoice_number ?? invoices.find((i) => i.id === r.receipt.invoice_id)?.invoice_number ?? '',
      client: clientName(r.receipt.client_id),
      issued_at: r.receipt.issued_at,
      amount_inr: ((r.receipt.snapshot?.amount_received_minor ?? 0) / 100).toFixed(2),
      method: paymentMethodLabel[(r.receipt.snapshot?.method ?? 'other') as keyof typeof paymentMethodLabel],
      status: r.voided ? 'void' : 'valid',
    }));
    downloadFile(`lunadesk-receipts-${todayISO()}.csv`, toCSV(data));
  };

  return (
    <div>
      <PageHeader
        eyebrow="Money"
        title="Invoices & receipts"
        description="Every receipt is an immutable snapshot of the payment it documents. Reprints always match the stored transaction — there is no “regenerate” that could quietly disagree."
        actions={
          <Button variant="ghost" onClick={exportCsv} disabled={rows.length === 0} icon={<Download className="h-4 w-4" />}>
            Export CSV
          </Button>
        }
      />

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search receipt or invoice" className="w-full sm:w-64" />
        <Select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} className="w-40 py-1.5 text-xs" aria-label="Filter by client">
          <option value="all">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <span className="ml-auto text-[11px] text-faint">{rows.length} receipts</span>
      </Toolbar>

      {loading ? (
        <SkeletonRows rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ReceiptIcon className="h-6 w-6" />}
          title={receipts.length === 0 ? 'No receipts yet' : 'No receipts match'}
          description={
            receipts.length === 0
              ? 'Receipts are created when you record a payment. Record one from the Payments screen and a numbered receipt is issued automatically.'
              : 'Adjust your search or client filter.'
          }
          action={
            receipts.length === 0 ? (
              <Link to="/admin/payments" className="btn btn-ghost">Go to payments</Link>
            ) : undefined
          }
        />
      ) : (
        <div className="surface overflow-hidden p-0">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Receipt</th>
                  <th>Invoice</th>
                  <th>Client</th>
                  <th>Issued</th>
                  <th>Method</th>
                  <th className="text-right">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ receipt, voided }) => (
                  <tr key={receipt.id}>
                    <td>
                      <span className="font-mono text-[11px] text-fg">{receipt.receipt_number}</span>
                      {voided && <Badge tone="magenta" className="ml-1.5">VOID</Badge>}
                    </td>
                    <td className="font-mono text-[10.5px] text-muted">{receipt.snapshot?.invoice_number ?? '—'}</td>
                    <td className="text-[12.5px] text-fg">{clientName(receipt.client_id)}</td>
                    <td className="whitespace-nowrap text-[11px] text-muted">{fmtDate(receipt.issued_at)}</td>
                    <td className="text-[11px] text-muted">
                      {receipt.snapshot?.method ? paymentMethodLabel[receipt.snapshot.method] : '—'}
                    </td>
                    <td className="text-right"><Money minor={receipt.snapshot?.amount_received_minor ?? 0} tone="mint" className="text-[12.5px]" /></td>
                    <td className="text-right">
                      <Link to={`/admin/receipts/${receipt.id}`} className="inline-flex items-center gap-1 text-[11px] text-magenta hover:underline">
                        <Printer className="h-3 w-3" aria-hidden /> Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {[
          { title: 'Numbered safely', body: 'Receipt numbers are generated inside a transaction, so two simultaneous payments can never collide.' },
          { title: 'Snapshot, not a template', body: 'Client, line items, amounts and branding are frozen at issue time. Later edits never rewrite history.' },
          { title: 'Clean print output', body: 'Printing renders only the receipt — no dashboard chrome, no overlays, A4 by default.' },
        ].map((item) => (
          <div key={item.title} className="surface-flat p-3.5">
            <p className="text-[11.5px] font-medium text-fg">{item.title}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">{item.body}</p>
          </div>
        ))}
      </div>

      <p className="mt-4 flex items-center gap-1.5 text-[10.5px] text-faint">
        <ExternalLink className="h-3 w-3" aria-hidden />
        Receipts open in a print-ready view — use your browser’s “Save as PDF” for a PDF copy.
      </p>
    </div>
  );
}
