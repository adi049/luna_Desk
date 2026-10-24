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
// twice. The claim is a lease rather than a permanent lock: a worker that dies
// mid-delivery hands the occurrence back for retry once the lease expires, and
// the number of attempts is capped so a permanently failing occurrence is
// abandoned with a visible reason instead of retried forever.
//
// The claim also issues a fencing token. A worker whose lease lapsed and was
// taken over by another run cannot report its outcome any more: the completion
// RPC rejects the stale token and writes nothing, so a resurrected worker can
// neither mark a live attempt delivered nor move the schedule.
//
// A failed push is a retryable failure, not a delivery. Completion and
// schedule advancement are one transaction (rpc_complete_reminder_delivery),
// and the reminder is only advanced when delivery actually succeeded. Retries
// re-use the existing in-app notification — the unique dedupe_key makes that
// insert a no-op — and then re-attempt the push, so "notification already
// exists" never means "push can be skipped".
// =============================================================================

import { json, preflight } from '../_shared/http.ts';
import { serviceClient } from '../_shared/supabase.ts';
import webpush from 'npm:web-push@3.6.7';

/** One row of rpc_due_reminders(). `occurrence` is already resolved in SQL. */
interface Reminder {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  remind_at: string;
  occurrence: string;
  repeat: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  repeat_until: string | null;
  alarm_enabled: boolean;
  snoozed_until: string | null;
  browser_notifications: boolean;
  user_timezone: string;
}

interface CompletionResult {
  ok: boolean;
  reason?: string;
  advanced?: boolean;
  finished?: boolean;
  next_occurrence?: string | null;
}

const WORKER = `scheduler:${crypto.randomUUID().slice(0, 8)}`;

/** How long a claim holds before another run may retry the occurrence. */
const LEASE_SECONDS = 300;
/** Total delivery attempts before an occurrence is abandoned. */
const MAX_ATTEMPTS = 5;
/** Rows fetched per run. Ordering is by occurrence, so this is a fair cut. */
const SCAN_LIMIT = 200;

interface ClaimResult {
  claimed: boolean;
  attempt: number;
  reason: string;
  token: string | null;
}

/**
 * rpc_claim_reminder returns jsonb. A boolean return value is still accepted so
 * that an older deployed function version cannot be read as a truthy object and
 * double-send.
 */
function normaliseClaim(data: unknown): ClaimResult {
  // A bare boolean is only ever returned by a pre-0011 deployment. It carries
  // no fencing token, and without a token the completion call cannot be made,
  // so treat it as "not claimed" rather than delivering without a lease.
  if (typeof data === 'boolean') {
    return { claimed: false, attempt: 1, reason: 'legacy_claim_without_token', token: null };
  }
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    return {
      claimed: record.claimed === true,
      attempt: typeof record.attempt === 'number' ? record.attempt : 1,
      reason: typeof record.reason === 'string' ? record.reason : 'unknown',
      token: typeof record.token === 'string' ? record.token : null,
    };
  }
  return { claimed: false, attempt: 1, reason: 'unknown', token: null };
}

/** Linear backoff: 60s, 120s, 180s … so a flapping device is not hammered. */
function retryAfterFor(attempt: number): number {
  return Math.max(60, 60 * Math.max(1, attempt));
}

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

  /**
   * Report the outcome of a claimed attempt.
   *
   * Completion and schedule advancement happen in ONE transaction inside
   * rpc_complete_reminder_delivery, fenced on the claim token. The Edge Function
   * never writes to `reminders` itself: doing so previously advanced a reminder
   * before the push result was known, which made a failed occurrence
   * unselectable and therefore impossible to retry.
   */
  const complete = async (
    reminder: Reminder,
    claim: ClaimResult,
    pushOk: boolean,
    error: string | null,
  ): Promise<CompletionResult | null> => {
    const { data, error: rpcError } = await supabase.rpc('rpc_complete_reminder_delivery', {
      p_reminder_id: reminder.id,
      p_occurrence: reminder.occurrence,
      p_token: claim.token,
      p_push_ok: pushOk,
      p_error: error,
      p_retry_after_seconds: pushOk ? 0 : retryAfterFor(claim.attempt),
    });

    if (rpcError) {
      console.error('completion failed', reminder.id, rpcError.message);
      return null;
    }

    const result = (data ?? {}) as CompletionResult;
    if (result.ok === false) {
      // stale_claim: another worker owns this occurrence now. Nothing to do —
      // and deliberately nothing written.
      console.warn('completion refused', reminder.id, result.reason);
    }
    return result;
  };

  // Due selection happens in SQL, on the *effective* occurrence
  // (coalesce(snoozed_until, remind_at)). Selecting on remind_at and then
  // discarding future snoozes in TypeScript meant those rows still consumed
  // the row limit, so a pile of snoozed reminders could hide the ones that
  // were genuinely due. The RPC also joins the user's preference row and
  // timezone, so one round trip answers everything the loop needs.
  const { data: dueRows, error } = await supabase.rpc('rpc_due_reminders', {
    p_horizon: horizon,
    p_limit: SCAN_LIMIT,
  });

  if (error) {
    console.error('reminder scan failed', error.message);
    return json({ ok: false, error: 'scan_failed' }, 500, origin);
  }

  const due = (dueRows ?? []) as Reminder[];

  let notified = 0;
  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  let retried = 0;

  for (const reminder of due) {
    const occurrence = reminder.occurrence;

    // Claim first. The claim is a time-bounded lease with a fencing token: if
    // this worker dies mid-delivery the occurrence becomes claimable again
    // after LEASE_SECONDS, and the dead worker can no longer write its outcome
    // over the live attempt.
    const { data: claimData, error: claimError } = await supabase.rpc('rpc_claim_reminder', {
      p_reminder_id: reminder.id,
      p_occurrence: occurrence,
      p_worker: WORKER,
      p_lease_seconds: LEASE_SECONDS,
      p_max_attempts: MAX_ATTEMPTS,
    });

    if (claimError) {
      console.error('claim failed', reminder.id, claimError.message);
      failed += 1;
      continue;
    }

    const claim = normaliseClaim(claimData);
    if (!claim.claimed || !claim.token) {
      if (claim.reason === 'attempts_exhausted') {
        // Bounded give-up: the occurrence stays undelivered and is reported, so
        // an operator can see it rather than it silently retrying for ever.
        console.error('reminder abandoned after too many attempts', reminder.id, occurrence);
        failed += 1;
      } else {
        // already_delivered / lease_active: another run owns it, or there is
        // nothing left to do. Neither is an error.
        skipped += 1;
      }
      continue;
    }

    // ---- in-app notification (deduplicated independently of the push) ----
    const { error: insertError } = await supabase.from('notifications').insert({
      user_id: reminder.owner_id,
      kind: 'reminder',
      title: reminder.title,
      body: reminder.description ?? 'Scheduled reminder',
      link: '/reminders',
      dedupe_key: `reminder:${reminder.id}:${occurrence}`,
    });

    // 23505 means a previous attempt already wrote this notification. That is
    // NOT the same as "delivered": the push may have failed then, so we fall
    // through and attempt the push again. The dedupe_key keeps the in-app row
    // single no matter how many retries happen.
    const alreadyRecorded = insertError?.code === '23505';
    if (insertError && !alreadyRecorded) {
      console.error('notification insert failed', insertError.message);
      await complete(reminder, claim, false, `notification insert: ${insertError.message}`);
      failed += 1;
      continue;
    }
    if (!insertError) notified += 1;
    if (alreadyRecorded) retried += 1;

    // ---- push ----
    // browser_notifications comes from the preference row, defaulting to the
    // column default (false = in-app only) when the user has no row at all.
    let pushError: string | null = null;

    if (pushEnabled && reminder.browser_notifications) {
      // The error is checked, not dropped. An unchecked failure here (RLS, a
      // dropped connection, a missing table) returns `data: null`, the loop
      // below would attempt no push at all, `pushError` would stay null, and the
      // reminder would be marked delivered and advanced — a notification lost
      // with no trace. A read failure is a delivery failure: it is retried.
      const { data: subs, error: subsError } = await supabase
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth')
        .eq('user_id', reminder.owner_id);

      if (subsError) {
        pushError = `push subscriptions: ${subsError.message}`;
        console.error('push subscription lookup failed', subsError.message);
      }

      for (const sub of subsError ? [] : subs ?? []) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify({
              title: reminder.title,
              body: reminder.description ?? 'LunaDesk reminder',
              tag: `reminder:${reminder.id}:${occurrence}`,
              url: '/#/reminders',
              // Honour the per-reminder alarm flag: without it the notification
              // is informational only, and does not demand interaction.
              requireInteraction: reminder.alarm_enabled,
              silent: !reminder.alarm_enabled,
            }),
          );
          pushed += 1;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // The endpoint is gone (uninstalled, permission reset, expired).
            // A failed cleanup is logged rather than retried: the send already
            // failed, and the next run will try the row again.
            const { error: deleteError } = await supabase
              .from('push_subscriptions')
              .delete()
              .eq('id', sub.id);
            if (deleteError) {
              console.error('stale subscription cleanup failed', deleteError.message);
            }
          } else {
            pushError = `push ${status ?? 'error'}: ${(err as Error).message}`;
            console.error('push failed', status, (err as Error).message);
          }
        }
      }
    }

    // ---- completion ----
    // One transactional call decides what happens next: on success the reminder
    // is advanced/finished here, on failure the lease is released and the
    // occurrence stays due. The Edge Function no longer writes reminder state.
    const done = await complete(reminder, claim, pushError === null, pushError);
    if (pushError) failed += 1;
    if (done && done.advanced === false && done.reason === 'retry_scheduled') retried += 1;
  }

  return json(
    {
      ok: true,
      checked: due.length,
      notified,
      pushed,
      retried,
      skipped,
      failed,
      push_enabled: pushEnabled,
      worker: WORKER,
    },
    200,
    origin,
  );
});
