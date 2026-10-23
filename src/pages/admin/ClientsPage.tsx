import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, Archive, KeyRound, Mail, Pencil, Phone, Plus, UserPlus, Users } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Money,
  PageHeader,
  Pagination,
  SearchInput,
  Segmented,
  Select,
  SkeletonRows,
  TextArea,
  TextInput,
  Toolbar,
} from '@/components/ui';
import { Drawer } from '@/components/ui/overlays';
import { useCollection, useData, useToast } from '@/context/app';
import { clientStatusMeta } from '@/lib/labels';
import { fmtDate, fmtRelative } from '@/lib/dates';
import { paidMinor } from '@/lib/finance';
import type { Client, ClientStatus, Invoice, Payment } from '@/lib/types';
import { uuid } from '@/lib/utils';
import { useDebouncedValue } from '@/hooks';

const PAGE_SIZE = 10;

const schema = z.object({
  name: z.string().trim().min(2, 'A client name is required.').max(120),
  business_name: z.string().trim().min(2, 'A business name is required.').max(160),
  contact_person: z.string().trim().max(120).optional(),
  email: z.union([z.string().trim().email('Enter a valid email.'), z.literal('')]).optional(),
  phone: z.string().trim().max(24).optional(),
  client_code: z
    .string()
    .trim()
    .min(3, 'At least 3 characters.')
    .max(12, 'At most 12 characters.')
    .regex(/^[A-Za-z0-9]+$/, 'Letters and numbers only.'),
  status: z.enum(['active', 'inactive', 'archived']),
  address: z.string().trim().max(300).optional(),
  internal_notes: z.string().trim().max(2000).optional(),
});
type ClientForm = z.infer<typeof schema>;

export function suggestClientCode(name: string): string {
  const letters = name
    .replace(/[^A-Za-z\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join('')
    .slice(0, 3)
    .padEnd(3, 'X');
  return `${letters}${Math.floor(100 + Math.random() * 900)}`;
}

export default function ClientsPage() {
  const { invalidate } = useData();
  const toast = useToast();

  const { data: clients, loading, error, refresh } = useCollection<Client>('clients');
  const { data: invoices } = useCollection<Invoice>('invoices');
  const { data: payments } = useCollection<Payment>('payments');

  const [search, setSearch] = useState('');
  // Filtering runs over the whole roster, so debounce the query rather than
  // re-filtering on every keystroke.
  const debouncedSearch = useDebouncedValue(search, 200);
  const [statusFilter, setStatusFilter] = useState<'all' | ClientStatus>('all');
  const [sort, setSort] = useState<'name' | 'recent'>('name');
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    const rows = clients
      .filter((c) => (statusFilter === 'all' ? true : c.status === statusFilter))
      .filter(
        (c) =>
          !q ||
          `${c.name} ${c.business_name} ${c.client_code} ${c.contact_person ?? ''} ${c.email ?? ''}`.toLowerCase().includes(q),
      );
    return rows.sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name) : b.updated_at.localeCompare(a.updated_at),
    );
  }, [clients, debouncedSearch, statusFilter, sort]);

  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const outstandingFor = (clientId: string) =>
    invoices
      .filter((i) => i.client_id === clientId && i.status !== 'cancelled')
      .reduce((sum, inv) => sum + Math.max(0, inv.total_minor - paidMinor(inv.id, payments)), 0);

  const counts = {
    all: clients.length,
    active: clients.filter((c) => c.status === 'active').length,
    inactive: clients.filter((c) => c.status === 'inactive').length,
    archived: clients.filter((c) => c.status === 'archived').length,
  };

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title="Clients"
        description="Every client, their portal access and what they owe. Internal notes on these records are never exposed to the portal."
        actions={
          <Button variant="primary" onClick={openNew} icon={<Plus className="h-4 w-4" />}>
            Add client
          </Button>
        }
      />

      <Toolbar>
        <SearchInput
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="Search name, business or code"
          className="w-full sm:w-72"
        />
        <Segmented
          size="sm"
          ariaLabel="Client status"
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'active', label: 'Active', count: counts.active },
            { value: 'inactive', label: 'Inactive', count: counts.inactive },
            { value: 'archived', label: 'Archived', count: counts.archived },
          ]}
        />
        <Select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="ml-auto w-40 py-1.5 text-xs" aria-label="Sort clients">
          <option value="name">Sort: name</option>
          <option value="recent">Sort: recently updated</option>
        </Select>
      </Toolbar>

      {loading ? (
        <SkeletonRows rows={6} />
      ) : error ? (
        <EmptyState title="Clients could not be loaded" description={error} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Users className="h-6 w-6" />}
          title={clients.length === 0 ? 'No clients yet' : 'No clients match'}
          description={
            clients.length === 0
              ? 'Add your first client to assign services, raise invoices and give them a private portal.'
              : 'Try a different search term or status filter.'
          }
          action={
            clients.length === 0 ? (
              <Button variant="primary" size="sm" onClick={openNew} icon={<Plus className="h-3.5 w-3.5" />}>
                Add client
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
                  <th>Code</th>
                  <th>Contact</th>
                  <th>Status</th>
                  <th>Portal</th>
                  <th className="text-right">Outstanding</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {paged.map((client) => (
                  <tr key={client.id}>
                    <td>
                      <Link to={`/admin/clients/${client.id}`} className="block">
                        <span className="block text-[13px] font-medium text-fg">{client.name}</span>
                        <span className="block text-[10.5px] text-faint">{client.business_name}</span>
                      </Link>
                    </td>
                    <td>
                      <span className="rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] text-muted" style={{ borderColor: 'rgb(var(--line) / 0.16)' }}>
                        {client.client_code}
                      </span>
                    </td>
                    <td>
                      <div className="space-y-0.5">
                        {client.contact_person && <p className="text-[11.5px] text-fg">{client.contact_person}</p>}
                        {client.email && (
                          <p className="flex items-center gap-1 text-[10.5px] text-faint">
                            <Mail className="h-2.5 w-2.5" aria-hidden /> {client.email}
                          </p>
                        )}
                        {client.phone && (
                          <p className="flex items-center gap-1 text-[10.5px] text-faint">
                            <Phone className="h-2.5 w-2.5" aria-hidden /> {client.phone}
                          </p>
                        )}
                      </div>
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
                      <Money minor={outstandingFor(client.id)} tone={outstandingFor(client.id) > 0 ? 'butter' : 'mint'} className="text-[12.5px]" />
                    </td>
                    <td className="whitespace-nowrap text-[11px] text-faint">
                      {fmtDate(client.created_at)}
                      <span className="block text-[10px]">upd. {fmtRelative(client.updated_at)}</span>
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="quiet"
                          onClick={() => {
                            setEditing(client);
                            setDialogOpen(true);
                          }}
                          aria-label={`Edit ${client.name}`}
                          icon={<Pencil className="h-3 w-3" />}
                        />
                        <Link
                          to={`/admin/clients/${client.id}`}
                          className="btn btn-quiet rounded-lg px-2 py-1.5 text-[13px]"
                          aria-label={`Open ${client.name}`}
                        >
                          <ArrowRight className="h-3 w-3" aria-hidden />
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-3">
            <Pagination page={page} pageSize={PAGE_SIZE} total={filtered.length} onPageChange={setPage} />
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="surface-flat p-3.5">
          <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-fg">
            <KeyRound className="h-3.5 w-3.5 text-magenta" aria-hidden /> Codes identify, they do not authorise
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            A client code is exchanged server-side for a real session. It never grants admin rights, and the admin code
            alone is never enough to sign in.
          </p>
        </div>
        <div className="surface-flat p-3.5">
          <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-fg">
            <UserPlus className="h-3.5 w-3.5 text-sky" aria-hidden /> Portal access is per client
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            Create, rotate or revoke access from a client’s profile. Revoking blocks the portal without deleting a rupee
            of financial history.
          </p>
        </div>
        <div className="surface-flat p-3.5">
          <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-fg">
            <Archive className="h-3.5 w-3.5 text-butter" aria-hidden /> Deactivate, never delete
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            Status changes keep services, invoices and receipts intact so your records stay auditable.
          </p>
        </div>
      </div>

      <ClientDrawer
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        client={editing}
        existingCodes={clients.filter((c) => c.id !== editing?.id).map((c) => c.client_code)}
        onSaved={() => {
          refresh();
          invalidate();
          toast.success(editing ? 'Client updated' : 'Client added');
        }}
      />
    </div>
  );
}

export function ClientDrawer({
  open,
  onClose,
  client,
  existingCodes,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  client: Client | null;
  existingCodes: string[];
  onSaved: () => void;
}) {
  const adapter = useData().adapters.data;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<ClientForm>({ resolver: zodResolver(schema) });

  const name = watch('name');

  useMemo(() => {
    if (!open) return;
    reset({
      name: client?.name ?? '',
      business_name: client?.business_name ?? '',
      contact_person: client?.contact_person ?? '',
      email: client?.email ?? '',
      phone: client?.phone ?? '',
      client_code: client?.client_code ?? suggestClientCode(''),
      status: client?.status ?? 'active',
      address: client?.address ?? '',
      internal_notes: client?.internal_notes ?? '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, client, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const code = values.client_code.trim().toUpperCase();
    if (existingCodes.map((c) => c.toUpperCase()).includes(code)) {
      toast.error('That client code is already in use', 'Codes must be unique across all clients.');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: values.name.trim(),
        business_name: values.business_name.trim(),
        contact_person: values.contact_person?.trim() || null,
        email: values.email?.trim() || null,
        phone: values.phone?.trim() || null,
        client_code: code,
        status: values.status,
        address: values.address?.trim() || null,
        internal_notes: values.internal_notes?.trim() || null,
      };
      if (client) {
        await adapter.update<Client>('clients', client.id, payload);
      } else {
        await adapter.insert('clients', {
          id: uuid(),
          ...payload,
          portal_status: 'none',
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error('Could not save the client', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title={client ? `Edit ${client.name}` : 'Add a client'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void onSubmit()} loading={busy} disabled={client ? !isDirty : false}>
            {client ? 'Save changes' : 'Add client'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client name" error={errors.name?.message} required>
            {(id) => <TextInput id={id} {...register('name')} placeholder="Prism Studio" autoFocus />}
          </Field>
          <Field label="Business name" error={errors.business_name?.message} required>
            {(id) => <TextInput id={id} {...register('business_name')} placeholder="Prism Studio LLP" />}
          </Field>
          <Field label="Contact person" error={errors.contact_person?.message}>
            {(id) => <TextInput id={id} {...register('contact_person')} placeholder="Priya Raghav" />}
          </Field>
          <Field label="Email" error={errors.email?.message} hint="Used for portal sign-in and receipts">
            {(id) => <TextInput id={id} type="email" {...register('email')} placeholder="priya@prismstudio.in" />}
          </Field>
          <Field label="Phone" error={errors.phone?.message}>
            {(id) => <TextInput id={id} {...register('phone')} placeholder="+91 90000 00000" />}
          </Field>
          <Field
            label="Client code"
            error={errors.client_code?.message}
            hint="Unique, 3–12 letters/numbers. This is the portal entry code — not a password."
            required
          >
            {(id) => (
              <div className="flex gap-2">
                <TextInput id={id} {...register('client_code')} className="font-mono uppercase" />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setValue('client_code', suggestClientCode(name || 'client'), { shouldDirty: true })}
                  aria-label="Suggest a code"
                >
                  Suggest
                </Button>
              </div>
            )}
          </Field>
        </div>

        <Field label="Account status" hint="Inactive clients keep their history but lose portal access.">
          {(id) => (
            <Select id={id} {...register('status')}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="archived">Archived</option>
            </Select>
          )}
        </Field>

        <Field label="Address" error={errors.address?.message}>
          {(id) => <TextArea id={id} {...register('address')} placeholder="Billing address, if you have one" className="min-h-[70px]" />}
        </Field>

        <Field
          label="Internal notes"
          error={errors.internal_notes?.message}
          hint="Never shown to the client. Stored on the client record only."
        >
          {(id) => <TextArea id={id} {...register('internal_notes')} placeholder="Approval habits, invoicing quirks, context…" />}
        </Field>
      </form>
    </Drawer>
  );
}
