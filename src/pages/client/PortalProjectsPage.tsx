import { useMemo, useState } from 'react';
import { FolderKanban } from 'lucide-react';
import { Badge, EmptyState, PageHeader, Segmented, SkeletonRows } from '@/components/ui';
import { useCollection } from '@/context/app';
import { projectStatusMeta } from '@/lib/labels';
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/dates';
import type { Project, ProjectUpdate } from '@/lib/types';

export default function PortalProjectsPage() {
  const { data: projects, loading } = useCollection<Project>('projects');
  const { data: updates } = useCollection<ProjectUpdate>('project_updates');
  const [filter, setFilter] = useState<'open' | 'completed'>('open');

  const listed = projects
    .filter((p) => (filter === 'open' ? !['completed', 'cancelled'].includes(p.status) : ['completed', 'cancelled'].includes(p.status)))
    .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'));

  const updatesFor = useMemo(
    () =>
      (projectId: string) =>
        updates.filter((u) => u.project_id === projectId).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [updates],
  );

  return (
    <div>
      <PageHeader
        eyebrow="Your account"
        title="Projects"
        description="Work in progress, what stage it is at, and the updates your team has shared."
      />

      <div className="mb-4">
        <Segmented
          size="sm"
          ariaLabel="Project filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open', label: 'In progress', count: projects.filter((p) => !['completed', 'cancelled'].includes(p.status)).length },
            { value: 'completed', label: 'Completed', count: projects.filter((p) => ['completed', 'cancelled'].includes(p.status)).length },
          ]}
        />
      </div>

      {loading ? (
        <SkeletonRows rows={3} />
      ) : listed.length === 0 ? (
        <EmptyState icon={<FolderKanban className="h-6 w-6" />} title="No projects to show" description="Projects your team shares with you will appear here." />
      ) : (
        <div className="space-y-3">
          {listed.map((p) => {
            const projectUpdates = updatesFor(p.id);
            const overdue = p.due_date && p.due_date < new Date().toISOString().slice(0, 10) && !['completed', 'cancelled'].includes(p.status);
            return (
              <article key={p.id} className="surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-[13.5px] font-semibold text-fg">{p.name}</h2>
                    {p.description && <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{p.description}</p>}
                  </div>
                  <Badge tone={projectStatusMeta[p.status].tone}>{projectStatusMeta[p.status].label}</Badge>
                </div>

                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-[10px] text-faint">
                    <span>Progress</span>
                    <span className="num">{p.progress}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[rgb(var(--line)/0.12)]">
                    <div className="h-full rounded-full bg-magenta" style={{ width: `${p.progress}%` }} />
                  </div>
                </div>

                <p className={`mt-2 text-[10.5px] ${overdue ? 'text-magenta' : 'text-faint'}`}>
                  {p.due_date ? `${overdue ? 'Target date passed · ' : 'Target '}${fmtDate(p.due_date)}` : 'No target date set'}
                </p>

                {projectUpdates.length > 0 && (
                  <ul className="mt-3 space-y-2 border-t pt-3">
                    {projectUpdates.slice(0, 4).map((u) => (
                      <li key={u.id} className="border-l-2 border-sky/40 pl-2.5">
                        <p className="text-[11.5px] font-medium text-fg">{u.title}</p>
                        {u.body && <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{u.body}</p>}
                        <p className="mt-0.5 text-[9.5px] text-faint" title={fmtDateTime(u.created_at)}>{fmtRelative(u.created_at)}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
