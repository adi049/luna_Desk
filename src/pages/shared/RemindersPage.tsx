import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  AlarmClock,
  Bell,
  BellOff,
  BellRing,
  CalendarClock,
  Check,
  Clock,
  Info,
  Pencil,
  Play,
  Plus,
  Repeat,
  Square,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
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
import { ConfirmDialog, Drawer, Modal } from '@/components/ui/overlays';
import { useCollection, useData, useToast } from '@/context/app';
import { useAuth } from '@/context/auth';
import { alarmPlayer, type AlarmTone } from '@/lib/alarm';
import { notificationSupport, requestNotificationPermission, showNotification, type PermissionState } from '@/lib/notifications';
import { isMissed, isRinging, isUpcoming, nextOccurrence } from '@/lib/reminders';
import { fmtDateTime, fmtRelative } from '@/lib/dates';
import type { NotificationPreferences, Reminder, ReminderRepeat, Task } from '@/lib/types';
import { cn, uuid } from '@/lib/utils';
import { subscribeToPush } from '@/lib/push';

const schema = z.object({
  title: z.string().trim().min(3, 'Give the reminder a clear title.').max(140),
  description: z.string().trim().max(1000).optional(),
  remind_at: z.string().min(1, 'Choose when this should ring.'),
  repeat: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']),
  alarm_enabled: z.boolean(),
  task_id: z.string().optional(),
});
type ReminderForm = z.infer<typeof schema>;

const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const defaultWhen = () => {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setSeconds(0, 0);
  return toLocalInput(d.toISOString());
};

export default function RemindersPage() {
  const { profile } = useAuth();
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const toast = useToast();

  const { data: reminders, loading, refresh } = useCollection<Reminder>('reminders');
  const { data: tasks } = useCollection<Task>('tasks');
  const { data: prefsRows, refresh: refreshPrefs } = useCollection<NotificationPreferences>('notification_preferences');
  const prefs = prefsRows[0];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Reminder | null>(null);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [permission, setPermission] = useState<PermissionState>('default');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [filter, setFilter] = useState<'upcoming' | 'missed' | 'history'>('upcoming');

  useEffect(() => {
    setPermission(notificationSupport());
    if (prefs && !prefs.browser_notifications && notificationSupport() === 'default') {
      // Explain once, only if the user has never been asked.
      const seen = localStorage.getItem('lunadesk.reminder-permission-explained');
      if (!seen) {
        setPermissionOpen(true);
        localStorage.setItem('lunadesk.reminder-permission-explained', '1');
      }
    }
  }, [prefs]);

  const now = Date.now();
  const grouped = useMemo(() => {
    const sorted = [...reminders].sort((a, b) => a.remind_at.localeCompare(b.remind_at));
    return {
      ringing: sorted.filter((r) => isRinging(r, now)),
      upcoming: sorted.filter((r) => isUpcoming(r, now)),
      missed: sorted.filter((r) => isMissed(r, now)),
      history: sorted.filter((r) => r.is_dismissed).sort((a, b) => b.remind_at.localeCompare(a.remind_at)),
    };
  }, [reminders, now]);

  const listed = grouped[filter];

  const ensurePrefs = async (): Promise<NotificationPreferences | null> => {
    if (prefs) return prefs;
    if (!profile) return null;
    const created = await adapter.insert<NotificationPreferences>('notification_preferences', {
      user_id: profile.id,
      browser_notifications: false,
      alarm_sound: true,
      alarm_volume: 0.6,
      alarm_sound_name: 'pulse',
      email_digest: false,
      quiet_hours_start: null,
      quiet_hours_end: null,
    });
    refreshPrefs();
    return created;
  };

  const enableNotifications = async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
    const current = await ensurePrefs();
    if (current) {
      await adapter.update('notification_preferences', current.user_id, { browser_notifications: result === 'granted' });
      refreshPrefs();
      invalidate();
    }
    if (result === 'granted') {
      showNotification('Notifications are on', { body: 'LunaDesk will alert you when a reminder is due.' });
      setPermissionOpen(false);

      // Beyond the permission prompt: store a push subscription so the
      // scheduled job can reach this device while the tab is closed. This is
      // best-effort by design — if it is unavailable we say so instead of
      // implying a background alarm exists.
      const userId = profile?.id;
      if (userId) {
        const status = await subscribeToPush(adapter, userId);
        if (status.state === 'subscribed') {
          toast.success('Browser notifications enabled', 'This device can now receive reminders while LunaDesk is closed, when the browser allows it.');
        } else if (status.state === 'unconfigured' || status.state === 'unsupported') {
          toast.success('Browser notifications enabled', status.reason);
        } else if (status.state === 'error' || status.state === 'denied') {
          toast.warning('Reminders will ring in-app only', status.reason);
        }
      } else {
        toast.success('Browser notifications enabled');
      }
    } else if (result === 'denied') {
      toast.warning('Notifications blocked', 'You can re-enable them in your browser’s site settings.');
    }
  };

  const updatePref = async (patch: Partial<NotificationPreferences>) => {
    const current = await ensurePrefs();
    if (!current) return;
    await adapter.update('notification_preferences', current.user_id, patch);
    refreshPrefs();
    invalidate();
  };

  const testAlarm = async () => {
    setTesting(true);
    try {
      await alarmPlayer.testPlay((prefs?.alarm_sound_name as AlarmTone) ?? 'pulse', prefs?.alarm_volume ?? 0.6);
      window.setTimeout(() => setTesting(false), 2700);
    } catch {
      toast.error('Your browser blocked audio', 'Interact with the page once, then try again.');
      setTesting(false);
    }
  };

  const snooze = async (reminder: Reminder, minutes: number) => {
    await adapter.update<Reminder>('reminders', reminder.id, {
      snoozed_until: new Date(Date.now() + minutes * 60_000).toISOString(),
      fired_at: null,
    });
    refresh();
    invalidate();
    toast.info(`Snoozed ${minutes} minutes`);
  };

  const dismiss = async (reminder: Reminder) => {
    if (reminder.repeat !== 'none') {
      const next = nextOccurrence(new Date(reminder.remind_at), reminder.repeat);
      await adapter.update<Reminder>('reminders', reminder.id, { remind_at: next.toISOString(), fired_at: null, snoozed_until: null });
      toast.success('Reminder completed', `Next one is ${fmtDateTime(next.toISOString())}.`);
    } else {
      await adapter.update<Reminder>('reminders', reminder.id, { is_dismissed: true, dismissed_at: new Date().toISOString(), snoozed_until: null });
      toast.success('Reminder dismissed');
    }
    refresh();
    invalidate();
  };

  const remove = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      await adapter.remove('reminders', confirmDelete.id);
      toast.success('Reminder deleted');
      setConfirmDelete(null);
      refresh();
      invalidate();
    } catch (err) {
      toast.error('Could not delete the reminder', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Productivity"
        title="Reminders & alarms"
        description="Timed alerts with an audible alarm and a visual overlay. Alarms ring while LunaDesk is open — read the limits below before relying on them."
        actions={
          <>
            <Button variant="ghost" onClick={() => void testAlarm()} icon={testing ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}>
              {testing ? 'Stop test' : 'Play test alarm'}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
              icon={<Plus className="h-4 w-4" />}
            >
              New reminder
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Segmented
              ariaLabel="Reminder list"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'upcoming', label: 'Upcoming', count: grouped.upcoming.length },
                { value: 'missed', label: 'Missed', count: grouped.missed.length },
                { value: 'history', label: 'History', count: grouped.history.length },
              ]}
            />
            {grouped.ringing.length > 0 && (
              <Badge tone="magenta" dot>
                {grouped.ringing.length} ringing now
              </Badge>
            )}
          </div>

          {loading ? (
            <SkeletonRows rows={4} />
          ) : listed.length === 0 ? (
            <EmptyState
              icon={<Bell className="h-6 w-6" />}
              title={
                filter === 'upcoming' ? 'No upcoming reminders' : filter === 'missed' ? 'Nothing was missed' : 'No reminder history yet'
              }
              description={
                filter === 'upcoming'
                  ? 'Create a reminder with a time and LunaDesk will alert you while the app is open.'
                  : filter === 'missed'
                    ? 'Reminders that elapsed while LunaDesk was closed would appear here, clearly marked as missed.'
                    : 'Dismissed and completed reminders are kept here for reference.'
              }
            />
          ) : (
            <ul className="space-y-2">
              {listed.map((r) => {
                const ringing = isRinging(r, now);
                const missed = isMissed(r, now);
                return (
                  <li key={r.id} className={cn('surface flex flex-wrap items-start gap-3 p-3.5', ringing && 'border-magenta/40')}>
                    <span
                      className={cn(
                        'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                        ringing ? 'bg-magenta/15 text-magenta' : missed ? 'bg-butter/15 text-butter' : 'bg-[rgb(var(--line)/0.08)] text-faint',
                      )}
                    >
                      {r.alarm_enabled ? <BellRing className="h-4 w-4" aria-hidden /> : <BellOff className="h-4 w-4" aria-hidden />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className={cn('text-[13px] font-medium', r.is_dismissed ? 'text-muted line-through' : 'text-fg')}>{r.title}</p>
                        {ringing && <Badge tone="magenta" dot>Ringing</Badge>}
                        {missed && <Badge tone="butter">Missed</Badge>}
                        {r.repeat !== 'none' && (
                          <Badge tone="muted">
                            <Repeat className="h-2.5 w-2.5" aria-hidden /> {r.repeat}
                          </Badge>
                        )}
                        {r.snoozed_until && new Date(r.snoozed_until) > new Date() && (
                          <Badge tone="sky">Snoozed until {fmtDateTime(r.snoozed_until)}</Badge>
                        )}
                      </div>
                      {r.description && <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{r.description}</p>}
                      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-faint">
                        <span className="flex items-center gap-1">
                          <CalendarClock className="h-3 w-3" aria-hidden /> {fmtDateTime(r.remind_at)} ({fmtRelative(r.remind_at)})
                        </span>
                        {r.task_id && <span>Linked to a task</span>}
                        {!r.alarm_enabled && <span>Silent (no alarm)</span>}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {!r.is_dismissed && (
                        <>
                          <Button size="sm" variant="quiet" onClick={() => void snooze(r, 5)}>
                            5m
                          </Button>
                          <Button size="sm" variant="quiet" onClick={() => void snooze(r, 15)}>
                            15m
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void dismiss(r)} icon={<Check className="h-3 w-3" />}>
                            Done
                          </Button>
                        </>
                      )}
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => {
                          setEditing(r);
                          setDialogOpen(true);
                        }}
                        aria-label={`Edit reminder ${r.title}`}
                        icon={<Pencil className="h-3 w-3" />}
                      />
                      <Button size="sm" variant="quiet" onClick={() => setConfirmDelete(r)} aria-label={`Delete reminder ${r.title}`} icon={<Trash2 className="h-3 w-3" />} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <aside className="space-y-3">
          <section className="surface p-4">
            <h2 className="flex items-center gap-1.5 text-xs font-semibold text-fg">
              <Volume2 className="h-3.5 w-3.5 text-faint" aria-hidden /> Alarm settings
            </h2>
            <div className="mt-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[12px] text-fg">Alarm sound</p>
                  <p className="text-[10.5px] text-faint">Synthesised locally, no download</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={prefs?.alarm_sound ?? true}
                  aria-label="Alarm sound"
                  onClick={() => void updatePref({ alarm_sound: !(prefs?.alarm_sound ?? true) })}
                  className={cn(
                    'relative h-5 w-9 shrink-0 rounded-full border transition',
                    (prefs?.alarm_sound ?? true) ? 'border-magenta/50 bg-magenta/60' : 'border-[rgb(var(--line)/0.25)] bg-[rgb(var(--line)/0.1)]',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all',
                      (prefs?.alarm_sound ?? true) ? 'left-[1.15rem]' : 'left-0.5',
                    )}
                  />
                </button>
              </div>

              <Field label={`Volume — ${Math.round((prefs?.alarm_volume ?? 0.6) * 100)}%`}>
                {(id) => (
                  <input
                    id={id}
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round((prefs?.alarm_volume ?? 0.6) * 100)}
                    onChange={(e) => {
                      const v = Number(e.target.value) / 100;
                      alarmPlayer.setVolume(v);
                      void updatePref({ alarm_volume: v });
                    }}
                    className="w-full accent-[#FF2D95]"
                  />
                )}
              </Field>

              <Field label="Alarm tone">
                {(id) => (
                  <Select
                    id={id}
                    value={prefs?.alarm_sound_name ?? 'pulse'}
                    onChange={(e) => void updatePref({ alarm_sound_name: e.target.value })}
                  >
                    <option value="pulse">Pulse</option>
                    <option value="chime">Chime</option>
                    <option value="beacon">Beacon</option>
                  </Select>
                )}
              </Field>

              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={() => void testAlarm()} icon={<Play className="h-3 w-3" />}>
                  Play test
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => {
                    alarmPlayer.stop();
                    setTesting(false);
                  }}
                  icon={<Square className="h-3 w-3" />}
                >
                  Stop
                </Button>
              </div>
            </div>
          </section>

          <section className="surface p-4">
            <h2 className="flex items-center gap-1.5 text-xs font-semibold text-fg">
              <Bell className="h-3.5 w-3.5 text-faint" aria-hidden /> Browser notifications
            </h2>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              {permission === 'granted'
                ? 'Enabled. Notifications appear even when this tab is in the background.'
                : permission === 'denied'
                  ? 'Blocked. Re-enable LunaDesk in your browser’s site settings (usually a padlock icon next to the address).'
                  : permission === 'unsupported'
                    ? 'This browser does not support the Notifications API. The visual alarm still works while the page is open.'
                    : 'Not requested yet. LunaDesk only asks when you press the button below.'}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {permission !== 'granted' && permission !== 'unsupported' && permission !== 'denied' && (
                <Button size="sm" variant="ghost" onClick={() => void enableNotifications()}>
                  Allow notifications
                </Button>
              )}
              {permission === 'granted' && (
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => showNotification('Test notification', { body: 'This is how a due reminder will look.' })}
                >
                  Send a test
                </Button>
              )}
              <Button size="sm" variant="quiet" onClick={() => setPermissionOpen(true)} icon={<Info className="h-3 w-3" />}>
                How this works
              </Button>
            </div>
          </section>

          <section className="surface-flat p-4">
            <h2 className="flex items-center gap-1.5 text-[11px] font-semibold text-fg">
              <Info className="h-3 w-3 text-butter" aria-hidden /> What to expect
            </h2>
            <ul className="mt-2 space-y-1.5 text-[10.5px] leading-relaxed text-muted">
              <li>• Open tab: the alarm rings and the overlay appears.</li>
              <li>• Background or minimised: timing is checked on every tick, so it rings as soon as the browser is allowed to run — usually within seconds.</li>
              <li>• Browser closed: nothing can ring. Missed reminders are shown as <span className="text-butter">Missed</span> when you return.</li>
              <li>• Phone battery optimisers can suspend background tabs. For critical alerts, keep LunaDesk installed as an app and open.</li>
            </ul>
          </section>
        </aside>
      </div>

      <ReminderDrawer
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        reminder={editing}
        tasks={tasks}
        ownerId={profile?.id ?? ''}
        onSaved={() => {
          refresh();
          invalidate();
        }}
      />

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={remove}
        busy={busy}
        title="Delete this reminder?"
        confirmLabel="Delete reminder"
        body={<><strong className="text-fg">{confirmDelete?.title}</strong> will be removed. Its history entry goes with it.</>}
      />

      <Modal
        open={permissionOpen}
        onClose={() => setPermissionOpen(false)}
        title="Reminder notifications & alarm sounds"
        size="md"
        footer={
          <>
            <Button variant="quiet" onClick={() => setPermissionOpen(false)}>
              Not now
            </Button>
            {permission !== 'granted' && permission !== 'unsupported' && (
              <Button variant="primary" onClick={() => void enableNotifications()}>
                Allow notifications
              </Button>
            )}
          </>
        }
      >
        <div className="flex gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-magenta/15 text-magenta">
            <BellRing className="h-4 w-4" aria-hidden />
          </span>
          <div className="text-sm leading-relaxed text-muted">
            <p>
              Allow reminder notifications and alarm sounds for a better productivity experience. Enable notifications and
              sounds so LunaDesk can alert you about important tasks, deadlines, and scheduled reminders.
            </p>
            <ul className="mt-3 space-y-1.5 text-xs">
              <li className="flex items-start gap-2">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky" aria-hidden />
                Notifications arrive while LunaDesk is open in any tab.
              </li>
              <li className="flex items-start gap-2">
                <AlarmClock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-butter" aria-hidden />
                The alarm is a sound plus a full-screen overlay, so it works with audio muted.
              </li>
              <li className="flex items-start gap-2">
                <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-magenta" aria-hidden />
                A closed browser cannot ring. We will never claim otherwise.
              </li>
            </ul>
            {permission === 'denied' && (
              <p className="mt-3 rounded-lg border border-butter/25 bg-butter/[0.06] px-2.5 py-2 text-[11px] text-accent-butter">
                Notifications are currently blocked. Open your browser’s site settings, find LunaDesk, and set
                Notifications to “Allow”. LunaDesk will not ask again automatically.
              </p>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}

function ReminderDrawer({
  open,
  onClose,
  reminder,
  tasks,
  ownerId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  reminder: Reminder | null;
  tasks: Task[];
  ownerId: string;
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
  } = useForm<ReminderForm>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (!open) return;
    reset({
      title: reminder?.title ?? '',
      description: reminder?.description ?? '',
      remind_at: reminder ? toLocalInput(reminder.remind_at) : defaultWhen(),
      repeat: reminder?.repeat ?? 'none',
      alarm_enabled: reminder?.alarm_enabled ?? true,
      task_id: reminder?.task_id ?? '',
    });
  }, [open, reminder, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setBusy(true);
    try {
      const payload = {
        title: values.title.trim(),
        description: values.description?.trim() || null,
        remind_at: new Date(values.remind_at).toISOString(),
        repeat: values.repeat as ReminderRepeat,
        alarm_enabled: values.alarm_enabled,
        task_id: values.task_id || null,
        snoozed_until: null,
        fired_at: null,
        is_dismissed: false,
        dismissed_at: null,
      };
      if (reminder) {
        await adapter.update<Reminder>('reminders', reminder.id, payload);
        toast.success('Reminder updated');
      } else {
        await adapter.insert('reminders', { id: uuid(), owner_id: ownerId, ...payload });
        toast.success('Reminder set', `It will ring ${fmtRelative(payload.remind_at)}.`);
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error('Could not save the reminder', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={reminder ? 'Edit reminder' : 'New reminder'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void onSubmit()} loading={busy}>
            {reminder ? 'Save changes' : 'Set reminder'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Title" error={errors.title?.message} required>
          {(id) => <TextInput id={id} {...register('title')} placeholder="e.g. Send Prism the monthly report" autoFocus />}
        </Field>
        <Field label="Details" error={errors.description?.message}>
          {(id) => <TextArea id={id} {...register('description')} placeholder="Anything you need at the moment it rings." />}
        </Field>
        <Field label="Date & time" error={errors.remind_at?.message} required hint="Uses your device timezone.">
          {(id) => <TextInput id={id} type="datetime-local" {...register('remind_at')} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Repeat" error={errors.repeat?.message}>
            {(id) => (
              <Select id={id} {...register('repeat')}>
                <option value="none">Once</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </Select>
            )}
          </Field>
          <Field label="Link to task">
            {(id) => (
              <Select id={id} {...register('task_id')}>
                <option value="">No task</option>
                {tasks
                  .filter((t) => t.status !== 'archived')
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        </div>
        <label className="flex items-start gap-2.5 rounded-xl border p-3" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
          <input type="checkbox" {...register('alarm_enabled')} className="mt-0.5 h-4 w-4 rounded accent-[#FF2D95]" />
          <span>
            <span className="block text-[12.5px] font-medium text-fg">Ring with an alarm</span>
            <span className="mt-0.5 block text-[11px] text-muted">
              Plays the alarm sound and shows a full-screen alert until dismissed or snoozed.
            </span>
          </span>
        </label>
      </form>
    </Drawer>
  );
}
