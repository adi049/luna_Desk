import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  ArrowUpRight,
  BellRing,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  FileText,
  FolderKanban,
  ListChecks,
  Plus,
  Receipt,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';
import { Badge, Button, EmptyState, Money, PageHeader, SkeletonRows, StatCard } from '@/components/ui';
import { RevenueTrendChart } from '@/components/charts';
import { useCollection } from '@/context/app';
import { useAuth } from '@/context/auth';
import { fmtDate, fmtDateTime, fmtRelative, monthLabel, todayISO } from '@/lib/dates';
import { effectiveStatus, monthlyReceivedSeries, paidMinor, summariseReceivables } from '@/lib/finance';
import { formatMoney } from '@/lib/money';
import { clientStatusMeta, paymentStatusMeta, projectStatusMeta, taskPriorityMeta } from '@/lib/labels';
import type {
  Client,
  Invoice,
  Payment,
  Project,
  ProjectUpdate,
  Reminder,
  Task,
} from '@/lib/types';
import { cn } from '@/lib/utils';

export default function OverviewPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [range, setRange] = useState<'6m' | '12m'>('6m');

  const clients = useCollection<Client>('clients');
  const projects = useCollection<Project>('projects');
  const invoices = useCollection<Invoice>('invoices');
  const payments = useCollection<Payment>('payments');
  const tasks = useCollection<Task>('tasks');
  const reminders = useCollection<Reminder>('reminders');
  const updates = useCollection<ProjectUpdate>('project_updates');

  const loading = clients.loading || projects.loading || invoices.loading || payments.loading;

  const today = todayISO();
  const now = Date.now();

  const stats = useMemo(() => {
    const activeClients = clients.data.filter((c) => c.status === 'active');
    const inactiveClients = clients.data.filter((c) => c.status !== 'active');
    const activeProjects = projects.data.filter((p) => !['completed', 'cancelled'].includes(p.status));
    const receivables = summariseReceivables(invoices.data, payments.data);
    const thisMonth = today.slice(0, 7);
    const monthlyReceived = payments.data
      .filter((p) => !p.voided_at && p.paid_at.slice(0, 7) === thisMonth)
      .reduce((sum, p) => sum + p.amount_minor, 0);
    const upcomingDeadlines = projects.data
      .filter((p) => p.due_date && p.due_date >= today && !['completed', 'cancelled'].includes(p.status))
      .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
      .slice(0, 5);
    const overdueTasks = tasks.data.filter(
      (t) => t.status !== 'completed' && t.status !== 'archived' && t.due_date && t.due_date < today,
    );
    const upcomingReminders = reminders.data
      .filter((r) => !r.is_dismissed && new Date(r.snoozed_until ?? r.remind_at).getTime() >= now)
      .sort((a, b) => a.remind_at.localeCompare(b.remind_at))
      .slice(0, 4);
    return {
      activeClients,
      inactiveClients,
      activeProjects,
      receivables,
      monthlyReceived,
      upcomingDeadlines,
      overdueTasks,
      upcomingReminders,
    };
  }, [clients.data, projects.data, invoices.data, payments.data, tasks.data, reminders.data, today, now]);

  const revenueSeries = useMemo(() => {
    const months = range === '6m' ? 6 : 12;
    return monthlyReceivedSeries(payments.data, months).map((point) => ({
      label: monthLabel(point.key).replace(' ', '\u00A0'),
      received: point.received,
      invoiced: invoices.data
        .filter((i) => String(i.issue_date).slice(0, 7) === point.key && i.status !== 'cancelled')
        .reduce((sum, i) => sum + i.total_minor, 0),
    }));
  }, [payments.data, invoices.data, range]);

  const recentPayments = useMemo(
    () =>
      [...payments.data]
        .filter((p) => !p.voided_at)
        .sort((a, b) => b.paid_at.localeCompare(a.paid_at))
        .slice(0, 5),
    [payments.data],
  );

  const recentUpdates = useMemo(
    () => [...updates.data].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 4),
    [updates.data],
  );

  const clientName = (id: string) => clients.data.find((c) => c.id === id)?.name ?? 'Client';
  const projectName = (id: string) => projects.data.find((p) => p.id === id)?.name ?? 'Project';

  const noDataYet = !loading && clients.data.length === 0;

  return (
    <div>
      <PageHeader
        eyebrow={`${fmtDate(new Date(), 'EEEE, d MMMM yyyy')}`}
        title={`Good to see you, ${profile?.full_name?.split(' ')[0] ?? 'Luna'}`}
        description="Everything on the desk right now — clients, cash and the work in flight. Numbers come straight from your database; nothing is estimated."
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate('/admin/payments')} icon={<Wallet className="h-4 w-4" />}>
              Record payment
            </Button>
            <Button variant="primary" onClick={() => navigate('/admin/clients')} icon={<Plus className="h-4 w-4" />}>
              New client
            </Button>
          </>
        }
      />

      {noDataYet && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="surface mb-5 overflow-hidden p-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-lg">
              <p className="eyebrow text-magenta">Getting started</p>
              <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-fg">Your workspace is empty — and that is correct</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">
                LunaDesk shows nothing it cannot prove. Add your first client, assign a service, then invoice it. Every
                figure on this page will fill in from real records.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => navigate('/admin/clients')} icon={<Users className="h-4 w-4" />}>
                Add a client
              </Button>
              <Button variant="ghost" onClick={() => navigate('/admin/settings')}>
                Branding & receipts
              </Button>
            </div>
          </div>
          <ol className="mt-5 grid gap-2 sm:grid-cols-4">
            {[
              { step: '1', label: 'Create a client', hint: 'And issue their portal code' },
              { step: '2', label: 'Assign a service', hint: 'One-time or recurring' },
              { step: '3', label: 'Raise an invoice', hint: 'Per billing period' },
              { step: '4', label: 'Record a payment', hint: 'Receipt follows automatically' },
            ].map((item) => (
              <li key={item.step} className="rounded-xl border p-3" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
                <span className="num text-[10px] text-magenta">{item.step.padStart(2, '0')}</span>
                <p className="mt-1 text-[12.5px] font-medium text-fg">{item.label}</p>
                <p className="mt-0.5 text-[10.5px] text-faint">{item.hint}</p>
              </li>
            ))}
          </ol>
        </motion.div>
      )}

      {loading ? (
        <SkeletonRows rows={3} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              index={0}
              label="Active clients"
              value={stats.activeClients.length}
              hint={`${stats.inactiveClients.length} inactive or archived`}
              icon={<Users className="h-4 w-4" aria-hidden />}
              onClick={() => navigate('/admin/clients')}
            />
            <StatCard
              index={1}
              label="Received this month"
              value={formatMoney(stats.monthlyReceived, { compact: true })}
              hint={`${monthLabel(today.slice(0, 7))} · payments only`}
              tone="mint"
              icon={<CircleDollarSign className="h-4 w-4" aria-hidden />}
              onClick={() => navigate('/admin/payments')}
            />
            <StatCard
              index={2}
              label="Outstanding"
              value={formatMoney(stats.receivables.outstanding, { compact: true })}
              hint={
                stats.receivables.overdue > 0
                  ? `${formatMoney(stats.receivables.overdue)} overdue across ${stats.receivables.overdueCount} invoices`
                  : `${stats.receivables.openCount} invoices open`
              }
              tone={stats.receivables.overdue > 0 ? 'magenta' : 'neutral'}
              icon={<TrendingUp className="h-4 w-4" aria-hidden />}
              onClick={() => navigate('/admin/invoices')}
            />
            <StatCard
              index={3}
              label="Active projects"
              value={stats.activeProjects.length}
              hint={`${stats.overdueTasks.length} tasks overdue`}
              tone={stats.overdueTasks.length ? 'butter' : 'sky'}
              icon={<FolderKanban className="h-4 w-4" aria-hidden />}
              onClick={() => navigate('/admin/projects')}
            />
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <section className="surface p-4 lg:col-span-2">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-fg">Cash received vs invoiced</h2>
                  <p className="mt-0.5 text-[11px] text-muted">Payments are money in. Invoiced is work billed — they are deliberately different lines.</p>
                </div>
                <div className="flex gap-1">
                  {(['6m', '12m'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRange(r)}
                      className={cn(
                        'rounded-md px-2 py-1 text-[11px] transition',
                        range === r ? 'bg-[rgb(var(--line)/0.14)] text-fg' : 'text-faint hover:text-muted',
                      )}
                    >
                      {r === '6m' ? '6 months' : '12 months'}
                    </button>
                  ))}
                </div>
              </div>
              {payments.data.length === 0 && invoices.data.length === 0 ? (
                <EmptyState
                  compact
                  icon={<TrendingUp className="h-5 w-5" />}
                  title="No financial history yet"
                  description="Once you record a payment or raise an invoice, the trend appears here."
                />
              ) : (
                <RevenueTrendChart data={revenueSeries} height={230} />
              )}
            </section>

            <section className="surface flex flex-col p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-fg">Needs attention</h2>
                <Link to="/admin/tasks" className="text-[11px] text-magenta hover:underline">
                  All tasks
                </Link>
              </div>
              {stats.overdueTasks.length === 0 && stats.upcomingReminders.length === 0 ? (
                <EmptyState compact icon={<CheckCircle2 className="h-5 w-5" />} title="Nothing overdue" description="Overdue tasks and due reminders show up here." />
              ) : (
                <ul className="space-y-2">
                  {stats.overdueTasks.slice(0, 4).map((task) => (
                    <li key={task.id}>
                      <Link to="/admin/tasks" className="flex items-start gap-2 rounded-lg p-1.5 transition hover:bg-raised/60">
                        <ListChecks className="mt-0.5 h-3.5 w-3.5 shrink-0 text-magenta" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-medium text-fg">{task.title}</span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-faint">
                            <span className="text-magenta">Overdue</span> · {fmtDate(task.due_date)}
                            <Badge tone={taskPriorityMeta[task.priority].tone}>{taskPriorityMeta[task.priority].label}</Badge>
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                  {stats.upcomingReminders.map((reminder) => (
                    <li key={reminder.id}>
                      <Link to="/admin/reminders" className="flex items-start gap-2 rounded-lg p-1.5 transition hover:bg-raised/60">
                        <BellRing className="mt-0.5 h-3.5 w-3.5 shrink-0 text-butter" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-medium text-fg">{reminder.title}</span>
                          <span className="text-[10px] text-faint">{fmtDateTime(reminder.remind_at)} · {fmtRelative(reminder.remind_at)}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <section className="surface p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-fg">Upcoming deadlines</h2>
                <Link to="/admin/projects" className="text-[11px] text-magenta hover:underline">
                  Projects
                </Link>
              </div>
              {stats.upcomingDeadlines.length === 0 ? (
                <EmptyState compact icon={<CalendarClock className="h-5 w-5" />} title="No deadlines ahead" description="Add a due date to a project to track it here." />
              ) : (
                <ul className="space-y-1.5">
                  {stats.upcomingDeadlines.map((p) => (
                    <li key={p.id}>
                      <Link to={`/admin/projects/${p.id}`} className="block rounded-lg p-1.5 transition hover:bg-raised/60">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[12px] font-medium text-fg">{p.name}</span>
                          <Badge tone={projectStatusMeta[p.status].tone}>{projectStatusMeta[p.status].label}</Badge>
                        </div>
                        <p className="mt-0.5 text-[10.5px] text-faint">
                          {clientName(p.client_id)} · due {fmtDate(p.due_date)} ({fmtRelative(`${p.due_date}T09:00:00`)})
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="surface p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-fg">Recent payments</h2>
                <Link to="/admin/receipts" className="text-[11px] text-magenta hover:underline">
                  Receipts
                </Link>
              </div>
              {recentPayments.length === 0 ? (
                <EmptyState compact icon={<Receipt className="h-5 w-5" />} title="No payments yet" description="Recorded payments appear here with their invoice." />
              ) : (
                <ul className="space-y-1.5">
                  {recentPayments.map((p) => {
                    const invoice = invoices.data.find((i) => i.id === p.invoice_id);
                    return (
                      <li key={p.id} className="flex items-start justify-between gap-2 rounded-lg p-1.5">
                        <div className="min-w-0">
                          <p className="truncate text-[12px] font-medium text-fg">{clientName(p.client_id)}</p>
                          <p className="text-[10px] text-faint">
                            {invoice?.invoice_number ?? 'Invoice'} · {fmtDate(p.paid_at)}
                          </p>
                        </div>
                        <Money minor={p.amount_minor} tone="mint" className="shrink-0 text-[12px]" />
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="surface p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-fg">Recent project updates</h2>
                <Link to="/admin/projects" className="text-[11px] text-magenta hover:underline">
                  View
                </Link>
              </div>
              {recentUpdates.length === 0 ? (
                <EmptyState compact icon={<FileText className="h-5 w-5" />} title="No updates posted" description="Updates you post against a project appear here and in the client portal." />
              ) : (
                <ul className="space-y-2">
                  {recentUpdates.map((u) => (
                    <li key={u.id} className="rounded-lg p-1.5">
                      <p className="flex items-center gap-1.5 truncate text-[12px] font-medium text-fg">
                        {u.title}
                        {u.client_visible && <Badge tone="sky">client</Badge>}
                      </p>
                      <p className="mt-0.5 truncate text-[10.5px] text-faint">
                        {projectName(u.project_id)} · {fmtRelative(u.created_at)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="surface mt-3 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-fg">Client status</h2>
              <Link to="/admin/clients" className="flex items-center gap-1 text-[11px] text-magenta hover:underline">
                Manage clients <ArrowUpRight className="h-3 w-3" aria-hidden />
              </Link>
            </div>
            {clients.data.length === 0 ? (
              <EmptyState compact title="No clients yet" description="Add a client to start assigning services and tracking payments." />
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th>Status</th>
                      <th>Portal</th>
                      <th className="text-right">Outstanding</th>
                      <th className="text-right">Active projects</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {clients.data.slice(0, 6).map((client) => {
                      const clientInvoices = invoices.data.filter((i) => i.client_id === client.id && i.status !== 'cancelled');
                      const outstanding = clientInvoices.reduce(
                        (sum, inv) => sum + Math.max(0, inv.total_minor - paidMinor(inv.id, payments.data)),
                        0,
                      );
                      const openProjectCount = projects.data.filter(
                        (p) => p.client_id === client.id && !['completed', 'cancelled'].includes(p.status),
                      ).length;
                      const overdue = clientInvoices.some((inv) => effectiveStatus(inv, payments.data) === 'overdue');
                      return (
                        <tr key={client.id}>
                          <td>
                            <Link to={`/admin/clients/${client.id}`} className="block">
                              <span className="block text-[13px] font-medium text-fg">{client.name}</span>
                              <span className="block text-[10.5px] text-faint">{client.business_name}</span>
                            </Link>
                          </td>
                          <td>
                            <Badge tone={clientStatusMeta[client.status].tone}>{clientStatusMeta[client.status].label}</Badge>
                          </td>
                          <td>
                            <Badge tone={client.portal_status === 'active' ? 'mint' : client.portal_status === 'revoked' ? 'magenta' : 'muted'}>
                              {client.portal_status === 'active' ? 'Active' : client.portal_status === 'revoked' ? 'Revoked' : 'Not set up'}
                            </Badge>
                          </td>
                          <td className="text-right">
                            <Money minor={outstanding} tone={overdue ? 'magenta' : outstanding > 0 ? 'neutral' : 'mint'} className="text-[12.5px]" />
                          </td>
                          <td className="num text-right text-[12.5px] text-muted">{openProjectCount}</td>
                          <td className="text-right">
                            <Link to={`/admin/clients/${client.id}`} className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-fg">
                              Open <ArrowRight className="h-3 w-3" aria-hidden />
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-faint">
            <span>{stats.receivables.invoiced > 0 ? `Invoiced lifetime: ${formatMoney(stats.receivables.invoiced)}` : 'No invoices yet'}</span>
            <span>{formatMoney(stats.receivables.received)} received</span>
            <span>{formatMoney(stats.receivables.outstanding)} outstanding</span>
            <span className="ml-auto">{paymentStatusMeta.paid.label} invoices are excluded from outstanding balances.</span>
          </p>
        </>
      )}
    </div>
  );
}
