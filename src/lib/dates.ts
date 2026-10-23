import { format, formatDistanceToNowStrict, isSameDay, parseISO } from 'date-fns';

export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function fmtDate(value?: string | Date | null, pattern = 'dd MMM yyyy'): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? parseISO(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return format(d, pattern);
}

export function fmtDateTime(value?: string | Date | null): string {
  return fmtDate(value, 'dd MMM yyyy, HH:mm');
}

export function fmtTime(value?: string | Date | null): string {
  return fmtDate(value, 'HH:mm');
}

export function fmtRelative(value?: string | Date | null): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? parseISO(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return `${formatDistanceToNowStrict(d, { addSuffix: true })}`;
}

export function todayISO(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

export function isToday(value?: string | Date | null): boolean {
  if (!value) return false;
  const d = typeof value === 'string' ? parseISO(value) : value;
  return isSameDay(d, new Date());
}

export function monthKey(value: string | Date): string {
  const d = typeof value === 'string' ? parseISO(value) : value;
  return format(d, 'yyyy-MM');
}

export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return format(new Date(y, m - 1, 1), 'MMM yyyy');
}

/** Local wall-clock time in a given IANA timezone, used to display + compare
 *  reminder times consistently even if the OS timezone differs. */
export function inTimezone(value: string | Date, timeZone = TZ): Date {
  const d = typeof value === 'string' ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return new Date(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
}
