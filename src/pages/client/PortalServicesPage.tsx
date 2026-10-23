import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Badge, EmptyState, Field, Money, PageHeader, Segmented, SkeletonRows, TextInput } from '@/components/ui';
import { useCollection } from '@/context/app';
import { billingTypeLabel } from '@/lib/finance';
import { serviceStatusMeta } from '@/lib/labels';
import { fmtDate } from '@/lib/dates';
import type { ClientService, Service } from '@/lib/types';

export default function PortalServicesPage() {
  const { data: services, loading } = useCollection<ClientService>('client_services');
  const { data: catalog } = useCollection<Service>('services');
  const [filter, setFilter] = useState<'active' | 'past'>('active');
  const [search, setSearch] = useState('');

  const nameOf = (s: ClientService) => s.title ?? catalog.find((c) => c.id === s.service_id)?.name ?? 'Service';
  const listed = services
    .filter((s) => (filter === 'active' ? s.status === 'active' || s.status === 'paused' : ['completed', 'cancelled'].includes(s.status)))
    .filter((s) => !search.trim() || nameOf(s).toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div>
      <PageHeader
        eyebrow="Your account"
        title="Services"
        description="What you have engaged Managed by Luna for, at the agreed price. Only your own services appear here."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          ariaLabel="Service filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'active', label: 'Current', count: services.filter((s) => s.status === 'active' || s.status === 'paused').length },
            { value: 'past', label: 'Past', count: services.filter((s) => ['completed', 'cancelled'].includes(s.status)).length },
          ]}
        />
        <Field className="ml-auto w-56">
          {(id) => <TextInput id={id} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search services" className="py-1.5 text-xs" aria-label="Search services" />}
        </Field>
      </div>

      {loading ? (
        <SkeletonRows rows={4} />
      ) : listed.length === 0 ? (
        <EmptyState icon={<Sparkles className="h-6 w-6" />} title="Nothing here" description="Services assigned to your account will appear in this list." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {listed.map((s) => (
            <article key={s.id} className="surface p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-[13px] font-semibold text-fg">{nameOf(s)}</h2>
                  <p className="mt-0.5 text-[10.5px] text-faint">{catalog.find((c) => c.id === s.service_id)?.name}</p>
                </div>
                <Badge tone={serviceStatusMeta[s.status].tone}>{serviceStatusMeta[s.status].label}</Badge>
              </div>
              {s.description && <p className="mt-2 text-[11.5px] leading-relaxed text-muted">{s.description}</p>}
              <div className="mt-3 flex items-end justify-between gap-2 border-t pt-2.5">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.1em] text-faint">Agreed price</p>
                  <Money minor={s.price_minor} className="text-[14px] font-semibold text-fg" />
                </div>
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-[0.1em] text-faint">Billing</p>
                  <p className="text-[11.5px] text-muted">{billingTypeLabel[s.billing_type]}</p>
                </div>
              </div>
              <p className="mt-2 text-[10.5px] text-faint">
                {fmtDate(s.start_date)} {s.end_date ? `→ ${fmtDate(s.end_date)}` : '→ ongoing'}
              </p>
              {s.client_notes && (
                <p className="mt-2 rounded-lg border p-2 text-[11px] leading-relaxed text-muted" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
                  {s.client_notes}
                </p>
              )}
            </article>
          ))}
        </div>
      )}

      <p className="mt-4 text-[10.5px] text-faint">
        Prices and scope are set by Managed by Luna. If something looks wrong, contact your team — you cannot edit them here.
      </p>
    </div>
  );
}
