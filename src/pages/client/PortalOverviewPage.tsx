import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, CalendarClock, CheckCircle2, Mail, Megaphone, Phone, Sparkles } from 'lucide-react';
import { Badge, EmptyState, Money, PageHeader } from '@/components/ui';
import { useCollection } from '@/context/app';
import { useAuth } from '@/context/auth';
import { fmtDate, fmtRelative, todayISO } from '@/lib/dates';
import { balanceMinor, effectiveStatus, summariseReceivables } from '@/lib/finance';
import { formatMoney } from '@/lib/money';
import { serviceStatusMeta, paymentStatusMeta } from '@/lib/labels';
import type {
  Announcement, BrandingSettings, CalendarEvent, Client, ClientService, Invoice, Payment, Project, ProjectUpdate, Service,
} from '@/lib/types';

export default function PortalOverviewPage() {
  const { profile } = useAuth();
  const { data: clients } = useCollection<Client>('clients');
  const { data: services } = useCollection<ClientService>('client_services');
  const { data: catalog } = useCollection<Service>('services');
  const { data: projects } = useCollection<Project>('projects');
  const { data: updates } = useCollection<ProjectUpdate>('project_updates');
  const { data: invoices } = useCollection<Invoice>('invoices');
  const { data: payments } = useCollection<Payment>('payments');
  const { data: events } = useCollection<CalendarEvent>('calendar_events');
  const { data: announcements } = useCollection<Announcement>('announcements');
  const { data: brandingRows } = useCollection<BrandingSettings>('branding_settings');
  const branding = brandingRows[0];

  const client = clients[0] ?? null;
  const activeServices = services.filter((s) => s.status === 'active');
  const openProjects = projects.filter((p) => !['completed', 'cancelled'].includes(p.status));
  const receivables = summariseReceivables(invoices, payments);
  const nextDue = useMemo(
    () =>
      invoices
        .filter((i) => balanceMinor(i, payments) > 0)
        .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))[0] ?? null,
    [invoices, payments],
  );
  const upcoming = useMemo(
    () =>
      events
        .filter((e) => new Date(e.ends_at).getTime() >= Date.now())
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
        .slice(0, 4),
    [events],
  );
  const latestUpdates = useMemo(
    () => [...updates].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 3),
    [updates],
  );
  const today = todayISO();

  if (!client && profile) {
    return (
      <EmptyState
        title="No client record linked"
        description="Your account is not attached to a client profile yet. Please contact Managed by Luna so they can link your portal."
      />
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow={client?.business_name ?? 'Client portal'}
        title={`Welcome back, ${profile?.full_name?.split(' ')[0] ?? 'there'}`}
        description="A read-only view of your work with Managed by Luna — services, projects, billing and receipts."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="surface p-4">
          <p className="eyebrow">Active services</p>
          <p className="num mt-1.5 text-2xl font-semibold text-fg">{activeServices.length}</p>
          <p className="mt-0.5 text-[10.5px] text-faint">{services.length - activeServices.length} completed or paused</p>
        </div>
        <div className="surface p-4">
          <p className="eyebrow">Projects in progress</p>
          <p className="num mt-1.5 text-2xl font-semibold text-sky">{openProjects.length}</p>
          <p className="mt-0.5 text-[10.5px] text-faint">{projects.length} total with you</p>
        </div>
        <div className="surface p-4">
          <p className="eyebrow">Outstanding balance</p>
          <p className={`num mt-1.5 text-2xl font-semibold ${receivables.overdue > 0 ? 'text-magenta' : 'text-butter'}`}>
            {formatMoney(receivables.outstanding, { compact: true })}
          </p>
          <p className="mt-0.5 text-[10.5px] text-faint">
            {receivables.overdue > 0 ? `${formatMoney(receivables.overdue)} past due` : 'Nothing overdue'}
          </p>
        </div>
        <div className="surface p-4">
          <p className="eyebrow">Paid to date</p>
          <p className="num mt-1.5 text-2xl font-semibold text-mint">{formatMoney(receivables.received, { compact: true })}</p>
          <p className="mt-0.5 text-[10.5px] text-faint">{payments.length} payments on record</p>
        </div>
      </div>

      {nextDue && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="surface mt-3 flex flex-wrap items-center gap-4 p-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-butter/15 text-butter">
            <CalendarClock className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-medium text-fg">
              Invoice {nextDue.invoice_number} · {formatMoney(balanceMinor(nextDue, payments))} due
            </p>
            <p className="mt-0.5 text-[11px] text-muted">
              {nextDue.due_date && nextDue.due_date < today ? 'Was due ' : 'Due '}
              {fmtDate(nextDue.due_date)} · {paymentStatusMeta[effectiveStatus(nextDue, payments)].label}
            </p>
          </div>
          <Link to="/portal/billing" className="btn btn-ghost rounded-xl px-3 py-2 text-[13px]">
            View invoice <ArrowRight className="ml-1 h-3 w-3" aria-hidden />
          </Link>
        </motion.div>
      )}

      {announcements.length > 0 && (
        <section className="mt-3 space-y-2">
          {announcements.map((a) => (
            <div key={a.id} className="surface flex gap-3 border-sky/25 p-4">
              <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-sky" aria-hidden />
              <div>
                <p className="text-[12.5px] font-medium text-fg">{a.title}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{a.body}</p>
                <p className="mt-1 text-[10px] text-faint">Posted {fmtRelative(a.published_at)}</p>
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <section className="surface p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg">Your services</h2>
            <Link to="/portal/services" className="text-[11px] text-magenta hover:underline">All services</Link>
          </div>
          {services.length === 0 ? (
            <EmptyState compact icon={<Sparkles className="h-5 w-5" />} title="No services yet" description="Services assigned to you will appear here with their agreed price and billing type." />
          ) : (
            <ul className="space-y-2">
              {services.slice(0, 4).map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-xl border p-3" style={{ borderColor: 'rgb(var(--line) / 0.12)' }}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-medium text-fg">
                      {s.title ?? catalog.find((c) => c.id === s.service_id)?.name ?? 'Service'}
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-faint">
                      {catalog.find((c) => c.id === s.service_id)?.name} · started {fmtDate(s.start_date)}
                    </p>
                  </div>
                  <Money minor={s.price_minor} className="text-[12.5px]" />
                  <Badge tone={serviceStatusMeta[s.status].tone}>{serviceStatusMeta[s.status].label}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="surface p-4">
          <h2 className="mb-3 text-sm font-semibold text-fg">Upcoming</h2>
          {upcoming.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-faint">Nothing scheduled. Deadlines we share appear here.</p>
          ) : (
            <ul className="space-y-2">
              {upcoming.map((e) => (
                <li key={e.id}>
                  <p className="text-[12px] font-medium text-fg">{e.title}</p>
                  <p className="text-[10.5px] text-faint">
                    {e.all_day ? fmtDate(e.starts_at) : `${fmtDate(e.starts_at)} · ${new Date(e.starts_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="surface p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg">Latest updates</h2>
            <Link to="/portal/projects" className="text-[11px] text-magenta hover:underline">Projects</Link>
          </div>
          {latestUpdates.length === 0 ? (
            <EmptyState compact icon={<CheckCircle2 className="h-5 w-5" />} title="No updates yet" description="Progress notes from your project team appear here." />
          ) : (
            <ul className="space-y-2.5">
              {latestUpdates.map((u) => {
                const project = projects.find((p) => p.id === u.project_id);
                return (
                  <li key={u.id} className="border-l-2 border-magenta/40 pl-3">
                    <p className="text-[12px] font-medium text-fg">{u.title}</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{u.body}</p>
                    <p className="mt-0.5 text-[10px] text-faint">
                      {project?.name ?? 'Project'} · {fmtRelative(u.created_at)}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="surface p-4">
          <h2 className="mb-3 text-sm font-semibold text-fg">Contact Managed by Luna</h2>
          <p className="text-[11.5px] leading-relaxed text-muted">
            Questions about a project, an invoice or a receipt? Reach your team directly.
          </p>
          <div className="mt-3 space-y-1.5 text-[11.5px]">
            <a href={`mailto:${branding?.contact_email ?? 'hello@managedbyluna.com'}`} className="flex items-center gap-2 text-fg hover:text-magenta">
              <Mail className="h-3.5 w-3.5 text-faint" aria-hidden /> {branding?.contact_email ?? 'hello@managedbyluna.com'}
            </a>
            {branding?.contact_phone && (
              <p className="flex items-center gap-2 text-fg">
                <Phone className="h-3.5 w-3.5 text-faint" aria-hidden /> {branding.contact_phone}
              </p>
            )}
          </div>
          <p className="mt-3 border-t pt-2 text-[10px] leading-relaxed text-faint">
            This portal is read-only. Your services, prices and payments are managed by the agency.
          </p>
        </section>
      </div>
    </div>
  );
}
