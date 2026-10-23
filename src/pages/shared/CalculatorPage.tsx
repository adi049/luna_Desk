import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Delete, History, RotateCcw, Trash2 } from 'lucide-react';
import { Button, PageHeader } from '@/components/ui';
import { CalcError, evaluate, formatResult } from '@/lib/calc';
import { useAuth } from '@/context/auth';
import { cn } from '@/lib/utils';

interface HistoryEntry {
  expression: string;
  result: string;
  at: string;
}

const KEYS = [
  ['(', ')', '%', '⌫'],
  ['7', '8', '9', '÷'],
  ['4', '5', '6', '×'],
  ['1', '2', '3', '−'],
  ['0', '.', 'C', '+'],
] as const;

const storageKey = (userId: string) => `lunadesk.calc.history.${userId}`;

export default function CalculatorPage() {
  const { profile } = useAuth();
  const [expression, setExpression] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const inputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!profile) return;
    try {
      const raw = localStorage.getItem(storageKey(profile.id));
      if (raw) setHistory(JSON.parse(raw) as HistoryEntry[]);
    } catch {
      /* ignore */
    }
  }, [profile]);

  const persistHistory = (next: HistoryEntry[]) => {
    setHistory(next);
    if (profile) {
      try {
        localStorage.setItem(storageKey(profile.id), JSON.stringify(next.slice(0, 50)));
      } catch {
        /* storage full or blocked — history stays in memory */
      }
    }
  };

  const compute = useCallback(() => {
    if (!expression.trim()) return;
    try {
      const value = evaluate(expression);
      const formatted = formatResult(value);
      setResult(formatted);
      setError(null);
      persistHistory([
        { expression, result: formatted, at: new Date().toISOString() },
        ...history.filter((h) => h.expression !== expression).slice(0, 49),
      ]);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    } catch (err) {
      setResult(null);
      setError(err instanceof CalcError ? err.message : 'That expression could not be calculated');
    }
  }, [expression, history]);

  const press = useCallback(
    (key: string) => {
      setError(null);
      if (key === 'C') {
        setExpression('');
        setResult(null);
        return;
      }
      if (key === '⌫') {
        setExpression((e) => e.slice(0, -1));
        return;
      }
      if (key === '=') {
        compute();
        return;
      }
      const map: Record<string, string> = { '×': '*', '÷': '/', '−': '-' };
      setExpression((e) => e + (map[key] ?? key));
    },
    [compute],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (/^[0-9.+\-*/()%]$/.test(e.key)) {
        e.preventDefault();
        press(e.key);
      } else if (e.key === 'Enter' || e.key === '=') {
        e.preventDefault();
        compute();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        press('⌫');
      } else if (e.key === 'Escape' || e.key.toLowerCase() === 'c') {
        e.preventDefault();
        press('C');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press, compute]);

  return (
    <div>
      <PageHeader
        eyebrow="Productivity"
        title="Calculator"
        description="A restricted arithmetic parser — no eval, no arbitrary code. Percentages behave like a desk calculator: 200 + 10% = 220."
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="surface p-4 sm:p-5">
          <div className="rounded-xl border bg-raised/50 p-4" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
            <div
              ref={inputRef}
              className="min-h-[42px] break-all text-right font-mono text-xl text-fg"
              aria-live="polite"
              aria-atomic="true"
            >
              {expression || <span className="text-faint">0</span>}
            </div>
            <div className="mt-1 min-h-[32px] break-all text-right font-mono text-2xl font-semibold tracking-tight">
              {error ? (
                <span className="text-[13px] font-sans font-normal text-magenta">{error}</span>
              ) : result !== null ? (
                <span className="text-mint" aria-live="polite">
                  = {result}
                </span>
              ) : (
                <span className="text-faint"> </span>
              )}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-4 gap-2" role="group" aria-label="Calculator keypad">
            {KEYS.flat().map((key) => {
              const isOp = ['÷', '×', '−', '+', '(', ')', '%'].includes(key);
              const isAction = key === 'C' || key === '⌫';
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => press(key)}
                  className={cn(
                    'flex h-14 items-center justify-center rounded-xl border font-mono text-lg transition active:scale-[0.97]',
                    isOp && 'text-sky',
                    isAction && 'text-magenta',
                    !isOp && !isAction && 'text-fg',
                  )}
                  style={{ borderColor: 'rgb(var(--line) / 0.15)', background: 'rgb(var(--raised) / 0.6)' }}
                  aria-label={key === '⌫' ? 'Backspace' : key === 'C' ? 'Clear' : key}
                >
                  {key === '⌫' ? <Delete className="h-4 w-4" aria-hidden /> : key}
                </button>
              );
            })}
            <button
              type="button"
              onClick={compute}
              className="btn btn-primary col-span-4 h-14 font-mono text-lg"
            >
              =
            </button>
          </div>
          <p className="mt-3 text-[11px] text-faint">
            Keyboard: digits and operators, Enter to evaluate, Backspace to delete, Esc to clear.
          </p>
        </div>

        <div className="surface flex min-h-[320px] flex-col p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-xs font-semibold text-fg">
              <History className="h-3.5 w-3.5 text-faint" aria-hidden /> History
            </h2>
            {history.length > 0 && (
              <Button size="sm" variant="quiet" onClick={() => persistHistory([])} icon={<Trash2 className="h-3 w-3" />}>
                Clear
              </Button>
            )}
          </div>
          {history.length === 0 ? (
            <p className="py-8 text-center text-xs text-faint">Calculations you run are stored here for this account.</p>
          ) : (
            <ul className="-mx-1 max-h-[420px] space-y-0.5 overflow-y-auto">
              {history.map((h) => (
                <li key={`${h.at}-${h.expression}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setExpression(h.expression);
                      setResult(h.result);
                    }}
                    className="w-full rounded-lg px-2 py-2 text-left transition hover:bg-raised/70"
                    title="Load this expression"
                  >
                    <span className="block truncate font-mono text-[11px] text-faint">{h.expression}</span>
                    <span className="block font-mono text-sm text-fg">= {h.result}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-auto flex items-center gap-2 pt-3 text-[10.5px] text-faint">
            <RotateCcw className="h-3 w-3" aria-hidden />
            Stored on this device only
            <ArrowLeft className="ml-auto h-3 w-3 rotate-180" aria-hidden />
          </div>
        </div>
      </div>
    </div>
  );
}
