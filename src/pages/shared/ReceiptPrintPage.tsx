import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Printer, Receipt as ReceiptIcon } from 'lucide-react';
import { Badge, Button, EmptyState, Segmented, SkeletonRows } from '@/components/ui';
import { useCollection } from '@/context/app';
import { useAuth } from '@/context/auth';
import { fmtDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { paymentMethodLabel, paymentStatusMeta } from '@/lib/labels';
import { LunaMark } from '@/components/brand/Logo';
import type { BrandingSettings, Payment, Receipt } from '@/lib/types';

/**
 * Print-ready receipt.
 *
 * Rendered from the stored snapshot, not recomputed from live records, so a
 * reprint is byte-for-byte the document the client received. Everything outside
 * `.print-sheet` carries `no-print` and disappears when printing.
 */
export default function ReceiptPrintPage() {
  const { isAdmin } = useAuth();
  const { data: receipts, loading } = useCollection<Receipt>('receipts');
  const { data: payments } = useCollection<Payment>('payments');
  const { data: branded } = useCollection<BrandingSettings>('branding_settings');
  const [layout, setLayout] = useState<'a4' | 'compact'>('a4');

  const path = window.location.hash.split('/').filter(Boolean);
  const id = path[path.length - 1];
  const receipt = receipts.find((r) => r.id === id) ?? null;
  const payment = receipt ? payments.find((p) => p.id === receipt.payment_id) : undefined;
  const voided = Boolean(payment?.voided_at);
  const snapshot = receipt?.snapshot;
  const company = snapshot?.company;
  const logoUrl = company?.logo_url ?? branded[0]?.logo_url ?? null;
  const backTo = isAdmin ? '/admin/receipts' : '/portal/receipts';

  if (loading) return <div className="mx-auto max-w-3xl p-6"><SkeletonRows rows={6} /></div>;

  if (!receipt || !snapshot) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <EmptyState
          icon={<ReceiptIcon className="h-6 w-6" />}
          title="Receipt not found"
          description="This receipt does not exist or is outside your access."
          action={<Link to={backTo} className="btn btn-ghost">Back to receipts</Link>}
        />
      </div>
    );
  }

  const status = paymentStatusMeta[snapshot.payment_status] ?? paymentStatusMeta.paid;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Link to={backTo} className="btn btn-quiet rounded-lg px-2.5 py-1.5 text-[13px]">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Receipts
        </Link>
        <Segmented
          size="sm"
          ariaLabel="Receipt layout"
          value={layout}
          onChange={setLayout}
          options={[
            { value: 'a4', label: 'A4' },
            { value: 'compact', label: 'Compact' },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          {voided && <Badge tone="magenta">Voided payment — this receipt is no longer valid</Badge>}
          <Button variant="primary" onClick={() => window.print()} icon={<Printer className="h-4 w-4" />}>
            Print / Save as PDF
          </Button>
        </div>
      </div>

      <article
        className={`print-sheet relative rounded-2xl border bg-white text-[#111] shadow-xl ${
          layout === 'a4' ? 'p-10' : 'mx-auto max-w-md p-6'
        }`}
        style={{ borderColor: 'rgb(var(--line) / 0.2)' }}
        aria-label={`Receipt ${snapshot.receipt_number}`}
      >
        {voided && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center print-muted"
            aria-hidden
          >
            <span className="rotate-[-18deg] text-[7rem] font-bold tracking-[0.1em] text-black/10">VOID</span>
          </div>
        )}

        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[#e6e6e6] pb-5">
          <div className="flex items-center gap-3">
            {logoUrl ? (
              <img src={logoUrl} alt={company?.company_name ?? 'Company logo'} className="h-12 w-12 rounded-lg object-contain" />
            ) : (
              <LunaMark size={44} />
            )}
            <div>
              <p className="text-[15px] font-semibold tracking-tight text-[#111]">{company?.company_name ?? 'Managed by Luna'}</p>
              <p className="text-[10.5px] text-[#666]">{company?.contact_email ?? 'hello@managedbyluna.com'}</p>
              {company?.contact_phone && <p className="text-[10.5px] text-[#666]">{company.contact_phone}</p>}
              {company?.address && <p className="mt-0.5 max-w-[15rem] text-[10px] leading-snug text-[#666]">{company.address}</p>}
              {company?.tax_id && (
                <p className="mt-0.5 text-[10px] text-[#666]">
                  {company.tax_label ?? 'Tax ID'}: {company.tax_id}
                </p>
              )}
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-[0.18em] text-[#888]">Receipt</p>
            <p className="font-mono text-[13px] font-medium text-[#111]">{snapshot.receipt_number}</p>
            <p className="mt-1 text-[10.5px] text-[#666]">Issued {fmtDate(snapshot.issue_date)}</p>
            <p className="text-[10.5px] text-[#666]">Invoice {snapshot.invoice_number}</p>
            <span
              className="mt-1.5 inline-block rounded-full border px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] print-muted"
              style={{ borderColor: '#d8d8d8', color: '#444' }}
            >
              {status.label}
            </span>
          </div>
        </header>

        <section className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-[9.5px] uppercase tracking-[0.16em] text-[#888]">Received from</p>
            <p className="mt-1 text-[13px] font-medium text-[#111]">{snapshot.client_name}</p>
            <p className="text-[11px] text-[#555]">{snapshot.client_business}</p>
            {snapshot.client_email && <p className="text-[10.5px] text-[#666]">{snapshot.client_email}</p>}
            {snapshot.client_phone && <p className="text-[10.5px] text-[#666]">{snapshot.client_phone}</p>}
          </div>
          <div className="sm:text-right">
            <p className="text-[9.5px] uppercase tracking-[0.16em] text-[#888]">Payment details</p>
            <p className="mt-1 text-[11px] text-[#333]">Method: {paymentMethodLabel[snapshot.method]}</p>
            {snapshot.reference && <p className="font-mono text-[10.5px] text-[#666]">Ref: {snapshot.reference}</p>}
            <p className="text-[10.5px] text-[#666]">Paid on {fmtDate(snapshot.payment_date)}</p>
            {snapshot.billing_period && <p className="text-[10.5px] text-[#666]">Period: {snapshot.billing_period}</p>}
          </div>
        </section>

        <table className="mt-6 w-full border-collapse text-[11.5px]">
          <thead>
            <tr>
              <th className="border-b border-[#e6e6e6] py-2 text-left text-[9.5px] uppercase tracking-[0.14em] text-[#888]">Description</th>
              <th className="border-b border-[#e6e6e6] py-2 text-right text-[9.5px] uppercase tracking-[0.14em] text-[#888]">Amount</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.items.map((item, i) => (
              <tr key={i}>
                <td className="border-b border-[#f0f0f0] py-2 pr-4 text-[#222]">{item.description}</td>
                <td className="border-b border-[#f0f0f0] py-2 text-right tabular-nums text-[#222]">{formatMoney(item.amount_minor)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="mt-4 ml-auto w-full max-w-[16rem] space-y-1.5 text-[11.5px]">
          <div className="flex justify-between text-[#555]">
            <span>Invoice total</span>
            <span className="tabular-nums">{formatMoney(snapshot.invoice_total_minor)}</span>
          </div>
          <div className="flex justify-between text-[#555]">
            <span>Previously paid</span>
            <span className="tabular-nums">{formatMoney(snapshot.previously_paid_minor)}</span>
          </div>
          <div className="flex justify-between border-t border-[#e6e6e6] pt-1.5 font-medium text-[#111]">
            <span>Payment received</span>
            <span className="tabular-nums">{formatMoney(snapshot.amount_received_minor)}</span>
          </div>
          <div className="flex justify-between text-[#111]">
            <span>Balance remaining</span>
            <span className="tabular-nums">{formatMoney(snapshot.balance_minor)}</span>
          </div>
        </section>

        {snapshot.notes && (
          <section className="mt-5 rounded-lg border border-[#ececec] bg-[#fafafa] p-3">
            <p className="text-[9.5px] uppercase tracking-[0.14em] text-[#888]">Notes</p>
            <p className="mt-1 text-[11px] leading-relaxed text-[#444]">{snapshot.notes}</p>
          </section>
        )}

        <footer className="mt-6 border-t border-[#e6e6e6] pt-3 text-[9.5px] leading-relaxed text-[#777]">
          <p>{company?.receipt_footer ?? 'Thank you for working with Managed by Luna.'}</p>
          <p className="mt-1">
            This receipt was generated by LunaDesk and reflects the payment recorded on{' '}
            {fmtDate(snapshot.payment_date)}. Amounts are in INR and inclusive of any tax shown on the invoice.
          </p>
        </footer>
      </article>

      <p className="no-print mt-4 text-center text-[10.5px] text-faint">
        Printing uses your browser’s print dialog. Choose “Save as PDF” for a digital copy.
      </p>
    </div>
  );
}
