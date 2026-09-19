import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiForTarget } from '../../app/api';
import type { ApiTarget } from '../../app/apiTargets';
import { AgentDreams } from './AgentDreams';
import { AgentMcpTools } from './AgentMcpTools';
import { AgentProfileDocuments } from './AgentProfileDocuments';

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
