import { useCallback, useEffect, useRef, useState } from 'react';
import { useCollection, useData, useToast } from '@/context/app';
import { useAuth } from '@/context/auth';
import { alarmPlayer, type AlarmTone } from '@/lib/alarm';
import { showNotification } from '@/lib/notifications';
import { effectiveTime, isRinging, nextOccurrence } from '@/lib/reminders';
import { uuid } from '@/lib/utils';
import type { NotificationPreferences, Reminder } from '@/lib/types';
import { AlarmOverlay } from './AlarmOverlay';

const POLL_MS = 10_000;

/**
 * Watches the signed-in user's reminders while the app is open.
 *
 * Honest scope: this fires only while a tab is alive (foreground, background or
 * minimised — browsers throttle timers, which is why we compare timestamps on
 * every tick instead of counting down). Closed-browser delivery needs the
 * service worker + server-side push path described in the README, which is not
 * simulated here and is never claimed to work.
 */
export function ReminderWatcher({ prefs }: { prefs?: NotificationPreferences }) {
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const { profile } = useAuth();
  const toast = useToast();
  const { data: reminders, refresh } = useCollection<Reminder>('reminders');
  const [active, setActive] = useState<Reminder[]>([]);
  const [soundPlaying, setSoundPlaying] = useState(false);
  const handled = useRef<Set<string>>(new Set());

  const soundEnabled = prefs?.alarm_sound ?? true;
  const volume = prefs?.alarm_volume ?? 0.6;
  const tone = (prefs?.alarm_sound_name as AlarmTone) ?? 'pulse';
  const browserNotifs = prefs?.browser_notifications ?? false;

  const fire = useCallback(
    async (reminder: Reminder) => {
      if (handled.current.has(reminder.id)) return;
      handled.current.add(reminder.id);
      setActive((prev) => [...prev, reminder]);

      if (reminder.alarm_enabled && soundEnabled) {
        try {
          await alarmPlayer.start(tone, volume);
          setSoundPlaying(true);
        } catch {
          setSoundPlaying(false);
        }
      }

      if (browserNotifs) {
        showNotification(reminder.title, {
          body: reminder.description ?? 'LunaDesk reminder',
          tag: `reminder-${reminder.id}`,
          requireInteraction: true,
        });
      }

      // Persist the firing so a re-render or a reload cannot re-alarm the
      // same occurrence, and record one durable notification per occurrence.
      try {
        await adapter.update<Reminder>('reminders', reminder.id, { fired_at: new Date().toISOString() });
        const existing = await adapter.list<{ id: string }>('notifications', {
          where: { user_id: profile?.id ?? '', dedupe_key: `reminder:${reminder.id}:${reminder.remind_at}` },
          limit: 1,
        });
        if (!existing.length && profile) {
          await adapter.insert('notifications', {
            id: uuid(),
            user_id: profile.id,
            kind: 'reminder',
            title: reminder.title,
            body: reminder.description,
            link: '/admin/reminders',
            dedupe_key: `reminder:${reminder.id}:${reminder.remind_at}`,
          });
        }
        invalidate();
      } catch {
        /* Keep the alarm visible even if persistence fails. */
      }
    },
    [adapter, browserNotifs, invalidate, profile, soundEnabled, tone, volume],
  );

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      for (const r of reminders) {
        if (isRinging(r, now)) void fire(r);
      }
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reminders, fire]);

  useEffect(() => {
    if (soundEnabled) alarmPlayer.setVolume(volume);
  }, [soundEnabled, volume]);

  const stopSound = () => {
    alarmPlayer.stop();
    setSoundPlaying(false);
  };

  const dismiss = async (reminder: Reminder) => {
    stopSound();
    setActive((prev) => prev.filter((r) => r.id !== reminder.id));
    try {
      if (reminder.repeat !== 'none') {
        const next = nextOccurrence(new Date(effectiveTime(reminder)), reminder.repeat);
        await adapter.update<Reminder>('reminders', reminder.id, {
          remind_at: next.toISOString(),
          fired_at: null,
          snoozed_until: null,
          is_dismissed: false,
        });
      } else {
        await adapter.update<Reminder>('reminders', reminder.id, {
          is_dismissed: true,
          dismissed_at: new Date().toISOString(),
          snoozed_until: null,
        });
      }
      toast.success('Reminder dismissed', reminder.title);
    } catch {
      toast.error('Could not update the reminder', 'It will appear again until the change is saved.');
    }
    handled.current.delete(reminder.id);
    refresh();
    invalidate();
  };

  const snooze = async (reminder: Reminder, minutes: number) => {
    stopSound();
    setActive((prev) => prev.filter((r) => r.id !== reminder.id));
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    try {
      await adapter.update<Reminder>('reminders', reminder.id, { snoozed_until: until, fired_at: null });
      toast.info(`Snoozed for ${minutes} minutes`, reminder.title);
    } catch {
      toast.error('Could not snooze the reminder');
    }
    handled.current.delete(reminder.id);
    refresh();
    invalidate();
  };

  const current = active[0] ?? null;

  return (
    <AlarmOverlay
      reminder={current}
      soundPlaying={soundPlaying && Boolean(current?.alarm_enabled)}
      onStopSound={stopSound}
      onSnooze={(m) => current && void snooze(current, m)}
      onDismiss={() => current && void dismiss(current)}
    />
  );
}
