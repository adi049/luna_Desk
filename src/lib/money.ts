/**
 * Money helpers. Every monetary value in LunaDesk is an integer number of
 * minor units (paise). This module is the only place that converts to a
 * display string, so rounding behaviour is consistent everywhere.
 */

export const CURRENCY = 'INR';

export function formatMoney(minor: number, opts: { compact?: boolean; sign?: boolean; currency?: string } = {}) {
  const { compact = false, sign = false, currency = CURRENCY } = opts;
  const value = (minor ?? 0) / 100;
  const fmt = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: Math.abs(value) < 1000 && value % 1 !== 0 ? 2 : 0,
    notation: compact && Math.abs(value) >= 100000 ? 'compact' : 'standard',
    ...(compact && Math.abs(value) >= 100000 ? { maximumFractionDigits: 1 } : {}),
  });
  const out = fmt.format(Math.abs(value));
  if (sign && value !== 0) return `${value < 0 ? '−' : '+'}${out}`;
  return value < 0 ? `−${out}` : out;
}

/** Parse a user-typed rupee amount into paise. Returns null when unparseable. */
export function parseMoneyToMinor(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, '');
  if (!cleaned || !/^-?\d*\.?\d{0,2}$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function minorToInput(minor: number): string {
  return (minor / 100).toFixed(2).replace(/\.00$/, '');
}

export function sum(minor: number[]): number {
  return minor.reduce((a, b) => a + b, 0);
}
