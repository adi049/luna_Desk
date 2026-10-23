import { useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
import { Badge, Button, EmptyState, Field, PageHeader, SkeletonRows, TextArea, TextInput } from '@/components/ui';
import { ConfirmDialog } from '@/components/ui/overlays';
import { useCollection, useData, useToast } from '@/context/app';
import { useAuth } from '@/context/auth';
import { projectStatusMeta } from '@/lib/labels';
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/dates';
import type { Client, ClientService, Project, ProjectUpdate, Task } from '@/lib/types';
import { uuid } from '@/lib/utils';
import { ProjectDrawer } from './ProjectsPage';

export default function ProjectDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const { profile } = useAuth();
  const toast = useToast();

  const { data: projects, loading, refresh } = useCollection<Project>('projects');
  const { data: updates, refresh: refreshUpdates } = useCollection<ProjectUpdate>('project_updates');
  const { data: clients } = useCollection<Client>('clients');
  const { data: services } = useCollection<ClientService>('client_services');
  const { data: tasks } = useCollection<Task>('tasks');

  const project = projects.find((p) => p.id === id) ?? null;
  const client = clients.find((c) => c.id === project?.client_id) ?? null;
  const myUpdates = useMemo(
    () => updates.filter((u) => u.project_id === id).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [updates, id],
  );
  const myTasks = tasks.filter((t) => t.project_id === id);

  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [updateTitle, setUpdateTitle] = useState('');
  const [updateBody, setUpdateBody] = useState('');
  const [updateVisible, setUpdateVisible] = useState(true);
  const [posting, setPosting] = useState(false);

  const postUpdate = async () => {
    if (!project) return;
    if (updateTitle.trim().length < 3) {
      toast.error('Add a short update title');
      return;
    }
    setPosting(true);
    try {
      await adapter.insert('project_updates', {
        id: uuid(),
        project_id: project.id,
        title: updateTitle.trim(),
        body: updateBody.trim() || null,
        client_visible: updateVisible,
        author_id: profile?.id ?? null,
      });
      setUpdateTitle('');
      setUpdateBody('');
      toast.success(updateVisible ? 'Update posted to the client portal' : 'Internal update saved');
      refreshUpdates();
      invalidate();
    } catch (err) {
      toast.error('Could not post the update', err instanceof Error ? err.message : undefined);
    } finally {
      setPosting(false);
    }
  };

  const toggleVisibility = async (update: ProjectUpdate) => {
    try {
      await adapter.update<ProjectUpdate>('project_updates', update.id, { client_visible: !update.client_visible });
      refreshUpdates();
      invalidate();
      toast.success(update.client_visible ? 'Update hidden from the client' : 'Update shared with the client');
    } catch (err) {
      toast.error('Could not change visibility', err instanceof Error ? err.message : undefined);
    }
  };

  const deleteProject = async () => {
    if (!project) return;
    setBusy(true);
    try {
      await adapter.remove('projects', project.id);
      toast.success('Project deleted');
      navigate('/admin/projects');
    } catch (err) {
      toast.error('Could not delete the project', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonRows rows={5} />;
  if (!project) {
    return (
      <EmptyState
        title="Project not found"
        description="It may have been deleted, or the link is out of date."
        action={<Button variant="ghost" onClick={() => navigate('/admin/projects')} icon={<ArrowLeft className="h-4 w-4" />}>Back to projects</Button>}
      />
    );
  }

  const overdue = project.due_date && project.due_date < new Date().toISOString().slice(0, 10) && !['completed', 'cancelled'].includes(project.status);

  return (
    <div>
      <button type="button" onClick={() => navigate('/admin/projects')} className="mb-3 inline-flex items-center gap-1 text-[11px] text-muted transition hover:text-fg">
        <ArrowLeft className="h-3 w-3" aria-hidden /> All projects
      </button>

      <PageHeader
        eyebrow={client ? `Client · ${client.name}` : 'Internal project'}
        title={project.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={projectStatusMeta[project.status].tone}>{projectStatusMeta[project.status].label}</Badge>
            <Badge tone={project.client_visible ? 'sky' : 'muted'}>
              {project.client_visible ? 'Visible to client' : 'Internal only'}
            </Badge>
            <span className={overdue ? 'text-[11px] text-magenta' : 'text-[11px] text-faint'}>
              {project.due_date ? `${overdue ? 'Overdue — ' : 'Due '}${fmtDate(project.due_date)}` : 'No due date'}
            </span>
            <span className="text-[11px] text-faint">Updated {fmtRelative(project.updated_at)}</span>
          </span>
        }
        actions={
          <>
            <Button variant="quiet" onClick={() => setConfirmDelete(true)} icon={<Trash2 className="h-4 w-4" />}>
              Delete
            </Button>
            <Button variant="ghost" onClick={() => setEditOpen(true)} icon={<Pencil className="h-4 w-4" />}>
              Edit project
            </Button>
          </>
        }
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <section className="surface p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-fg">Delivery</h2>
              <span className="num text-xs text-muted">{project.progress}% complete</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[rgb(var(--line)/0.12)]">
              <div className="h-full rounded-full bg-magenta transition-[width] duration-500" style={{ width: `${project.progress}%` }} />
            </div>
            {project.description && <p className="mt-3 whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted">{project.description}</p>}
            <dl className="mt-4 grid grid-cols-2 gap-3 text-[11.5px] sm:grid-cols-4">
              <div>
                <dt className="eyebrow">Start</dt>
                <dd className="mt-0.5 text-fg">{fmtDate(project.start_date)}</dd>
              </div>
              <div>
                <dt className="eyebrow">Due</dt>
                <dd className="mt-0.5 text-fg">{fmtDate(project.due_date)}</dd>
              </div>
              <div>
                <dt className="eyebrow">Linked service</dt>
                <dd className="mt-0.5 truncate text-fg">
                  {services.find((s) => s.id === project.client_service_id)?.title ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="eyebrow">Open tasks</dt>
                <dd className="mt-0.5 text-fg">{myTasks.filter((t) => t.status !== 'completed').length}</dd>
              </div>
            </dl>
          </section>

          <section className="surface p-4">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
              <MessageSquarePlus className="h-4 w-4 text-faint" aria-hidden /> Post an update
            </h2>
            <div className="mt-3 space-y-3">
              <Field label="Title" required>
                {(id) => <TextInput id={id} value={updateTitle} onChange={(e) => setUpdateTitle(e.target.value)} placeholder="e.g. Layout v3 shared for review" />}
              </Field>
              <Field label="Detail">
                {(id) => <TextArea id={id} value={updateBody} onChange={(e) => setUpdateBody(e.target.value)} placeholder="What changed, what you need next" className="min-h-[80px]" />}
              </Field>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-[11.5px] text-fg">
                  <input type="checkbox" checked={updateVisible} onChange={(e) => setUpdateVisible(e.target.checked)} className="h-4 w-4 rounded accent-[#FF2D95]" />
                  Share with the client
                </label>
                <Button variant="primary" onClick={() => void postUpdate()} loading={posting}>
                  Post update
                </Button>
              </div>
            </div>
          </section>

          <section className="surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-fg">Updates</h2>
              <span className="text-[10.5px] text-faint">{myUpdates.length} total</span>
            </div>
            {myUpdates.length === 0 ? (
              <EmptyState compact title="No updates yet" description="Updates give the client a running account of the work without an email thread." />
            ) : (
              <ol className="space-y-3">
                {myUpdates.map((u) => (
                  <li key={u.id} className="relative border-l pl-4" style={{ borderColor: 'rgb(var(--line) / 0.18)' }}>
                    <span className="absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full bg-magenta" aria-hidden />
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[12.5px] font-medium text-fg">{u.title}</p>
                      <Badge tone={u.client_visible ? 'sky' : 'muted'}>
                        {u.client_visible ? 'client-visible' : 'internal'}
                      </Badge>
                      <span className="text-[10px] text-faint">{fmtDateTime(u.created_at)}</span>
                      <button
                        type="button"
                        onClick={() => void toggleVisibility(u)}
                        className="ml-auto rounded p-1 text-faint transition hover:text-fg"
                        aria-label={u.client_visible ? 'Hide from client' : 'Share with client'}
                      >
                        {u.client_visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                      </button>
                    </div>
                    {u.body && <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-muted">{u.body}</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="space-y-3">
          <section className="surface p-4">
            <h2 className="text-xs font-semibold text-fg">Client</h2>
            {client ? (
              <>
                <p className="mt-2 text-[12.5px] font-medium text-fg">{client.name}</p>
                <p className="text-[10.5px] text-faint">{client.business_name}</p>
                <Link to={`/admin/clients/${client.id}`} className="mt-2 inline-block text-[11px] text-magenta hover:underline">
                  Open client profile
                </Link>
              </>
            ) : (
              <p className="mt-2 text-[11px] text-faint">This project is not linked to a client.</p>
            )}
          </section>

          <section className="surface p-4">
            <h2 className="text-xs font-semibold text-fg">Linked tasks</h2>
            {myTasks.length === 0 ? (
              <p className="mt-2 text-[11px] text-faint">No tasks linked to this project.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {myTasks.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2">
                    <span className={`truncate text-[11.5px] ${t.status === 'completed' ? 'text-muted line-through' : 'text-fg'}`}>{t.title}</span>
                    <span className="text-[10px] text-faint">{t.due_date ? fmtDate(t.due_date, 'd MMM') : '—'}</span>
                  </li>
                ))}
              </ul>
            )}
            <Link to="/admin/tasks" className="mt-2 inline-block text-[11px] text-magenta hover:underline">
              Go to tasks
            </Link>
          </section>
        </aside>
      </div>

      <ProjectDrawer
        open={editOpen}
        onClose={() => setEditOpen(false)}
        project={project}
        clients={clients}
        services={services}
        onSaved={() => { refresh(); invalidate(); }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={deleteProject}
        busy={busy}
        title="Delete this project?"
        confirmLabel="Delete project"
        body={
          <>
            <strong className="text-fg">{project.name}</strong> and its update history will be removed. Invoices and
            payments that are already linked to the client are not affected. Consider marking it cancelled instead.
          </>
        }
      />
    </div>
  );
}
