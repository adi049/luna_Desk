import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Bold,
  Eye,
  Italic,
  List,
  ListOrdered,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  StickyNote,
  Trash2,
  AlertCircle,
  Check,
  Heading3,
} from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  PageHeader,
  SearchInput,
  Segmented,
  Select,
  SkeletonRows,
  TextInput,
  Toolbar,
} from '@/components/ui';
import { ConfirmDialog } from '@/components/ui/overlays';
import { useCollection, useData, useToast } from '@/context/app';
import { useAuth } from '@/context/auth';
import { noteScopeMeta } from '@/lib/labels';
import { fmtRelative } from '@/lib/dates';
import { htmlToText, sanitizeHtml } from '@/lib/sanitize';
import type { Client, Note, NoteScope } from '@/lib/types';
import { cn, uuid } from '@/lib/utils';

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export default function NotesPage() {
  const { profile, isAdmin } = useAuth();
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const toast = useToast();
  const { data: notes, loading, refresh } = useCollection<Note>('notes');
  const { data: clients } = useCollection<Client>('clients', {}, isAdmin);

  const [search, setSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState<'all' | NoteScope>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);

  const editorRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | null>(null);
  const pending = useRef<Record<string, unknown> | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return notes
      .filter((n) => (showArchived ? n.is_archived : !n.is_archived))
      .filter((n) => (scopeFilter === 'all' ? true : n.scope === scopeFilter))
      .filter((n) => !q || `${n.title} ${htmlToText(n.body)} ${n.tags.join(' ')}`.toLowerCase().includes(q))
      .sort((a, b) => {
        if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
        return b.updated_at.localeCompare(a.updated_at);
      });
  }, [notes, search, scopeFilter, showArchived]);

  const selected = filtered.find((n) => n.id === selectedId) ?? filtered[0] ?? null;

  useEffect(() => {
    if (selected && selected.id !== selectedIdRef.current) {
      selectedIdRef.current = selected.id;
      setSelectedId(selected.id);
      if (editorRef.current) editorRef.current.innerHTML = sanitizeHtml(selected.body);
      setSaveState('saved');
      setLastSavedAt(selected.updated_at);
      setPreview(false);
    }
  }, [selected]);

  const persist = useCallback(
    async (id: string, patch: Record<string, unknown>) => {
      setSaveState('saving');
      try {
        const updated = await adapter.update<Note>('notes', id, patch);
        setSaveState('saved');
        setLastSavedAt(updated.updated_at);
        refresh();
        invalidate();
      } catch (err) {
        setSaveState('error');
        toast.error('Save failed — your text is still here', err instanceof Error ? err.message : 'Retry to keep the changes.');
      }
    },
    [adapter, invalidate, refresh, toast],
  );

  const queueSave = (patch: Record<string, unknown>) => {
    if (!selected) return;
    pending.current = { ...(pending.current ?? {}), ...patch };
    setSaveState('dirty');
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (!selectedIdRef.current || !pending.current) return;
      const payload = pending.current;
      pending.current = null;
      void persist(selectedIdRef.current, payload);
    }, 900);
  };

  const retry = () => {
    if (!selected) return;
    const html = editorRef.current?.innerHTML ?? '';
    void persist(selected.id, { title: selected.title, body: sanitizeHtml(html) });
  };

  const createNote = async () => {
    if (!profile) return;
    try {
      const note = await adapter.insert<Note>('notes', {
        id: uuid(),
        owner_id: profile.id,
        scope: 'personal',
        client_id: null,
        title: 'Untitled note',
        body: '',
        tags: [],
        is_pinned: false,
        is_archived: false,
      });
      refresh();
      invalidate();
      selectedIdRef.current = note.id;
      setSelectedId(note.id);
      window.setTimeout(() => {
        if (editorRef.current) editorRef.current.innerHTML = '';
        editorRef.current?.focus();
      }, 60);
    } catch (err) {
      toast.error('Could not create the note', err instanceof Error ? err.message : undefined);
    }
  };

  const exec = (command: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    handleInput();
  };

  const handleInput = () => {
    const html = editorRef.current?.innerHTML ?? '';
    queueSave({ body: sanitizeHtml(html) });
  };

  const togglePin = async (note: Note) => {
    const updated = await adapter.update<Note>('notes', note.id, { is_pinned: !note.is_pinned });
    refresh();
    invalidate();
    toast.success(updated.is_pinned ? 'Note pinned' : 'Note unpinned');
  };

  const toggleArchive = async (note: Note) => {
    await adapter.update<Note>('notes', note.id, { is_archived: !note.is_archived });
    refresh();
    invalidate();
    toast.success(note.is_archived ? 'Note restored' : 'Note archived');
  };

  const removeNote = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      await adapter.remove('notes', confirmDelete.id);
      toast.success('Note deleted');
      setConfirmDelete(null);
      selectedIdRef.current = null;
      setSelectedId(null);
      refresh();
      invalidate();
    } catch (err) {
      toast.error('Could not delete the note', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const saveIndicator = () => {
    if (saveState === 'saving') return { icon: <Loader2 className="h-3 w-3 animate-spin" />, text: 'Saving…', tone: 'text-faint' };
    if (saveState === 'dirty') return { icon: <Pencil className="h-3 w-3" />, text: 'Unsaved changes', tone: 'text-butter' };
    if (saveState === 'error') return { icon: <AlertCircle className="h-3 w-3" />, text: 'Save failed', tone: 'text-magenta' };
    if (saveState === 'saved') return { icon: <Check className="h-3 w-3" />, text: lastSavedAt ? `Saved ${fmtRelative(lastSavedAt)}` : 'Saved', tone: 'text-mint' };
    return { icon: null, text: 'Autosaves as you type', tone: 'text-faint' };
  };
  const indicator = saveIndicator();

  return (
    <div>
      <PageHeader
        eyebrow="Productivity"
        title="Notes"
        description="Private by default. Agency and client notes carry an explicit scope so nothing internal can leak into a client portal."
        actions={
          <Button variant="primary" onClick={() => void createNote()} icon={<Plus className="h-4 w-4" />}>
            New note
          </Button>
        }
      />

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search notes" className="w-full sm:w-56" />
        <Segmented
          size="sm"
          ariaLabel="Note scope"
          value={scopeFilter}
          onChange={setScopeFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'personal', label: 'Personal' },
            { value: 'agency', label: 'Agency' },
            { value: 'client', label: 'Client' },
          ]}
        />
        <label className="ml-auto flex items-center gap-2 text-[11px] text-muted">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-[rgb(var(--line)/0.3)] bg-transparent accent-[#FF2D95]"
          />
          Show archived
        </label>
      </Toolbar>

      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="surface max-h-[70vh] overflow-y-auto p-2">
          {loading ? (
            <SkeletonRows rows={4} />
          ) : filtered.length === 0 ? (
            <EmptyState
              compact
              icon={<StickyNote className="h-5 w-5" />}
              title={notes.length === 0 ? 'No notes yet' : 'No matches'}
              description={notes.length === 0 ? 'Create a note to capture context, decisions and research.' : 'Adjust the search or filters.'}
            />
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((note) => (
                <li key={note.id}>
                  <button
                    type="button"
                    onClick={() => {
                      selectedIdRef.current = note.id;
                      setSelectedId(note.id);
                    }}
                    className={cn(
                      'w-full rounded-lg px-2.5 py-2 text-left transition',
                      selected?.id === note.id ? 'bg-[rgb(var(--line)/0.1)]' : 'hover:bg-raised/60',
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      {note.is_pinned && <Pin className="h-3 w-3 shrink-0 text-magenta" aria-label="Pinned" />}
                      <span className="truncate text-[12.5px] font-medium text-fg">{note.title || 'Untitled note'}</span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-faint">
                      {htmlToText(note.body).slice(0, 120) || 'Empty note'}
                    </span>
                    <span className="mt-1 flex items-center gap-1.5">
                      <Badge tone={noteScopeMeta[note.scope].tone}>{noteScopeMeta[note.scope].label}</Badge>
                      <span className="text-[10px] text-faint">{fmtRelative(note.updated_at)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {selected ? (
          <section className="surface flex min-h-[420px] flex-col p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <input
                  value={selected.title}
                  onChange={(e) => {
                    const title = e.target.value;
                    // Optimistic local update keeps typing smooth.
                    const idx = notes.findIndex((n) => n.id === selected.id);
                    if (idx >= 0) notes[idx] = { ...notes[idx], title };
                    queueSave({ title });
                  }}
                  className="w-full bg-transparent text-lg font-semibold tracking-tight text-fg outline-none placeholder:text-faint"
                  placeholder="Note title"
                  aria-label="Note title"
                  maxLength={160}
                />
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="quiet" onClick={() => void togglePin(selected)} aria-label={selected.is_pinned ? 'Unpin note' : 'Pin note'} icon={selected.is_pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />} />
                <Button size="sm" variant="quiet" onClick={() => void toggleArchive(selected)} aria-label={selected.is_archived ? 'Restore note' : 'Archive note'} icon={selected.is_archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />} />
                <Button size="sm" variant="quiet" onClick={() => setConfirmDelete(selected)} aria-label="Delete note" icon={<Trash2 className="h-3.5 w-3.5" />} />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 border-y py-2">
              {!preview && (
                <div className="flex items-center gap-0.5" role="toolbar" aria-label="Formatting">
                  <ToolbarButton onClick={() => exec('bold')} label="Bold"><Bold className="h-3.5 w-3.5" /></ToolbarButton>
                  <ToolbarButton onClick={() => exec('italic')} label="Italic"><Italic className="h-3.5 w-3.5" /></ToolbarButton>
                  <ToolbarButton onClick={() => exec('formatBlock', 'h3')} label="Heading"><Heading3 className="h-3.5 w-3.5" /></ToolbarButton>
                  <ToolbarButton onClick={() => exec('insertUnorderedList')} label="Bulleted list"><List className="h-3.5 w-3.5" /></ToolbarButton>
                  <ToolbarButton onClick={() => exec('insertOrderedList')} label="Numbered list"><ListOrdered className="h-3.5 w-3.5" /></ToolbarButton>
                </div>
              )}
              <Select
                aria-label="Note scope"
                value={selected.scope}
                onChange={(e) => {
                  const scope = e.target.value as NoteScope;
                  void persist(selected.id, { scope, client_id: scope === 'client' ? selected.client_id : null });
                }}
                className="w-auto py-1 text-[11px]"
              >
                {Object.entries(noteScopeMeta).map(([value, meta]) => (
                  <option key={value} value={value}>
                    {meta.label}
                  </option>
                ))}
              </Select>
              {selected.scope === 'client' && clients.length > 0 && (
                <Select
                  aria-label="Linked client"
                  value={selected.client_id ?? ''}
                  onChange={(e) => void persist(selected.id, { client_id: e.target.value || null })}
                  className="w-auto py-1 text-[11px]"
                >
                  <option value="">Choose client…</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
              <InputTags note={selected} onSave={(tags) => void persist(selected.id, { tags })} />
              <div className="ml-auto flex items-center gap-2">
                <span className={cn('flex items-center gap-1 text-[10.5px]', indicator.tone)} aria-live="polite">
                  {indicator.icon}
                  {indicator.text}
                </span>
                {saveState === 'error' && (
                  <Button size="sm" variant="ghost" onClick={retry}>
                    Retry
                  </Button>
                )}
                <Button size="sm" variant="quiet" onClick={() => setPreview((p) => !p)} icon={<Eye className="h-3.5 w-3.5" />}>
                  {preview ? 'Edit' : 'Preview'}
                </Button>
              </div>
            </div>

            {selected.scope !== 'personal' && (
              <p className="mt-2 flex items-center gap-1.5 rounded-lg border border-sky/25 bg-sky/[0.06] px-2.5 py-1.5 text-[10.5px] text-accent-sky">
                <AlertCircle className="h-3 w-3 shrink-0" aria-hidden />
                {selected.scope === 'agency'
                  ? 'Agency notes are internal to your team. Clients never see them.'
                  : 'Client notes are internal to the agency and are never shown in the client portal.'}
              </p>
            )}

            {preview ? (
              <div
                className="prose-luna mt-3 min-h-[240px] flex-1 overflow-y-auto text-sm leading-relaxed text-fg [&_a]:text-sky [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_h3]:mt-3 [&_h3]:text-base [&_h3]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-2"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(selected.body) }}
              />
            ) : (
              <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                onInput={handleInput}
                onBlur={() => {
                  if (pending.current && selectedIdRef.current) {
                    const payload = pending.current;
                    pending.current = null;
                    void persist(selectedIdRef.current, payload);
                  }
                }}
                role="textbox"
                aria-multiline="true"
                aria-label="Note body"
                data-placeholder="Start writing…"
                className="mt-3 min-h-[240px] flex-1 overflow-y-auto text-sm leading-relaxed text-fg outline-none empty:before:text-faint empty:before:content-[attr(data-placeholder)]"
              />
            )}
          </section>
        ) : (
          <section className="surface flex items-center justify-center p-6">
            <EmptyState
              icon={<StickyNote className="h-6 w-6" />}
              title="Select a note"
              description="Choose a note on the left, or create a new one. Edits save automatically."
            />
          </section>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={removeNote}
        busy={busy}
        title="Delete this note?"
        confirmLabel="Delete note"
        body={
          <>
            <strong className="text-fg">{confirmDelete?.title || 'Untitled note'}</strong> will be permanently deleted.
            Consider archiving it instead if you may need it later.
          </>
        }
      />

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {[
          { title: 'Private by default', body: 'Notes you create are readable only by your account.' },
          { title: 'Autosave, visibly', body: 'The save indicator tells you the moment a write lands — and shouts if it fails.' },
          { title: 'Rich text, safely', body: 'Formatting is allow-listed and sanitised before it is rendered.' },
        ].map((item) => (
          <div key={item.title} className="surface-flat p-3.5">
            <p className="text-[12px] font-medium text-fg">{item.title}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">{item.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolbarButton({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="rounded-md p-1.5 text-muted transition hover:bg-raised hover:text-fg"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function InputTags({ note, onSave }: { note: Note; onSave: (tags: string[]) => void }) {
  const [value, setValue] = useState(note.tags.join(', '));
  useEffect(() => setValue(note.tags.join(', ')), [note.id, note.tags]);
  return (
    <Field className="min-w-[10rem] flex-1 sm:max-w-[16rem]">
      {(id) => (
        <TextInput
          id={id}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            const tags = value
              .split(',')
              .map((t) => t.trim().toLowerCase())
              .filter(Boolean)
              .slice(0, 8);
            if (tags.join(',') !== note.tags.join(',')) onSave(tags);
          }}
          placeholder="tags, comma separated"
          className="py-1 text-[11px]"
          aria-label="Tags"
        />
      )}
    </Field>
  );
}
