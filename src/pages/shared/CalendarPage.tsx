import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  addDays,
  addMonths,
  addWeeks,
  format,
  isSameDay,
  isToday,
} from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight, Clock, Eye, Plus, Repeat, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  PageHeader,
  Segmented,
  Select,
  SkeletonRows,
  TextArea,
  TextInput,
} from '@/components/ui';
import { ConfirmDialog, Drawer } from '@/components/ui/overlays';
import { useCollection, useData, useToast } from '@/context/app';
import { useAuth } from '@/context/auth';
import { buildMonthMatrix, buildWeekDays, expandEvents, rangeForView } from '@/lib/calendar';
import { eventCategoryTone } from '@/lib/labels';
import { fmtDate, fmtTime } from '@/lib/dates';
import type { CalendarEvent, Client, Project, Task } from '@/lib/types';
import { cn, uuid } from '@/lib/utils';

type View = 'month' | 'week' | 'day' | 'agenda';

const schema = z.object({
  title: z.string().trim().min(2, 'Give the event a title.').max(140),
  description: z.string().trim().max(1000).optional(),
  category: z.enum(['work', 'billing', 'meeting', 'deadline', 'personal']),
  starts_at: z.string().min(1, 'Choose a start time.'),
  ends_at: z.string().min(1, 'Choose an end time.'),
  all_day: z.boolean(),
  recurrence: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']),
  recurrence_until: z.string().optional(),
  client_visible: z.boolean(),
  client_id: z.string().optional(),
  project_id: z.string().optional(),
  task_id: z.string().optional(),
});
type EventForm = z.infer<typeof schema>;

const toLocalInput = (date: Date) => format(date, "yyyy-MM-dd'T'HH:mm");

export default function CalendarPage() {
  const { profile, isAdmin } = useAuth();
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const toast = useToast();

  const { data: events, loading, refresh } = useCollection<CalendarEvent>('calendar_events');
  const { data: clients } = useCollection<Client>('clients', {}, isAdmin);
  const { data: projects } = useCollection<Project>('projects', {}, isAdmin);
  const { data: tasks } = useCollection<Task>('tasks');

  const [view, setView] = useState<View>('month');
  const [cursor, setCursor] = useState(() => new Date());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [prefillDate, setPrefillDate] = useState<Date | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CalendarEvent | null>(null);
  const [busy, setBusy] = useState(false);

  const { from, to } = useMemo(() => rangeForView(view, cursor), [view, cursor]);
  const occurrences = useMemo(() => expandEvents(events, from, to), [events, from, to]);

  const step = (direction: 1 | -1) => {
    if (view === 'month') setCursor((c) => addMonths(c, direction));
    else if (view === 'week') setCursor((c) => addWeeks(c, direction));
    else if (view === 'day') setCursor((c) => addDays(c, direction));
    else setCursor((c) => addDays(c, 14 * direction));
  };

  const openNew = (date?: Date) => {
    setEditing(null);
    setPrefillDate(date ?? cursor);
    setDialogOpen(true);
  };

  const remove = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      await adapter.remove('calendar_events', confirmDelete.id);
      toast.success('Event deleted');
      setConfirmDelete(null);
      refresh();
      invalidate();
    } catch (err) {
      toast.error('Could not delete the event', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const dayEvents = (day: Date) => occurrences.filter((o) => isSameDay(o.start, day));

  const headerLabel =
    view === 'month'
      ? format(cursor, 'MMMM yyyy')
      : view === 'week'
        ? `${format(buildWeekDays(cursor)[0], 'd MMM')} – ${format(buildWeekDays(cursor)[6], 'd MMM yyyy')}`
        : view === 'day'
          ? format(cursor, 'EEEE, d MMMM yyyy')
          : 'Next 60 days';

  return (
    <div>
      <PageHeader
        eyebrow="Productivity"
        title="Calendar"
        description="Plan around work, billing and deadlines. Recurring events are expanded with calendar arithmetic so daylight-saving changes never shift your 9am."
        actions={
          <Button variant="primary" onClick={() => openNew()} icon={<Plus className="h-4 w-4" />}>
            New event
          </Button>
        }
      />

      <div className="surface overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5">
          <div className="flex items-center gap-1">
            <Button size="sm" variant="quiet" onClick={() => step(-1)} aria-label="Previous period" icon={<ChevronLeft className="h-3.5 w-3.5" />} />
            <Button size="sm" variant="quiet" onClick={() => step(1)} aria-label="Next period" icon={<ChevronRight className="h-3.5 w-3.5" />} />
            <Button size="sm" variant="ghost" onClick={() => setCursor(new Date())}>
              Today
            </Button>
          </div>
          <h2 className="ml-1 text-sm font-semibold text-fg">{headerLabel}</h2>
          <div className="ml-auto">
            <Segmented
              size="sm"
              ariaLabel="Calendar view"
              value={view}
              onChange={setView}
              options={[
                { value: 'month', label: 'Month' },
                { value: 'week', label: 'Week' },
                { value: 'day', label: 'Day' },
                { value: 'agenda', label: 'Agenda' },
              ]}
            />
          </div>
        </div>

        {loading ? (
          <div className="p-4">
            <SkeletonRows rows={6} />
          </div>
        ) : view === 'month' ? (
          <div className="min-w-[640px] overflow-x-auto">
            <div className="grid grid-cols-7 border-b text-[10px] uppercase tracking-[0.14em] text-faint">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <div key={d} className="px-2 py-2">
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {buildMonthMatrix(cursor).map((day) => {
                const items = dayEvents(day);
                const inMonth = day.getMonth() === cursor.getMonth();
                return (
                  <div
                    key={day.toISOString()}
                    className={cn(
                      'min-h-[104px] border-b border-r p-1.5 transition last:border-r-0 hover:bg-raised/40',
                      !inMonth && 'opacity-45',
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => {
                          setCursor(day);
                          setView('day');
                        }}
                        className={cn(
                          'num flex h-6 w-6 items-center justify-center rounded-full text-[11px] transition hover:bg-raised',
                          isToday(day) ? 'bg-magenta font-semibold text-white' : 'text-muted',
                        )}
                        aria-label={`Open ${format(day, 'd MMMM yyyy')}`}
                      >
                        {format(day, 'd')}
                      </button>
                      <button
                        type="button"
                        onClick={() => openNew(day)}
                        className="rounded p-0.5 text-faint opacity-0 transition hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 [div:hover>&]:opacity-100"
                        aria-label={`Add event on ${format(day, 'd MMMM')}`}
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="space-y-1">
                      {items.slice(0, 3).map((o, i) => (
                        <button
                          key={`${o.event.id}-${i}`}
                          type="button"
                          onClick={() => {
                            setEditing(o.event);
                            setDialogOpen(true);
                          }}
                          className="block w-full truncate rounded px-1.5 py-1 text-left text-[10.5px] transition hover:bg-[rgb(var(--line)/0.1)]"
                        >
                          <span className="flex items-center gap-1">
                            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', `bg-${eventCategoryTone[o.event.category] === 'sky' ? 'sky' : 'magenta'}`)} aria-hidden />
                            <span className="truncate text-muted">{o.event.all_day ? '' : `${format(o.start, 'HH:mm')} `}{o.event.title}</span>
                          </span>
                        </button>
                      ))}
                      {items.length > 3 && <p className="pl-1.5 text-[10px] text-faint">+{items.length - 3} more</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : view === 'week' || view === 'day' ? (
          <div className="min-w-[560px] overflow-x-auto">
            <div className={cn('grid border-b', view === 'week' ? 'grid-cols-7' : 'grid-cols-1')}>
              {(view === 'week' ? buildWeekDays(cursor) : [cursor]).map((day) => (
                <div key={day.toISOString()} className="min-h-[320px] border-r p-2 last:border-r-0">
                  <div className="mb-2 flex items-center justify-between">
                    <p className={cn('text-[11px] font-semibold', isToday(day) ? 'text-magenta' : 'text-muted')}>
                      {format(day, view === 'week' ? 'EEE d' : 'EEEE d MMMM')}
                    </p>
                    <button type="button" onClick={() => openNew(day)} className="rounded p-0.5 text-faint hover:text-fg" aria-label="Add event">
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {dayEvents(day).length === 0 && <p className="text-[10px] text-faint">—</p>}
                    {dayEvents(day).map((o, i) => (
                      <button
                        key={`${o.event.id}-${i}`}
                        type="button"
                        onClick={() => {
                          setEditing(o.event);
                          setDialogOpen(true);
                        }}
                        className="block w-full rounded-lg border px-2 py-1.5 text-left transition hover:border-[rgb(var(--line)/0.3)]"
                        style={{ borderColor: 'rgb(var(--line) / 0.12)' }}
                      >
                        <p className="truncate text-[11.5px] font-medium text-fg">{o.event.title}</p>
                        <p className="mt-0.5 flex items-center gap-1 text-[10px] text-faint">
                          <Clock className="h-2.5 w-2.5" aria-hidden />
                          {o.event.all_day ? 'All day' : `${format(o.start, 'HH:mm')}–${format(o.end, 'HH:mm')}`}
                          {o.isRecurringInstance && <Repeat className="ml-1 h-2.5 w-2.5" aria-hidden />}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="divide-y">
            {occurrences.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  compact
                  icon={<CalendarDays className="h-5 w-5" />}
                  title="Nothing scheduled"
                  description="Events you add appear here in chronological order."
                />
              </div>
            ) : (
              occurrences.map((o, i) => (
                <button
                  key={`${o.event.id}-${i}`}
                  type="button"
                  onClick={() => {
                    setEditing(o.event);
                    setDialogOpen(true);
                  }}
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-2.5 text-left transition hover:bg-raised/40"
                >
                  <div className="w-24 shrink-0">
                    <p className="text-[11px] font-semibold text-fg">{format(o.start, 'd MMM')}</p>
                    <p className="num text-[10px] text-faint">{o.event.all_day ? 'All day' : format(o.start, 'HH:mm')}</p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-medium text-fg">{o.event.title}</p>
                    {o.event.description && <p className="truncate text-[11px] text-muted">{o.event.description}</p>}
                  </div>
                  <Badge tone={eventCategoryTone[o.event.category]}>{o.event.category}</Badge>
                  {o.event.client_visible && (
                    <Badge tone="sky">
                      <Eye className="h-2.5 w-2.5" aria-hidden /> client
                    </Badge>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[10.5px] text-faint">
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky" aria-hidden /> Work</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-butter" aria-hidden /> Billing</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-blush" aria-hidden /> Meeting</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-magenta" aria-hidden /> Deadline</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-silver" aria-hidden /> Personal</span>
        <span className="ml-auto">Personal events are private; only events marked client-visible reach a portal.</span>
      </div>

      <EventDrawer
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        event={editing}
        prefillDate={prefillDate}
        ownerId={profile?.id ?? ''}
        isAdmin={Boolean(isAdmin)}
        clients={clients}
        projects={projects}
        tasks={tasks}
        onSaved={() => {
          refresh();
          invalidate();
        }}
        onDelete={(ev) => {
          setDialogOpen(false);
          setConfirmDelete(ev);
        }}
      />

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={remove}
        busy={busy}
        title="Delete this event?"
        confirmLabel="Delete event"
        body={<><strong className="text-fg">{confirmDelete?.title}</strong> will be removed from your calendar.</>}
      />
    </div>
  );
}

function EventDrawer({
  open,
  onClose,
  event,
  prefillDate,
  ownerId,
  isAdmin,
  clients,
  projects,
  tasks,
  onSaved,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  event: CalendarEvent | null;
  prefillDate: Date | null;
  ownerId: string;
  isAdmin: boolean;
  clients: Client[];
  projects: Project[];
  tasks: Task[];
  onSaved: () => void;
  onDelete: (event: CalendarEvent) => void;
}) {
  const adapter = useData().adapters.data;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<EventForm>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (!open) return;
    const base = event ? new Date(event.starts_at) : prefillDate ? new Date(prefillDate) : new Date();
    if (!event) base.setHours(9, 0, 0, 0);
    const end = event ? new Date(event.ends_at) : new Date(base.getTime() + 60 * 60_000);
    reset({
      title: event?.title ?? '',
      description: event?.description ?? '',
      category: event?.category ?? 'work',
      starts_at: toLocalInput(base),
      ends_at: toLocalInput(end),
      all_day: event?.all_day ?? false,
      recurrence: event?.recurrence ?? 'none',
      recurrence_until: event?.recurrence_until ?? '',
      client_visible: event?.client_visible ?? false,
      client_id: event?.client_id ?? '',
      project_id: event?.project_id ?? '',
      task_id: event?.task_id ?? '',
    });
  }, [open, event, prefillDate, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setBusy(true);
    try {
      const startDate = new Date(values.starts_at);
      const endDate = new Date(values.ends_at);
      if (endDate < startDate) throw new Error('The end time must be after the start time.');
      const payload = {
        title: values.title.trim(),
        description: values.description?.trim() || null,
        category: values.category,
        starts_at: startDate.toISOString(),
        ends_at: endDate.toISOString(),
        all_day: values.all_day,
        recurrence: values.recurrence,
        recurrence_until: values.recurrence === 'none' ? null : values.recurrence_until || null,
        client_visible: isAdmin ? values.client_visible : false,
        client_id: values.client_id || null,
        project_id: values.project_id || null,
        task_id: values.task_id || null,
      };
      if (event) {
        await adapter.update<CalendarEvent>('calendar_events', event.id, payload);
        toast.success('Event updated');
      } else {
        await adapter.insert('calendar_events', { id: uuid(), owner_id: ownerId, ...payload });
        toast.success('Event created');
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error('Could not save the event', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={event ? 'Edit event' : 'New event'}
      footer={
        <>
          {event && (
            <Button variant="quiet" className="mr-auto" onClick={() => onDelete(event)} icon={<Trash2 className="h-3.5 w-3.5" />}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void onSubmit()} loading={busy}>
            {event ? 'Save changes' : 'Create event'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Title" error={errors.title?.message} required>
          {(id) => <TextInput id={id} {...register('title')} placeholder="e.g. Prism monthly review" autoFocus />}
        </Field>
        <Field label="Notes" error={errors.description?.message}>
          {(id) => <TextArea id={id} {...register('description')} placeholder="Agenda or context" />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts" error={errors.starts_at?.message} required>
            {(id) => <TextInput id={id} type="datetime-local" {...register('starts_at')} />}
          </Field>
          <Field label="Ends" error={errors.ends_at?.message} required>
            {(id) => <TextInput id={id} type="datetime-local" {...register('ends_at')} />}
          </Field>
          <Field label="Category" error={errors.category?.message}>
            {(id) => (
              <Select id={id} {...register('category')}>
                <option value="work">Work</option>
                <option value="billing">Billing</option>
                <option value="meeting">Meeting</option>
                <option value="deadline">Deadline</option>
                <option value="personal">Personal</option>
              </Select>
            )}
          </Field>
          <Field label="Repeats">
            {(id) => (
              <Select id={id} {...register('recurrence')}>
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </Select>
            )}
          </Field>
          <Field label="Repeat until" hint="Leave empty to repeat indefinitely">
            {(id) => <TextInput id={id} type="date" {...register('recurrence_until')} />}
          </Field>
          <Field label="Linked task">
            {(id) => (
              <Select id={id} {...register('task_id')}>
                <option value="">None</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <label className="flex items-center gap-2 text-[12px] text-fg">
          <input type="checkbox" {...register('all_day')} className="h-4 w-4 rounded accent-[#FF2D95]" />
          All-day event
        </label>

        {isAdmin && (
          <>
            <div className="h-px" style={{ background: 'rgb(var(--line) / 0.12)' }} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Client">
                {(id) => (
                  <Select id={id} {...register('client_id')}>
                    <option value="">Internal</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Project">
                {(id) => (
                  <Select id={id} {...register('project_id')}>
                    <option value="">Not linked</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <label className="flex items-start gap-2.5 rounded-xl border p-3" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
              <input type="checkbox" {...register('client_visible')} className="mt-0.5 h-4 w-4 rounded accent-[#FF2D95]" />
              <span>
                <span className="block text-[12.5px] font-medium text-fg">Visible to the client</span>
                <span className="mt-0.5 block text-[11px] text-muted">
                  Off by default. When on, this event appears as an upcoming deadline in the client’s portal.
                </span>
              </span>
            </label>
          </>
        )}
        {event && (
          <p className="text-[10.5px] text-faint">
            Created {fmtDate(event.created_at)} · {event.recurrence === 'none' ? 'One-off' : `Repeats ${event.recurrence}`}
            {event.all_day ? ' · All day' : ` · ${fmtTime(event.starts_at)}–${fmtTime(event.ends_at)}`}
          </p>
        )}
        <p className="text-[10.5px] text-faint">Times are stored with timezone information and displayed in your local timezone.</p>
      </form>
    </Drawer>
  );
}
