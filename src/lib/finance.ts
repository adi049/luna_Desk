import type { Invoice, Payment, ClientService, PaymentStatus, BillingType } from './types';

/**
 * Financial derivations.
 *
 * Invariant: an invoice's balance is derived from *its own* non-voided
 * payments — never from a client's lifetime totals. Recurring services are
 * invoiced per period, so period-level arithmetic is the only correct unit.
 */

export function paymentsForInvoice(invoiceId: string, payments: Payment[]): Payment[] {
  return payments.filter((p) => p.invoice_id === invoiceId && !p.voided_at);
}

export function paidMinor(invoiceId: string, payments: Payment[]): number {
  return paymentsForInvoice(invoiceId, payments).reduce((sum, p) => sum + p.amount_minor, 0);
}

export function balanceMinor(invoice: Invoice, payments: Payment[]): number {
  if (invoice.status === 'cancelled') return 0;
  return Math.max(0, invoice.total_minor - paidMinor(invoice.id, payments));
}

/** The status shown in the UI: stored status, corrected for elapsed due dates. */
export function effectiveStatus(invoice: Invoice, payments: Payment[], today = new Date()): PaymentStatus {
  if (invoice.status === 'cancelled') return 'cancelled';
  const paid = paidMinor(invoice.id, payments);
  if (paid >= invoice.total_minor) return 'paid';
  const overdue = invoice.due_date ? new Date(invoice.due_date) < startOfToday(today) : false;
  if (paid > 0) return overdue ? 'overdue' : 'partially_paid';
  return overdue ? 'overdue' : 'pending';
}

function startOfToday(base: Date) {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  return d;
}

export interface ReceivableSummary {
  invoiced: number;
  received: number;
  outstanding: number;
  overdue: number;
  overdueCount: number;
  openCount: number;
}

export function summariseReceivables(invoices: Invoice[], payments: Payment[], today = new Date()): ReceivableSummary {
  let invoiced = 0;
  let received = 0;
  let outstanding = 0;
  let overdue = 0;
  let overdueCount = 0;
  let openCount = 0;
  for (const inv of invoices) {
    if (inv.status === 'cancelled') continue;
    invoiced += inv.total_minor;
    const paid = paidMinor(inv.id, payments);
    received += paid;
    const bal = Math.max(0, inv.total_minor - paid);
    outstanding += bal;
    if (bal > 0) {
      openCount += 1;
      if (effectiveStatus(inv, payments, today) === 'overdue') {
        overdue += bal;
        overdueCount += 1;
      }
    }
  }
  return { invoiced, received, outstanding, overdue, overdueCount, openCount };
}

/** Money actually received in a date window (payments, not invoices). */
export function receivedInRange(payments: Payment[], from: string, to: string): number {
  return payments
    .filter((p) => !p.voided_at && p.paid_at >= from && p.paid_at <= to)
    .reduce((sum, p) => sum + p.amount_minor, 0);
}

export function monthlyReceivedSeries(payments: Payment[], months = 6): { key: string; received: number }[] {
  const out: { key: string; received: number }[] = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push({ key, received: 0 });
  }
  const index = new Map(out.map((o) => [o.key, o]));
  for (const p of payments) {
    if (p.voided_at) continue;
    const key = p.paid_at.slice(0, 7);
    const bucket = index.get(key);
    if (bucket) bucket.received += p.amount_minor;
  }
  return out;
}

/** Expected billing for a recurring service in a given month, used only for
 *  reporting "what should have been invoiced" — never as money received. */
export function expectedForMonth(service: ClientService, monthKey: string): number {
  if (service.status !== 'active' && service.status !== 'paused') return 0;
  const startKey = service.start_date.slice(0, 7);
  if (monthKey < startKey) return 0;
  if (service.end_date) {
    const endKey = service.end_date.slice(0, 7);
    if (monthKey > endKey) return 0;
  }
  if (service.billing_type === 'monthly') return service.price_minor;
  if (service.billing_type === 'quarterly') {
    const [sy, sm] = service.start_date.split('-').map(Number);
    const [y, m] = monthKey.split('-').map(Number);
    const diff = (y - sy) * 12 + (m - sm);
    return diff >= 0 && diff % 3 === 0 ? service.price_minor : 0;
  }
  if (service.billing_type === 'yearly') return monthKey.endsWith(service.start_date.slice(5, 7)) ? service.price_minor : 0;
  return 0;
}

export const billingTypeLabel: Record<BillingType, string> = {
  one_time: 'One-time',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
  custom: 'Custom',
};
