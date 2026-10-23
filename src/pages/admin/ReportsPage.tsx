import { useMemo, useState } from 'react';
import { BarChart3, Download, DownloadCloud, TrendingUp } from 'lucide-react';
import { Badge, Button, EmptyState, Money, PageHeader, TextInput } from '@/components/ui';
import { MonthlyBars, RevenueTrendChart, TaskTrend } from '@/components/charts';
import { useCollection } from '@/context/app';
import { fmtDate, monthLabel, todayISO } from '@/lib/dates';
import { balanceMinor, billingTypeLabel, effectiveStatus, paidMinor, receivedInRange, summariseReceivables } from '@/lib/finance';
import { formatMoney } from '@/lib/money';
import { downloadFile, toCSV } from '@/lib/utils';
import type { Client, ClientService, Invoice, Payment, Project, Service, Task } from '@/lib/types';

export default function ReportsPage() {
  const { data: clients } = useCollection<Client>('clients');
  const { data: services } = useCollection<ClientService>('client_services');
  const { data: catalog } = useCollection<Service>('services');
  const { data: projects } = useCollection<Project>('projects');
  const { data: invoices } = useCollection<Invoice>('invoices');
  const { data: payments } = useCollection<Payment>('payments');
  const { data: tasks } = useCollection<Task>('tasks');

  const firstOfYear = `${new Date().getFullYear()}-01-01`;
  const [from, setFrom] = useState(firstOfYear);
  const [to, setTo] = useState(todayISO());

  const rangePayments = useMemo(
    () => payments.filter((p) => !p.voided_at && p.paid_at >= from && p.paid_at <= to),
    [payments, from, to],
  );
  const rangeInvoices = useMemo(
    () => invoices.filter((i) => i.issue_date >= from && i.issue_date <= to),
    [invoices, from, to],
  );

  const received = rangePayments.reduce((s, p) => s + p.amount_minor, 0);
  const invoiced = rangeInvoices.filter((i) => i.status !== 'cancelled').reduce((s, i) => s + i.total_minor, 0);
  const allReceivables = summariseReceivables(invoices, payments);

  const byClient = useMemo(() => {
    const map = new Map<string, { received: number; invoiced: number; outstanding: number }>();
    for (const client of clients) map.set(client.id, { received: 0, invoiced: 0, outstanding: 0 });
    for (const p of rangePayments) {
      const row = map.get(p.client_id);
      if (row) row.received += p.amount_minor;
    }
    for (const inv of rangeInvoices) {
      const row = map.get(inv.client_id);
      if (row && inv.status !== 'cancelled') {
        row.invoiced += inv.total_minor;
        row.outstanding += Math.max(0, inv.total_minor - paidMinor(inv.id, payments));
      }
    }
    return [...map.entries()]
      .map(([id, v]) => ({ id, name: clients.find((c) => c.id === id)?.name ?? 'Client', ...v }))
      .filter((r) => r.received > 0 || r.invoiced > 0)
      .sort((a, b) => b.received - a.received);
  }, [clients, rangePayments, rangeInvoices, payments]);

  const byService = useMemo(() => {
    const map = new Map<string, { label: string; received: number; invoiced: number }>();
    for (const inv of rangeInvoices) {
      const assignment = services.find((s) => s.id === inv.client_service_id);
      const label = assignment
        ? `${catalog.find((c) => c.id === assignment.service_id)?.name ?? 'Service'} · ${billingTypeLabel[assignment.billing_type]}`
        : 'Unassigned / one-off';
      const row = map.get(label) ?? { label, received: 0, invoiced: 0 };
      if (inv.status !== 'cancelled') row.invoiced += inv.total_minor;
      row.received += paidMinor(inv.id, payments);
      map.set(label, row);
    }
    return [...map.values()].filter((r) => r.invoiced > 0).sort((a, b) => b.invoiced - a.invoiced);
  }, [rangeInvoices, services, catalog, payments]);

  const months = useMemo(() => {
    const out: { key: string; label: string; received: number; invoiced: number }[] = [];
    const start = new Date(from);
    const end = new Date(to);
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= end) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      out.push({ key, label: monthLabel(key), received: 0, invoiced: 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    const index = new Map(out.map((m) => [m.key, m]));
    for (const p of rangePayments) {
      const m = index.get(p.paid_at.slice(0, 7));
      if (m) m.received += p.amount_minor;
    }
    for (const i of rangeInvoices) {
      if (i.status === 'cancelled') continue;
      const m = index.get(i.issue_date.slice(0, 7));
      if (m) m.invoiced += i.total_minor;
    }
    return out;
  }, [from, to, rangePayments, rangeInvoices]);

  const overdueInvoices = useMemo(
    () =>
      invoices
        .filter((i) => effectiveStatus(i, payments) === 'overdue')
        .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '')),
    [invoices, payments],
  );

  const taskTrend = useMemo(() => {
    const out: { label: string; completed: number }[] = [];
    const now = new Date();
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      out.push({
        label: monthLabel(key),
        completed: tasks.filter((t) => t.completed_at && t.completed_at.slice(0, 7) === key).length,
      });
    }
    return out;
  }, [tasks]);

  const operational = {
    activeClients: clients.filter((c) => c.status === 'active').length,
    activeServices: services.filter((s) => s.status === 'active').length,
    completedProjects: projects.filter((p) => p.status === 'completed').length,
    overdueTasks: tasks.filter((t) => t.status !== 'completed' && t.status !== 'archived' && t.due_date && t.due_date < todayISO()).length,
    upcomingDeadlines: projects.filter((p) => p.due_date && p.due_date >= todayISO() && !['completed', 'cancelled'].includes(p.status)).length,
    completionRate: (() => {
      const finished = tasks.filter((t) => t.status === 'completed').length;
      const total = tasks.filter((t) => t.status !== 'archived').length;
      return total ? Math.round((finished / total) * 100) : 0;
    })(),
  };

  const exportClients = () => {
    downloadFile(
      `lunadesk-report-clients-${todayISO()}.csv`,
      toCSV(
        byClient.map((r) => ({
          client: r.name,
          received_inr: (r.received / 100).toFixed(2),
          invoiced_inr: (r.invoiced / 100).toFixed(2),
          outstanding_inr: (r.outstanding / 100).toFixed(2),
        })),
      ),
    );
  };

  const exportMonthly = () => {
    downloadFile(
      `lunadesk-report-monthly-${todayISO()}.csv`,
      toCSV(
        months.map((m) => ({
          month: m.label,
          invoiced_inr: (m.invoiced / 100).toFixed(2),
          received_inr: (m.received / 100).toFixed(2),
          gap_inr: ((m.invoiced - m.received) / 100).toFixed(2),
        })),
      ),
    );
  };

  const exportOverdue = () => {
    downloadFile(
      `lunadesk-report-overdue-${todayISO()}.csv`,
      toCSV(
        overdueInvoices.map((i) => ({
          invoice: i.invoice_number,
          client: clients.find((c) => c.id === i.client_id)?.name ?? '',
          due_date: i.due_date ?? '',
          total_inr: (i.total_minor / 100).toFixed(2),
          balance_inr: ((i.total_minor - paidMinor(i.id, payments)) / 100).toFixed(2),
        })),
      ),
    );
  };

  const noData = invoices.length === 0 && payments.length === 0;

  return (
    <div>
      <PageHeader
        eyebrow="Money"
        title="Reports"
        description="Invoiced, received and outstanding are three different numbers here — an unpaid invoice never counts as money in."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" className="w-36 py-1.5 text-xs" />
            <span className="text-xs text-faint">→</span>
            <TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" className="w-36 py-1.5 text-xs" />
          </div>
        }
      />

      {noData ? (
        <EmptyState
          icon={<BarChart3 className="h-6 w-6" />}
          title="Nothing to report yet"
          description="Reports are built from real invoices and payments. Raise an invoice or record a payment and the analysis fills in."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: 'Invoiced in range', value: invoiced, hint: `${rangeInvoices.length} invoices`, tone: 'text-fg' },
              { label: 'Received in range', value: received, hint: `${rangePayments.length} payments`, tone: 'text-mint' },
              { label: 'Outstanding (all time)', value: allReceivables.outstanding, hint: `${allReceivables.openCount} open invoices`, tone: 'text-butter' },
              { label: 'Overdue (all time)', value: allReceivables.overdue, hint: `${allReceivables.overdueCount} invoices`, tone: 'text-magenta' },
            ].map((stat) => (
              <div key={stat.label} className="surface p-3.5">
                <p className="eyebrow">{stat.label}</p>
                <p className={`num mt-1.5 text-xl font-semibold ${stat.tone}`}>{formatMoney(stat.value, { compact: true })}</p>
                <p className="mt-0.5 text-[10.5px] text-faint">{stat.hint}</p>
              </div>
            ))}
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <section className="surface p-4 lg:col-span-2">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                  <TrendingUp className="h-4 w-4 text-magenta" aria-hidden /> Invoiced vs received
                </h2>
                <Button size="sm" variant="quiet" onClick={exportMonthly} icon={<Download className="h-3 w-3" />}>
                  CSV
                </Button>
              </div>
              <RevenueTrendChart data={months.map((m) => ({ label: m.label.replace(' ', '\u00A0'), received: m.received, invoiced: m.invoiced }))} height={260} />
            </section>

            <section className="surface p-4">
              <h2 className="mb-3 text-sm font-semibold text-fg">Receivables by age</h2>
              <MonthlyBars
                data={[
                  { label: 'Current', value: Math.max(0, allReceivables.outstanding - allReceivables.overdue) },
                  { label: 'Overdue', value: allReceivables.overdue },
                ]}
                height={200}
              />
              <p className="mt-2 text-[10.5px] leading-relaxed text-faint">
                Outstanding excludes cancelled invoices and respects every partial payment recorded.
              </p>
            </section>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <section className="surface p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-fg">Payments by client</h2>
                <Button size="sm" variant="quiet" onClick={exportClients} icon={<DownloadCloud className="h-3 w-3" />}>
                  Export
                </Button>
              </div>
              {byClient.length === 0 ? (
                <p className="py-6 text-center text-[11px] text-faint">No client activity in this range.</p>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Client</th>
                        <th className="text-right">Invoiced</th>
                        <th className="text-right">Received</th>
                        <th className="text-right">Outstanding</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byClient.map((row) => (
                        <tr key={row.id}>
                          <td className="text-[12px] text-fg">{row.name}</td>
                          <td className="text-right"><Money minor={row.invoiced} className="text-[11.5px]" /></td>
                          <td className="text-right"><Money minor={row.received} tone="mint" className="text-[11.5px]" /></td>
                          <td className="text-right"><Money minor={row.outstanding} tone={row.outstanding ? 'butter' : 'mint'} className="text-[11.5px]" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="surface p-4">
              <h2 className="mb-3 text-sm font-semibold text-fg">Payments by service</h2>
              {byService.length === 0 ? (
                <p className="py-6 text-center text-[11px] text-faint">No invoiced services in this range.</p>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Service</th>
                        <th className="text-right">Invoiced</th>
                        <th className="text-right">Collected</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byService.map((row) => (
                        <tr key={row.label}>
                          <td className="text-[12px] text-fg">{row.label}</td>
                          <td className="text-right"><Money minor={row.invoiced} className="text-[11.5px]" /></td>
                          <td className="text-right"><Money minor={row.received} tone="mint" className="text-[11.5px]" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <section className="surface p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-fg">Overdue invoices</h2>
                <Button size="sm" variant="quiet" onClick={exportOverdue} disabled={overdueInvoices.length === 0} icon={<Download className="h-3 w-3" />}>
                  Export
                </Button>
              </div>
              {overdueInvoices.length === 0 ? (
                <p className="py-6 text-center text-[11px] text-faint">Nothing overdue. Good.</p>
              ) : (
                <ul className="space-y-1.5">
                  {overdueInvoices.map((inv) => (
                    <li key={inv.id} className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1.5">
                      <div className="min-w-0">
                        <p className="truncate text-[12px] text-fg">
                          {clients.find((c) => c.id === inv.client_id)?.name} · <span className="font-mono text-[10.5px] text-muted">{inv.invoice_number}</span>
                        </p>
                        <p className="text-[10px] text-faint">due {fmtDate(inv.due_date)}</p>
                      </div>
                      <Money minor={balanceMinor(inv, payments)} tone="magenta" className="shrink-0 text-[12px]" />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="surface p-4">
              <h2 className="mb-3 text-sm font-semibold text-fg">Operations</h2>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Active clients', value: operational.activeClients },
                  { label: 'Active services', value: operational.activeServices },
                  { label: 'Completed projects', value: operational.completedProjects },
                  { label: 'Upcoming deadlines', value: operational.upcomingDeadlines },
                  { label: 'Overdue tasks', value: operational.overdueTasks },
                  { label: 'Task completion', value: `${operational.completionRate}%` },
                ].map((item) => (
                  <div key={item.label} className="rounded-lg border p-2.5" style={{ borderColor: 'rgb(var(--line) / 0.12)' }}>
                    <p className="text-[10px] uppercase tracking-[0.1em] text-faint">{item.label}</p>
                    <p className="num mt-0.5 text-base font-semibold text-fg">{item.value}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4">
                <p className="mb-1 text-[11px] text-muted">Tasks completed per month</p>
                <TaskTrend data={taskTrend} height={150} />
              </div>
            </section>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[10.5px] text-faint">
            <Badge tone="muted">Range {fmtDate(from)} → {fmtDate(to)}</Badge>
            <Badge tone="mint">{formatMoney(receivedInRange(payments, from, to))} received in range</Badge>
            <span>Exports include only rows inside the selected range.</span>
          </div>
        </>
      )}
    </div>
  );
}
