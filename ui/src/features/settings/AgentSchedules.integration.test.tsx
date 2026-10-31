import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { UnsavedChangesProvider } from '../../app/UnsavedChanges';
import type { ScheduleProject, ScheduledJob, ScheduleTask } from './schedules';
import { AgentSchedules } from './AgentSchedules';

vi.mock('../../app/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  api: vi.fn(),
}));

const apiMock = vi.mocked(api);
const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const schedulePath = (agentId = AGENT_A) => `/api/scheduled-jobs?agentId=${encodeURIComponent(agentId)}`;

function job(changes: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'job-1',
    agentId: AGENT_A,
    name: 'Morning briefing',
    jobKind: 'prompt',
    prompt: 'Prepare the briefing.',
    taskId: null,
    extraInstructions: '',
    scheduleKind: 'cron',
    cron: '0 9 * * *',
    runAt: null,
    enabled: true,
    modelConnectionId: null,
    model: null,
    ...changes,
  };
}

function task(changes: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    id: 'task-1',
    projectId: 'project-1',
    title: 'Prepare release notes',
    status: 'todo',
    assignedAgentId: AGENT_A,
    ...changes,
  };
}

function project(changes: Partial<ScheduleProject> = {}): ScheduleProject {
  return { id: 'project-1', name: 'Release', ...changes };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function mountSchedules({ agentId = AGENT_A, onOpenChat }: { agentId?: string; onOpenChat?: (sessionId: string, agentId: string) => void } = {}) {
  return render(<ConfirmProvider><UnsavedChangesProvider><AgentSchedules agentId={agentId} savedProviders={[]} onOpenChat={onOpenChat} /></UnsavedChangesProvider></ConfirmProvider>);
}

function mutationCalls(method: 'POST' | 'PATCH') {
  return apiMock.mock.calls.filter(([, init]) => init?.method === method);
}

function bodyOf(call: (typeof apiMock.mock.calls)[number]) {
  return JSON.parse(String(call[1]?.body));
}

function taskOptions() {
  return Array.from((screen.getByLabelText('Task') as HTMLSelectElement).options);
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('AgentSchedules integration', () => {
  it('offers only this agent’s unarchived ToDo records in project groups, defaults the title, preserves a custom name, and posts task context without task prose', async () => {
    const tasks = [
      task({ id: 'todo-release', projectId: 'release', title: 'Prepare release notes' }),
      task({ id: 'todo-quality', projectId: 'quality', title: 'Audit keyboard support' }),
      task({ id: 'other-agent', title: 'Other agent task', assignedAgentId: AGENT_B }),
      task({ id: 'unassigned', title: 'Unassigned task', assignedAgentId: null }),
      task({ id: 'in-progress', title: 'In-progress task', status: 'in_progress' }),
      task({ id: 'archived', title: 'Archived task', archived: true }),
    ];
    const projects = [project({ id: 'release', name: 'Release operations' }), project({ id: 'quality', name: 'Quality' })];
    apiMock.mockImplementation(async (path, init) => {
      if (path === '/api/settings/timezone') return { timezone: 'UTC' };
      if (path === schedulePath()) return { jobs: [] };
      if (path === '/api/task-board/tasks') return { tasks };
      if (path === '/api/task-board/projects') return { projects };
      if (path === '/api/scheduled-jobs' && init?.method === 'POST') return { ok: true };
      throw new Error(`Unexpected offline API request: ${path}`);
    });

    mountSchedules();
    await screen.findByText('No scheduled jobs for this agent.');
    fireEvent.change(screen.getByLabelText('Run'), { target: { value: 'task' } });
    await screen.findByRole('option', { name: 'Prepare release notes' });

    const picker = screen.getByLabelText('Task') as HTMLSelectElement;
    expect(Array.from(picker.querySelectorAll('optgroup')).map(group => group.label)).toEqual(['Release operations', 'Quality']);
    expect(taskOptions().map(option => option.textContent)).toEqual([
      'Choose a ToDo task', 'Prepare release notes', 'Audit keyboard support',
    ]);
    expect(screen.queryByRole('option', { name: 'Other agent task' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Unassigned task' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'In-progress task' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Archived task' })).toBeNull();

    fireEvent.change(picker, { target: { value: 'todo-release' } });
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Prepare release notes');
    fireEvent.change(picker, { target: { value: 'todo-quality' } });
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Audit keyboard support');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Custom review schedule' } });
    fireEvent.change(picker, { target: { value: 'todo-release' } });
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Custom review schedule');
    expect((screen.getByLabelText('Extra instructions (optional)') as HTMLTextAreaElement).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Add job' }));
    await waitFor(() => expect(mutationCalls('POST')).toHaveLength(1));
    const payload = bodyOf(mutationCalls('POST')[0]);
    expect(payload).toMatchObject({
      agentId: AGENT_A,
      name: 'Custom review schedule',
      jobKind: 'task',
      prompt: '',
      taskId: 'todo-release',
      extraInstructions: '',
      sessionId: 'default',
      contextMode: 'continue',
      scheduleKind: 'cron',
      cron: '0 9 * * *',
      runAt: null,
      enabled: true,
    });
    expect(payload).not.toHaveProperty('taskTitle');
    expect(payload).not.toHaveProperty('taskDescription');
    expect(apiMock.mock.calls.some(([path]) => path.endsWith('/trigger'))).toBe(false);
  });

  it('drops stale task state when switching to a prompt and drops cron state when switching to once', async () => {
    const tasks = [task({ id: 'todo-1', title: 'Task state that must not leak' })];
    apiMock.mockImplementation(async (path, init) => {
      if (path === '/api/settings/timezone') return { timezone: 'UTC' };
      if (path === schedulePath()) return { jobs: [] };
      if (path === '/api/task-board/tasks') return { tasks };
      if (path === '/api/task-board/projects') return { projects: [project()] };
      if (path === '/api/scheduled-jobs' && init?.method === 'POST') return { ok: true };
      throw new Error(`Unexpected offline API request: ${path}`);
    });

    mountSchedules();
    await screen.findByText('No scheduled jobs for this agent.');
    fireEvent.change(screen.getByLabelText('Run'), { target: { value: 'task' } });
    const picker = await screen.findByLabelText('Task') as HTMLSelectElement;
    await waitFor(() => expect(picker.disabled).toBe(false));
    fireEvent.change(picker, { target: { value: 'todo-1' } });
    fireEvent.change(screen.getByLabelText('Extra instructions (optional)'), { target: { value: 'Do not retain this task-only text.' } });
    fireEvent.change(screen.getByLabelText('Run'), { target: { value: 'prompt' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Prompt once' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Use only this prompt.' } });
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'once' } });
    fireEvent.change(screen.getByLabelText('Run at'), { target: { value: '2026-08-04T09:15' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add job' }));
    await waitFor(() => expect(mutationCalls('POST')).toHaveLength(1));
    const payload = bodyOf(mutationCalls('POST')[0]);
    expect(payload).toMatchObject({
      jobKind: 'prompt',
      prompt: 'Use only this prompt.',
      taskId: null,
      extraInstructions: '',
      scheduleKind: 'once',
      cron: null,
      runAt: '2026-08-04T09:15',
    });
    expect(payload).not.toHaveProperty('sessionId');
    expect(payload).not.toHaveProperty('contextMode');
  });

  it('drops a stale one-time datetime when switching back to a recurring prompt', async () => {
    apiMock.mockImplementation(async (path, init) => {
      if (path === '/api/settings/timezone') return { timezone: 'UTC' };
      if (path === schedulePath()) return { jobs: [] };
      if (path === '/api/scheduled-jobs' && init?.method === 'POST') return { ok: true };
      throw new Error(`Unexpected offline API request: ${path}`);
    });

    mountSchedules();
    await screen.findByText('No scheduled jobs for this agent.');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Recurring prompt' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Only recurring state should remain.' } });
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'once' } });
    fireEvent.change(screen.getByLabelText('Run at'), { target: { value: '2026-08-04T09:15' } });
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'cron' } });
    fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '15 7 * * 1' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add job' }));
    await waitFor(() => expect(mutationCalls('POST')).toHaveLength(1));
    expect(bodyOf(mutationCalls('POST')[0])).toMatchObject({
      jobKind: 'prompt',
      scheduleKind: 'cron',
      cron: '15 7 * * 1',
      runAt: null,
    });
  });

  it('shows a saved one-time ISO instant in the operator zone, retains it untouched, and sends an edited datetime-local value without an offset', async () => {
    const runAt = '2026-07-15T12:05:00Z';
    const onceJob = job({
      id: 'once-job',
      name: 'DST-safe one-time job',
      prompt: 'Run once.',
      scheduleKind: 'once',
      cron: null,
      runAt,
      effectiveTimezone: 'America/New_York',
    });
    apiMock.mockImplementation(async (path, init) => {
      if (path === '/api/settings/timezone') return { timezone: 'America/New_York' };
      if (path === schedulePath()) return { jobs: [onceJob] };
      if (path === '/api/scheduled-jobs/once-job' && init?.method === 'PATCH') return { ok: true };
      throw new Error(`Unexpected offline API request: ${path}`);
    });

    mountSchedules();
    const expectedDisplay = new Intl.DateTimeFormat(undefined, {
      timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(runAt));
    const selector = await screen.findByRole('button', { name: /DST-safe one-time job/ });
    expect(selector.textContent).toContain(`Once · ${expectedDisplay} · America/New_York`);
    fireEvent.click(selector);
    // datetime-local canonicalizes a zero-seconds value without the optional :00 in jsdom.
    expect((screen.getByLabelText('Run at') as HTMLInputElement).value).toBe('2026-07-15T08:05');

    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));
    await waitFor(() => expect(mutationCalls('PATCH')).toHaveLength(1));
    expect(bodyOf(mutationCalls('PATCH')[0])).toMatchObject({ scheduleKind: 'once', cron: null, runAt });

    fireEvent.click(await screen.findByRole('button', { name: /DST-safe one-time job/ }));
    fireEvent.change(screen.getByLabelText('Run at'), { target: { value: '2026-07-15T09:45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));
    await waitFor(() => expect(mutationCalls('PATCH')).toHaveLength(2));
    const edited = bodyOf(mutationCalls('PATCH')[1]);
    expect(edited).toMatchObject({ scheduleKind: 'once', cron: null, runAt: '2026-07-15T09:45' });
    expect(edited.runAt.endsWith('Z')).toBe(false);
    expect(edited.runAt).not.toMatch(/[+-]\d{2}:\d{2}$/);
  });

  it('normalizes a legacy prompt/cron record on PATCH and saving never dispatches a run', async () => {
    const legacy = job({
      id: 'legacy-job',
      name: 'Legacy weekly briefing',
      prompt: 'Keep this legacy prompt.',
      cron: '15 6 * * 1-5',
      enabled: false,
    });
    delete legacy.jobKind;
    delete legacy.scheduleKind;
    delete legacy.taskId;
    delete legacy.extraInstructions;
    delete legacy.runAt;
    apiMock.mockImplementation(async (path, init) => {
      if (path === '/api/settings/timezone') return { timezone: 'UTC' };
      if (path === schedulePath()) return { jobs: [legacy] };
      if (path === '/api/scheduled-jobs/legacy-job' && init?.method === 'PATCH') return { ok: true };
      throw new Error(`Unexpected offline API request: ${path}`);
    });

    mountSchedules();
    fireEvent.click(await screen.findByRole('button', { name: /Legacy weekly briefing/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));
    await waitFor(() => expect(mutationCalls('PATCH')).toHaveLength(1));
    const payload = bodyOf(mutationCalls('PATCH')[0]);
    expect(payload).toMatchObject({
      name: 'Legacy weekly briefing',
      jobKind: 'prompt',
      prompt: 'Keep this legacy prompt.',
      taskId: null,
      extraInstructions: '',
      scheduleKind: 'cron',
      cron: '15 6 * * 1-5',
      runAt: null,
      enabled: false,
      modelConnectionId: null,
      model: null,
    });
    expect(payload).not.toHaveProperty('timezone');
    expect(payload).not.toHaveProperty('sessionId');
    expect(apiMock.mock.calls.some(([path]) => path.endsWith('/trigger'))).toBe(false);
  });

  it.each([
    ['changed status', task({ id: 'changed-task', status: 'in_progress' }), 'In Progress'],
    ['missing task', null, 'Task no longer exists'],
    ['reassigned task', task({ id: 'reassigned-task', assignedAgentId: AGENT_B }), 'Assigned to another agent'],
    ['archived task', task({ id: 'archived-task', archived: true }), 'Archived'],
  ] as const)('retains a %s selection as a disabled saved ID and permits PATCH pause', async (_label, changedTask, problem) => {
    const taskId = changedTask?.id ?? 'missing-task';
    const retained = job({
      id: `retained-${taskId}`,
      name: `Retained ${taskId}`,
      jobKind: 'task',
      prompt: '',
      taskId,
      extraInstructions: '',
      scheduleKind: 'cron',
      cron: '0 9 * * *',
      enabled: true,
    });
    apiMock.mockImplementation(async (path, init) => {
      if (path === '/api/settings/timezone') return { timezone: 'UTC' };
      if (path === schedulePath()) return { jobs: [retained] };
      if (path === '/api/task-board/tasks') return { tasks: changedTask ? [changedTask, task({ id: 'eligible-replacement', title: 'Eligible replacement' })] : [task({ id: 'eligible-replacement', title: 'Eligible replacement' })] };
      if (path === '/api/task-board/projects') return { projects: [project()] };
      if (path === `/api/scheduled-jobs/${retained.id}` && init?.method === 'PATCH') return { ok: true };
      throw new Error(`Unexpected offline API request: ${path}`);
    });

    mountSchedules();
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(retained.name) }));
    const picker = await screen.findByLabelText('Task') as HTMLSelectElement;
    await waitFor(() => expect(picker.disabled).toBe(false));
    expect(picker.value).toBe(taskId);
    const retainedOptions = Array.from(picker.options).filter(option => option.value === taskId);
    expect(retainedOptions).toHaveLength(1);
    expect(retainedOptions[0].disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain(problem);
    expect(screen.getByRole('option', { name: 'Eligible replacement' })).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));
    await waitFor(() => expect(mutationCalls('PATCH')).toHaveLength(1));
    expect(bodyOf(mutationCalls('PATCH')[0])).toMatchObject({
      jobKind: 'task', taskId, enabled: false, sessionId: 'default', contextMode: 'continue',
    });
  });

  it('reports an explicit skipped trigger without claiming it started and refreshes the list afterward', async () => {
    const initial = job({ id: 'skip-job', name: 'Eligibility guard', enabled: false });
    const refreshed = job({ id: 'skip-job', name: 'Eligibility guard refreshed', enabled: false });
    let reads = 0;
    apiMock.mockImplementation(async (path, init) => {
      if (path === '/api/settings/timezone') return { timezone: 'UTC' };
      if (path === schedulePath()) return { jobs: ++reads === 1 ? [initial] : [refreshed] };
      if (path === '/api/scheduled-jobs/skip-job/trigger' && init?.method === 'POST') return { ok: true, skipped: true, reason: 'The saved task is archived.' };
      throw new Error(`Unexpected offline API request: ${path}`);
    });

    mountSchedules();
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('Eligibility guard skipped. The saved task is archived.');
    expect(notice.textContent).not.toContain('started');
    expect(await screen.findByRole('button', { name: /Eligibility guard refreshed/ })).toBeTruthy();
    expect(apiMock.mock.calls.filter(([path]) => path === schedulePath())).toHaveLength(2);
  });

  it.each(['Stay', 'Discard', 'Save'] as const)('uses the shared unsaved guard before chat navigation: %s', async choice => {
    const chat = vi.fn();
    const chatJob = job({
      id: 'chat-guard-job',
      name: 'Chat guard job',
      lastRun: { status: 'completed', sessionId: 'session-guard', agentId: 'agent-from-receipt', runId: 'run-guard' },
    });
    apiMock.mockImplementation(async (path, init) => {
      if (path === '/api/settings/timezone') return { timezone: 'UTC' };
      if (path === schedulePath()) return { jobs: [chatJob] };
      if (path === '/api/scheduled-jobs/chat-guard-job' && init?.method === 'PATCH') return { ok: true };
      throw new Error(`Unexpected offline API request: ${path}`);
    });

    mountSchedules({ onOpenChat: chat });
    fireEvent.click(await screen.findByRole('button', { name: /Chat guard job/, pressed: false }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Unsaved schedule prompt.' } });
    fireEvent.click(screen.getByRole('button', { name: /^Open chat/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Unsaved changes' });
    expect(chat).not.toHaveBeenCalled();

    fireEvent.click(dialog.querySelector(`button${choice === 'Save' ? '.primary' : choice === 'Discard' ? '.danger' : '.secondary'}`) as HTMLButtonElement);
    if (choice === 'Stay') {
      expect(chat).not.toHaveBeenCalled();
      expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Unsaved schedule prompt.');
      expect(mutationCalls('PATCH')).toHaveLength(0);
    } else {
      await waitFor(() => expect(chat).toHaveBeenCalledWith('session-guard', 'agent-from-receipt'));
      if (choice === 'Discard') {
        expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Prepare the briefing.');
        expect(mutationCalls('PATCH')).toHaveLength(0);
      } else {
        expect(mutationCalls('PATCH')).toHaveLength(1);
        expect(bodyOf(mutationCalls('PATCH')[0]).prompt).toBe('Unsaved schedule prompt.');
      }
    }
  });

  it('opens chat with the exact result session and receipt agent, and does not offer a link for skipped results', async () => {
    const openChat = vi.fn();
    const completed = job({
      id: 'completed-job',
      name: 'Completed receipt',
      lastRun: { status: 'completed', sessionId: 'session-exact', agentId: 'agent-exact', runId: 'run-exact' },
    });
    const skipped = job({
      id: 'skipped-job',
      name: 'Skipped receipt',
      lastRun: { status: 'skipped', sessionId: 'session-do-not-open', agentId: 'agent-do-not-open', runId: 'run-skipped' },
    });
    apiMock.mockImplementation(async path => {
      if (path === '/api/settings/timezone') return { timezone: 'UTC' };
      if (path === schedulePath()) return { jobs: [completed, skipped] };
      throw new Error(`Unexpected offline API request: ${path}`);
    });

    mountSchedules({ onOpenChat: openChat });
    fireEvent.click(await screen.findByRole('button', { name: /^Open chat/ }));
    expect(openChat).toHaveBeenCalledWith('session-exact', 'agent-exact');
    expect(screen.queryAllByRole('button', { name: /^Open chat/ })).toHaveLength(1);
  });

  it('ignores an old task-board response after agent ownership changes', async () => {
    const oldTasks = deferred<{ tasks: ScheduleTask[] }>();
    const oldProjects = deferred<{ projects: ScheduleProject[] }>();
    let servingAgentB = false;
    const aJob = job({ id: 'a-task-job', agentId: AGENT_A, name: 'A task schedule', jobKind: 'task', prompt: '', taskId: 'a-task' });
    const bJob = job({ id: 'b-task-job', agentId: AGENT_B, name: 'B task schedule', jobKind: 'task', prompt: '', taskId: 'b-task' });
    apiMock.mockImplementation((path) => {
      if (path === '/api/settings/timezone') return Promise.resolve({ timezone: 'UTC' });
      if (path === schedulePath(AGENT_A)) return Promise.resolve({ jobs: [aJob] });
      if (path === schedulePath(AGENT_B)) return Promise.resolve({ jobs: [bJob] });
      if (path === '/api/task-board/tasks') return servingAgentB ? Promise.resolve({ tasks: [task({ id: 'b-task', title: 'B board task', assignedAgentId: AGENT_B })] }) : oldTasks.promise;
      if (path === '/api/task-board/projects') return servingAgentB ? Promise.resolve({ projects: [project({ name: 'B project' })] }) : oldProjects.promise;
      throw new Error(`Unexpected offline API request: ${path}`);
    });

    const view = mountSchedules();
    await screen.findByRole('button', { name: /A task schedule/ });
    await waitFor(() => expect(apiMock.mock.calls.some(([path]) => path === '/api/task-board/tasks')).toBe(true));
    servingAgentB = true;
    view.rerender(<ConfirmProvider><UnsavedChangesProvider><AgentSchedules agentId={AGENT_B} savedProviders={[]} /></UnsavedChangesProvider></ConfirmProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /B task schedule/ }));
    const picker = await screen.findByLabelText('Task') as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe('b-task'));
    await act(async () => {
      oldTasks.resolve({ tasks: [task({ id: 'a-task', title: 'A stale board task' })] });
      oldProjects.resolve({ projects: [project({ name: 'A stale project' })] });
      await Promise.all([oldTasks.promise, oldProjects.promise]);
    });
    expect((screen.getByLabelText('Task') as HTMLSelectElement).value).toBe('b-task');
    expect(screen.queryByRole('option', { name: 'A stale board task' })).toBeNull();
  });

  it('ignores an old trigger response after switching agent ownership', async () => {
    const trigger = deferred<{ ok: boolean }>();
    const aJob = job({ id: 'a-trigger-job', name: 'A trigger job' });
    const bJob = job({ id: 'b-trigger-job', agentId: AGENT_B, name: 'B trigger job' });
    apiMock.mockImplementation((path, init) => {
      if (path === '/api/settings/timezone') return Promise.resolve({ timezone: 'UTC' });
      if (path === schedulePath(AGENT_A)) return Promise.resolve({ jobs: [aJob] });
      if (path === schedulePath(AGENT_B)) return Promise.resolve({ jobs: [bJob] });
      if (path === '/api/scheduled-jobs/a-trigger-job/trigger' && init?.method === 'POST') return trigger.promise;
      throw new Error(`Unexpected offline API request: ${path}`);
    });

    const view = mountSchedules();
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(apiMock.mock.calls.some(([path]) => path === '/api/scheduled-jobs/a-trigger-job/trigger')).toBe(true));
    view.rerender(<ConfirmProvider><UnsavedChangesProvider><AgentSchedules agentId={AGENT_B} savedProviders={[]} /></UnsavedChangesProvider></ConfirmProvider>);
    await screen.findByRole('button', { name: /B trigger job/ });
    await act(async () => { trigger.resolve({ ok: true }); await trigger.promise; });
    expect(screen.queryByText('A trigger job started. The run continues in the background.')).toBeNull();
    expect(screen.getByRole('button', { name: /B trigger job/ })).toBeTruthy();
    expect(apiMock.mock.calls.filter(([path]) => path === schedulePath(AGENT_A) || path === schedulePath(AGENT_B))).toHaveLength(2);
  });

  it('shows a task-board read failure and makes Retry tasks populate the picker', async () => {
    let boardAvailable = false;
    apiMock.mockImplementation(async path => {
      if (path === '/api/settings/timezone') return { timezone: 'UTC' };
      if (path === schedulePath()) return { jobs: [] };
      if (path === '/api/task-board/tasks') {
        if (!boardAvailable) throw new Error('board offline');
        return { tasks: [task({ id: 'retry-task', title: 'Retried ToDo' })] };
      }
      if (path === '/api/task-board/projects') return { projects: [project()] };
      throw new Error(`Unexpected offline API request: ${path}`);
    });

    mountSchedules();
    await screen.findByText('No scheduled jobs for this agent.');
    fireEvent.change(screen.getByLabelText('Run'), { target: { value: 'task' } });
    const picker = await screen.findByLabelText('Task') as HTMLSelectElement;
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load task board: board offline');
    expect(picker.disabled).toBe(true);

    boardAvailable = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry tasks' }));
    await screen.findByRole('option', { name: 'Retried ToDo' });
    expect((screen.getByLabelText('Task') as HTMLSelectElement).disabled).toBe(false);
  });

  it('disables one-time scheduling while the operator timezone is unavailable and enables it after retry', async () => {
    let timezoneAttempts = 0;
    apiMock.mockImplementation(async (path, init) => {
      if (path === '/api/settings/timezone') {
        timezoneAttempts += 1;
        if (timezoneAttempts === 1) throw new Error('timezone offline');
        return { timezone: 'UTC' };
      }
      if (path === schedulePath()) return { jobs: [] };
      if (path === '/api/scheduled-jobs' && init?.method === 'POST') return { ok: true };
      throw new Error(`Unexpected offline API request: ${path}`);
    });

    mountSchedules();
    await screen.findByText('No scheduled jobs for this agent.');
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'once' } });
    const runAt = screen.getByLabelText('Run at') as HTMLInputElement;
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load operator timezone.');
    expect(runAt.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Add job' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Retry timezone' }));
    await waitFor(() => expect(runAt.disabled).toBe(false));
    expect(screen.getByText('Operator timezone · UTC')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Recovered one-time job' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Run after zone recovery.' } });
    fireEvent.change(runAt, { target: { value: '2026-08-04T09:15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add job' }));
    await waitFor(() => expect(mutationCalls('POST')).toHaveLength(1));
    expect(bodyOf(mutationCalls('POST')[0])).toMatchObject({ scheduleKind: 'once', cron: null, runAt: '2026-08-04T09:15' });
  });

  it('keeps the newest same-agent board refresh when an earlier read completes late', async () => {
    const older = deferred<{ tasks: ScheduleTask[] }>();
    let taskReads = 0;
    apiMock.mockImplementation(async path => {
      if (path === '/api/settings/timezone') return { timezone: 'UTC' };
      if (path === schedulePath()) return { jobs: [job({ jobKind: 'task', taskId: 'task-1', prompt: '' })] };
      if (path === '/api/task-board/projects') return { projects: [project()] };
      if (path === '/api/task-board/tasks') return ++taskReads === 1 ? older.promise : { tasks: [task({ title: 'Latest saved task' })] };
      throw new Error(`Unexpected offline API request: ${path}`);
    });
    mountSchedules();
    fireEvent.click(await screen.findByRole('button', { name: /Morning briefing/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh jobs' }));
    await screen.findByRole('option', { name: 'Latest saved task' });
    await act(async () => { older.resolve({ tasks: [task({ title: 'Stale saved task' })] }); await older.promise; });
    expect(screen.getByRole('option', { name: 'Latest saved task' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Stale saved task' })).toBeNull();
  });

  it('locks a confirmed create whose follow-up read failed until refresh, without repeating POST', async () => {
    let created = false;
    let refreshAvailable = false;
    apiMock.mockImplementation(async (path, init) => {
      if (path === '/api/settings/timezone') return { timezone: 'UTC' };
      if (path === schedulePath()) {
        if (created && !refreshAvailable) throw new Error('read unavailable');
        return { jobs: created ? [job()] : [] };
      }
      if (path === '/api/scheduled-jobs' && init?.method === 'POST') { created = true; return { ok: true }; }
      throw new Error(`Unexpected offline API request: ${path}`);
    });
    mountSchedules();
    await screen.findByText('No scheduled jobs for this agent.');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Morning briefing' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Saved once.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add job' }));
    await screen.findByText('Schedule saved, but refreshing jobs failed. Reload jobs before another save.');
    const save = screen.getByRole('button', { name: 'Add job' }) as HTMLButtonElement;
    expect(save.closest('fieldset')?.disabled).toBe(true);
    fireEvent.click(save);
    expect(mutationCalls('POST')).toHaveLength(1);
    refreshAvailable = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh jobs' }));
    await screen.findByRole('button', { name: /Morning briefing/ });
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
    expect(mutationCalls('POST')).toHaveLength(1);
  });


  it('ignores an earlier inventory refresh completed during a save and keeps controls busy until committed', async () => {
    const stale = deferred<{ jobs: ScheduledJob[] }>();
    const patch = deferred<{ ok: boolean }>();
    let reads = 0;
    const initial = job();
    apiMock.mockImplementation(async (path, init) => {
      if (path === '/api/settings/timezone') return { timezone: 'UTC' };
      if (path === schedulePath()) return ++reads === 2 ? stale.promise : { jobs: [reads > 2 ? { ...initial, name: 'Updated job' } : initial] };
      if (init?.method === 'PATCH') return patch.promise;
      throw new Error(`Unexpected offline API request: ${path}`);
    });
    mountSchedules();
    fireEvent.click(await screen.findByRole('button', { name: /Morning briefing/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh jobs' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated job' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));
    await act(async () => { stale.resolve({ jobs: [initial] }); await stale.promise; });
    expect((screen.getByLabelText('Name') as HTMLInputElement).closest('fieldset')?.disabled).toBe(true);
    await act(async () => { patch.resolve({ ok: true }); await patch.promise; });
    await screen.findByRole('button', { name: /Updated job/ });
    expect(screen.queryByRole('button', { name: /Morning briefing/ })).toBeNull();
    expect(mutationCalls('PATCH')).toHaveLength(1);
  });

});
