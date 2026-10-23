import { useCallback, useEffect, useRef, useState } from 'react';
import { Flag, Pause, Play, RotateCcw, Save, Square, Timer, Trash2 } from 'lucide-react';
import { Badge, Button, EmptyState, Field, PageHeader, SkeletonRows, TextInput } from '@/components/ui';
import { useCollection, useData, useToast } from '@/context/app';
import { fmtDateTime, fmtRelative } from '@/lib/dates';
import type { StopwatchSession } from '@/lib/types';
import { uuid } from '@/lib/utils';

function formatDuration(ms: number): { main: string; centis: string; hours: string } {
  const total = Math.max(0, ms);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const centis = Math.floor((total % 1000) / 10);
  return {
    main: `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`,
    centis: centis.toString().padStart(2, '0'),
    hours: String(hours).padStart(2, '0'),
  };
}

export default function StopwatchPage() {
  const { data: sessions, loading, refresh } = useCollection<StopwatchSession>('stopwatch_sessions');
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const toast = useToast();

  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [laps, setLaps] = useState<number[]>([]);
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);

  // Timestamp-based timing: the displayed value is always derived from the
  // wall clock, so a throttled tab (background/minimised) never loses time.
  const startedAt = useRef<number | null>(null);
  const accumulated = useRef(0);
  const frame = useRef<number | null>(null);
  const lastLap = useRef(0);

  const computeElapsed = useCallback(() => {
    if (startedAt.current === null) return accumulated.current;
    return accumulated.current + (performance.now() - startedAt.current);
  }, []);

  useEffect(() => {
    if (!running) return;
    const loop = () => {
      setElapsed(computeElapsed());
      frame.current = requestAnimationFrame(loop);
    };
    frame.current = requestAnimationFrame(loop);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [running, computeElapsed]);

  // Re-sync the moment the tab becomes visible again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setElapsed(computeElapsed());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [computeElapsed]);

  const start = () => {
    startedAt.current = performance.now();
    setRunning(true);
  };

  const pause = () => {
    accumulated.current = computeElapsed();
    startedAt.current = null;
    setRunning(false);
    setElapsed(accumulated.current);
  };

  const reset = () => {
    setRunning(false);
    startedAt.current = null;
    accumulated.current = 0;
    lastLap.current = 0;
    setElapsed(0);
    setLaps([]);
  };

  const lap = () => {
    const now = computeElapsed();
    const split = now - lastLap.current;
    lastLap.current = now;
    setLaps((prev) => [split, ...prev]);
  };

  const save = async () => {
    const total = computeElapsed();
    if (total < 1000) {
      toast.warning('Nothing to save yet', 'Run the stopwatch for at least a second.');
      return;
    }
    setSaving(true);
    const startIso = new Date(Date.now() - total).toISOString();
    try {
      await adapter.insert('stopwatch_sessions', {
        id: uuid(),
        label: label.trim() || 'Untitled session',
        started_at: startIso,
        ended_at: new Date().toISOString(),
        duration_ms: Math.round(total),
        laps: [...laps].reverse().map((_, i, arr) => Math.round(arr.slice(0, i + 1).reduce((a, b) => a + b, 0))),
      });
      toast.success('Session saved', `${formatDuration(total).main} added to your history.`);
      setLabel('');
      reset();
      refresh();
      invalidate();
    } catch (err) {
      toast.error('Could not save the session', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const removeSession = async (id: string) => {
    try {
      await adapter.remove('stopwatch_sessions', id);
      toast.success('Session deleted');
      refresh();
      invalidate();
    } catch {
      toast.error('Could not delete the session');
    }
  };

  const time = formatDuration(elapsed);
  const totalLap = laps.reduce((a, b) => a + b, 0);

  return (
    <div>
      <PageHeader
        eyebrow="Productivity"
        title="Stopwatch"
        description="Timestamp-based timing that stays accurate when the tab is throttled or backgrounded. Sessions are private to your account."
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="surface overflow-hidden">
          <div className="relative flex flex-col items-center px-5 py-10">
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-70"
              style={{ background: running ? 'radial-gradient(ellipse at 50% 0%, rgba(255,45,149,0.18), transparent 70%)' : 'none' }}
              aria-hidden
            />
            <p className="eyebrow relative mb-4">{running ? 'Running' : elapsed > 0 ? 'Paused' : 'Ready'}</p>
            <div
              className="num relative flex items-baseline gap-1 font-mono text-fg"
              role="timer"
              aria-live={running ? 'off' : 'polite'}
              aria-label={`Elapsed time ${time.hours} hours ${time.main} and ${time.centis} hundredths`}
            >
              <span className="text-[clamp(2.8rem,9vw,4.6rem)] font-semibold leading-none tracking-[-0.03em]">
                {time.hours !== '00' ? `${time.hours}:` : ''}
                {time.main}
              </span>
              <span className="text-2xl text-muted">.{time.centis}</span>
            </div>

            <div className="relative mt-8 flex flex-wrap items-center justify-center gap-2">
              {!running ? (
                <Button variant="primary" size="lg" onClick={start} icon={<Play className="h-4 w-4" />}>
                  {elapsed > 0 ? 'Resume' : 'Start'}
                </Button>
              ) : (
                <Button variant="ghost" size="lg" onClick={pause} icon={<Pause className="h-4 w-4" />}>
                  Pause
                </Button>
              )}
              <Button variant="ghost" size="lg" onClick={lap} disabled={elapsed === 0} icon={<Flag className="h-4 w-4" />}>
                Lap
              </Button>
              <Button variant="quiet" size="lg" onClick={reset} disabled={elapsed === 0} icon={<RotateCcw className="h-4 w-4" />}>
                Reset
              </Button>
              <Button
                variant="ghost"
                size="lg"
                onClick={() => void save()}
                loading={saving}
                disabled={elapsed < 1000}
                icon={<Save className="h-4 w-4" />}
              >
                Save session
              </Button>
            </div>

            <div className="relative mt-6 w-full max-w-sm">
              <Field label="Session label (optional)">
                {(id) => (
                  <TextInput
                    id={id}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. Prism — reel edits"
                    maxLength={80}
                  />
                )}
              </Field>
            </div>
          </div>

          <div className="border-t px-5 py-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-fg">Laps</h2>
              {laps.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="num text-[11px] text-faint">Total {formatDuration(totalLap).main}</span>
                  <Button size="sm" variant="quiet" onClick={() => { setLaps([]); lastLap.current = 0; }}>
                    Clear laps
                  </Button>
                </div>
              )}
            </div>
            {laps.length === 0 ? (
              <p className="py-4 text-center text-[11px] text-faint">Press Lap while the timer runs to record splits.</p>
            ) : (
              <ol className="max-h-48 space-y-1 overflow-y-auto">
                {laps.map((lapMs, i) => {
                  const d = formatDuration(lapMs);
                  const previous = laps[i + 1];
                  const faster = previous !== undefined && lapMs < previous;
                  return (
                    <li key={`${i}-${lapMs}`} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-xs odd:bg-[rgb(var(--line)/0.04)]">
                      <span className="text-faint">Lap {laps.length - i}</span>
                      <span className="num font-mono text-fg">
                        {d.hours !== '00' && `${d.hours}:`}
                        {d.main}.{d.centis}
                      </span>
                      {previous !== undefined && (
                        <Badge tone={faster ? 'mint' : 'muted'}>{faster ? 'faster' : 'slower'}</Badge>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>

        <div className="surface p-4">
          <div className="mb-3 flex items-center gap-1.5">
            <Timer className="h-3.5 w-3.5 text-faint" aria-hidden />
            <h2 className="text-xs font-semibold text-fg">Your sessions</h2>
            <span className="ml-auto text-[10px] text-faint">{sessions.length} saved</span>
          </div>
          {loading ? (
            <SkeletonRows rows={3} />
          ) : sessions.length === 0 ? (
            <EmptyState
              compact
              icon={<Timer className="h-5 w-5" />}
              title="No sessions saved"
              description="Saved stopwatch sessions appear here. Only you can see them."
            />
          ) : (
            <ul className="max-h-[520px] space-y-1 overflow-y-auto">
              {sessions.map((s) => {
                const d = formatDuration(s.duration_ms);
                return (
                  <li key={s.id} className="group flex items-start gap-2 rounded-lg px-2 py-2 transition hover:bg-raised/60">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-medium text-fg">{s.label ?? 'Untitled session'}</p>
                      <p className="mt-0.5 text-[10.5px] text-faint">
                        {fmtDateTime(s.started_at)} · {fmtRelative(s.started_at)}
                        {s.laps?.length ? ` · ${s.laps.length} laps` : ''}
                      </p>
                    </div>
                    <span className="num shrink-0 font-mono text-xs text-sky">
                      {d.hours !== '00' ? `${d.hours}:` : ''}
                      {d.main}
                    </span>
                    <button
                      type="button"
                      onClick={() => void removeSession(s.id)}
                      className="rounded p-1 text-faint opacity-0 transition hover:text-magenta group-hover:opacity-100 focus-visible:opacity-100"
                      aria-label={`Delete session ${s.label ?? 'Untitled session'}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 flex items-center gap-1.5 border-t pt-2.5 text-[10px] text-faint">
            <Square className="h-2.5 w-2.5" aria-hidden />
            Sessions are saved to your account and never shared with clients.
          </p>
        </div>
      </div>
    </div>
  );
}
