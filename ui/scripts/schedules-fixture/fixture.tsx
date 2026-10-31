import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../src/app/UnsavedChanges';
import type { SavedProvider } from '../../src/app/types';
import { AgentSchedules } from '../../src/features/settings/AgentSchedules';
import type { BoardTask, Project } from '../../src/features/tasks/TasksPage';
import '../../src/app.css';
import './fixture.css';
import { TIMEZONE, normalizeRunAt, taskSelectionProblem } from './contract';

// Everything below is synthetic and lives only in this document's memory.
const AGENT = 'smatchet';

const FIXTURE_TASK = 'task-weekly-review';
const timestamp = '2026-10-20T14:00:00.000Z';
const providers: SavedProvider[] = [
  { id: 'fixture-openai', provider: 'OpenAI — work', apiType: 'openai-responses', url: '', apiKey: '', models: ['gpt-example', 'gpt-example-mini'], modelLabels: { 'gpt-example': 'Example reasoning', 'gpt-example-mini': 'Example fast' } },
  { id: 'fixture-anthropic', provider: 'Anthropic — team', apiType: 'anthropic-messages', url: '', apiKey: '', models: ['claude-example'], modelLabels: { 'claude-example': 'Example Sonnet' } },
];
const initialProjects: Project[] = [
  { id: 'project-release', name: 'Release operations', description: 'Synthetic release planning board.' },
  { id: 'project-quality', name: 'Quality and accessibility', description: 'Synthetic UI quality board.' },
];
function task(id: string, projectId: string, title: string, status = 'todo', assignedAgentId: string | null = AGENT, archived = false): BoardTask {
  return { id, projectId, title, description: 'Synthetic task for schedule acceptance.', status, priority: 'normal', assignedAgentId, metadata: {}, createdAt: timestamp, updatedAt: timestamp, archived, archivedAt: archived ? timestamp : null };
}
const initialTasks: BoardTask[] = [
  task(FIXTURE_TASK, 'project-release', 'Prepare the weekly release readiness summary'),
  task('task-quality', 'project-quality', 'Audit keyboard navigation and accessible labels'),
  task('task-backlog', 'project-release', 'Plan the next release retrospective', 'backlog'),
  task('task-progress', 'project-quality', 'Investigate an in-progress visual regression', 'in_progress'),
  task('task-review', 'project-release', 'Review pending release notes', 'review'),
  task('task-done', 'project-release', 'Verify the completed rollout checklist', 'done'),
  task('task-reassigned', 'project-quality', 'Task reassigned to another agent', 'todo', 'hatchet'),
  task('task-unassigned', 'project-quality', 'Task with no assignee', 'todo', null),
  task('task-archived', 'project-release', 'Archived task not eligible for a new schedule', 'todo', AGENT, true),
];
type LastRun = { status: 'completed' | 'failed' | 'skipped'; error: string | null; completedAt: string; sessionId: string | null; agentId: string | null; runId: string | null };
type Job = {
  id: string; agentId: string; ownerModId: string | null; name: string; jobKind: 'prompt' | 'task';
  prompt: string; taskId: string | null; extraInstructions: string; scheduleKind: 'cron' | 'once';
  cron: string | null; runAt: string | null; enabled: boolean; timezone: string | null; effectiveTimezone: string;
  sessionId: string | null; contextMode: 'continue' | 'fresh' | null;
  modelConnectionId: string | null; model: string | null; nextRunAt: string | null; lastRunAt: string | null; lastRun: LastRun | null;
};
function job(id: string, overrides: Partial<Job>): Job {
  return { id, agentId: AGENT, ownerModId: null, name: 'Synthetic job', jobKind: 'prompt', prompt: '', taskId: null, extraInstructions: '', scheduleKind: 'cron', cron: '0 9 * * 1', runAt: null, enabled: true, timezone: null, effectiveTimezone: TIMEZONE, sessionId: null, contextMode: null, modelConnectionId: null, model: null, nextRunAt: null, lastRunAt: null, lastRun: null, ...overrides };
}
const initialJobs: Job[] = [
  job('job-prompt', { name: 'Morning briefing', prompt: 'Summarize the release board and highlight blockers.', cron: '0 9 * * 1-5', nextRunAt: '2030-06-12T14:00:00.000Z', lastRunAt: '2026-10-23T14:00:00.000Z', lastRun: { status: 'completed', error: null, completedAt: '2026-10-23T14:01:30.000Z', sessionId: 'fixture-session-briefing', agentId: AGENT, runId: 'fixture-run-briefing' } }),
  job('job-task', { name: 'Weekly release readiness task', jobKind: 'task', taskId: FIXTURE_TASK, extraInstructions: '', sessionId: 'default', contextMode: 'continue', cron: '30 8 * * 1', modelConnectionId: 'fixture-anthropic', model: 'claude-example', nextRunAt: '2030-06-17T13:30:00.000Z' }),
  job('job-status-changed', { name: 'Completed checklist — saved task', jobKind: 'task', taskId: 'task-done', extraInstructions: '', sessionId: 'default', contextMode: 'continue', enabled: false, cron: '0 10 * * 2', lastRun: { status: 'skipped', error: 'Task is no longer in To Do.', completedAt: '2026-10-22T15:00:00.000Z', sessionId: null, agentId: AGENT, runId: 'fixture-run-skipped' } }),
  job('job-missing-task', { name: 'Missing task — retained schedule', jobKind: 'task', taskId: 'task-deleted-before-fixture', extraInstructions: '', sessionId: 'default', contextMode: 'continue', cron: '0 11 * * 3', enabled: false, lastRun: { status: 'failed', error: 'Task no longer exists.', completedAt: '2026-10-21T16:00:00.000Z', sessionId: null, agentId: AGENT, runId: 'fixture-run-missing' } }),
  job('job-once', { name: 'One-time review of a deliberately long release readiness and accessibility checklist before the quarterly handoff', prompt: 'Prepare a concise handoff summary with remaining risks.', scheduleKind: 'once', cron: null, runAt: '2030-06-12T14:30:00.000Z', nextRunAt: '2030-06-12T14:30:00.000Z' }),
  job('job-managed', { name: 'Managed nightly digest', ownerModId: 'fixture-release-mod', prompt: 'Summarize fixture activity for the release mod.', cron: '0 3 * * *', enabled: true }),
];

const copy = <T,>(value: T): T => structuredClone(value);
let projects = copy(initialProjects);
let tasks = copy(initialTasks);
let jobs = copy(initialJobs);
let nextId = 1;
let redraw = () => {};
let renderEvidence = () => {};
type RequestRecord = { method: string; path: string; body: unknown; response: unknown; status: number | 'pending' | 'blocked' | 'aborted'; at: string };
type ChatOpenRecord = { sessionId: string; agentId: string; at: string };
const requests: RequestRecord[] = [];
const chatOpens: ChatOpenRecord[] = [];
const unexpected: string[] = [];
const requestEvidence = () => [...requests].reverse();
const latestChatOpen = () => chatOpens.at(-1) ?? null;
function recordChatOpen(sessionId: string, agentId: string) {
  chatOpens.push({ sessionId, agentId, at: new Date().toISOString() });
  renderEvidence();
}

function setTask(id: string, patch: Partial<Pick<BoardTask, 'status' | 'assignedAgentId' | 'archived' | 'archivedAt'>>) {
  if (!tasks.some(item => item.id === id)) throw new Error(`No synthetic task ${id}`);
  tasks = tasks.map(item => item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item);
  redraw();
  renderEvidence();
}
function deleteTask(id: string) {
  if (!tasks.some(item => item.id === id)) throw new Error(`No synthetic task ${id}`);
  tasks = tasks.filter(item => item.id !== id);
  redraw();
  renderEvidence();
}
function restoreTasks() { tasks = copy(initialTasks); redraw(); renderEvidence(); }
function reset() { projects = copy(initialProjects); tasks = copy(initialTasks); jobs = copy(initialJobs); nextId = 1; chatOpens.length = 0; redraw(); renderEvidence(); }
const snapshot = () => copy({ timezone: TIMEZONE, projects, tasks, jobs, chatOpens });
const fixture = {
  requests, chatOpens, unexpected, snapshot,
  setTaskStatus: (id: string, status: string) => {
    if (!['backlog', 'todo', 'in_progress', 'review', 'done'].includes(status)) throw new Error(`Unknown synthetic task status ${status}`);
    setTask(id, { status });
  },
  reassignTask: (id: string, agentId: string | null) => setTask(id, { assignedAgentId: agentId }),
  archiveTask: (id: string, archived = true) => setTask(id, { archived, archivedAt: archived ? new Date().toISOString() : null }),
  deleteTask, restoreTasks, reset, refresh: () => redraw(),
  clearRequests: () => { requests.length = 0; unexpected.length = 0; renderEvidence(); },
  clearChatOpens: () => { chatOpens.length = 0; renderEvidence(); },
};
Object.assign(window, { __schedulesFixture: fixture });

const json = (body: unknown, status = 200) => Response.json(copy(body), { status });
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function queryAllowed(url: URL, allowed: string[]) {
  return [...url.searchParams.keys()].every(key => allowed.includes(key));
}
const writableFields = ['name', 'prompt', 'jobKind', 'taskId', 'extraInstructions', 'sessionId', 'contextMode', 'scheduleKind', 'cron', 'runAt', 'enabled', 'modelConnectionId', 'model'] as const;
function saveJob(body: Record<string, unknown>, previous?: Job): Job {
  const allowed = previous ? writableFields : [...writableFields, 'agentId'];
  const unknown = Object.keys(body).filter(key => !(allowed as readonly string[]).includes(key));
  if (unknown.length) throw new Error(`Unsupported synthetic job fields: ${unknown.join(', ')}`);
  if (!previous && body.agentId !== AGENT) throw new Error('This fixture only accepts the synthetic Smatchet agent');

  const patch: Partial<Job> = {};
  for (const key of writableFields) if (Object.hasOwn(body, key)) Object.assign(patch, { [key]: body[key] });
  const base = previous ? copy(previous) : job(`fixture-new-${nextId++}`, {});
  const saved = { ...base, ...patch } as Job;
  if (saved.jobKind !== 'prompt' && saved.jobKind !== 'task') throw new Error('jobKind must be prompt or task');
  if (saved.scheduleKind !== 'cron' && saved.scheduleKind !== 'once') throw new Error('scheduleKind must be cron or once');
  if (typeof saved.name !== 'string' || !saved.name.trim() || typeof saved.enabled !== 'boolean'
    || typeof saved.prompt !== 'string' || typeof saved.extraInstructions !== 'string'
    || !(saved.modelConnectionId === null || typeof saved.modelConnectionId === 'string')
    || !(saved.model === null || typeof saved.model === 'string')) throw new Error('Invalid synthetic job shape');

  if (saved.jobKind === 'prompt') {
    saved.taskId = null; saved.extraInstructions = ''; saved.sessionId = null; saved.contextMode = null;
  } else {
    saved.prompt = '';
    if (typeof saved.taskId !== 'string' || !saved.taskId) throw new Error('A task job requires a taskId');
    // The integrated task form always sends these defaults. The mock also
    // supplies them for legacy/direct fixture saves so task state is canonical.
    // Task schedules always use the fixture's deterministic continuing session.
    // Inputs attempting another task context are rejected rather than accepted
    // and then silently rewritten.
    if ((Object.hasOwn(body, 'sessionId') && body.sessionId !== 'default') || (Object.hasOwn(body, 'contextMode') && body.contextMode !== 'continue')) {
      throw new Error('Task schedules require sessionId default and contextMode continue');
    }
    saved.sessionId = 'default';
    saved.contextMode = 'continue';
    const problem = taskSelectionProblem(saved, previous, tasks, AGENT);
    if (problem) throw new Error(`Task selection is not eligible: ${problem}`);
  }

  if (saved.scheduleKind === 'cron') {
    if (typeof saved.cron !== 'string' || !saved.cron.trim()) throw new Error('Cron is required for a recurring job');
    saved.runAt = null;
  } else {
    saved.cron = null;
    saved.runAt = normalizeRunAt(saved.runAt);
  }
  if (!(saved.taskId === null || typeof saved.taskId === 'string') || !(saved.cron === null || typeof saved.cron === 'string') || !(saved.runAt === null || typeof saved.runAt === 'string')) throw new Error('Invalid synthetic job shape');

  if (!previous || saved.scheduleKind !== previous.scheduleKind || saved.cron !== previous.cron || saved.runAt !== previous.runAt) {
    saved.nextRunAt = saved.scheduleKind === 'once' ? saved.runAt : null;
  }
  saved.agentId = AGENT;
  saved.timezone = null;
  saved.effectiveTimezone = TIMEZONE;
  // Canonical response shape only: save never dispatches a task, starts a run, or contacts a runtime.
  return saved;
}

window.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  const request = input instanceof Request ? new Request(input, init) : new Request(url, init);
  const method = request.method.toUpperCase();
  const raw = method === 'GET' || method === 'HEAD' ? '' : await request.clone().text();
  let body: unknown = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  const path = url.origin === window.location.origin ? `${url.pathname}${url.search}` : url.href;
  const record: RequestRecord = { method, path, body: copy(body), response: null, status: 'pending', at: new Date().toISOString() };
  requests.push(record);
  const reply = (responseBody: unknown, status = 200) => { record.status = status; record.response = copy(responseBody); renderEvidence(); return json(responseBody, status); };
  const block = () => {
    record.status = 'blocked';
    record.response = { ok: false, error: 'fixture_unmocked_request_blocked' };
    unexpected.push(`${method} ${url.href}`);
    renderEvidence();
    throw new Error(`Unmocked fixture request blocked: ${method} ${url.href}`);
  };
  if (request.signal.aborted) { record.status = 'aborted'; record.response = { ok: false, error: 'fixture_request_aborted' }; renderEvidence(); throw new DOMException('Aborted', 'AbortError'); }
  if (url.origin !== window.location.origin) return block();

  if (method === 'GET' && url.pathname === '/api/settings/timezone' && !url.search) return reply({ ok: true, timezone: TIMEZONE });
  if (method === 'GET' && url.pathname === '/api/task-board/projects' && !url.search) return reply({ ok: true, projects });
  if (method === 'GET' && url.pathname === '/api/task-board/tasks' && queryAllowed(url, ['projectId', 'status', 'priority', 'assignedAgentId'])) {
    const filtered = tasks.filter(item => [...url.searchParams].every(([key, value]) => key === 'projectId'
      ? item.projectId === value || projects.some(project => project.id === item.projectId && project.name.toLowerCase() === value.toLowerCase())
      : item[key as 'status' | 'priority' | 'assignedAgentId'] === value));
    return reply({ ok: true, tasks: filtered });
  }
  const taskMatch = url.pathname.match(/^\/api\/task-board\/tasks\/([^/]+)$/);
  if (method === 'GET' && taskMatch && !url.search) {
    const found = tasks.find(item => item.id === decodeURIComponent(taskMatch[1]));
    return found ? reply({ ok: true, task: found }) : reply({ ok: false, error: 'task_not_found' }, 404);
  }
  if (url.pathname === '/api/scheduled-jobs' && method === 'GET' && queryAllowed(url, ['agentId', 'enabled'])) {
    const found = jobs.filter(item => (!url.searchParams.has('agentId') || item.agentId === url.searchParams.get('agentId')) && (!url.searchParams.has('enabled') || String(item.enabled) === url.searchParams.get('enabled')));
    return reply({ ok: true, jobs: found, activeRuns: [] });
  }
  if (url.pathname === '/api/scheduled-jobs' && method === 'POST' && !url.search) {
    if (!isRecord(body)) return reply({ ok: false, error: 'fixture_invalid_job_body' }, 400);
    try {
      const saved = saveJob(body);
      jobs = [...jobs, saved];
      return reply({ ok: true, job: saved }, 201);
    } catch (cause) {
      return reply({ ok: false, error: cause instanceof Error ? cause.message : 'fixture_invalid_job' }, 400);
    }
  }
  const jobMatch = url.pathname.match(/^\/api\/scheduled-jobs\/([^/]+)(?:\/(trigger))?$/);
  if (jobMatch && !url.search) {
    const found = jobs.find(item => item.id === decodeURIComponent(jobMatch[1]));
    // Deliberately explicit: this fixture demonstrates UI behavior only and cannot execute a schedule or task.
    if (jobMatch[2] === 'trigger' && method === 'POST') return reply({ ok: false, error: 'fixture_execution_disabled' }, 403);
    if (!jobMatch[2] && method === 'GET') return found ? reply({ ok: true, job: found }) : reply({ ok: false, error: 'fixture_job_not_found' }, 404);
    if (!jobMatch[2] && (method === 'PATCH' || method === 'DELETE')) {
      if (!found) return reply({ ok: false, error: 'fixture_job_not_found' }, 404);
      if (found.ownerModId) return reply({ ok: false, error: 'fixture_managed_job_read_only' }, 403);
      if (method === 'DELETE') { jobs = jobs.filter(item => item.id !== found.id); return reply({ ok: true, job: found }); }
      if (!isRecord(body)) return reply({ ok: false, error: 'fixture_invalid_job_body' }, 400);
      try {
        const saved = saveJob(body, found);
        jobs = jobs.map(item => item.id === saved.id ? saved : item);
        return reply({ ok: true, job: saved });
      } catch (cause) {
        return reply({ ok: false, error: cause instanceof Error ? cause.message : 'fixture_invalid_job' }, 400);
      }
    }
  }
  return block();
}) as typeof fetch;

function Fixture() {
  const [overflow, setOverflow] = useState<HTMLElement | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [evidenceEpoch, setEvidenceEpoch] = useState(0);
  const [fixtureStatus, setFixtureStatus] = useState('in_progress');
  const navigate = useUnsavedNavigation();
  useEffect(() => {
    redraw = () => setEpoch(value => value + 1);
    renderEvidence = () => setEvidenceEpoch(value => value + 1);
    return () => { redraw = () => {}; renderEvidence = () => {}; };
  }, []);
  const change = (action: () => void) => navigate(action);
  const target = tasks.find(item => item.id === FIXTURE_TASK);
  const evidence = requestEvidence();
  const lastChatOpen = latestChatOpen();
  return <div className="cockpit settings-mode settings-top-navigation" data-theme="smatchet">
    <div className="app-navigation-stack">
      <header className="app-header"><nav className="page-tabs" aria-label="Primary navigation">{['Chat', 'Tasks', 'Archive', 'Brains', 'Forge', 'Settings'].map(name => <button type="button" key={name} className={name === 'Settings' ? 'active' : ''} aria-current={name === 'Settings' ? 'page' : undefined}>{name}</button>)}</nav></header>
      <div className="settings-navigation-card"><nav className="settings-blank-column settings-prototype-menu" aria-label="Settings sections"><div className="settings-prototype-menu-items">{['General', 'Agents', 'Skills', 'Connections', 'Mods'].map(name => <button type="button" key={name} className={name === 'Agents' ? 'active' : ''} aria-current={name === 'Agents' ? 'page' : undefined}>{name}</button>)}</div></nav></div>
    </div>
    <section className="workspace settings-workspace">
      <main className="settings-blank-slate has-top-navigation has-agent-selector" aria-label="Settings layout prototype">
        <div className="settings-prototype-agent-selector"><div className="agent-toolbar" aria-label="Agent configuration selector"><button className="primary" type="button">New Agent</button><div className="agent-toolbar-selector" role="group" aria-label="Configured agents"><button type="button">Global</button><button type="button" className="active" aria-pressed="true">Smatchet</button><button type="button">Hatchet</button></div></div></div>
        <section className="settings-blank-column settings-prototype-sections"><nav className="settings-prototype-section-items" aria-label="Smatchet settings sections">{['Agent details', 'Profile documents', 'MCP tools', 'Cron jobs', 'Workflow events', 'Dreams', 'Skills'].map(name => <button type="button" key={name} className={name === 'Cron jobs' ? 'active' : ''} aria-current={name === 'Cron jobs' ? 'page' : undefined}>{name}</button>)}</nav></section>
        <section className="settings-blank-column settings-prototype-configuration"><AgentSchedules key={epoch} agentId={AGENT} savedProviders={providers} overflowTarget={overflow} onOpenChat={recordChatOpen} /></section>
        <section className="settings-blank-column settings-prototype-overflow" ref={setOverflow} aria-label="Additional settings" />
      </main>
    </section>
    <footer className="status-bar"><span>Isolated schedules fixture · synthetic data only</span><span role="status">{lastChatOpen ? `Fixture chat callback recorded · ${lastChatOpen.sessionId} · ${lastChatOpen.agentId}` : 'Fixture chat navigation disabled'}</span><span className="status-right">Operator timezone · America/Chicago</span></footer>
    <details className="fixture-controls"><summary>Fixture controls &amp; evidence</summary><div>
      <p>Weekly release task: <strong>{target ? `${target.status} · ${target.assignedAgentId ?? 'unassigned'}${target.archived ? ' · archived' : ''}` : 'deleted'}</strong></p>
      <label>Fixture task state <select aria-label="Fixture task state" value={fixtureStatus} onChange={event => setFixtureStatus(event.target.value)}>{['todo', 'in_progress', 'review', 'done', 'backlog'].map(status => <option key={status} value={status}>{status}</option>)}</select></label>
      <div className="fixture-actions"><button type="button" className="secondary" disabled={!target} onClick={() => change(() => fixture.setTaskStatus(FIXTURE_TASK, fixtureStatus))}>Apply status</button><button type="button" className="secondary" disabled={!target} onClick={() => change(() => fixture.reassignTask(FIXTURE_TASK, 'hatchet'))}>Reassign</button><button type="button" className="secondary" disabled={!target} onClick={() => change(() => fixture.archiveTask(FIXTURE_TASK))}>Archive</button><button type="button" className="danger" disabled={!target} onClick={() => change(() => fixture.deleteTask(FIXTURE_TASK))}>Delete task</button><button type="button" className="secondary" onClick={() => change(fixture.restoreTasks)}>Restore tasks</button><button type="button" className="secondary" onClick={() => change(fixture.reset)}>Reset fixture</button></div>
      <small>Changes stay in this tab. They reload the editor; dirty drafts prompt first.</small>
      <section className="fixture-evidence" aria-label="Fixture evidence" data-evidence-epoch={evidenceEpoch}>
        <div className="fixture-evidence-heading"><strong>Local evidence</strong><div className="fixture-actions"><button type="button" className="secondary" onClick={fixture.clearRequests}>Clear requests</button><button type="button" className="secondary" onClick={fixture.clearChatOpens}>Clear chat record</button></div></div>
        <p>Network: <strong>in-memory fetch only</strong> · unknown paths/origins blocked · trigger returns <strong>403</strong>.</p>
        <p>Open chat: {lastChatOpen ? <strong>recorded · session {lastChatOpen.sessionId} · agent {lastChatOpen.agentId}</strong> : <strong>not invoked</strong>} {lastChatOpen && <small>({lastChatOpen.at})</small>}</p>
        <p>Requests: <strong>{requests.length}</strong>{unexpected.length ? <span className="fixture-evidence-error"> · unexpected {unexpected.length}</span> : ' · no unexpected requests'}</p>
        {evidence.length ? <ol className="fixture-request-log">{evidence.slice(0, 6).map((request, index) => <li key={`${request.at}-${index}`}><code>{request.method} {request.path}</code> <strong>{request.status}</strong>{request.body !== null && <><small>Request</small><pre>{JSON.stringify(request.body, null, 2)}</pre></>}{request.response !== null && <><small>Response</small><pre>{JSON.stringify(request.response, null, 2)}</pre></>}</li>)}</ol> : <small>No requests recorded yet. Initial component reads appear here after load.</small>}
      </section>
    </div></details>
  </div>;
}
createRoot(document.getElementById('root')!).render(<ConfirmProvider><UnsavedChangesProvider><Fixture /></UnsavedChangesProvider></ConfirmProvider>);
