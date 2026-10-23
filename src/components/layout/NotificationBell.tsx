import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import { useAuth } from '@/context/auth';
import { useCollection, useData } from '@/context/app';
import { fmtRelative } from '@/lib/dates';
import type { AppNotification, NotificationPreferences } from '@/lib/types';
import { cn } from '@/lib/utils';

const kindTone: Record<AppNotification['kind'], string> = {
  deadline: 'bg-butter',
  overdue_task: 'bg-magenta',
  reminder: 'bg-butter',
  payment: 'bg-mint',
  account: 'bg-sky',
  announcement: 'bg-sky',
};

export function NotificationBell({ prefs }: { prefs?: NotificationPreferences }) {
  const { isAdmin } = useAuth();
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const { data } = useCollection<AppNotification>('notifications');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const unread = useMemo(() => data.filter((n) => !n.read_at), [data]);
  const preview = useMemo(() => data.slice(0, 6), [data]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const markAllRead = async () => {
    const now = new Date().toISOString();
    await Promise.all(
      unread.map((n) => adapter.update<AppNotification>('notifications', n.id, { read_at: now }).catch(() => null)),
    );
    invalidate();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-lg p-2 text-muted transition hover:bg-raised hover:text-fg"
        aria-label={unread.length ? `Notifications, ${unread.length} unread` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Bell className="h-4 w-4" aria-hidden />
        {unread.length > 0 && (
          <span className="absolute right-1.5 top-1.5 flex h-[7px] w-[7px]">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-magenta opacity-70" aria-hidden />
            <span className="relative inline-flex h-[7px] w-[7px] rounded-full bg-magenta" aria-hidden />
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Notifications"
            initial={{ opacity: 0, y: -6, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.99 }}
            transition={{ duration: 0.16 }}
            className="surface absolute right-0 top-11 z-50 w-[min(92vw,22rem)] overflow-hidden p-0 no-print"
          >
            <div className="flex items-center justify-between border-b px-3.5 py-2.5">
              <p className="text-xs font-semibold text-fg">
                Notifications
                {unread.length > 0 && <span className="ml-1.5 text-faint">({unread.length} new)</span>}
              </p>
              {unread.length > 0 && (
                <button
                  type="button"
                  onClick={() => void markAllRead()}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted transition hover:bg-raised hover:text-fg"
                >
                  <CheckCheck className="h-3 w-3" aria-hidden /> Mark all read
                </button>
              )}
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {preview.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                  <BellOff className="h-5 w-5 text-faint" aria-hidden />
                  <p className="text-xs text-muted">Nothing yet. Updates about payments, deadlines and reminders appear here.</p>
                </div>
              ) : (
                <ul>
                  {preview.map((n) => (
                    <li key={n.id}>
                      <Link
                        to={n.link ?? (isAdmin ? '/admin/notifications' : '/portal')}
                        onClick={async () => {
                          setOpen(false);
                          if (!n.read_at) {
                            await adapter.update('notifications', n.id, { read_at: new Date().toISOString() }).catch(() => null);
                            invalidate();
                          }
                        }}
                        className={cn(
                          'flex gap-2.5 border-b px-3.5 py-2.5 transition last:border-b-0 hover:bg-raised/60',
                          !n.read_at && 'bg-[rgb(var(--line)/0.04)]',
                        )}
                      >
                        <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', kindTone[n.kind] ?? 'bg-silver')} aria-hidden />
                        <span className="min-w-0">
                          <span className="block truncate text-[12.5px] font-medium text-fg">{n.title}</span>
                          {n.body && <span className="mt-0.5 block truncate text-[11px] text-muted">{n.body}</span>}
                          <span className="mt-0.5 block text-[10px] text-faint">{fmtRelative(n.created_at)}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="border-t px-3.5 py-2">
              <Link
                to={isAdmin ? '/admin/notifications' : '/portal'}
                onClick={() => setOpen(false)}
                className="text-[11px] font-medium text-magenta hover:underline"
              >
                View notification centre
              </Link>
              {prefs && !prefs.browser_notifications && (
                <p className="mt-1 text-[10px] text-faint">Browser notifications are off. Enable them in Settings.</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
