import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Printer, Receipt as ReceiptIcon } from 'lucide-react';
import { Badge, EmptyState, Money, PageHeader, SearchInput, SkeletonRows } from '@/components/ui';
import { useCollection } from '@/context/app';
import { fmtDate } from '@/lib/dates';
import { paymentMethodLabel } from '@/lib/labels';
import type { Payment, Receipt } from '@/lib/types';

export default function PortalReceiptsPage() {
  const { data: receipts, loading } = useCollection<Receipt>('receipts');
  const { data: payments } = useCollection<Payment>('payments');
  const [search, setSearch] = useState('');

  const listed = receipts
    .filter((r) => {
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return `${r.receipt_number} ${r.snapshot?.invoice_number ?? ''}`.toLowerCase().includes(q);
    })
    .sort((a, b) => b.issued_at.localeCompare(a.issued_at));

  return (
    <div>
      <PageHeader
        eyebrow="Billing"
        title="Receipts"
        description="A receipt is issued for each payment received. Open any receipt to print it or save it as a PDF."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search receipt or invoice" className="w-full sm:w-64" />
        <span className="ml-auto text-[11px] text-faint">{listed.length} receipts</span>
      </div>

      {loading ? (
        <SkeletonRows rows={4} />
      ) : listed.length === 0 ? (
        <EmptyState
          icon={<ReceiptIcon className="h-6 w-6" />}
          title={receipts.length === 0 ? 'No receipts yet' : 'No receipts match'}
          description={receipts.length === 0 ? 'When a payment is recorded against your invoice, a numbered receipt is issued here.' : 'Try a different search.'}
        />
      ) : (
        <ul className="space-y-1.5">
          {listed.map((r) => {
            const payment = payments.find((p) => p.id === r.payment_id);
            const voided = Boolean(payment?.voided_at);
            return (
              <li key={r.id} className="surface flex flex-wrap items-center gap-3 p-3.5">
                <ReceiptIcon className="h-4 w-4 shrink-0 text-faint" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
                    <span className="font-mono">{r.receipt_number}</span>
                    {voided && <Badge tone="magenta">VOID</Badge>}
                  </p>
                  <p className="mt-0.5 text-[10.5px] text-faint">
                    Invoice {r.snapshot?.invoice_number} · {fmtDate(r.issued_at)}
                    {r.snapshot?.method ? ` · ${paymentMethodLabel[r.snapshot.method]}` : ''}
                  </p>
                </div>
                <Money minor={r.snapshot?.amount_received_minor ?? 0} className="text-[13px]" />
                <Link
                  to={`/portal/receipts/${r.id}`}
                  className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] text-muted transition hover:text-fg"
                  style={{ borderColor: 'rgb(var(--line) / 0.16)' }}
                >
                  <Printer className="h-3 w-3" aria-hidden /> Open
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
