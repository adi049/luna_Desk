import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import type { CalendarEvent } from './types';

export interface Occurrence {
  event: CalendarEvent;
  /** Concrete start/end for this occurrence (recurring series expanded). */
  start: Date;
  end: Date;
  isRecurringInstance: boolean;
}

/**
 * Expands a recurring series into concrete occurrences inside [from, to].
 *
 * Recurrence is stored as a wall-clock timestamp plus a rule. Expansion uses
 * local calendar arithmetic (addDays/addWeeks/…) rather than fixed millisecond
 * offsets, so a weekly 09:00 meeting stays at 09:00 across a DST boundary.
 */
export function expandEvents(events: CalendarEvent[], from: Date, to: Date): Occurrence[] {
  const out: Occurrence[] = [];
  for (const event of events) {
    const start = new Date(event.starts_at);
    const end = new Date(event.ends_at);
    const duration = end.getTime() - start.getTime();
    if (event.recurrence === 'none' || !event.recurrence) {
      if (end >= from && start <= to) out.push({ event, start, end, isRecurringInstance: false });
      continue;
    }
    const until = event.recurrence_until ? new Date(`${event.recurrence_until}T23:59:59`) : addYears(from, 3);
    let cursor = start;
    let guard = 0;
    while (cursor <= to && cursor <= until && guard < 500) {
      const occEnd = new Date(cursor.getTime() + duration);
      if (occEnd >= from) out.push({ event, start: new Date(cursor), end: occEnd, isRecurringInstance: true });
      switch (event.recurrence) {
        case 'daily':
          cursor = addDays(cursor, 1);
          break;
        case 'weekly':
          cursor = addWeeks(cursor, 1);
          break;
        case 'monthly':
          cursor = addMonths(cursor, 1);
          break;
        case 'yearly':
          cursor = addYears(cursor, 1);
          break;
        default:
          guard = 1000;
      }
      guard += 1;
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function buildMonthMatrix(cursor: Date): Date[] {
  const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 });
  const end = endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 });
  const days: Date[] = [];
  let day = start;
  while (day <= end) {
    days.push(day);
    day = addDays(day, 1);
  }
  return days;
}

export function buildWeekDays(cursor: Date): Date[] {
  const start = startOfWeek(cursor, { weekStartsOn: 1 });
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function rangeForView(view: 'month' | 'week' | 'day' | 'agenda', cursor: Date): { from: Date; to: Date } {
  if (view === 'month') {
    const days = buildMonthMatrix(cursor);
    return { from: days[0], to: addDays(days[days.length - 1], 1) };
  }
  if (view === 'week') {
    const days = buildWeekDays(cursor);
    return { from: days[0], to: addDays(days[6], 1) };
  }
  if (view === 'day') {
    return { from: new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate()), to: addDays(cursor, 1) };
  }
  return { from: new Date(cursor), to: addDays(cursor, 60) };
}

export function monthTitle(cursor: Date) {
  return format(cursor, 'MMMM yyyy');
}

export function isCurrentMonth(day: Date, cursor: Date) {
  return isSameMonth(day, cursor);
}
