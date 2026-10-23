import { useMemo, useState } from 'react';
import { FileText, Info } from 'lucide-react';
import { Badge, EmptyState, Money, PageHeader, Segmented, SkeletonRows } from '@/components/ui';
import { useCollection } from '@/context/app';
import { balanceMinor, effectiveStatus, paidMinor, summariseReceivables } from '@/lib/finance';
import { paymentMethodLabel, paymentStatusMeta } from '@/lib/labels';
import { fmtDate, monthLabel } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import type { ClientService, Invoice, Payment, Service } from '@/lib/types';

export default function PortalBillingPage() {
  const { data: invoices, loading } = useCollection<Invoice>('invoices');
  const { data: payments } = useCollection<Payment>('payments');
  const { data: services } = useCollection<ClientService>('client_services');
  const { data: catalog } = useCollection<Service>('services');
  const [filter, setFilter] = useState<'all' | 'open' | 'paid'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const receivables = summariseReceivables(invoices, payments);

  const listed = useMemo(() => {
    return invoices
      .map((inv) => ({ inv, status: effectiveStatus(inv, payments), paid: paidMinor(inv.id, payments), balance: balanceMinor(inv, payments) }))
      .filter((row) => (filter === 'open' ? row.balance > 0 : filter === 'paid' ? row.status === 'paid' : true))
      .sort((a, b) => b.inv.issue_date.localeCompare(a.inv.issue_date));
  }, [invoices, payments, filter]);

  const serviceName = (id: string | null) => {
    if (!id) return 'One-off billing';
    const assignment = services.find((s) => s.id === id);
    if (!assignment) return 'Service';
    return assignment.title ?? catalog.find((c) => c.id === assignment.service_id)?.name ?? 'Service';
  };

  return (
    <div>
      <PageHeader
        eyebrow="Billing"
        title="Invoices & payments"
        description="Every billing period has its own invoice and its own balance. Nothing here is editable — if something looks wrong, contact your team."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="surface p-3.5">
          <p className="eyebrow">Invoiced</p>
          <p className="num mt-1 text-xl font-semibold text-fg">{formatMoney(receivables.invoiced, { compact: true })}</p>
        </div>
        <div className="surface p-3.5">
          <p className="eyebrow">Paid</p>
          <p className="num mt-1 text-xl font-semibold text-mint">{formatMoney(receivables.received, { compact: true })}</p>
        </div>
        <div className="surface p-3.5">
          <p className="eyebrow">Outstanding</p>
          <p className="num mt-1 text-xl font-semibold text-butter">{formatMoney(receivables.outstanding, { compact: true })}</p>
        </div>
      </div>

      <div className="mt-4">
        <Segmented
          size="sm"
          ariaLabel="Invoice filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: invoices.length },
            { value: 'open', label: 'Open', count: invoices.filter((i) => balanceMinor(i, payments) > 0 && i.status !== 'cancelled').length },
            { value: 'paid', label: 'Paid', count: invoices.filter((i) => effectiveStatus(i, payments) === 'paid').length },
          ]}
        />
      </div>

      {loading ? (
        <div className="mt-4"><SkeletonRows rows={4} /></div>
      ) : listed.length === 0 ? (
        <div className="mt-4">
          <EmptyState icon={<FileText className="h-6 w-6" />} title="No invoices to show" description="Invoices issued to you will appear here, with the payments recorded against each one." />
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {listed.map(({ inv, status, paid, balance }) => {
            const invoicePayments = payments.filter((p) => p.invoice_id === inv.id && !p.voided_at);
            const isOpen = expanded === inv.id;
            return (
              <li key={inv.id} className="surface p-4">
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : inv.id)}
                  className="flex w-full flex-wrap items-center gap-3 text-left"
                  aria-expanded={isOpen}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[12.5px] font-medium text-fg">
                      {serviceName(inv.client_service_id)}
                      <Badge tone={paymentStatusMeta[status].tone}>{paymentStatusMeta[status].label}</Badge>
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-faint">
                      <span className="font-mono">{inv.invoice_number}</span> ·{' '}
                      {inv.billing_period_start ? monthLabel(inv.billing_period_start.slice(0, 7)) : fmtDate(inv.issue_date)} · due {fmtDate(inv.due_date)}
                    </p>
                  </div>
                  <div className="text-right">
                    <Money minor={inv.total_minor} className="block text-[13px]" />
                    <span className={`text-[10px] ${balance > 0 ? 'text-butter' : 'text-mint'}`}>
                      {balance > 0 ? `${formatMoney(balance)} due` : 'settled'}
                    </span>
                  </div>
                </button>

                {isOpen && (
                  <div className="mt-3 border-t pt-3">
                    <dl className="grid grid-cols-2 gap-2 text-[11.5px] sm:grid-cols-4">
                      <div>
                        <dt className="eyebrow">Total</dt>
                        <dd className="mt-0.5"><Money minor={inv.total_minor} /></dd>
                      </div>
                      <div>
                        <dt className="eyebrow">Paid</dt>
                        <dd className="mt-0.5 text-mint"><Money minor={paid} /></dd>
                      </div>
                      <div>
                        <dt className="eyebrow">Balance</dt>
                        <dd className={`mt-0.5 ${balance > 0 ? 'text-butter' : 'text-mint'}`}><Money minor={balance} /></dd>
                      </div>
                      <div>
                        <dt className="eyebrow">Issued</dt>
                        <dd className="mt-0.5 text-fg">{fmtDate(inv.issue_date)}</dd>
                      </div>
                    </dl>

                    <p className="mt-3 text-[10px] uppercase tracking-[0.12em] text-faint">Payments received</p>
                    {invoicePayments.length === 0 ? (
                      <p className="mt-1 text-[11px] text-muted">No payments recorded for this invoice yet.</p>
                    ) : (
                      <ul className="mt-1.5 space-y-1">
                        {invoicePayments.map((p) => (
                          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                            <span className="text-muted">
                              {fmtDate(p.paid_at)} · {paymentMethodLabel[p.method]}
                              {p.reference ? <span className="ml-1 font-mono text-faint">{p.reference}</span> : null}
                            </span>
                            <Money minor={p.amount_minor} tone="mint" />
                          </li>
                        ))}
                      </ul>
                    )}

                    {inv.notes && (
                      <p className="mt-3 rounded-lg border p-2 text-[11px] leading-relaxed text-muted" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
                        {inv.notes}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-4 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-faint">
        <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        Amounts are in Indian Rupees. A receipt for each payment is available under Receipts — it is the document to keep
        for your accounts.
      </p>
    </div>
  );
}
