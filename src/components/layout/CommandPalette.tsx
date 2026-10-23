import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { CornerDownLeft, Search } from 'lucide-react';
import { adminNav, clientNav } from './nav';
import { cn } from '@/lib/utils';

/** Keyboard-first navigation. Only routes to real pages — no dead commands. */
export function GlobalCommandPalette({ open, onClose, isAdmin }: { open: boolean; onClose: () => void; isAdmin: boolean }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const groups = isAdmin ? adminNav : clientNav;
    return groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })));
  }, [isAdmin]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => `${i.label} ${i.group}`.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, filtered.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const target = filtered[cursor];
        if (target) {
          navigate(target.to);
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, cursor, navigate, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[85] flex items-start justify-center p-4 pt-[12vh] no-print">
          <motion.div
            className="absolute inset-0 bg-black/60 backdrop-blur-[3px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Search and jump"
            className="surface relative w-full max-w-lg overflow-hidden p-0"
            initial={{ opacity: 0, y: -8, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.99 }}
            transition={{ duration: 0.16 }}
          >
            <div className="flex items-center gap-2 border-b px-3.5 py-3">
              <Search className="h-4 w-4 text-faint" aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
                placeholder="Go to…"
                aria-label="Search pages"
                className="w-full bg-transparent text-sm text-fg outline-none placeholder:text-faint"
              />
              <kbd className="rounded border px-1.5 py-0.5 text-[10px] text-faint" style={{ borderColor: 'rgb(var(--line)/0.18)' }}>
                Esc
              </kbd>
            </div>
            <ul className="max-h-[46vh] overflow-y-auto p-1.5">
              {filtered.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted">No matching pages.</li>}
              {filtered.map((item, i) => {
                const Icon = item.icon;
                return (
                  <li key={item.to}>
                    <button
                      type="button"
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => {
                        navigate(item.to);
                        onClose();
                      }}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition',
                        i === cursor ? 'bg-[rgb(var(--line)/0.12)] text-fg' : 'text-muted hover:bg-raised/60',
                      )}
                    >
                      <Icon className="h-4 w-4 text-faint" aria-hidden />
                      <span className="flex-1">{item.label}</span>
                      <span className="text-[10px] uppercase tracking-[0.12em] text-faint">{item.group}</span>
                      {i === cursor && <CornerDownLeft className="h-3 w-3 text-faint" aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
