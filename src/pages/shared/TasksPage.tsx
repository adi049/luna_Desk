import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion } from 'framer-motion';
import {
  Archive,
  CalendarClock,
  Check,
  CheckCircle2,
  CircleDot,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Field,
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
import { useAuth } from '@/context/auth';
import { taskPriorityMeta, taskStatusMeta } from '@/lib/labels';
import { fmtDate, fmtRelative, todayISO } from '@/lib/dates';
import type { Client, Task, TaskPriority, TaskStatus } from '@/lib/types';
import { cn, uuid } from '@/lib/utils';

const schema = z.object({
  title: z.string().trim().min(3, 'Give the task a clear title.').max(140),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  status: z.enum(['todo', 'in_progress', 'completed', 'archived']),
  category: z.string().trim().max(40).optional(),
  due_date: z.string().optional(),
  due_time: z.string().optional(),
  client_id: z.string().optional(),
});
type TaskForm = z.infer<typeof schema>;

type DateFilter = 'all' | 'today' | 'upcoming' | 'overdue' | 'completed';
type ViewMode = 'board' | 'list';

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'To do' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'completed', label: 'Completed' },
];

export default function TasksPage() {
  const { profile, isAdmin } = useAuth();
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const toast = useToast();

  const { data: tasks, loading, error, refresh } = useCollection<Task>('tasks');
  const { data: clients } = useCollection<Client>('clients', {}, isAdmin);

  const [view, setView] = useState<ViewMode>('board');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | TaskStatus>('all');
  const [priorityFilter, setPriorityFilter] = useState<'all' | TaskPriority>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [sort, setSort] = useState<'due_date' | 'priority' | 'created'>('due_date');

  const [editing, setEditing] = useState<Task | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);

  const today = todayISO();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = tasks.filter((t) => {
      if (q && !`${t.title} ${t.description ?? ''} ${t.category ?? ''}`.toLowerCase().includes(q)) return false;
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      if (dateFilter === 'today') return t.status !== 'completed' && t.status !== 'archived' && t.due_date === today;
      if (dateFilter === 'upcoming')
        return t.status !== 'completed' && t.status !== 'archived' && Boolean(t.due_date) && t.due_date! > today;
      if (dateFilter === 'overdue')
        return t.status !== 'completed' && t.status !== 'archived' && Boolean(t.due_date) && t.due_date! < today;
      if (dateFilter === 'completed') return t.status === 'completed';
      return true;
    });
    rows = [...rows].sort((a, b) => {
      if (sort === 'priority') return taskPriorityMeta[b.priority].weight - taskPriorityMeta[a.priority].weight;
      if (sort === 'created') return b.created_at.localeCompare(a.created_at);
      if (!a.due_date && !b.due_date) return 0;
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date.localeCompare(b.due_date);
    });
    return rows;
  }, [tasks, search, statusFilter, priorityFilter, dateFilter, sort, today]);

  const counts = useMemo(() => {
    const active = tasks.filter((t) => t.status !== 'completed' && t.status !== 'archived');
    return {
      all: tasks.length,
      today: active.filter((t) => t.due_date === today).length,
      upcoming: active.filter((t) => t.due_date && t.due_date > today).length,
      overdue: active.filter((t) => t.due_date && t.due_date < today).length,
      completed: tasks.filter((t) => t.status === 'completed').length,
    };
  }, [tasks, today]);

  const clientName = (id: string | null) => (id ? clients.find((c) => c.id === id)?.name : null);

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (task: Task) => {
    setEditing(task);
    setDialogOpen(true);
  };

  const setStatus = async (task: Task, status: TaskStatus) => {
    try {
      await adapter.update<Task>('tasks', task.id, {
        status,
        completed_at: status === 'completed' ? new Date().toISOString() : null,
      });
      refresh();
      invalidate();
      if (status === 'completed') toast.success('Task completed', task.title);
    } catch (err) {
      toast.error('Could not update the task', err instanceof Error ? err.message : undefined);
    }
  };

  const removeTask = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      await adapter.remove('tasks', confirmDelete.id);
      toast.success('Task deleted');
      setConfirmDelete(null);
      refresh();
      invalidate();
    } catch (err) {
      toast.error('Could not delete the task', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Productivity"
        title="Tasks"
        description={
          isAdmin
            ? 'Agency work and your own to-dos. Personal tasks are visible only to you; client-linked tasks never appear in a client portal.'
            : 'Your private task list. Nothing here is visible to Managed by Luna or to other clients.'
        }
        actions={
          <Button variant="primary" onClick={openNew} icon={<Plus className="h-4 w-4" />}>
            New task
          </Button>
        }
      />

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search tasks" className="w-full sm:w-56" />
        <Segmented
          size="sm"
          ariaLabel="Date filter"
          value={dateFilter}
          onChange={setDateFilter}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'today', label: 'Today', count: counts.today },
            { value: 'upcoming', label: 'Upcoming', count: counts.upcoming },
            { value: 'overdue', label: 'Overdue', count: counts.overdue },
            { value: 'completed', label: 'Completed', count: counts.completed },
          ]}
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value as typeof priorityFilter)} className="w-32 py-1.5 text-xs" aria-label="Filter by priority">
            <option value="all">All priorities</option>
            {Object.entries(taskPriorityMeta).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </Select>
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="w-32 py-1.5 text-xs" aria-label="Filter by status">
            <option value="all">All statuses</option>
            {Object.entries(taskStatusMeta).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </Select>
          <Select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="w-36 py-1.5 text-xs" aria-label="Sort tasks">
            <option value="due_date">Sort: due date</option>
            <option value="priority">Sort: priority</option>
            <option value="created">Sort: newest</option>
          </Select>
          <Segmented
            size="sm"
            ariaLabel="Task view"
            value={view}
            onChange={setView}
            options={[
              { value: 'board', label: 'Board' },
              { value: 'list', label: 'List' },
            ]}
          />
        </div>
      </Toolbar>

      {loading ? (
        <SkeletonRows rows={5} />
      ) : error ? (
        <EmptyState title="Tasks could not be loaded" description={error} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 className="h-6 w-6" />}
          title={tasks.length === 0 ? 'No tasks yet' : 'Nothing matches those filters'}
          description={
            tasks.length === 0
              ? 'Create your first task to start tracking work. Tasks can carry a priority, a due date and an optional client.'
              : 'Try clearing the search or switching the date filter.'
          }
          action={
            tasks.length === 0 ? (
              <Button variant="primary" size="sm" onClick={openNew} icon={<Plus className="h-3.5 w-3.5" />}>
                New task
              </Button>
            ) : undefined
          }
        />
      ) : view === 'board' ? (
        <div className="grid gap-3 md:grid-cols-3">
          {COLUMNS.map((col) => {
            const colTasks = filtered.filter((t) => t.status === col.status);
            return (
              <motion.section
                key={col.status}
                layout
                className="surface flex min-h-[160px] flex-col p-3"
                aria-label={`${col.label} tasks`}
              >
                <header className="mb-2 flex items-center gap-2 px-1">
                  <CircleDot
                    className={cn(
                      'h-3 w-3',
                      col.status === 'todo' ? 'text-silver' : col.status === 'in_progress' ? 'text-sky' : 'text-mint',
                    )}
                    aria-hidden
                  />
                  <h2 className="text-xs font-semibold text-fg">{col.label}</h2>
                  <span className="num ml-auto text-[10px] text-faint">{colTasks.length}</span>
                </header>
                <div className="space-y-2">
                  {colTasks.map((task) => {
                    const overdue = task.due_date && task.due_date < today && task.status !== 'completed';
                    return (
                      <motion.article
                        layout
                        key={task.id}
                        className="group rounded-xl border bg-raised/50 p-3 transition hover:border-[rgb(var(--line)/0.26)]"
                        style={{ borderColor: 'rgb(var(--line) / 0.12)' }}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => void setStatus(task, task.status === 'completed' ? 'todo' : 'completed')}
                            className={cn(
                              'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition',
                              task.status === 'completed'
                                ? 'border-mint/60 bg-mint/20 text-mint'
                                : 'border-[rgb(var(--line)/0.3)] text-transparent hover:border-mint/60',
                            )}
                            aria-label={task.status === 'completed' ? `Reopen ${task.title}` : `Complete ${task.title}`}
                          >
                            <Check className="h-3 w-3" aria-hidden />
                          </button>
                          <button
                            type="button"
                            onClick={() => openEdit(task)}
                            className="min-w-0 flex-1 text-left"
                          >
                            <p className={cn('text-[13px] font-medium leading-snug text-fg', task.status === 'completed' && 'text-muted line-through')}>
                              {task.title}
                            </p>
                          </button>
                          <button
                            type="button"
                            onClick={() => openEdit(task)}
                            className="rounded p-1 text-faint opacity-0 transition hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
                            aria-label={`Edit ${task.title}`}
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1">
                          <Badge tone={taskPriorityMeta[task.priority].tone}>{taskPriorityMeta[task.priority].label}</Badge>
                          {task.category && <Badge tone="muted">{task.category}</Badge>}
                          {clientName(task.client_id) && <Badge tone="sky">{clientName(task.client_id)}</Badge>}
                        </div>
                        {task.due_date && (
                          <p className={cn('mt-2 flex items-center gap-1 text-[10.5px]', overdue ? 'text-magenta' : 'text-faint')}>
                            <CalendarClock className="h-3 w-3" aria-hidden />
                            {overdue ? 'Overdue · ' : ''}
                            {fmtDate(task.due_date)}
                            {task.due_time ? ` · ${task.due_time}` : ''}
                          </p>
                        )}
                      </motion.article>
                    );
                  })}
                  {colTasks.length === 0 && (
                    <p className="rounded-lg border border-dashed px-2 py-6 text-center text-[11px] text-faint" style={{ borderColor: 'rgb(var(--line)/0.14)' }}>
                      Nothing here
                    </p>
                  )}
                </div>
              </motion.section>
            );
          })}
        </div>
      ) : (
        <div className="surface overflow-hidden p-0">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-8" />
                  <th>Task</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th>Client</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((task) => {
                  const overdue = task.due_date && task.due_date < today && task.status !== 'completed';
                  return (
                    <tr key={task.id}>
                      <td>
                        <button
                          type="button"
                          onClick={() => void setStatus(task, task.status === 'completed' ? 'todo' : 'completed')}
                          className={cn(
                            'flex h-4 w-4 items-center justify-center rounded-[5px] border transition',
                            task.status === 'completed'
                              ? 'border-mint/60 bg-mint/20 text-mint'
                              : 'border-[rgb(var(--line)/0.3)] text-transparent hover:border-mint/60',
                          )}
                          aria-label={task.status === 'completed' ? `Reopen ${task.title}` : `Complete ${task.title}`}
                        >
                          <Check className="h-3 w-3" aria-hidden />
                        </button>
                      </td>
                      <td className="max-w-[22rem]">
                        <button type="button" onClick={() => openEdit(task)} className="block w-full text-left">
                          <span className={cn('block truncate text-[13px] font-medium', task.status === 'completed' ? 'text-muted line-through' : 'text-fg')}>
                            {task.title}
                          </span>
                          {task.description && <span className="mt-0.5 block truncate text-[11px] text-faint">{task.description}</span>}
                        </button>
                      </td>
                      <td>
                        <Badge tone={taskPriorityMeta[task.priority].tone}>{taskPriorityMeta[task.priority].label}</Badge>
                      </td>
                      <td>
                        <Badge tone={taskStatusMeta[task.status].tone}>{taskStatusMeta[task.status].label}</Badge>
                      </td>
                      <td className={cn('num whitespace-nowrap text-xs', overdue ? 'text-magenta' : 'text-muted')}>
                        {task.due_date ? fmtDate(task.due_date) : '—'}
                        {task.due_time && <span className="ml-1 text-faint">{task.due_time}</span>}
                      </td>
                      <td className="text-xs text-muted">{clientName(task.client_id) ?? '—'}</td>
                      <td>
                        <div className="flex items-center justify-end gap-1">
                          {task.status === 'completed' ? (
                            <Button size="sm" variant="quiet" onClick={() => void setStatus(task, 'todo')} aria-label={`Reopen ${task.title}`} icon={<RotateCcw className="h-3 w-3" />} />
                          ) : (
                            <Button size="sm" variant="quiet" onClick={() => void setStatus(task, 'archived')} aria-label={`Archive ${task.title}`} icon={<Archive className="h-3 w-3" />} />
                          )}
                          <Button size="sm" variant="quiet" onClick={() => openEdit(task)} aria-label={`Edit ${task.title}`} icon={<Pencil className="h-3 w-3" />} />
                          <Button size="sm" variant="quiet" onClick={() => setConfirmDelete(task)} aria-label={`Delete ${task.title}`} icon={<Trash2 className="h-3 w-3" />} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <TaskDrawer
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        task={editing}
        clients={isAdmin ? clients : []}
        ownerId={profile?.id ?? ''}
        onSaved={() => {
          refresh();
          invalidate();
        }}
        onDelete={(task) => {
          setDialogOpen(false);
          setConfirmDelete(task);
        }}
      />

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={removeTask}
        busy={busy}
        title="Delete this task?"
        confirmLabel="Delete task"
        body={
          <>
            <strong className="text-fg">{confirmDelete?.title}</strong> will be permanently removed. Archiving keeps a
            record instead; this cannot be undone.
          </>
        }
      />
    </div>
  );
}

function TaskDrawer({
  open,
  onClose,
  task,
  clients,
  ownerId,
  onSaved,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  task: Task | null;
  clients: Client[];
  ownerId: string;
  onSaved: () => void;
  onDelete: (task: Task) => void;
}) {
  const adapter = useData().adapters.data;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<TaskForm>({ resolver: zodResolver(schema) });

  useMemo(() => {
    if (!open) return;
    reset({
      title: task?.title ?? '',
      description: task?.description ?? '',
      priority: task?.priority ?? 'medium',
      status: task?.status ?? 'todo',
      category: task?.category ?? '',
      due_date: task?.due_date ?? '',
      due_time: task?.due_time ?? '',
      client_id: task?.client_id ?? '',
    });
  }, [open, task, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setBusy(true);
    try {
      const payload = {
        title: values.title.trim(),
        description: values.description?.trim() || null,
        priority: values.priority,
        status: values.status,
        category: values.category?.trim() || null,
        due_date: values.due_date || null,
        due_time: values.due_time || null,
        client_id: values.client_id || null,
        completed_at: values.status === 'completed' ? task?.completed_at ?? new Date().toISOString() : null,
      };
      if (task) {
        await adapter.update<Task>('tasks', task.id, payload);
        toast.success('Task updated');
      } else {
        await adapter.insert('tasks', { id: uuid(), owner_id: ownerId, ...payload });
        toast.success('Task created');
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error('Could not save the task', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={task ? 'Edit task' : 'New task'}
      footer={
        <>
          {task && (
            <Button variant="quiet" onClick={() => onDelete(task)} icon={<Trash2 className="h-3.5 w-3.5" />} className="mr-auto">
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void onSubmit()} loading={busy} disabled={task ? !isDirty : false}>
            {task ? 'Save changes' : 'Create task'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Title" error={errors.title?.message} required>
          {(id) => <TextInput id={id} {...register('title')} placeholder="What needs to happen?" autoFocus />}
        </Field>
        <Field label="Description" error={errors.description?.message}>
          {(id) => <TextArea id={id} {...register('description')} placeholder="Context, links, acceptance criteria…" />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Priority" error={errors.priority?.message}>
            {(id) => (
              <Select id={id} {...register('priority')}>
                {Object.entries(taskPriorityMeta).map(([value, meta]) => (
                  <option key={value} value={value}>
                    {meta.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Status" error={errors.status?.message}>
            {(id) => (
              <Select id={id} {...register('status')}>
                {Object.entries(taskStatusMeta).map(([value, meta]) => (
                  <option key={value} value={value}>
                    {meta.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Due date" error={errors.due_date?.message}>
            {(id) => <TextInput id={id} type="date" {...register('due_date')} />}
          </Field>
          <Field label="Due time" error={errors.due_time?.message}>
            {(id) => <TextInput id={id} type="time" {...register('due_time')} />}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category" hint="Optional label, e.g. Delivery, Finance" error={errors.category?.message}>
            {(id) => <TextInput id={id} {...register('category')} placeholder="Delivery" />}
          </Field>
          {clients.length > 0 && (
            <Field label="Client" hint="Links the task to client work (never shown in their portal)">
              {(id) => (
                <Select id={id} {...register('client_id')}>
                  <option value="">No client</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        {task && (
          <p className="text-[11px] text-faint">
            Created {fmtRelative(task.created_at)} · last updated {fmtRelative(task.updated_at)}
          </p>
        )}
      </form>
    </Drawer>
  );
}
