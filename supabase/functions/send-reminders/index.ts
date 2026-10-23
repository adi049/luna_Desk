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
// Delivery is claimed before it is attempted (rpc_claim_reminder). The
// (reminder_id, occurrence) unique key is the mutex, so overlapping scheduler
// runs — or a rerun after a partial failure — cannot push the same occurrence
// twice. A claim that fails to deliver is recorded, not retried silently.
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

const WORKER = `scheduler:${crypto.randomUUID().slice(0, 8)}`;

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

  // Compared as presented, so an empty configured secret never matches.
  const authorised =
    (secret.length > 0 && presented === secret) ||
    (serviceKey.length > 0 && bearer === serviceKey);
  if (!authorised) {
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

  // Only rows that have not already been delivered. One-time reminders carry
  // fired_at after delivery, so they drop out permanently instead of being
  // re-selected on every run (the previous duplicate-delivery bug).
  const { data: due, error } = await supabase
    .from('reminders')
    .select('id, owner_id, title, description, remind_at, snoozed_until, repeat, repeat_until, alarm_enabled')
    .eq('is_dismissed', false)
    .is('fired_at', null)
    .lte('remind_at', horizon)
    .order('remind_at', { ascending: true })
    .limit(200);

  if (error) {
    console.error('reminder scan failed', error.message);
    return json({ ok: false, error: 'scan_failed' }, 500, origin);
  }

  let notified = 0;
  let pushed = 0;
  let skipped = 0;
  let failed = 0;

  for (const reminder of (due ?? []) as Reminder[]) {
    const occurrence = reminder.snoozed_until ?? reminder.remind_at;

    // A snooze pushes the occurrence into the future; leave it for later.
    if (new Date(occurrence) > new Date(horizon)) {
      skipped += 1;
      continue;
    }

    // Claim first. If another run already owns this occurrence, do nothing.
    const { data: claimed, error: claimError } = await supabase.rpc('rpc_claim_reminder', {
      p_reminder_id: reminder.id,
      p_occurrence: occurrence,
      p_worker: WORKER,
    });

    if (claimError) {
      console.error('claim failed', reminder.id, claimError.message);
      failed += 1;
      continue;
    }
    if (claimed !== true) {
      skipped += 1;
      continue;
    }

    // Respect the user's preference: no preference row is treated as the
    // conservative default (in-app only, no system notification).
    const { data: prefs } = await supabase
      .from('notification_preferences')
      .select('browser_notifications, timezone')
      .eq('user_id', reminder.owner_id)
      .maybeSingle();

    const { error: insertError } = await supabase.from('notifications').insert({
      user_id: reminder.owner_id,
      kind: 'reminder',
      title: reminder.title,
      body: reminder.description ?? 'Scheduled reminder',
      link: '/reminders',
      dedupe_key: `reminder:${reminder.id}:${occurrence}`,
    });

    // 23505 means the occurrence was already recorded (a previous partial run);
    // the claim still owns delivery, so pushing once more is safe but pointless.
    const alreadyRecorded = insertError?.code === '23505';
    if (insertError && !alreadyRecorded) {
      console.error('notification insert failed', insertError.message);
      await supabase.rpc('rpc_mark_reminder_delivery', {
        p_reminder_id: reminder.id,
        p_occurrence: occurrence,
        p_delivered: false,
        p_error: `notification insert: ${insertError.message}`,
      });
      failed += 1;
      continue;
    }
    if (!insertError) notified += 1;

    let pushError: string | null = null;

    if (pushEnabled && prefs?.browser_notifications !== false && !alreadyRecorded) {
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
              tag: `reminder:${reminder.id}:${occurrence}`,
              url: '/#/reminders',
              requireInteraction: true,
            }),
          );
          pushed += 1;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // The endpoint is gone (uninstalled, permission reset, expired).
            await supabase.from('push_subscriptions').delete().eq('id', sub.id);
          } else {
            pushError = `push ${status ?? 'error'}: ${(err as Error).message}`;
            console.error('push failed', status, (err as Error).message);
          }
        }
      }
    }

    // Persist the new state only after the claim is owned, so a crash between
    // claim and update leaves a claim row rather than a silent re-send.
    if (reminder.repeat === 'none') {
      await supabase
        .from('reminders')
        .update({ fired_at: now.toISOString(), snoozed_until: null })
        .eq('id', reminder.id);
    } else {
      // Advance past "now" in one step: after downtime we notify once for the
      // backlog instead of replaying every missed occurrence.
      let next = nextOccurrence(reminder.remind_at, reminder.repeat, prefs?.timezone ?? 'Asia/Kolkata');
      let guard = 0;
      while (next.getTime() <= now.getTime() && guard < 400) {
        next = nextOccurrence(next.toISOString(), reminder.repeat, prefs?.timezone ?? 'Asia/Kolkata');
        guard += 1;
      }

      const expired = reminder.repeat_until && next.toISOString().slice(0, 10) > reminder.repeat_until;

      await supabase
        .from('reminders')
        .update(
          expired
            // Series finished: terminal state, same as a one-time reminder.
            ? { fired_at: now.toISOString(), snoozed_until: null }
            // Next occurrence is pending, so clear fired_at (it means "this
            // occurrence was delivered", not "this reminder is finished").
            : { remind_at: next.toISOString(), fired_at: null, snoozed_until: null },
        )
        .eq('id', reminder.id);
    }

    await supabase.rpc('rpc_mark_reminder_delivery', {
      p_reminder_id: reminder.id,
      p_occurrence: occurrence,
      p_delivered: pushError === null,
      p_error: pushError,
    });
    if (pushError) failed += 1;
  }

  return json(
    {
      ok: true,
      checked: due?.length ?? 0,
      notified,
      pushed,
      skipped,
      failed,
      push_enabled: pushEnabled,
      worker: WORKER,
    },
    200,
    origin,
  );
});
