import { motion } from 'framer-motion';
import { BellRing, Clock, Check } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui';
import { fmtDateTime } from '@/lib/dates';
import type { Reminder } from '@/lib/types';

/**
 * Visual alarm. Always shown when an alarm rings — it is the accessible
 * alternative for users who cannot hear the sound, and the only cue when
 * audio is blocked by the browser.
 */
export function AlarmOverlay({
  reminder,
  onSnooze,
  onDismiss,
  onStopSound,
  soundPlaying,
}: {
  reminder: Reminder | null;
  onSnooze: (minutes: number) => void;
  onDismiss: () => void;
  onStopSound: () => void;
  soundPlaying: boolean;
}) {
  if (!reminder) return null;
  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4 no-print" role="alertdialog" aria-modal="true" aria-label={`Reminder: ${reminder.title}`}>
      <motion.div
        className="absolute inset-0 bg-black/75 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      />
      <motion.div
        className="surface relative w-full max-w-md overflow-hidden p-6"
        initial={{ scale: 0.94, opacity: 0, y: 16 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 26 }}
        style={{ boxShadow: '0 40px 120px -40px rgba(255,45,149,0.55)' }}
      >
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-magenta/20 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-3">
          <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-magenta/15 text-magenta">
            <BellRing className="h-5 w-5" aria-hidden />
            <span className="absolute inset-0 animate-pulse-ring rounded-full" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="eyebrow text-magenta">Reminder</p>
            <h2 className="mt-0.5 text-lg font-semibold leading-tight tracking-tight text-fg">{reminder.title}</h2>
          </div>
        </div>

        {reminder.description && <p className="relative mt-3 text-sm leading-relaxed text-muted">{reminder.description}</p>}
        <p className="relative mt-3 flex items-center gap-1.5 text-xs text-faint">
          <Clock className="h-3.5 w-3.5" aria-hidden />
          Set for {fmtDateTime(reminder.remind_at)}
        </p>

        <div className="relative mt-5 flex flex-wrap gap-2">
          <Button variant="primary" onClick={onDismiss} icon={<Check className="h-4 w-4" />}>
            Dismiss
          </Button>
          <Button variant="ghost" onClick={() => onSnooze(5)}>
            Snooze 5 min
          </Button>
          <Button variant="ghost" onClick={() => onSnooze(10)}>
            Snooze 10 min
          </Button>
          {soundPlaying && (
            <Button variant="quiet" onClick={onStopSound}>
              Stop sound
            </Button>
          )}
        </div>
        <p className="relative mt-4 text-[10.5px] leading-relaxed text-faint">
          The alarm keeps ringing until you dismiss or snooze it. If your browser blocks audio, this screen is the
          primary alert.
        </p>
      </motion.div>
    </div>,
    document.body,
  );
}
