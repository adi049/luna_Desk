// =============================================================================
// POST /functions/v1/send-reminders        (invoked by a scheduler, not a user)
//
// Honestly scoped: Web Push can wake a service worker after the tab is closed,
// but **nothing in the browser can guarantee a loud alarm**, and delivery is
// best-effort — a device that is offline, has notifications muted, or whose
// browser killed the push service will not ring. The in-app reminder list and
// notification centre are the source of truth; this job only improves
// punctuality.
//
// What the job does, once per minute:
//   1. finds reminders whose next occurrence is due (or was missed),
//   2. writes a durable notification row (deduped per occurrence),
//   3. pushes to every stored subscription for that user,
//   4. advances repeating reminders to their next occurrence.
//
// Auth: a scheduler must present `x-cron-secret: $CRON_SECRET` (or the
// service-role key as a bearer token). It is never callable by a browser.
// =============================================================================

import { json, preflight } from '../_shared/http.ts';
import { serviceClient } from '../_shared/supabase.ts';
import webpush from 'npm:web-push@3.6.7';

interface Reminder {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  remind_at: string;
  snoozed_until: string | null;
  repeat: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  repeat_until: string | null;
  alarm_enabled: boolean;
}

/** Add one repeat interval in the user's timezone, so DST does not drift. */
const nextOccurrence = (iso: string, repeat: Reminder['repeat'], timeZone: string): Date => {
  const base = new Date(iso);
  if (repeat === 'none') return base;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(base);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')));

  if (repeat === 'daily') wall.setUTCDate(wall.getUTCDate() + 1);
  if (repeat === 'weekly') wall.setUTCDate(wall.getUTCDate() + 7);
  if (repeat === 'monthly') wall.setUTCMonth(wall.getUTCMonth() + 1);
  if (repeat === 'yearly') wall.setUTCFullYear(wall.getUTCFullYear() + 1);

  // Re-express the wall clock in the user's zone.
  const offsetMinutes = (date: Date, zone: string) => {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const p = dtf.formatToParts(date);
    const num = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
    const asUTC = Date.UTC(num('year'), num('month') - 1, num('day'), num('hour'), num('minute'), num('second'));
    return (asUTC - date.getTime()) / 60000;
  };

  const guess = new Date(wall.getTime() - offsetMinutes(base, timeZone) * 60000);
  return new Date(wall.getTime() - offsetMinutes(guess, timeZone) * 60000);
};

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return preflight(origin);
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);

  const secret = Deno.env.get('CRON_SECRET') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const presented = req.headers.get('x-cron-secret') ?? '';
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!(secret && presented === secret) && !(serviceKey && bearer === serviceKey)) {
    return json({ ok: false, error: 'forbidden' }, 403, origin);
  }

  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY');
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY');
  const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:hello@managedbyluna.com';
  const pushEnabled = Boolean(vapidPublic && vapidPrivate);
  if (pushEnabled) {
    webpush.setVapidDetails(vapidSubject, vapidPublic!, vapidPrivate!);
  }

  const supabase = serviceClient();
  const now = new Date();
  const horizon = new Date(now.getTime() + 60_000).toISOString();

  const { data: due, error } = await supabase
    .from('reminders')
    .select('id, owner_id, title, description, remind_at, snoozed_until, repeat, repeat_until, alarm_enabled')
    .eq('is_dismissed', false)
    .lte('remind_at', horizon)
    .order('remind_at', { ascending: true })
    .limit(200);

  if (error) {
    console.error('reminder scan failed', error.message);
    return json({ ok: false, error: 'scan_failed' }, 500, origin);
  }

  let notified = 0;
  let pushed = 0;

  for (const reminder of (due ?? []) as Reminder[]) {
    const occurrence = reminder.snoozed_until ?? reminder.remind_at;
    if (new Date(occurrence) > new Date(horizon)) continue;

    const dedupeKey = `reminder:${reminder.id}:${occurrence}`;
    const { error: insertError } = await supabase.from('notifications').insert({
      user_id: reminder.owner_id,
      kind: 'reminder',
      title: reminder.title,
      body: reminder.description ?? 'Scheduled reminder',
      link: '/reminders',
      dedupe_key: dedupeKey,
    });

    // 23505 = the occurrence was already notified (another tab, earlier run).
    if (insertError && insertError.code !== '23505') {
      console.error('notification insert failed', insertError.message);
      continue;
    }
    if (!insertError) notified += 1;

    if (pushEnabled) {
      const { data: subs } = await supabase
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth')
        .eq('user_id', reminder.owner_id);

      for (const sub of subs ?? []) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify({
              title: reminder.title,
              body: reminder.description ?? 'LunaDesk reminder',
              tag: dedupeKey,
              url: '/#/reminders',
              requireInteraction: true,
            }),
          );
          pushed += 1;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await supabase.from('push_subscriptions').delete().eq('id', sub.id);
          } else {
            console.error('push failed', status, (err as Error).message);
          }
        }
      }
    }

    if (reminder.repeat === 'none') {
      await supabase.from('reminders').update({ fired_at: now.toISOString(), snoozed_until: null }).eq('id', reminder.id);
    } else {
      const { data: profile } = await supabase
        .from('profiles')
        .select('timezone')
        .eq('id', reminder.owner_id)
        .maybeSingle();

      const next = nextOccurrence(reminder.remind_at, reminder.repeat, profile?.timezone ?? 'Asia/Kolkata');
      const expired = reminder.repeat_until && next.toISOString().slice(0, 10) > reminder.repeat_until;

      await supabase
        .from('reminders')
        .update(
          expired
            ? { fired_at: now.toISOString(), snoozed_until: null }
            : { remind_at: next.toISOString(), fired_at: now.toISOString(), snoozed_until: null },
        )
        .eq('id', reminder.id);
    }
  }

  return json({ ok: true, checked: due?.length ?? 0, notified, pushed, push_enabled: pushEnabled }, 200, origin);
});
