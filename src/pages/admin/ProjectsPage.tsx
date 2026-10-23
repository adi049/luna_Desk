import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, Eye, FolderKanban, Plus } from 'lucide-react';
import {
  Badge, Button, EmptyState, Field, PageHeader, SearchInput, Segmented, Select,
  SkeletonRows, TextArea, TextInput, Toolbar,
} from '@/components/ui';
import { Drawer } from '@/components/ui/overlays';
import { useCollection, useData, useToast } from '@/context/app';
import { projectStatusMeta } from '@/lib/labels';
import { fmtDate, fmtRelative } from '@/lib/dates';
import type { Client, ClientService, Project, ProjectStatus } from '@/lib/types';
import { uuid } from '@/lib/utils';

const schema = z.object({
  client_id: z.string().min(1, 'Choose a client.'),
  client_service_id: z.string().optional(),
  name: z.string().trim().min(2, 'Name the project.').max(120),
  description: z.string().trim().max(1200).optional(),
  status: z.enum(['planning', 'in_progress', 'review', 'completed', 'on_hold', 'cancelled']),
  progress: z.coerce.number().min(0).max(100),
  start_date: z.string().optional(),
  due_date: z.string().optional(),
  client_visible: z.boolean(),
});
type ProjectForm = z.infer<typeof schema>;

export default function ProjectsPage() {
  const { invalidate } = useData();
  const { data: projects, loading, refresh } = useCollection<Project>('projects');
  const { data: clients } = useCollection<Client>('clients');
  const { data: services } = useCollection<ClientService>('client_services');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | ProjectStatus>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? 'Client';

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects
      .filter((p) => {
        if (statusFilter === 'all') return true;
        if (statusFilter === 'open') return !['completed', 'cancelled'].includes(p.status);
        return p.status === statusFilter;
      })
      .filter((p) => !q || `${p.name} ${clientName(p.client_id)} ${p.description ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => {
        if (!a.due_date && !b.due_date) return 0;
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return a.due_date.localeCompare(b.due_date);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, search, statusFilter, clients]);

  const counts = {
    all: projects.length,
    open: projects.filter((p) => !['completed', 'cancelled'].includes(p.status)).length,
  };

  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title="Projects"
        description="The work in flight. Marking a project client-visible publishes it — and its updates — to that client’s portal."
        actions={
          <Button variant="primary" onClick={() => { setEditing(null); setDialogOpen(true); }} icon={<Plus className="h-4 w-4" />}>
            New project
          </Button>
        }
      />

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search projects" className="w-full sm:w-64" />
        <Segmented
          size="sm"
          ariaLabel="Project status"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'open', label: 'Open', count: counts.open },
            { value: 'review', label: 'In review' },
            { value: 'completed', label: 'Completed' },
          ]}
        />
      </Toolbar>

      {loading ? (
        <SkeletonRows rows={5} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<FolderKanban className="h-6 w-6" />}
          title={projects.length === 0 ? 'No projects yet' : 'No projects match'}
          description={
            projects.length === 0
              ? 'Create a project to track delivery with a status, progress and a due date your client can see.'
              : 'Try another search or status.'
          }
          action={
            projects.length === 0 ? (
              <Button variant="primary" size="sm" onClick={() => setDialogOpen(true)} icon={<Plus className="h-3.5 w-3.5" />}>
                New project
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p) => {
            const overdue = p.due_date && p.due_date < new Date().toISOString().slice(0, 10) && !['completed', 'cancelled'].includes(p.status);
            return (
              <Link
                key={p.id}
                to={`/admin/projects/${p.id}`}
                className="surface group flex flex-col p-4 transition hover:border-[rgb(var(--line)/0.26)]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-fg">{p.name}</p>
                    <p className="mt-0.5 truncate text-[10.5px] text-faint">{clientName(p.client_id)}</p>
                  </div>
                  <Badge tone={projectStatusMeta[p.status].tone}>{projectStatusMeta[p.status].label}</Badge>
                </div>
                {p.description && <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-muted">{p.description}</p>}
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-[10px] text-faint">
                    <span>Progress</span>
                    <span className="num">{p.progress}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[rgb(var(--line)/0.12)]">
                    <div
                      className="h-full rounded-full bg-magenta transition-[width] duration-500"
                      style={{ width: `${p.progress}%` }}
                    />
                  </div>
                </div>
                <div className="mt-auto flex items-center justify-between pt-3 text-[10.5px]">
                  <span className={overdue ? 'text-magenta' : 'text-faint'}>
                    {p.due_date ? `${overdue ? 'Overdue · ' : 'Due '}${fmtDate(p.due_date)}` : 'No due date'}
                  </span>
                  <span className="flex items-center gap-1 text-faint">
                    {p.client_visible ? <Eye className="h-3 w-3" aria-hidden /> : null}
                    {p.updated_at ? fmtRelative(p.updated_at) : ''}
                    <ArrowRight className="h-3 w-3 opacity-0 transition group-hover:opacity-100" aria-hidden />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <ProjectDrawer
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        project={editing}
        clients={clients}
        services={services}
        onSaved={() => { refresh(); invalidate(); }}
      />
    </div>
  );
}

export function ProjectDrawer({
  open, onClose, project, clients, services, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  project: Project | null;
  clients: Client[];
  services: ClientService[];
  onSaved: () => void;
}) {
  const adapter = useData().adapters.data;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<ProjectForm>({ resolver: zodResolver(schema) });
  const clientId = watch('client_id');

  useEffect(() => {
    if (!open) return;
    reset({
      client_id: project?.client_id ?? clients[0]?.id ?? '',
      client_service_id: project?.client_service_id ?? '',
      name: project?.name ?? '',
      description: project?.description ?? '',
      status: project?.status ?? 'planning',
      progress: project?.progress ?? 0,
      start_date: project?.start_date ?? '',
      due_date: project?.due_date ?? '',
      client_visible: project?.client_visible ?? true,
    });
  }, [open, project, clients, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setBusy(true);
    try {
      const payload = {
        client_id: values.client_id,
        client_service_id: values.client_service_id || null,
        name: values.name.trim(),
        description: values.description?.trim() || null,
        status: values.status,
        progress: Number(values.progress),
        start_date: values.start_date || null,
        due_date: values.due_date || null,
        client_visible: values.client_visible,
      };
      if (project) {
        await adapter.update<Project>('projects', project.id, payload);
        toast.success('Project updated');
      } else {
        await adapter.insert('projects', { id: uuid(), ...payload });
        toast.success('Project created');
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error('Could not save the project', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title={project ? 'Edit project' : 'New project'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void onSubmit()} loading={busy}>
            {project ? 'Save changes' : 'Create project'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Project name" error={errors.name?.message} required>
          {(id) => <TextInput id={id} {...register('name')} placeholder="Q4 social calendar" autoFocus />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client" error={errors.client_id?.message} required>
            {(id) => (
              <Select id={id} {...register('client_id')}>
                {clients.length === 0 && <option value="">Add a client first</option>}
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Linked service">
            {(id) => (
              <Select id={id} {...register('client_service_id')}>
                <option value="">Not linked</option>
                {services.filter((s) => s.client_id === clientId).map((s) => (
                  <option key={s.id} value={s.id}>{s.title ?? s.id.slice(0, 8)}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Description" error={errors.description?.message}>
          {(id) => <TextArea id={id} {...register('description')} placeholder="Scope, deliverables, dependencies" />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Status">
            {(id) => (
              <Select id={id} {...register('status')}>
                {Object.entries(projectStatusMeta).map(([value, meta]) => (
                  <option key={value} value={value}>{meta.label}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Progress %" error={errors.progress?.message}>
            {(id) => <TextInput id={id} type="number" min={0} max={100} {...register('progress')} className="num" />}
          </Field>
          <Field label="Start date">
            {(id) => <TextInput id={id} type="date" {...register('start_date')} />}
          </Field>
          <Field label="Due date">
            {(id) => <TextInput id={id} type="date" {...register('due_date')} />}
          </Field>
        </div>
        <label className="flex items-start gap-2.5 rounded-xl border p-3" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
          <input type="checkbox" {...register('client_visible')} className="mt-0.5 h-4 w-4 rounded accent-[#FF2D95]" />
          <span>
            <span className="block text-[12.5px] font-medium text-fg">Visible in the client portal</span>
            <span className="mt-0.5 block text-[11px] text-muted">Turn off for internal projects the client should not see.</span>
          </span>
        </label>
      </form>
    </Drawer>
  );
}
