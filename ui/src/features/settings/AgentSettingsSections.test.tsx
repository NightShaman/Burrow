import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiForTarget } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import type { ApiTarget } from '../../app/apiTargets';
import { AgentDreams } from './AgentDreams';
import { AgentMcpTools } from './AgentMcpTools';
import { AgentProfileDocuments } from './AgentProfileDocuments';
import { AgentSchedules } from './AgentSchedules';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  apiForTarget: vi.fn(),
}));

const apiMock = vi.mocked(apiForTarget);
const targets: ApiTarget[] = [
  { id: 'local', name: 'Local', baseUrl: '', enabled: true },
  { id: 'node-1', name: 'Node One', baseUrl: 'http://node-one:8787', enabled: true },
];

function pendingRequestSignals() {
  return apiMock.mock.calls.map(([, , init]) => init?.signal).filter((signal): signal is AbortSignal => Boolean(signal));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

const dreamSettings = (overrides = {}) => ({ enabled: false, cron: '0 4 * * *', timezone: 'UTC', prompt: '', modelConnectionId: null, model: null, ...overrides });

afterEach(cleanup);

describe('agent settings sections', () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(() => new Promise(() => undefined));
  });


  it('saves an explicit cron model override without changing the agent model', async () => {
    apiMock.mockImplementation((_target, _path, init) => init?.method === 'POST' ? Promise.resolve({}) : Promise.resolve({ jobs: [] }));
    render(<ConfirmProvider><AgentSchedules agentId="smatchet" targets={targets} savedProviders={[{ id: 'connection-1', provider: 'Claude', apiType: 'anthropic-messages', url: '', apiKey: '', models: ['model-1'] }]} /></ConfirmProvider>);

    await screen.findByText('No cron jobs configured for this agent.');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Briefing' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Prepare it.' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Model/ }), { target: { value: JSON.stringify(['connection-1', 'model-1']) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add job' }));

    await waitFor(() => expect(apiMock.mock.calls.some(([, path, init]) => path === '/api/scheduled-jobs' && init?.method === 'POST')).toBe(true));
    const [, , init] = apiMock.mock.calls.find(([, path, request]) => path === '/api/scheduled-jobs' && request?.method === 'POST')!;
    expect(JSON.parse(init?.body as string)).toMatchObject({ agentId: 'smatchet', modelConnectionId: 'connection-1', model: 'model-1' });
    expect(apiMock.mock.calls.some(([, path]) => path.includes('/api/agents/'))).toBe(false);
  });

  it('saves null cron model fields when inheriting the agent chat model', async () => {
    apiMock.mockImplementation((_target, _path, init) => init?.method === 'POST' ? Promise.resolve({}) : Promise.resolve({ jobs: [] }));
    render(<ConfirmProvider><AgentSchedules agentId="smatchet" targets={targets} savedProviders={[]} /></ConfirmProvider>);

    await screen.findByText('No cron jobs configured for this agent.');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Briefing' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Prepare it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add job' }));

    await waitFor(() => expect(apiMock.mock.calls.some(([, path, init]) => path === '/api/scheduled-jobs' && init?.method === 'POST')).toBe(true));
    const [, , init] = apiMock.mock.calls.find(([, path, request]) => path === '/api/scheduled-jobs' && request?.method === 'POST')!;
    expect(JSON.parse(init?.body as string)).toMatchObject({ modelConnectionId: null, model: null });
  });

  it('shows a persisted unavailable cron override and blocks silent fallback', async () => {
    apiMock.mockResolvedValue({ jobs: [{ id: 'job-1', agentId: 'smatchet', name: 'Briefing', prompt: 'Prepare it.', cron: '0 9 * * *', timezone: 'UTC', enabled: true, modelConnectionId: 'removed', model: 'gone' }] });
    render(<ConfirmProvider><AgentSchedules agentId="smatchet" targets={targets} savedProviders={[]} /></ConfirmProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('alert').textContent).toContain('will not silently fall back');
    expect((screen.getByRole('combobox', { name: /Model/ }) as HTMLSelectElement).value).toBe(JSON.stringify(['removed', 'gone']));
    expect(screen.getByRole('button', { name: 'Save job' }).getAttribute('disabled')).not.toBeNull();
  });

  it('offers Run now for mod-owned jobs without exposing edit or delete and reports scheduler refusal', async () => {
    apiMock.mockImplementation((_target, path, init) => path.endsWith('/trigger') && init?.method === 'POST'
      ? Promise.resolve({ ok: false, error: 'scheduled_job_owner_inactive' })
      : Promise.resolve({ jobs: [{ id: 'owned-1', ownerModId: 'lore-master', agentId: 'smatchet', name: 'Daily lore', prompt: 'Collect', cron: '0 9 * * *', timezone: 'UTC', enabled: true }] }));
    render(<ConfirmProvider><AgentSchedules agentId="smatchet" targets={targets} savedProviders={[]} /></ConfirmProvider>);
    expect(await screen.findByText('Managed by lore-master')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('scheduled_job_owner_inactive'));
    expect(apiMock.mock.calls.some(([, path, init]) => path === '/api/scheduled-jobs/owned-1/trigger' && init?.method === 'POST')).toBe(true);
  });

  it('reports accepted dispatch without claiming the cron run completed', async () => {
    apiMock.mockImplementation((_target, path, init) => path.endsWith('/trigger') && init?.method === 'POST'
      ? Promise.resolve({ ok: true, run: { id: 'run-1' } })
      : Promise.resolve({ jobs: [{ id: 'job-1', agentId: 'smatchet', name: 'Briefing', prompt: 'Prepare it.', cron: '0 9 * * *', timezone: 'UTC', enabled: false }] }));
    render(<ConfirmProvider><AgentSchedules agentId="smatchet" targets={targets} savedProviders={[]} /></ConfirmProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('started. The run continues in the background'));
  });

  it('places recent Dream activity in the fourth column without moving the settings form', async () => {
    apiMock.mockImplementation((_target, path) => Promise.resolve(path.includes('/dream-cycle')
      ? { receipts: [{ runId: 'cycle-1', status: 'completed' }] }
      : { settings: dreamSettings() }));
    const overflow = document.createElement('section');
    document.body.append(overflow);
    const view = render(<AgentDreams agentId="smatchet" targets={targets} savedProviders={[]} overflowTarget={overflow} />);
    await waitFor(() => expect(overflow.textContent).toContain('Completed'));
    expect(view.container.querySelector('textarea')).toBeTruthy();
    expect(view.container.textContent).not.toContain('Recent activity');
    expect(overflow.textContent).toContain('Recent activity');
    view.unmount();
    overflow.remove();
  });

  it('blocks Dream edits until its initial settings request resolves', async () => {
    const load = deferred<{ settings: ReturnType<typeof dreamSettings> }>();
    apiMock.mockReturnValue(load.promise);
    render(<AgentDreams agentId="smatchet" targets={targets} savedProviders={[]} />);

    expect(screen.getByLabelText('Enable scheduled dreaming').getAttribute('disabled')).not.toBeNull();
    expect(screen.getByLabelText('Cron').getAttribute('disabled')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Dream model' }).getAttribute('disabled')).not.toBeNull();
    expect(screen.getByLabelText('Dream prompt').getAttribute('disabled')).not.toBeNull();

    await act(async () => { load.resolve({ settings: dreamSettings() }); });
    expect(screen.getByLabelText('Enable scheduled dreaming').getAttribute('disabled')).toBeNull();
  });

  it('ignores an old Dream save response after switching agents', async () => {
    const firstLoad = deferred<{ settings: ReturnType<typeof dreamSettings> }>();
    const save = deferred<{ settings: ReturnType<typeof dreamSettings> }>();
    const secondLoad = deferred<{ settings: ReturnType<typeof dreamSettings> }>();
    apiMock.mockImplementation((_target, path, init) => {
      if (init?.method === 'PUT') return save.promise;
      if (path.includes('/dream-cycle')) return Promise.resolve({ receipts: [] });
      return apiMock.mock.calls.filter(([, requestPath]) => requestPath.includes('/dream-settings')).length === 1 ? firstLoad.promise : secondLoad.promise;
    });
    const view = render(<AgentDreams agentId="smatchet" targets={targets} savedProviders={[]} />);
    await act(async () => { firstLoad.resolve({ settings: dreamSettings({ prompt: 'Agent A' }) }); });
    await screen.findByDisplayValue('Agent A');
    fireEvent.click(screen.getByRole('button', { name: 'Save dream settings' }));
    expect(screen.getByLabelText('Dream prompt').getAttribute('disabled')).not.toBeNull();

    view.rerender(<AgentDreams agentId="node-1::hatchet" targets={targets} savedProviders={[]} />);
    await act(async () => { secondLoad.resolve({ settings: dreamSettings({ prompt: 'Agent B' }) }); });
    await screen.findByDisplayValue('Agent B');
    await act(async () => { save.resolve({ settings: dreamSettings({ prompt: 'Old save' }) }); });

    expect(screen.getByDisplayValue('Agent B')).toBeTruthy();
    expect(screen.getByLabelText('Dream prompt').getAttribute('disabled')).toBeNull();
  });

  it('shows an unavailable persisted Dream model instead of pretending it inherits', async () => {
    apiMock.mockResolvedValue({ settings: { enabled: false, cron: '0 4 * * *', timezone: 'UTC', prompt: '', modelConnectionId: 'removed-connection', model: 'gone-model' } });
    render(<AgentDreams agentId="smatchet" targets={targets} savedProviders={[]} />);

    expect(await screen.findByText('Unavailable model · removed-connection · gone-model')).toBeTruthy();
  });

  it('shows an unconfigured effective model and its resolution error', async () => {
    apiMock.mockResolvedValue({ settings: { enabled: false, cron: '0 4 * * *', timezone: 'UTC', prompt: '' }, effectiveModel: null, modelResolutionError: 'No chat model is configured for this agent.' });
    render(<AgentDreams agentId="smatchet" targets={targets} savedProviders={[]} />);

    expect(await screen.findByText('Effective model: Unconfigured')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Model resolution error: No chat model is configured for this agent.');
  });

  it('shows the resolved effective Dream model', async () => {
    apiMock.mockResolvedValue({ settings: { enabled: false, cron: '0 4 * * *', timezone: 'UTC', prompt: '' }, effectiveModel: { modelConnectionId: 'connection-1', model: 'model-1' } });
    render(<AgentDreams agentId="smatchet" targets={targets} savedProviders={[{ id: 'connection-1', provider: 'Claude', apiType: 'anthropic-messages', url: '', apiKey: '', models: ['model-1'] }]} />);

    expect(await screen.findByText('Effective model: Claude · model-1')).toBeTruthy();
  });

  it('saves an explicit null model selection when inheritance is chosen', async () => {
    apiMock.mockResolvedValue({ settings: { enabled: false, cron: '0 4 * * *', timezone: 'UTC', prompt: '', modelConnectionId: 'connection-1', model: 'model-1' } });
    render(<AgentDreams agentId="smatchet" targets={targets} savedProviders={[{ id: 'connection-1', provider: 'Claude', apiType: 'anthropic-messages', url: '', apiKey: '', models: ['model-1'] }]} />);

    await screen.findByText('Claude · model-1');
    fireEvent.click(screen.getByRole('button', { name: 'Dream model' }));
    fireEvent.click(screen.getByRole('option', { name: 'Use agent chat model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save dream settings' }));

    await waitFor(() => expect(apiMock.mock.calls.some(([, , init]) => init?.method === 'PUT')).toBe(true));
    const [, , init] = apiMock.mock.calls.find(([, , request]) => request?.method === 'PUT')!;
    expect(JSON.parse(init?.body as string)).toMatchObject({ modelConnectionId: null, model: null });
  });

  it('shows running and interrupted Dream activity with the backend error', async () => {
    apiMock.mockImplementation((_target, path) => path.includes('/dream-cycle')
      ? Promise.resolve({ receipts: [
        { runId: 'running-1', status: 'running', startedAt: '2026-09-18T03:00:00.000Z' },
        { runId: 'interrupted-1', status: 'interrupted', error: 'Dream interrupted by runtime restart before completion', completedAt: '2026-09-18T03:05:00.000Z' },
      ] })
      : Promise.resolve({ settings: dreamSettings() }));
    render(<AgentDreams agentId="smatchet" targets={targets} savedProviders={[]} />);

    expect(await screen.findByText('Running')).toBeTruthy();
    expect(screen.getByText('Interrupted')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Dream interrupted by runtime restart before completion');
  });

  it('renders Dream activity with a missing status without crashing Agents settings', async () => {
    apiMock.mockImplementation((_target, path) => path.includes('/dream-cycle')
      ? Promise.resolve({ receipts: [{ runId: 'legacy-1', completedAt: '2026-09-18T03:05:00.000Z' }] })
      : Promise.resolve({ settings: dreamSettings() }));
    render(<AgentDreams agentId="smatchet" targets={targets} savedProviders={[]} />);

    expect(await screen.findByText('Unknown')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save dream settings' })).toBeTruthy();
  });

  it.each([
    ['profile documents', (agentId: string) => <AgentProfileDocuments agentId={agentId} targets={targets} />],
    ['dream settings', (agentId: string) => <AgentDreams agentId={agentId} targets={targets} savedProviders={[]} />],
    ['MCP grants', (agentId: string) => <AgentMcpTools agentId={agentId} targets={targets} />],
  ])('aborts obsolete %s requests when agent ownership changes', (_label, section) => {
    const view = render(section('smatchet'));
    const firstSignals = pendingRequestSignals();
    expect(firstSignals.length).toBeGreaterThan(0);
    firstSignals.forEach((signal) => expect(signal.aborted).toBe(false));

    act(() => view.rerender(section('node-1::hatchet')));

    firstSignals.forEach((signal) => expect(signal.aborted).toBe(true));
    const currentSignals = pendingRequestSignals().slice(firstSignals.length);
    expect(currentSignals.length).toBeGreaterThan(0);
    currentSignals.forEach((signal) => expect(signal.aborted).toBe(false));
  });
});
