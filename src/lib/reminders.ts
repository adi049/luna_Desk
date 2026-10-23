import type { Reminder, ReminderRepeat } from './types';

/** Minutes after `remind_at` beyond which we treat a reminder as "missed"
 *  rather than "ringing now". Prevents an alarm storm when a tab is restored. */
export const MISS_WINDOW_MINUTES = 10;

export function nextOccurrence(from: Date, repeat: ReminderRepeat): Date {
  const d = new Date(from);
  switch (repeat) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7);
      break;
    case 'monthly':
      d.setMonth(d.getMonth() + 1);
      break;
    case 'yearly':
      d.setFullYear(d.getFullYear() + 1);
      break;
    default:
      return d;
  }
  return d;
}

export function effectiveTime(r: Reminder): number {
  return new Date(r.snoozed_until ?? r.remind_at).getTime();
}

export function isRinging(r: Reminder, now = Date.now()): boolean {
  if (r.is_dismissed) return false;
  const due = effectiveTime(r);
  if (due > now) return false;
  // Already handled this occurrence.
  if (r.fired_at && !r.snoozed_until) return false;
  return now - due <= MISS_WINDOW_MINUTES * 60_000;
}

export function isMissed(r: Reminder, now = Date.now()): boolean {
  if (r.is_dismissed) return false;
  if (r.fired_at && !r.snoozed_until) return false;
  return now - effectiveTime(r) > MISS_WINDOW_MINUTES * 60_000;
}

export function isUpcoming(r: Reminder, now = Date.now()): boolean {
  return !r.is_dismissed && effectiveTime(r) > now;
}
