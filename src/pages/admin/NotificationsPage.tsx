import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BellOff, BellRing, CheckCheck, RefreshCw, Trash2 } from 'lucide-react';
import { Badge, Button, EmptyState, PageHeader, Segmented, SkeletonRows, Toolbar } from '@/components/ui';
import { useCollection, useData, useToast } from '@/context/app';
import { useAuth } from '@/context/auth';
import { fmtDateTime, fmtRelative, todayISO } from '@/lib/dates';
import type { AppNotification, Client, Project, Reminder, Task } from '@/lib/types';
import { uuid } from '@/lib/utils';

const kindMeta: Record<AppNotification['kind'], { label: string; tone: 'magenta' | 'butter' | 'mint' | 'sky' | 'muted' }> = {
  deadline: { label: 'Deadline', tone: 'butter' },
  overdue_task: { label: 'Task overdue', tone: 'magenta' },
  reminder: { label: 'Reminder', tone: 'butter' },
  payment: { label: 'Payment', tone: 'mint' },
  account: { label: 'Account', tone: 'sky' },
  announcement: { label: 'Announcement', tone: 'sky' },
};

export default function NotificationsPage() {
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const { profile, isAdmin } = useAuth();
  const toast = useToast();

  const { data: notifications, loading, refresh } = useCollection<AppNotification>('notifications');
  const { data: projects } = useCollection<Project>('projects');
  const { data: tasks } = useCollection<Task>('tasks');
  const { data: reminders } = useCollection<Reminder>('reminders');
  const { data: clients } = useCollection<Client>('clients', {}, Boolean(isAdmin));

  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [scanning, setScanning] = useState(false);

  const unread = notifications.filter((n) => !n.read_at);
  const listed = useMemo(
    () => (filter === 'unread' ? unread : notifications).slice().sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [notifications, unread, filter],
  );

  const markRead = async (n: AppNotification) => {
    if (n.read_at) return;
    await adapter.update('notifications', n.id, { read_at: new Date().toISOString() });
    refresh();
    invalidate();
  };

  const markAll = async () => {
    await Promise.all(
      unread.map((n) => adapter.update('notifications', n.id, { read_at: new Date().toISOString() }).catch(() => null)),
    );
    toast.success('All notifications marked read');
    refresh();
    invalidate();
  };

  const remove = async (n: AppNotification) => {
    await adapter.remove('notifications', n.id);
    refresh();
    invalidate();
  };

  /**
   * Durable alerts are created once per real event, keyed by a dedupe_key so a
   * re-render (or repeated scans) can never duplicate them. This is the only
   * place deadline/overdue notifications are created — never during render.
   */
  const scanForAlerts = async () => {
    if (!profile || !isAdmin) return;
    setScanning(true);
    const today = todayISO();
    const candidates: { kind: AppNotification['kind']; title: string; body: string; link: string; key: string }[] = [];

    for (const project of projects) {
      if (!project.due_date || ['completed', 'cancelled'].includes(project.status)) continue;
      const days = Math.round((new Date(project.due_date).getTime() - new Date(today).getTime()) / 86400000);
      if (days >= 0 && days <= 7) {
        candidates.push({
          kind: 'deadline',
          title: days === 0 ? `Deadline today — ${project.name}` : `Deadline in ${days} ${days === 1 ? 'day' : 'days'} — ${project.name}`,
          body: clients.find((c) => c.id === project.client_id)?.name ?? 'Internal project',
          link: `/admin/projects/${project.id}`,
          key: `deadline:${project.id}:${project.due_date}`,
        });
      }
    }
    for (const task of tasks) {
      if (!task.due_date || task.status === 'completed' || task.status === 'archived') continue;
      if (task.due_date < today) {
        candidates.push({
          kind: 'overdue_task',
          title: `Task overdue — ${task.title}`,
          body: `Was due ${task.due_date}`,
          link: '/admin/tasks',
          key: `overdue:${task.id}:${task.due_date}`,
        });
      }
    }
    for (const reminder of reminders) {
      if (reminder.is_dismissed) continue;
      const due = new Date(reminder.snoozed_until ?? reminder.remind_at);
      if (due.getTime() < Date.now() - 10 * 60_000) {
        candidates.push({
          kind: 'reminder',
          title: `Missed reminder — ${reminder.title}`,
          body: fmtDateTime(reminder.remind_at),
          link: '/admin/reminders',
          key: `missed:${reminder.id}:${reminder.remind_at}`,
        });
      }
    }

    const existing = new Set(notifications.map((n) => n.dedupe_key).filter(Boolean) as string[]);
    const fresh = candidates.filter((c) => !existing.has(c.key));

    try {
      await Promise.all(
        fresh.map((c) =>
          adapter.insert('notifications', {
            id: uuid(),
            user_id: profile.id,
            kind: c.kind,
            title: c.title,
            body: c.body,
            link: c.link,
            dedupe_key: c.key,
          }),
        ),
      );
      toast.success(fresh.length ? `${fresh.length} new alerts created` : 'Everything is already up to date', fresh.length ? 'Duplicates were skipped using dedupe keys.' : undefined);
      refresh();
      invalidate();
    } catch (err) {
      toast.error('Could not create alerts', err instanceof Error ? err.message : undefined);
    } finally {
      setScanning(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="System"
        title="Notifications"
        description="Durable, database-backed alerts. Each real event produces exactly one notification — never one per render."
        actions={
          <>
            <Button variant="ghost" onClick={() => void markAll()} disabled={unread.length === 0} icon={<CheckCheck className="h-4 w-4" />}>
              Mark all read
            </Button>
            {isAdmin && (
              <Button variant="primary" onClick={() => void scanForAlerts()} loading={scanning} icon={<RefreshCw className="h-4 w-4" />}>
                Scan for due alerts
              </Button>
            )}
          </>
        }
      />

      <Toolbar>
        <Segmented
          size="sm"
          ariaLabel="Notification filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: notifications.length },
            { value: 'unread', label: 'Unread', count: unread.length },
          ]}
        />
        <span className="ml-auto text-[11px] text-faint">Browser notifications are configured in Settings</span>
      </Toolbar>

      {loading ? (
        <SkeletonRows rows={5} />
      ) : listed.length === 0 ? (
        <EmptyState
          icon={<BellOff className="h-6 w-6" />}
          title={filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
          description="Payment events, deadline warnings and due reminders land here. Run a scan to pick up anything already due."
        />
      ) : (
        <ul className="space-y-1.5">
          {listed.map((n) => {
            const meta = kindMeta[n.kind] ?? kindMeta.account;
            return (
              <li
                key={n.id}
                className={`surface flex flex-wrap items-start gap-3 p-3.5 ${!n.read_at ? 'border-l-2 border-l-magenta' : ''}`}
              >
                <Badge tone={meta.tone}>{meta.label}</Badge>
                <div className="min-w-0 flex-1">
                  <p className={`text-[12.5px] ${n.read_at ? 'text-muted' : 'font-medium text-fg'}`}>{n.title}</p>
                  {n.body && <p className="mt-0.5 text-[11px] text-muted">{n.body}</p>}
                  <p className="mt-1 text-[10px] text-faint">
                    {fmtDateTime(n.created_at)} · {fmtRelative(n.created_at)}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {n.link && (
                    <Link to={n.link} onClick={() => void markRead(n)} className="rounded-md px-2 py-1 text-[11px] text-magenta hover:underline">
                      Open
                    </Link>
                  )}
                  {!n.read_at && (
                    <Button size="sm" variant="quiet" onClick={() => void markRead(n)} aria-label="Mark read" icon={<BellRing className="h-3 w-3" />} />
                  )}
                  <Button size="sm" variant="quiet" onClick={() => void remove(n)} aria-label="Delete notification" icon={<Trash2 className="h-3 w-3" />} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
