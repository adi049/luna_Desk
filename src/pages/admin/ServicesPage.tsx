import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Archive, Layers, Pencil, Plus, Sparkles, Users } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Money,
  PageHeader,
  SearchInput,
  Segmented,
  Select,
  SkeletonRows,
  TextArea,
  TextInput,
  Toolbar,
} from '@/components/ui';
import { ConfirmDialog, Drawer } from '@/components/ui/overlays';
import { useCollection, useData, useToast } from '@/context/app';
import { billingTypeLabel } from '@/lib/finance';
import { serviceStatusMeta } from '@/lib/labels';
import { fmtDate, todayISO } from '@/lib/dates';
import { minorToInput, parseMoneyToMinor } from '@/lib/money';
import type { Client, ClientService, Service, ServiceStatus } from '@/lib/types';
import { cn, uuid } from '@/lib/utils';

const serviceSchema = z.object({
  name: z.string().trim().min(2, 'Name the service.').max(80),
  category: z.string().trim().min(2, 'Name the category.').max(40),
  description: z.string().trim().max(400).optional(),
});

const assignmentSchema = z.object({
  client_id: z.string().min(1, 'Choose a client.'),
  service_id: z.string().min(1, 'Choose a service.'),
  title: z.string().trim().max(120).optional(),
  description: z.string().trim().max(600).optional(),
  price: z.string().min(1, 'Enter the agreed price.'),
  billing_type: z.enum(['one_time', 'monthly', 'quarterly', 'yearly', 'custom']),
  billing_frequency_label: z.string().trim().max(60).optional(),
  start_date: z.string().min(1, 'Choose a start date.'),
  end_date: z.string().optional(),
  status: z.enum(['active', 'paused', 'completed', 'cancelled']),
  internal_notes: z.string().trim().max(1000).optional(),
  client_notes: z.string().trim().max(1000).optional(),
});
type AssignmentForm = z.infer<typeof assignmentSchema>;

export default function ServicesPage() {
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const toast = useToast();

  const { data: catalog, loading: catalogLoading, refresh: refreshCatalog } = useCollection<Service>('services');
  const { data: assignments, loading: assignmentsLoading, refresh: refreshAssignments } = useCollection<ClientService>('client_services');
  const { data: clients } = useCollection<Client>('clients');

  const [tab, setTab] = useState<'assigned' | 'catalog'>('assigned');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ServiceStatus>('all');
  const [serviceDialog, setServiceDialog] = useState(false);
  const [assignDialog, setAssignDialog] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState<ClientService | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Service | null>(null);
  const [busy, setBusy] = useState(false);

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? 'Unknown client';
  const serviceName = (id: string) => catalog.find((s) => s.id === id)?.name ?? 'Service';

  const filteredAssignments = useMemo(() => {
    const q = search.trim().toLowerCase();
    return assignments
      .filter((a) => (statusFilter === 'all' ? true : a.status === statusFilter))
      .filter(
        (a) =>
          !q ||
          `${clientName(a.client_id)} ${a.title ?? ''} ${serviceName(a.service_id)}`.toLowerCase().includes(q),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignments, search, statusFilter, clients, catalog]);

  const groupedCatalog = useMemo(() => {
    const map = new Map<string, Service[]>();
    for (const service of catalog.filter((s) => !s.is_archived)) {
      const list = map.get(service.category) ?? [];
      list.push(service);
      map.set(service.category, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [catalog]);

  const archiveService = async () => {
    if (!archiveTarget) return;
    setBusy(true);
    try {
      await adapter.update<Service>('services', archiveTarget.id, { is_archived: true });
      toast.success('Service archived', 'Historical assignments keep pointing at it.');
      setArchiveTarget(null);
      refreshCatalog();
      invalidate();
    } catch (err) {
      toast.error('Could not archive the service', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title="Services"
        description="Your catalogue of what you sell, and exactly what each client has bought. Assignments keep their own price and status, so changing a rate never rewrites history."
        actions={
          <>
            <Button variant="ghost" onClick={() => setServiceDialog(true)} icon={<Plus className="h-4 w-4" />}>
              New service type
            </Button>
            <Button variant="primary" onClick={() => { setEditingAssignment(null); setAssignDialog(true); }} icon={<Users className="h-4 w-4" />}>
              Assign to client
            </Button>
          </>
        }
      />

      <Toolbar>
        <Segmented
          size="sm"
          ariaLabel="Services view"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'assigned', label: 'Client assignments', count: assignments.length },
            { value: 'catalog', label: 'Service catalogue', count: catalog.filter((s) => !s.is_archived).length },
          ]}
        />
        {tab === 'assigned' && (
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Search client or service" className="w-full sm:w-64" />
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="ml-auto w-36 py-1.5 text-xs"
              aria-label="Filter by service status"
            >
              <option value="all">All statuses</option>
              {Object.entries(serviceStatusMeta).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </Select>
          </>
        )}
      </Toolbar>

      {tab === 'assigned' ? (
        assignmentsLoading ? (
          <SkeletonRows rows={5} />
        ) : filteredAssignments.length === 0 ? (
          <EmptyState
            icon={<Layers className="h-6 w-6" />}
            title={assignments.length === 0 ? 'No services assigned yet' : 'Nothing matches'}
            description={
              assignments.length === 0
                ? 'Assign a service to a client to start billing. Completed and cancelled services stay in this list for your records.'
                : 'Adjust the search or status filter.'
            }
            action={
              assignments.length === 0 ? (
                <Button variant="primary" size="sm" onClick={() => { setEditingAssignment(null); setAssignDialog(true); }}>
                  Assign a service
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="surface overflow-hidden p-0">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Service</th>
                    <th>Billing</th>
                    <th className="text-right">Price</th>
                    <th>Period</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filteredAssignments.map((a) => (
                    <tr key={a.id}>
                      <td className="text-[12.5px] font-medium text-fg">{clientName(a.client_id)}</td>
                      <td>
                        <p className="text-[12px] text-fg">{a.title ?? serviceName(a.service_id)}</p>
                        <p className="text-[10.5px] text-faint">{serviceName(a.service_id)}</p>
                      </td>
                      <td className="text-[11.5px] text-muted">{billingTypeLabel[a.billing_type]}</td>
                      <td className="text-right"><Money minor={a.price_minor} className="text-[12px]" /></td>
                      <td className="whitespace-nowrap text-[11px] text-muted">
                        {fmtDate(a.start_date)}
                        <span className="block text-[10px] text-faint">{a.end_date ? `→ ${fmtDate(a.end_date)}` : 'ongoing'}</span>
                      </td>
                      <td><Badge tone={serviceStatusMeta[a.status].tone}>{serviceStatusMeta[a.status].label}</Badge></td>
                      <td className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="quiet" onClick={() => { setEditingAssignment(a); setAssignDialog(true); }} aria-label="Edit assignment" icon={<Pencil className="h-3 w-3" />} />
                          <Button
                            size="sm"
                            variant="quiet"
                            onClick={async () => {
                              await adapter.update<ClientService>('client_services', a.id, { status: a.status === 'active' ? 'paused' : 'active' });
                              refreshAssignments();
                              invalidate();
                              toast.success(a.status === 'active' ? 'Service paused' : 'Service resumed');
                            }}
                            aria-label={a.status === 'active' ? 'Pause service' : 'Resume service'}
                            icon={<Archive className="h-3 w-3" />}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : catalogLoading ? (
        <SkeletonRows rows={4} />
      ) : groupedCatalog.length === 0 ? (
        <EmptyState
          icon={<Sparkles className="h-6 w-6" />}
          title="Catalogue is empty"
          description="Add the services you sell — website builds, retainers, ads management, design — then assign them to clients."
          action={<Button variant="primary" size="sm" onClick={() => setServiceDialog(true)}>New service type</Button>}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groupedCatalog.map(([category, items]) => (
            <section key={category} className="surface p-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-faint">{category}</h2>
                <span className="num text-[10px] text-faint">{items.length}</span>
              </div>
              <ul className="space-y-1">
                {items.map((service) => {
                  const assigned = assignments.filter((a) => a.service_id === service.id && a.status === 'active').length;
                  return (
                    <li key={service.id} className="group flex items-start gap-2 rounded-lg px-1.5 py-1.5 transition hover:bg-raised/50">
                      <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-magenta/70" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] font-medium text-fg">{service.name}</p>
                        {service.description && <p className="text-[10.5px] leading-snug text-faint">{service.description}</p>}
                        <p className="mt-0.5 text-[10px] text-muted">{assigned} active {assigned === 1 ? 'client' : 'clients'}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setArchiveTarget(service)}
                        className="rounded p-1 text-faint opacity-0 transition hover:text-magenta group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Archive ${service.name}`}
                      >
                        <Archive className="h-3 w-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <ServiceDialog
        open={serviceDialog}
        onClose={() => setServiceDialog(false)}
        onSaved={() => {
          refreshCatalog();
          invalidate();
        }}
      />

      <AssignmentDrawer
        open={assignDialog}
        onClose={() => setAssignDialog(false)}
        assignment={editingAssignment}
        clients={clients}
        catalog={catalog.filter((s) => !s.is_archived)}
        onSaved={() => {
          refreshAssignments();
          invalidate();
        }}
      />

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        onConfirm={archiveService}
        busy={busy}
        title="Archive this service type?"
        confirmLabel="Archive"
        body={
          <>
            <strong className="text-fg">{archiveTarget?.name}</strong> disappears from the picker for new assignments.
            Existing client assignments and their history are untouched.
          </>
        }
      />
    </div>
  );
}

function ServiceDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const adapter = useData().adapters.data;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<z.infer<typeof serviceSchema>>({ resolver: zodResolver(serviceSchema) });

  useEffect(() => {
    if (open) reset({ name: '', category: 'Growth', description: '' });
  }, [open, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setBusy(true);
    try {
      await adapter.insert('services', {
        id: uuid(),
        name: values.name.trim(),
        category: values.category.trim(),
        description: values.description?.trim() || null,
        is_archived: false,
      });
      toast.success('Service type added', values.name);
      onSaved();
      onClose();
    } catch (err) {
      toast.error('Could not add the service', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="New service type"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void onSubmit()} loading={busy}>Add service</Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Service name" error={errors.name?.message} required>
          {(id) => <TextInput id={id} {...register('name')} placeholder="e.g. Email marketing" autoFocus />}
        </Field>
        <Field label="Category" hint="Groups the catalogue, e.g. Build, Growth, Creative" error={errors.category?.message} required>
          {(id) => <TextInput id={id} {...register('category')} placeholder="Growth" />}
        </Field>
        <Field label="Description" error={errors.description?.message}>
          {(id) => <TextArea id={id} {...register('description')} placeholder="What this includes" />}
        </Field>
      </form>
    </Drawer>
  );
}

function AssignmentDrawer({
  open,
  onClose,
  assignment,
  clients,
  catalog,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  assignment: ClientService | null;
  clients: Client[];
  catalog: Service[];
  onSaved: () => void;
}) {
  const adapter = useData().adapters.data;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<AssignmentForm>({ resolver: zodResolver(assignmentSchema) });

  useEffect(() => {
    if (!open) return;
    reset({
      client_id: assignment?.client_id ?? clients[0]?.id ?? '',
      service_id: assignment?.service_id ?? catalog[0]?.id ?? '',
      title: assignment?.title ?? '',
      description: assignment?.description ?? '',
      price: assignment ? minorToInput(assignment.price_minor) : '',
      billing_type: assignment?.billing_type ?? 'monthly',
      billing_frequency_label: assignment?.billing_frequency_label ?? '',
      start_date: assignment?.start_date ?? todayISO(),
      end_date: assignment?.end_date ?? '',
      status: assignment?.status ?? 'active',
      internal_notes: assignment?.internal_notes ?? '',
      client_notes: assignment?.client_notes ?? '',
    });
  }, [open, assignment, clients, catalog, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const priceMinor = parseMoneyToMinor(values.price);
    if (priceMinor === null || priceMinor < 0) {
      toast.error('Enter a valid price');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        client_id: values.client_id,
        service_id: values.service_id,
        title: values.title?.trim() || null,
        description: values.description?.trim() || null,
        price_minor: priceMinor,
        billing_type: values.billing_type,
        billing_frequency_label: values.billing_type === 'custom' ? values.billing_frequency_label?.trim() || null : null,
        start_date: values.start_date,
        end_date: values.end_date || null,
        status: values.status,
        internal_notes: values.internal_notes?.trim() || null,
        client_notes: values.client_notes?.trim() || null,
      };
      if (assignment) {
        await adapter.update<ClientService>('client_services', assignment.id, payload);
        toast.success('Assignment updated');
      } else {
        await adapter.insert('client_services', { id: uuid(), ...payload });
        toast.success('Service assigned');
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error('Could not save the assignment', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title={assignment ? 'Edit service assignment' : 'Assign a service'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void onSubmit()} loading={busy}>
            {assignment ? 'Save changes' : 'Assign service'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client" error={errors.client_id?.message} required>
            {(id) => (
              <Select id={id} {...register('client_id')} autoFocus>
                {clients.length === 0 && <option value="">Add a client first</option>}
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Service type" error={errors.service_id?.message} required>
            {(id) => (
              <Select id={id} {...register('service_id')}>
                {catalog.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <Field label="Assignment title" hint="Shown to the client, e.g. “Social retainer — Instagram + LinkedIn”">
          {(id) => <TextInput id={id} {...register('title')} placeholder="Optional, defaults to the service name" />}
        </Field>
        <Field label="Description">
          {(id) => <TextArea id={id} {...register('description')} placeholder="Scope of work" className="min-h-[64px]" />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Agreed price (₹)" error={errors.price?.message} required>
            {(id) => (
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-faint">₹</span>
                <TextInput id={id} {...register('price')} inputMode="decimal" className="num pl-7" placeholder="45000" />
              </div>
            )}
          </Field>
          <Field label="Billing type" error={errors.billing_type?.message}>
            {(id) => (
              <Select id={id} {...register('billing_type')}>
                {Object.entries(billingTypeLabel).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Start date" error={errors.start_date?.message} required>
            {(id) => <TextInput id={id} type="date" {...register('start_date')} />}
          </Field>
          <Field label="End date" hint="Leave empty for ongoing retainers">
            {(id) => <TextInput id={id} type="date" {...register('end_date')} />}
          </Field>
          <Field label="Custom billing label" hint="Only used when billing type is Custom">
            {(id) => <TextInput id={id} {...register('billing_frequency_label')} placeholder="3 milestones" />}
          </Field>
          <Field label="Status">
            {(id) => (
              <Select id={id} {...register('status')}>
                {Object.entries(serviceStatusMeta).map(([value, meta]) => (
                  <option key={value} value={value}>{meta.label}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className={cn('grid gap-4 sm:grid-cols-2')}>
          <Field label="Internal notes" hint="Agency only">
            {(id) => <TextArea id={id} {...register('internal_notes')} placeholder="Margin, scope creep, renewal notes" />}
          </Field>
          <Field label="Client-visible notes" hint="Appears in the client portal">
            {(id) => <TextArea id={id} {...register('client_notes')} placeholder="Revisions included, cadence, exclusions" />}
          </Field>
        </div>
      </form>
    </Drawer>
  );
}
