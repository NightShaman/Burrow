import { useEffect, useMemo, useState } from 'react';
import { api, jsonMutation } from '../../app/api';
import type { Agent } from '../../app/types';
import { TaskActivity } from './TaskActivity';
import type { BoardTask, Project } from './TasksPage';

export function taskArchiveDate(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function TaskArchiveShelf({ agents, selectedAgent, selectedDate, search, onCount, onDates }: {
  agents: Agent[]; selectedAgent: string; selectedDate: string; search: string;
  onCount: (count: number) => void; onDates: (dates: string[]) => void;
}) {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    async function refresh() {
      try {
        const [board, projects] = await Promise.all([
          api<{ tasks: BoardTask[] }>('/api/task-board/tasks', { signal: abort.signal }),
          api<{ projects: Project[] }>('/api/task-board/projects', { signal: abort.signal }),
        ]);
        if (!abort.signal.aborted) { setTasks(board.tasks); setProjects(projects.projects); setError(''); }
      } catch (cause) { if (!abort.signal.aborted) setError(`Could not load archived tasks: ${(cause as Error).message}`); }
      finally { if (!abort.signal.aborted) setLoading(false); }
    }
    setLoading(true); void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [retry]);
  const projectName = (id: string) => projects.find(project => project.id === id)?.name ?? 'Unknown project';
  const agentName = (id: string | null) => agents.find(agent => (agent.resourceId ?? agent.id) === id)?.name ?? id ?? 'Unassigned';
  const agentId = agents.find(agent => agent.id === selectedAgent)?.resourceId ?? selectedAgent;
  const archived = useMemo(() => tasks.filter(task => task.archived && (!agentId || task.assignedAgentId === agentId)), [tasks, agentId]);
  const visible = archived.filter(task => (!selectedDate || taskArchiveDate(task.archivedAt) === selectedDate) &&
    (!search.trim() || [task.title, task.description, projectName(task.projectId), agentName(task.assignedAgentId), task.priority].join(' ').toLowerCase().includes(search.trim().toLowerCase())))
    .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '') || a.id.localeCompare(b.id));
  useEffect(() => { onCount(visible.length); }, [visible.length, onCount]);
  useEffect(() => { onDates([...new Set(archived.map(task => taskArchiveDate(task.archivedAt)).filter(Boolean))]); }, [archived, onDates]);
  const selected = visible.find(task => task.id === selectedId);
  async function reopen(task: BoardTask) {
    setReopening(true); setReopenError('');
    try {
      const result = await api<{ task: BoardTask }>(`/api/task-board/tasks/${encodeURIComponent(task.id)}`, jsonMutation('PATCH', { status: 'todo' }));
      setTasks(current => current.map(item => item.id === result.task.id ? result.task : item));
      setSelectedId(current => current === task.id ? '' : current);
    } catch (cause) { setReopenError(`Could not reopen task: ${(cause as Error).message}`); }
    finally { setReopening(false); }
  }
  return <div className="archive-split-view task-archive-shelf">
    <section className="archive-results-pane" aria-label="Archived tasks">
      <div className="archive-pane-heading"><span className="eyebrow">Tasks</span><strong>{visible.length} archived</strong></div>
      {loading && <p role="status">Loading archived tasks…</p>}
      {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry tasks</button></div>}
      <div className="archive-session-list">
        {!loading && !error && !visible.length && <section className="archive-empty-state"><h3>No archived tasks match.</h3></section>}
        {!loading && !error && visible.map(task => <button type="button" key={task.id} aria-pressed={selected?.id === task.id} className={`archive-session-card${selected?.id === task.id ? ' selected' : ''}`} onClick={() => { setSelectedId(task.id); setReopenError(''); }}>
          <div className="archive-session-main"><div className="archive-session-meta"><span>{projectName(task.projectId)}</span><time dateTime={task.archivedAt ?? undefined}>{task.archivedAt ? new Date(task.archivedAt).toLocaleDateString() : ''}</time></div><h3>{task.title}</h3>{task.description && <p>{task.description}</p>}</div>
          <div className="archive-session-side"><span>{agentName(task.assignedAgentId)}</span><em>Done</em></div>
        </button>)}
      </div>
    </section>
    <section className="archive-reader-pane" aria-label="Archived task details">
      {selected && !loading && !error ? <div className="task-archive-reader">
        <header className="archive-reader-toolbar"><div><h2>{selected.title}</h2><p>{projectName(selected.projectId)} · {agentName(selected.assignedAgentId)} · {selected.priority} · Done</p></div><button className="secondary" type="button" disabled={reopening} onClick={() => void reopen(selected)}>{reopening ? 'Reopening…' : 'Reopen task'}</button></header>
        {reopenError && <p role="alert">{reopenError}</p>}
        <div className="archive-content-body"><div className="task-archive-description">{selected.description && <p>{selected.description}</p>}<dl><div><dt>Created</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd></div><div><dt>Archived</dt><dd>{selected.archivedAt ? new Date(selected.archivedAt).toLocaleString() : '—'}</dd></div></dl></div><TaskActivity key={selected.id} taskId={selected.id} revision={selected.updatedAt} readOnly /></div>
      </div> : <div className="archive-reader-empty"><h3>Select a task</h3></div>}
    </section>
  </div>;
}
