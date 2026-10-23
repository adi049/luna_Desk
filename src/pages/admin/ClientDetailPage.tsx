import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  BadgeCheck,
  Ban,
  Building2,
  CalendarClock,
  CheckCircle2,
  Copy,
  FileText,
  History,
  KeyRound,
  Mail,
  Pencil,
  Phone,
  Plus,
  Receipt as ReceiptIcon,
  RotateCcw,
  ShieldOff,
  Sparkles,
  Wallet,
} from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Money,
  PageHeader,
  Segmented,
  SkeletonRows,
  TextInput,
  Toolbar,
} from '@/components/ui';
import { ConfirmDialog, Drawer } from '@/components/ui/overlays';
import { PaymentDialog, InvoiceDialog } from '@/components/finance/dialogs';
import { useCollection, useData, useToast } from '@/context/app';
import { clientStatusMeta, paymentMethodLabel, paymentStatusMeta, projectStatusMeta, serviceStatusMeta } from '@/lib/labels';
import { fmtDate, fmtDateTime, fmtRelative, monthLabel } from '@/lib/dates';
import { balanceMinor, billingTypeLabel, effectiveStatus, paidMinor, summariseReceivables } from '@/lib/finance';
import { formatMoney } from '@/lib/money';
import type {
  AuditLog,
  Client,
  ClientService,
  Invoice,
  Payment,
  Project,
  Receipt,
  Service,
} from '@/lib/types';
import { ClientDrawer } from './ClientsPage';

type Tab = 'overview' | 'services' | 'projects' | 'invoices' | 'payments' | 'receipts' | 'activity';

export default function ClientDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const toast = useToast();

  const { data: clients, loading, refresh } = useCollection<Client>('clients');
  const { data: services } = useCollection<ClientService>('client_services');
  const { data: catalog } = useCollection<Service>('services');
  const { data: projects } = useCollection<Project>('projects');
  const { data: invoices } = useCollection<Invoice>('invoices');
  const { data: payments } = useCollection<Payment>('payments');
  const { data: receipts } = useCollection<Receipt>('receipts');
  const { data: logs } = useCollection<AuditLog>('audit_logs');

  const client = clients.find((c) => c.id === id) ?? null;

  const [tab, setTab] = useState<Tab>('overview');
  const [editOpen, setEditOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const myServices = useMemo(() => services.filter((s) => s.client_id === id), [services, id]);
  const myProjects = useMemo(() => projects.filter((p) => p.client_id === id), [projects, id]);
  const myInvoices = useMemo(
    () => invoices.filter((i) => i.client_id === id).sort((a, b) => b.issue_date.localeCompare(a.issue_date)),
    [invoices, id],
  );
  const myPayments = useMemo(
    () => payments.filter((p) => p.client_id === id && !p.voided_at).sort((a, b) => b.paid_at.localeCompare(a.paid_at)),
    [payments, id],
  );
  const myReceipts = useMemo(
    () => receipts.filter((r) => r.client_id === id).sort((a, b) => b.issued_at.localeCompare(a.issued_at)),
    [receipts, id],
  );
  const myLogs = useMemo(
    () => logs.filter((l) => l.entity_id === id || myInvoices.some((i) => i.id === l.entity_id)).slice(0, 30),
    [logs, id, myInvoices],
  );

  const receivables = summariseReceivables(myInvoices, payments);
  const activeServices = myServices.filter((s) => s.status === 'active');

  const setClientStatus = async (status: Client['status']) => {
    if (!client) return;
    setBusy(true);
    try {
      await adapter.update<Client>('clients', client.id, { status });
      if (status !== 'active') {
        await adapter.rpc('revoke_client_access', { client_id: client.id });
      }
      toast.success(status === 'active' ? 'Client reactivated' : 'Client deactivated', 'Financial history is untouched.');
      setDeactivateOpen(false);
      refresh();
      invalidate();
    } catch (err) {
      toast.error('Could not update the client', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const revokeAccess = async () => {
    if (!client) return;
    setBusy(true);
    try {
      await adapter.rpc('revoke_client_access', { client_id: client.id });
      toast.success('Portal access revoked', 'Their next request is rejected at the database.');
      setRevokeOpen(false);
      refresh();
      invalidate();
    } catch (err) {
      toast.error('Could not revoke access', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const reactivatePortal = async () => {
    if (!client) return;
    setBusy(true);
    try {
      await adapter.rpc('create_client_portal', { client_id: client.id });
      toast.success('Portal access restored', 'The existing code works again.');
      refresh();
      invalidate();
    } catch (err) {
      toast.error('Could not restore access', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonRows rows={6} />;

  if (!client) {
    return (
      <EmptyState
        title="Client not found"
        description="This client may have been removed, or the link is out of date."
        action={
          <Button variant="ghost" onClick={() => navigate('/admin/clients')} icon={<ArrowLeft className="h-4 w-4" />}>
            Back to clients
          </Button>
        }
      />
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => navigate('/admin/clients')}
        className="mb-3 inline-flex items-center gap-1 text-[11px] text-muted transition hover:text-fg"
      >
        <ArrowLeft className="h-3 w-3" aria-hidden /> All clients
      </button>

      <PageHeader
        eyebrow={client.business_name}
        title={client.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={clientStatusMeta[client.status].tone}>{clientStatusMeta[client.status].label}</Badge>
            <Badge tone={client.portal_status === 'active' ? 'mint' : client.portal_status === 'revoked' ? 'magenta' : 'muted'}>
              Portal {client.portal_status === 'active' ? 'active' : client.portal_status === 'revoked' ? 'revoked' : 'not set up'}
            </Badge>
            <span className="font-mono text-[11px] text-faint">{client.client_code}</span>
            <span className="text-[11px] text-faint">Added {fmtDate(client.created_at)}</span>
          </span>
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setEditOpen(true)} icon={<Pencil className="h-4 w-4" />}>
              Edit
            </Button>
            <Button variant="ghost" onClick={() => setAccessOpen(true)} icon={<KeyRound className="h-4 w-4" />}>
              Portal access
            </Button>
            <Button variant="primary" onClick={() => setPayOpen(true)} icon={<Wallet className="h-4 w-4" />}>
              Record payment
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Active services', value: String(activeServices.length), hint: `${myServices.length} total assigned` },
          { label: 'Invoiced', value: formatMoney(receivables.invoiced, { compact: true }), hint: `${myInvoices.length} invoices` },
          { label: 'Received', value: formatMoney(receivables.received, { compact: true }), hint: `${myPayments.length} payments` },
          {
            label: 'Outstanding',
            value: formatMoney(receivables.outstanding, { compact: true }),
            hint: receivables.overdue > 0 ? `${formatMoney(receivables.overdue)} overdue` : 'Nothing overdue',
          },
        ].map((stat) => (
          <div key={stat.label} className="surface p-3.5">
            <p className="eyebrow">{stat.label}</p>
            <p className="num mt-1.5 text-xl font-semibold text-fg">{stat.value}</p>
            <p className="mt-0.5 text-[10.5px] text-faint">{stat.hint}</p>
          </div>
        ))}
      </div>

      <Toolbar>
        <Segmented
          size="sm"
          ariaLabel="Client sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'services', label: 'Services', count: myServices.length },
            { value: 'projects', label: 'Projects', count: myProjects.length },
            { value: 'invoices', label: 'Invoices', count: myInvoices.length },
            { value: 'payments', label: 'Payments', count: myPayments.length },
            { value: 'receipts', label: 'Receipts', count: myReceipts.length },
            { value: 'activity', label: 'Activity' },
          ]}
        />
      </Toolbar>

      {tab === 'overview' && (
        <div className="grid gap-3 lg:grid-cols-3">
          <section className="surface p-4">
            <h2 className="text-xs font-semibold text-fg">Contact</h2>
            <dl className="mt-3 space-y-2 text-[12px]">
              <div className="flex items-start gap-2">
                <Building2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
                <div>
                  <dt className="text-[10px] uppercase tracking-[0.12em] text-faint">Business</dt>
                  <dd className="text-fg">{client.business_name}</dd>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
                <div>
                  <dt className="text-[10px] uppercase tracking-[0.12em] text-faint">Contact person</dt>
                  <dd className="text-fg">{client.contact_person ?? '—'}</dd>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
                <div className="min-w-0">
                  <dt className="text-[10px] uppercase tracking-[0.12em] text-faint">Email</dt>
                  <dd className="truncate text-fg">{client.email ?? '—'}</dd>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Phone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
                <div>
                  <dt className="text-[10px] uppercase tracking-[0.12em] text-faint">Phone</dt>
                  <dd className="text-fg">{client.phone ?? '—'}</dd>
                </div>
              </div>
              {client.address && (
                <div className="flex items-start gap-2">
                  <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
                  <div>
                    <dt className="text-[10px] uppercase tracking-[0.12em] text-faint">Address</dt>
                    <dd className="text-fg">{client.address}</dd>
                  </div>
                </div>
              )}
            </dl>
            <p className="mt-3 border-t pt-2 text-[10px] text-faint">Last updated {fmtRelative(client.updated_at)}</p>
          </section>

          <section className="surface p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold text-fg">Portal access</h2>
              <Button size="sm" variant="quiet" onClick={() => setAccessOpen(true)} icon={<KeyRound className="h-3 w-3" />}>
                Manage
              </Button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              {client.portal_status === 'active'
                ? 'This client can sign in with their access code and sees only their own services, projects and billing.'
                : client.portal_status === 'revoked'
                  ? 'Portal access is revoked. Their account cannot read anything, and codes are rejected server-side.'
                  : 'No portal account yet. Create one and issue an access code when you are ready.'}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {client.portal_status !== 'active' ? (
                <Button size="sm" variant="ghost" onClick={() => void reactivatePortal()} loading={busy} icon={<RotateCcw className="h-3 w-3" />}>
                  {client.portal_status === 'revoked' ? 'Reactivate portal' : 'Create portal account'}
                </Button>
              ) : (
                <Button size="sm" variant="danger" onClick={() => setRevokeOpen(true)} icon={<ShieldOff className="h-3 w-3" />}>
                  Revoke access
                </Button>
              )}
              {client.status !== 'inactive' ? (
                <Button size="sm" variant="quiet" onClick={() => setDeactivateOpen(true)} icon={<Ban className="h-3 w-3" />}>
                  Deactivate client
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => void setClientStatus('active')} loading={busy} icon={<CheckCircle2 className="h-3 w-3" />}>
                  Reactivate client
                </Button>
              )}
            </div>
          </section>

          <section className="surface p-4">
            <h2 className="flex items-center gap-1.5 text-xs font-semibold text-fg">
              <History className="h-3.5 w-3.5 text-faint" aria-hidden /> Internal notes
            </h2>
            <p className="mt-2 whitespace-pre-wrap text-[11.5px] leading-relaxed text-muted">
              {client.internal_notes || 'No internal notes. Add them from Edit — clients never see this field.'}
            </p>
          </section>

          <section className="surface p-4 lg:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-fg">Current billing</h2>
              <Button size="sm" variant="quiet" onClick={() => setInvoiceOpen(true)} icon={<Plus className="h-3 w-3" />}>
                New invoice
              </Button>
            </div>
            {myInvoices.length === 0 ? (
              <EmptyState compact icon={<FileText className="h-5 w-5" />} title="No invoices yet" description="Raise an invoice for one billing period at a time so recurring services stay reconciled." />
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Period</th>
                      <th>Status</th>
                      <th className="text-right">Total</th>
                      <th className="text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {myInvoices.slice(0, 5).map((inv) => {
                      const status = effectiveStatus(inv, payments);
                      return (
                        <tr key={inv.id}>
                          <td className="font-mono text-[11px] text-fg">{inv.invoice_number}</td>
                          <td className="text-[11px] text-muted">
                            {inv.billing_period_start ? monthLabel(String(inv.billing_period_start).slice(0, 7)) : fmtDate(inv.issue_date)}
                          </td>
                          <td>
                            <Badge tone={paymentStatusMeta[status].tone}>{paymentStatusMeta[status].label}</Badge>
                          </td>
                          <td className="text-right"><Money minor={inv.total_minor} className="text-[12px]" /></td>
                          <td className="text-right">
                            <Money minor={balanceMinor(inv, payments)} tone={status === 'paid' ? 'mint' : 'butter'} className="text-[12px]" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="surface p-4">
            <h2 className="text-xs font-semibold text-fg">Assigned services</h2>
            {myServices.length === 0 ? (
              <p className="mt-2 text-[11px] text-faint">No services assigned yet.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {myServices.slice(0, 5).map((s) => (
                  <li key={s.id} className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[12px] text-fg">{s.title ?? catalog.find((c) => c.id === s.service_id)?.name}</p>
                      <p className="text-[10px] text-faint">{billingTypeLabel[s.billing_type]}</p>
                    </div>
                    <Badge tone={serviceStatusMeta[s.status].tone}>{serviceStatusMeta[s.status].label}</Badge>
                  </li>
                ))}
              </ul>
            )}
            <Link to="/admin/services" className="mt-3 inline-flex items-center gap-1 text-[11px] text-magenta hover:underline">
              Manage services
            </Link>
          </section>
        </div>
      )}

      {tab === 'services' && (
        <section className="surface p-4">
          {myServices.length === 0 ? (
            <EmptyState
              icon={<Sparkles className="h-6 w-6" />}
              title="No services assigned"
              description="Assign a service from the Services page to bill this client."
              action={<Link to="/admin/services" className="btn btn-ghost">Go to services</Link>}
            />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Billing</th>
                    <th>Price</th>
                    <th>Period</th>
                    <th>Status</th>
                    <th>Client notes</th>
                  </tr>
                </thead>
                <tbody>
                  {myServices.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <p className="text-[12.5px] font-medium text-fg">{s.title ?? catalog.find((c) => c.id === s.service_id)?.name}</p>
                        {s.description && <p className="mt-0.5 max-w-sm truncate text-[10.5px] text-faint">{s.description}</p>}
                      </td>
                      <td className="text-[11.5px] text-muted">{billingTypeLabel[s.billing_type]}</td>
                      <td><Money minor={s.price_minor} className="text-[12px]" /></td>
                      <td className="whitespace-nowrap text-[11px] text-muted">
                        {fmtDate(s.start_date)}
                        <span className="block text-[10px] text-faint">{s.end_date ? `→ ${fmtDate(s.end_date)}` : 'ongoing'}</span>
                      </td>
                      <td><Badge tone={serviceStatusMeta[s.status].tone}>{serviceStatusMeta[s.status].label}</Badge></td>
                      <td className="max-w-[16rem] text-[11px] text-muted">{s.client_notes ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'projects' && (
        <section className="surface p-4">
          {myProjects.length === 0 ? (
            <EmptyState icon={<CalendarClock className="h-6 w-6" />} title="No projects" description="Projects give this client visibility into work in progress." />
          ) : (
            <ul className="space-y-2">
              {myProjects.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 rounded-xl border p-3" style={{ borderColor: 'rgb(var(--line) / 0.12)' }}>
                  <div className="min-w-0 flex-1">
                    <Link to={`/admin/projects/${p.id}`} className="text-[12.5px] font-medium text-fg hover:underline">
                      {p.name}
                    </Link>
                    <p className="mt-0.5 text-[10.5px] text-faint">
                      {p.due_date ? `Due ${fmtDate(p.due_date)}` : 'No due date'} · {p.progress}% complete
                      {p.client_visible ? ' · visible to client' : ' · internal only'}
                    </p>
                  </div>
                  <Badge tone={projectStatusMeta[p.status].tone}>{projectStatusMeta[p.status].label}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'invoices' && (
        <section className="surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-fg">Invoices</h2>
            <Button size="sm" variant="ghost" onClick={() => setInvoiceOpen(true)} icon={<Plus className="h-3 w-3" />}>
              New invoice
            </Button>
          </div>
          {myInvoices.length === 0 ? (
            <EmptyState compact icon={<FileText className="h-5 w-5" />} title="No invoices" description="Nothing has been billed to this client yet." />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Issued</th>
                    <th>Due</th>
                    <th>Status</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Paid</th>
                    <th className="text-right">Balance</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {myInvoices.map((inv) => {
                    const status = effectiveStatus(inv, payments);
                    const balance = balanceMinor(inv, payments);
                    return (
                      <tr key={inv.id}>
                        <td className="font-mono text-[11px] text-fg">{inv.invoice_number}</td>
                        <td className="text-[11px] text-muted">{fmtDate(inv.issue_date)}</td>
                        <td className="text-[11px] text-muted">{fmtDate(inv.due_date)}</td>
                        <td><Badge tone={paymentStatusMeta[status].tone}>{paymentStatusMeta[status].label}</Badge></td>
                        <td className="text-right"><Money minor={inv.total_minor} className="text-[12px]" /></td>
                        <td className="text-right"><Money minor={paidMinor(inv.id, payments)} tone="mint" className="text-[12px]" /></td>
                        <td className="text-right"><Money minor={balance} tone={balance > 0 ? 'butter' : 'mint'} className="text-[12px]" /></td>
                        <td className="text-right">
                          {balance > 0 && (
                            <Button size="sm" variant="quiet" onClick={() => setPayOpen(true)}>
                              Record
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'payments' && (
        <section className="surface p-4">
          {myPayments.length === 0 ? (
            <EmptyState compact icon={<Wallet className="h-5 w-5" />} title="No payments recorded" description="Payments appear here once you record them against an invoice." />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Invoice</th>
                    <th>Method</th>
                    <th>Reference</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {myPayments.map((p) => {
                    const inv = invoices.find((i) => i.id === p.invoice_id);
                    return (
                      <tr key={p.id}>
                        <td className="text-[11.5px] text-muted">{fmtDate(p.paid_at)}</td>
                        <td className="font-mono text-[11px] text-fg">{inv?.invoice_number ?? '—'}</td>
                        <td className="text-[11.5px] text-muted">{paymentMethodLabel[p.method]}</td>
                        <td className="font-mono text-[10.5px] text-faint">{p.reference ?? '—'}</td>
                        <td className="text-right"><Money minor={p.amount_minor} tone="mint" className="text-[12.5px]" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'receipts' && (
        <section className="surface p-4">
          {myReceipts.length === 0 ? (
            <EmptyState compact icon={<ReceiptIcon className="h-5 w-5" />} title="No receipts" description="A receipt is issued when a payment is recorded." />
          ) : (
            <ul className="space-y-1.5">
              {myReceipts.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5" style={{ borderColor: 'rgb(var(--line) / 0.12)' }}>
                  <ReceiptIcon className="h-3.5 w-3.5 text-faint" aria-hidden />
                  <span className="font-mono text-[11px] text-fg">{r.receipt_number}</span>
                  <span className="text-[10.5px] text-faint">issued {fmtDate(r.issued_at)}</span>
                  <Money minor={r.snapshot?.amount_received_minor ?? 0} className="ml-auto text-[12px]" />
                  <Link to={`/admin/receipts/${r.id}`} className="text-[11px] text-magenta hover:underline">
                    Open
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'activity' && (
        <section className="surface p-4">
          {myLogs.length === 0 ? (
            <EmptyState compact icon={<History className="h-5 w-5" />} title="No recorded activity" description="Financial and access changes on this client are logged with who did what." />
          ) : (
            <ul className="space-y-2">
              {myLogs.map((log) => (
                <li key={log.id} className="flex items-start gap-2 border-b pb-2 text-[11.5px] last:border-b-0">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-sky" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-fg">{log.action.replace(/[._]/g, ' ')}</p>
                    <p className="text-[10.5px] text-faint">
                      {log.actor_label ?? 'System'} · {fmtDateTime(log.created_at)}
                    </p>
                  </div>
                  <Badge tone="muted">{log.entity}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <ClientDrawer
        open={editOpen}
        onClose={() => setEditOpen(false)}
        client={client}
        existingCodes={clients.filter((c) => c.id !== client.id).map((c) => c.client_code)}
        onSaved={() => {
          refresh();
          invalidate();
        }}
      />

      <PortalAccessDrawer
        open={accessOpen}
        onClose={() => setAccessOpen(false)}
        client={client}
        onChanged={() => {
          refresh();
          invalidate();
        }}
      />

      <PaymentDialog open={payOpen} onClose={() => setPayOpen(false)} invoice={null} />
      <InvoiceDialog open={invoiceOpen} onClose={() => setInvoiceOpen(false)} defaultClientId={client.id} />

      <ConfirmDialog
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        onConfirm={revokeAccess}
        busy={busy}
        title="Revoke portal access?"
        confirmLabel="Revoke access"
        body={
          <>
            <strong className="text-fg">{client.name}</strong> will be signed out and their codes rejected immediately.
            Projects, invoices, payments and receipts are kept — this only closes the door.
          </>
        }
      />

      <ConfirmDialog
        open={deactivateOpen}
        onClose={() => setDeactivateOpen(false)}
        onConfirm={() => void setClientStatus('inactive')}
        busy={busy}
        title="Deactivate this client?"
        confirmLabel="Deactivate"
        body={
          <>
            The client is marked inactive and portal access is revoked. Nothing is deleted: services, invoices and
            receipts remain for your records, and you can reactivate at any time.
          </>
        }
      />
    </div>
  );
}

function PortalAccessDrawer({
  open,
  onClose,
  client,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  client: Client;
  onChanged: () => void;
}) {
  const adapter = useData().adapters.data;
  const toast = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);

  const generate = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    setCode(value);
  };

  const apply = async () => {
    const normalised = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(normalised)) {
      toast.error('Use 4–12 letters or numbers');
      return;
    }
    setBusy(true);
    try {
      if (client.portal_status === 'active') {
        // Existing portal: rotate the code in place.
        await adapter.rpc('change_client_access_code', { client_id: client.id, code: normalised });
      } else {
        // First portal (or one that was revoked): provision identity + code.
        await adapter.rpc('create_client_portal', {
          client_id: client.id,
          code: normalised,
          email: client.email ?? undefined,
        });
      }
      setGenerated(normalised);
      toast.success(
        client.portal_status === 'active' ? 'Access code updated' : 'Portal created',
        'Share the code with the client over a channel you trust.',
      );
      onChanged();
    } catch (err) {
      toast.error('Could not update portal access', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`Portal access — ${client.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={() => void apply()} loading={busy}>
            {client.portal_status === 'active' ? 'Rotate code' : 'Create portal & set code'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border p-3 text-[11.5px] leading-relaxed text-muted" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
          <p className="mb-1 font-medium text-fg">Status: {client.portal_status === 'active' ? 'Active' : client.portal_status === 'revoked' ? 'Revoked' : 'Not set up'}</p>
          The code is exchanged server-side for a real Supabase session. LunaDesk stores a hash of it, never the code
          itself, and rate-limits repeated attempts. Rotating a code invalidates the old one immediately.
        </div>

        <Field label="New access code" hint="4–12 letters or numbers, no spaces" required>
          {(id) => (
            <div className="flex gap-2">
              <TextInput
                id={id}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="PR104"
                className="font-mono uppercase tracking-[0.2em]"
                autoFocus
              />
              <Button type="button" variant="ghost" onClick={generate}>
                Generate
              </Button>
            </div>
          )}
        </Field>

        {generated && (
          <div className="rounded-xl border border-mint/30 bg-mint/[0.07] p-3">
            <p className="text-[10px] uppercase tracking-[0.14em] text-accent-mint">New code</p>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-lg tracking-[0.25em] text-fg">{generated}</span>
              <Button
                size="sm"
                variant="quiet"
                onClick={() => {
                  void navigator.clipboard?.writeText(generated);
                  toast.success('Copied to clipboard');
                }}
                icon={<Copy className="h-3 w-3" />}
              >
                Copy
              </Button>
            </div>
            <p className="mt-1.5 text-[10.5px] text-muted">
              This is the only time the code is displayed. It cannot be retrieved later — only rotated.
            </p>
          </div>
        )}

        <p className="text-[10.5px] leading-relaxed text-faint">
          Short codes are low-entropy by design. LunaDesk mitigates that with server-side rate limiting, attempt logging
          and immediate rotation — not by assuming the code is secret.
        </p>
      </div>
    </Drawer>
  );
}
