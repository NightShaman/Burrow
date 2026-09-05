import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, type ProgressEntry } from '../../app/api';
import type { Agent } from '../../app/types';
import { useConfirm } from '../../app/ConfirmDialog';

export type ProjectPathEntry = { label: string; path: string; note: string; sortOrder: number };
export type Project = { id: string; name: string; description?: string; notes?: string; pathEntries?: ProjectPathEntry[] };

function normalizePathEntries(project: Project): ProjectPathEntry[] {
  return (project.pathEntries ?? []).map((entry, index) => ({ label: entry.label ?? '', path: entry.path ?? '', note: entry.note ?? '', sortOrder: Number.isFinite(entry.sortOrder) ? entry.sortOrder : index }));
}
type BoardTask = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignedAgentId: string | null;
  metadata: Record<string, unknown>;
  execution?: { runId?: string; status?: string; ok?: boolean; error?: string | null; executedAt?: string | null; result?: { answerText?: string | null; blockers?: string[] } } | null;
  createdAt: string;
  updatedAt: string;
};

type TaskEditorState = { mode: 'create' } | { mode: 'edit'; task: BoardTask };
type ProjectDraft = { id?: string; name: string; description: string; notes: string; pathEntries: ProjectPathEntry[] };

const newProjectDraft = (project?: Project): ProjectDraft => ({ id: project?.id, name: project?.name ?? '', description: project?.description ?? '', notes: project?.notes ?? '', pathEntries: normalizePathEntries(project ?? { id: '', name: '' }) });
type ActiveRun = { runId: string; agentId: string; sessionId: string; status: string; phase?: string; progress?: Array<{ type?: string; data?: Record<string, unknown>; ts?: string }> };
type TaskExecutionState = { taskId: string; runId: string; agentId: string; sessionId: string; progress: ProgressEntry[]; phase: string };

function publicProgressLabel(entry: { type?: string; data?: Record<string, unknown> }) {
  const data = entry.data ?? {};
  if (entry.type === 'model.started') return 'Model started';
  if (entry.type === 'model.completed') return data.ok === false ? 'Model failed' : 'Model completed';
  if (entry.type === 'tool.started') return `Started ${typeof data.label === 'string' ? data.label : typeof data.tool === 'string' ? data.tool.replaceAll('_', ' ') : 'tool'}`;
  if (entry.type === 'tool.completed') return `Completed ${typeof data.label === 'string' ? data.label : typeof data.tool === 'string' ? data.tool.replaceAll('_', ' ') : 'tool'}`;
  if (entry.type === 'verification.completed') return data.ok === false ? 'Verification failed' : 'Verification completed';
  if (entry.type === 'route.decided') return 'Route selected';
  if (entry.type === 'runtime.notice') return 'Runtime notice';
  return 'Working';
}

function activeRunProgress(run: ActiveRun): ProgressEntry[] {
  return (run.progress ?? []).map((entry, index) => ({
    id: `${run.runId}:${index}`,
    text: publicProgressLabel(entry),
    ts: typeof entry.ts === 'string' ? entry.ts : new Date().toISOString(),
    status: 'complete',
  }));
}

function TaskExecutionProgress({ execution }: { execution: TaskExecutionState }) {
  return <section className="task-execution-progress" aria-live="polite" aria-label="Task execution progress">
    <header><div><span className="eyebrow">LIVE EXECUTION</span><h3>{execution.phase === 'streaming' ? 'Agent is working' : 'Starting agent'}</h3></div><span className="task-execution-pulse" aria-hidden="true" /></header>
    {execution.progress.length ? <ol>{execution.progress.map((entry) => <li key={entry.id}><span aria-hidden="true">✓</span><span>{entry.text}</span></li>)}</ol> : <p role="status">Waiting for the first progress update…</p>}
  </section>;
}

const columns = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'todo', title: 'To Do' },
  { id: 'in_progress', title: 'In Progress' },
  { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' },
];

const statusLabel = (status: string) => status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const priorityLabel = (priority: string) => priority.replace(/\b\w/g, (letter) => letter.toUpperCase());
const formatTaskDate = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export function Tasks({ agents }: { agents: Agent[] }) {
  const confirm = useConfirm();
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<TaskEditorState | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectDraft | null>(null);
  const [showProjects, setShowProjects] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [taskExecution, setTaskExecution] = useState<TaskExecutionState | null>(null);

  async function loadBoard() {
    setLoading(true);
    setError('');
    try {
      const [projectResult, taskResult] = await Promise.all([
        api<{ projects: Project[] }>('/api/task-board/projects'),
        api<{ tasks: BoardTask[] }>('/api/task-board/tasks'),
      ]);
      setProjects(projectResult.projects);
      setTasks(taskResult.tasks);
    } catch (loadError) {
      setError(`Could not load the task board: ${(loadError as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadBoard(); }, []);

  useEffect(() => {
    if (!taskExecution) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await api<{ ok: boolean; runs: ActiveRun[] }>(`/api/chat/runs/active?agentId=${encodeURIComponent(taskExecution.agentId)}&sessionId=${encodeURIComponent(taskExecution.sessionId)}`);
        if (cancelled) return;
        const run = response.runs.find((candidate) => candidate.runId === taskExecution.runId);
        if (run) {
          setTaskExecution((current) => current && current.runId === run.runId ? { ...current, phase: run.phase || current.phase, progress: activeRunProgress(run) } : current);
          return;
        }
        setTaskExecution(null);
        const latest = await api<{ task: BoardTask }>(`/api/task-board/tasks/${encodeURIComponent(taskExecution.taskId)}`);
        if (!cancelled) {
          setTasks((current) => current.map((task) => task.id === latest.task.id ? latest.task : task));
          setEditor((current) => current?.mode === 'edit' && current.task.id === latest.task.id ? { mode: 'edit', task: latest.task } : current);
        }
      } catch {
        // Keep the execution panel visible while a transient status poll fails.
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [taskExecution?.agentId, taskExecution?.runId, taskExecution?.sessionId]);

  const visibleTasks = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tasks.filter((task) => {
      if (selectedProjectId && task.projectId !== selectedProjectId) return false;
      return !query || [task.title, task.description, task.priority, statusLabel(task.status)].some((value) => value.toLowerCase().includes(query));
    });
  }, [tasks, selectedProjectId, search]);

  const projectFor = (projectId: string) => projects.find((project) => project.id === projectId);
  // Remote agent IDs are target-qualified for UI identity, but the selected
  // runtime task board owns and validates its unqualified resource ID.
  const agentFor = (agentId: string | null) => agents.find((agent) => (agent.resourceId ?? agent.id) === agentId);
  const editingTask = editor?.mode === 'edit' ? editor.task : null;

  async function saveTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const projectId = String(form.get('projectId') ?? '');
    if (!projectId) { setError('Choose a project before saving the task.'); return; }
    const payload = {
      projectId,
      title: String(form.get('title') ?? ''),
      description: String(form.get('description') ?? ''),
      status: String(form.get('status') ?? 'todo'),
      priority: String(form.get('priority') ?? 'normal'),
      assignedAgentId: String(form.get('assignedAgentId') ?? '') || null,
    };
    setSaving(true);
    setError('');
    try {
      if (editingTask) {
        const result = await api<{ task: BoardTask }>(`/api/task-board/tasks/${encodeURIComponent(editingTask.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        setTasks((current) => current.map((task) => task.id === result.task.id ? result.task : task));
      } else {
        const result = await api<{ task: BoardTask }>('/api/task-board/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        setTasks((current) => [result.task, ...current]);
      }
      setEditor(null);
    } catch (saveError) {
      setError(`Could not save the task: ${(saveError as Error).message}`);
    } finally { setSaving(false); }
  }

  async function deleteTask() {
    if (!editingTask || !await confirm({ title: 'Delete task?', message: `Delete “${editingTask.title}”?`, confirmLabel: 'Delete task', tone: 'danger' })) return;
    setSaving(true);
    setError('');
    try {
      await api(`/api/task-board/tasks/${encodeURIComponent(editingTask.id)}`, { method: 'DELETE' });
      setTasks((current) => current.filter((task) => task.id !== editingTask.id));
      setEditor(null);
    } catch (deleteError) { setError(`Could not delete the task: ${(deleteError as Error).message}`); } finally { setSaving(false); }
  }

  async function executeTask() {
    if (!editingTask) return;
    setSaving(true);
    setError('');
    try {
      const result = await api<{ task: BoardTask; execution?: { runId?: string; agentId?: string; sessionId?: string } }>(`/api/task-board/tasks/${encodeURIComponent(editingTask.id)}/execute`, { method: 'POST' });
      setTasks((current) => current.map((task) => task.id === result.task.id ? result.task : task));
      setEditor({ mode: 'edit', task: result.task });
      if (result.execution?.runId && result.execution.agentId && result.execution.sessionId) {
        setTaskExecution({ taskId: editingTask.id, runId: result.execution.runId, agentId: result.execution.agentId, sessionId: result.execution.sessionId, progress: [], phase: 'thinking' });
      }
    } catch (executeError) { setError(`Could not execute the task: ${(executeError as Error).message}`); } finally { setSaving(false); }
  }

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectDraft) return;
    const body = { name: projectDraft.name, description: projectDraft.description, notes: projectDraft.notes, pathEntries: projectDraft.pathEntries.map((entry, index) => ({ ...entry, sortOrder: index })) };
    setSaving(true);
    setError('');
    try {
      if (projectDraft.id) {
        const result = await api<{ project: Project }>(`/api/task-board/projects/${encodeURIComponent(projectDraft.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        setProjects((current) => current.map((project) => project.id === result.project.id ? result.project : project));
      } else {
        const result = await api<{ project: Project }>('/api/task-board/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        setProjects((current) => [...current, result.project].sort((a, b) => a.name.localeCompare(b.name)));
        setSelectedProjectId(result.project.id);
      }
      setProjectDraft(null);
    } catch (saveError) { setError(`Could not save the project: ${(saveError as Error).message}`); } finally { setSaving(false); }
  }

  async function deleteProject(project: Project) {
    if (!await confirm({ title: 'Delete project?', message: `Delete project “${project.name}” and all of its tasks?`, confirmLabel: 'Delete project', tone: 'danger' })) return;
    setSaving(true);
    setError('');
    try {
      await api(`/api/task-board/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      setProjects((current) => current.filter((item) => item.id !== project.id));
      setTasks((current) => current.filter((task) => task.projectId !== project.id));
      if (selectedProjectId === project.id) setSelectedProjectId('');
    } catch (deleteError) { setError(`Could not delete the project: ${(deleteError as Error).message}`); } finally { setSaving(false); }
  }


  return <div className="tasks-page-shell"><div className="page-view tasks-page">
    <div className="task-toolbar">
      <label className="task-search"><span className="sr-only">Search tasks</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks" /></label>
      <div className="task-project-controls">
        <label className="task-project-select"><span>Project</span><select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}><option value="">All projects</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
        <div className="task-heading-actions"><button className="secondary" type="button" onClick={() => { setShowProjects(true); setProjectDraft(null); }}>Manage projects</button><button className="primary" type="button" disabled={!projects.length} onClick={() => setEditor({ mode: 'create' })}>＋ New task</button></div>
      </div>
    </div>
    {error && <p className="task-board-error" role="alert">{error}</p>}
    {!loading && !projects.length && <section className="task-empty-state"><h2>No projects yet</h2><p>Create a project before adding work to the board.</p><button className="primary" type="button" onClick={() => { setShowProjects(true); setProjectDraft(newProjectDraft()); }}>Add project</button></section>}
    {loading ? <p className="task-loading">Loading task board…</p> : projects.length > 0 && <div className="kanban-board" aria-label="Task board">{columns.map((column) => {
      const columnTasks = visibleTasks.filter((task) => task.status === column.id);
      return <section className="kanban-column" key={column.id}><header><span>{column.title}</span><strong>{columnTasks.length}</strong></header><div className="kanban-cards">{columnTasks.map((task) => <button className="task-card" type="button" key={task.id} onClick={() => setEditor({ mode: 'edit', task })}><span className={`task-priority ${task.priority}`}>{priorityLabel(task.priority)}</span><strong>{task.title}</strong><small>{projectFor(task.projectId)?.name ?? 'Unknown project'}</small><small>Owner · {agentFor(task.assignedAgentId)?.name ?? 'Unassigned'}</small></button>)}{columnTasks.length === 0 && <p className="kanban-empty">No tasks</p>}</div></section>;
    })}</div>}
    {showProjects && <div className="task-detail-backdrop" role="presentation" onMouseDown={() => { setShowProjects(false); setProjectDraft(null); }}><section className="project-manager-panel" role="dialog" aria-modal="true" aria-labelledby="project-manager-title" onMouseDown={(event) => event.stopPropagation()}><header className="task-detail-header"><div><span className="eyebrow">CONFIGURATION</span><h2 id="project-manager-title">Projects</h2></div><button className="task-modal-close" type="button" aria-label="Close project manager" onClick={() => { setShowProjects(false); setProjectDraft(null); }}>×</button></header><div className="project-manager-content">{projectDraft ? <form className="project-form" onSubmit={saveProject}><label className="task-form-field"><span>Project name <b aria-hidden="true">*</b></span><input autoFocus required value={projectDraft.name} onChange={(event) => setProjectDraft({ ...projectDraft, name: event.target.value })} /></label><label className="task-form-field"><span>Description</span><textarea rows={4} value={projectDraft.description} onChange={(event) => setProjectDraft({ ...projectDraft, description: event.target.value })} /></label><label className="task-form-field"><span>Project notes</span><textarea rows={4} value={projectDraft.notes} onChange={(event) => setProjectDraft({ ...projectDraft, notes: event.target.value })} placeholder="Shared context for this project" /></label><fieldset className="project-paths"><legend>Named paths</legend><p className="hint">Reference useful directories or files by label in project-scoped conversations.</p>{projectDraft.pathEntries.map((entry, index) => <div className="project-path-entry" key={index}><input aria-label={`Path ${index + 1} label`} placeholder="Label" value={entry.label} onChange={(event) => setProjectDraft({ ...projectDraft, pathEntries: projectDraft.pathEntries.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) })} /><input aria-label={`Path ${index + 1} path`} placeholder="Path" value={entry.path} onChange={(event) => setProjectDraft({ ...projectDraft, pathEntries: projectDraft.pathEntries.map((item, itemIndex) => itemIndex === index ? { ...item, path: event.target.value } : item) })} /><input aria-label={`Path ${index + 1} note`} placeholder="Note (optional)" value={entry.note} onChange={(event) => setProjectDraft({ ...projectDraft, pathEntries: projectDraft.pathEntries.map((item, itemIndex) => itemIndex === index ? { ...item, note: event.target.value } : item) })} /><button type="button" aria-label={`Remove path ${index + 1}`} onClick={() => setProjectDraft({ ...projectDraft, pathEntries: projectDraft.pathEntries.filter((_, itemIndex) => itemIndex !== index) })}>Remove</button></div>)}<button type="button" onClick={() => setProjectDraft({ ...projectDraft, pathEntries: [...projectDraft.pathEntries, { label: '', path: '', note: '', sortOrder: projectDraft.pathEntries.length }] })}>＋ Add path</button></fieldset><footer><button type="button" onClick={() => setProjectDraft(null)}>Cancel</button><button className="primary" disabled={saving} type="submit">{saving ? 'Saving…' : projectDraft.id ? 'Save project' : 'Add project'}</button></footer></form> : <><button className="primary project-add" type="button" onClick={() => setProjectDraft(newProjectDraft())}>＋ Add project</button><div className="project-list">{projects.map((project) => <article className="project-row" key={project.id}><div><strong>{project.name}</strong>{project.description && <p>{project.description}</p>}</div><div><button type="button" onClick={() => setProjectDraft(newProjectDraft(project))}>Edit</button><button className="task-delete" type="button" disabled={saving} onClick={() => void deleteProject(project)}>Delete</button></div></article>)}{!projects.length && <p className="kanban-empty">No configured projects.</p>}</div></>}</div></section></div>}
    {editor && <div className="task-detail-backdrop" role="presentation" onMouseDown={() => setEditor(null)}><section className="task-detail-panel" role="dialog" aria-modal="true" aria-labelledby="task-editor-title" onMouseDown={(event) => event.stopPropagation()}>{taskExecution && editingTask?.id === taskExecution.taskId && <TaskExecutionProgress execution={taskExecution} />}<header className="task-detail-header"><div><span className="eyebrow">{editingTask ? 'TASK DETAILS' : 'NEW TASK'}</span><h2 id="task-editor-title">{editingTask ? 'Edit task' : 'New task'}</h2></div><button className="task-modal-close" type="button" aria-label="Close task editor" onClick={() => setEditor(null)}>×</button></header><form className="task-detail-form" onSubmit={saveTask}><label className="task-form-field"><span>Title <b aria-hidden="true">*</b></span><input required name="title" defaultValue={editingTask?.title} /></label><label className="task-form-field"><span>Description</span><textarea name="description" rows={5} defaultValue={editingTask?.description} /></label><div className="task-form-grid"><label className="task-form-field"><span>Status</span><select name="status" defaultValue={editingTask?.status ?? 'todo'}>{columns.map((column) => <option key={column.id} value={column.id}>{column.title}</option>)}</select></label><label className="task-form-field"><span>Priority</span><select name="priority" defaultValue={editingTask?.priority ?? 'normal'}>{['critical', 'high', 'normal', 'low'].map((priority) => <option key={priority} value={priority}>{priorityLabel(priority)}</option>)}</select></label><label className="task-form-field"><span>Assignee</span><select name="assignedAgentId" defaultValue={editingTask?.assignedAgentId ?? ''}><option value="">Unassigned</option>{agents.map((agent) => <option value={agent.resourceId ?? agent.id} key={agent.id}>{agent.name}</option>)}</select></label><label className="task-form-field"><span>Project <b aria-hidden="true">*</b></span><select required name="projectId" defaultValue={editingTask?.projectId ?? selectedProjectId}>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label></div>{editingTask && <dl className="task-metadata" aria-label="Task metadata"><div><dt>Created</dt><dd>{formatTaskDate(editingTask.createdAt)}</dd></div><div><dt>Updated</dt><dd>{formatTaskDate(editingTask.updatedAt)}</dd></div></dl>}<footer className="task-detail-actions">{editingTask && <button className="task-execute" disabled={saving || !editingTask.assignedAgentId || ['done', 'cancelled'].includes(editingTask.status)} type="button" onClick={() => void executeTask()}>▷ Execute</button>}<div className="task-editor-primary-actions">{editingTask && <button className="task-delete" disabled={saving} type="button" onClick={() => void deleteTask()}>⌫ Delete</button>}<button className="primary" disabled={saving} type="submit">{saving ? 'Saving…' : editingTask ? 'Save changes' : 'Create task'}</button></div></footer></form></section></div>}
  </div></div>;
}
