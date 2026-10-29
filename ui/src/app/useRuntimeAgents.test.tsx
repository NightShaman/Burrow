import { act, renderHook, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type { SavedProvider } from './types';
import { useRuntimeAgents } from './useRuntimeAgents';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  api: vi.fn(),
}));

const apiMock = vi.mocked(api);
const runtimeProviders = { current: [] } as MutableRefObject<SavedProvider[]>;
const setSelectedAgentId = vi.fn();
const setSelectedStreamId = vi.fn();
const onNoAgents = vi.fn();
const reportError = vi.fn();

function renderRuntimeAgents(selectedAgentId = '') {
  return renderHook(() => useRuntimeAgents({
    selectedAgentId,
        setSelectedAgentId,
    parentSessionIdForAgent: () => 'default',
    runtimeProviders,
    setSelectedStreamId,
    onNoAgents,
    reportError,
  }));
}

describe('useRuntimeAgents registry state', () => {
  beforeEach(() => {
    apiMock.mockReset();
    setSelectedAgentId.mockReset();
    setSelectedStreamId.mockReset();
    onNoAgents.mockReset();
    reportError.mockReset();
  });

  it('reports a successful empty registry as empty', async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === '/api/agents') return { agents: [] };
      if (path === '/api/agents/overview') return { agents: [] };
      throw new Error(`Unexpected path: ${path}`);
    });

    const { result } = renderRuntimeAgents();

    await waitFor(() => expect(result.current.registryState).toBe('empty'));
    expect(result.current.registryError).toBe('');
    expect(onNoAgents).toHaveBeenCalledOnce();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('reports an unreachable runtime as unavailable instead of empty', async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === '/api/agents') return { agents: [] };
      if (path === '/api/agents/overview') throw new Error('Connection refused');
      throw new Error(`Unexpected path: ${path}`);
    });

    const { result } = renderRuntimeAgents();

    await waitFor(() => expect(result.current.registryState).toBe('unavailable'));
    expect(result.current.registryError).toContain('Connection refused');
    expect(onNoAgents).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining('Connection refused'));
  });

  it('keeps the last good registry and marks a failed refresh stale', async () => {
    let overviewCalls = 0;
    apiMock.mockImplementation(async (path) => {
      if (path === '/api/agents') return { agents: [{ id: 'smatchet', name: 'Smatchet', enabled: true }] };
      if (path !== '/api/agents/overview') throw new Error(`Unexpected path: ${path}`);
      overviewCalls += 1;
      if (overviewCalls > 1) throw new Error('Bad Gateway');
      return { agents: [{
        agent: { id: 'smatchet', name: 'Smatchet', enabled: true },
        sessionId: 'default', selection: null,
        status: { agents: [{ sessionId: 'default', status: 'IDLE' }] }, contexts: {},
      }] };
    });

    const { result } = renderRuntimeAgents();
    await waitFor(() => expect(result.current.registryState).toBe('ready'));
    const loadedAgents = result.current.agents;

    await act(async () => { await result.current.refreshAgents(); });

    expect(result.current.agents).toEqual(loadedAgents);
    expect(result.current.registryState).toBe('ready');
    expect(result.current.registryStale).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('does not let an older overview overwrite a newer context refresh', async () => {
    const overview = (percent: number) => ({ agents: [{ agent: { id: 'smatchet', name: 'Smatchet', enabled: true }, sessionId: 'default', selection: null, status: { agents: [] }, contexts: { default: { context: { percent } } } }] });
    let resolveOld!: (value: unknown) => void;
    let call = 0;
    apiMock.mockImplementation(async (path) => {
      if (path === '/api/agents') return { agents: [{ id: 'smatchet' }] };
      if (path === '/api/agents/overview') {
        call++;
        if (call === 2) return new Promise(resolve => { resolveOld = resolve; });
        return overview(call === 1 ? 80 : 20);
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const { result } = renderRuntimeAgents();
    await waitFor(() => expect(result.current.agents[0]?.context).toBe(80));
    let old!: Promise<void>;
    act(() => { old = result.current.refreshAgents(); });
    await waitFor(() => expect(resolveOld).toBeDefined());
    await act(async () => { await result.current.refreshAgents(); });
    expect(result.current.agents[0].context).toBe(20);
    await act(async () => { resolveOld(overview(80)); await old; });
    expect(result.current.agents[0].context).toBe(20);
  });

  it('hydrates parent and child state with one local registry overview request', async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === '/api/agents') return { agents: [{ id: 'smatchet', name: 'Smatchet', enabled: true }] };
      if (path !== '/api/agents/overview') throw new Error(`Unexpected path: ${path}`);
      return { agents: [{
        agent: { id: 'smatchet', name: 'Smatchet', enabled: true, contextConfig: { a2aInDefault: false } },
        identity: { id: 'smatchet', name: 'Smatchet UI', avatar: 'S' },
        sessionId: 'default',
        selection: null,
        status: { agents: [
          { sessionId: 'default', status: 'THINKING' },
          { sessionId: 'child-1', parentSessionId: 'default', label: 'CSS audit', status: 'VERIFYING', subagentId: 'sub-1' },
          { sessionId: 'child-2', parentSessionId: 'default', label: 'Incomplete audit', status: 'ERROR', result: { summary: 'Audit stopped', blockers: ['subagent_incomplete'] } },
          { sessionId: 'child-3', parentSessionId: 'default', label: 'Failed audit', status: 'ERROR', result: { blockers: ['subagent_spawn_failed'] } },
        ] },
        contexts: {
          default: { context: { percent: 42 } },
          'child-1': { context: { percent: 12 } },
        },
      }], };
    });

    const { result } = renderRuntimeAgents();

    await waitFor(() => expect(result.current.registryState).toBe('ready'));
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(apiMock).toHaveBeenNthCalledWith(1, '/api/agents', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(apiMock).toHaveBeenNthCalledWith(2, '/api/agents/overview', expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }));
    expect(result.current.agents[0]).toMatchObject({ name: 'Smatchet UI', activity: 'Thinking', context: 42, contextConfig: { a2aInDefault: false } });
    expect(result.current.agents[0].subagents[0]).toMatchObject({ name: 'CSS audit', activity: 'Verifying', context: 12 });
    expect(result.current.agents[0].subagents[1]).toMatchObject({ activity: 'Incomplete', outcomeReason: 'Audit stopped · subagent_incomplete' });
    expect(result.current.agents[0].subagents[2]).toMatchObject({ activity: 'Error' });
  });
});


it.each([true, false])('retains disabled identities for management but selects only enabled agents (%s)', async hasEnabled => {
  const registry = [
    { id: 'disabled', name: 'Disabled agent', enabled: false },
    ...(hasEnabled ? [{ id: 'enabled', name: 'Enabled agent', enabled: true }] : []),
  ];
  apiMock.mockImplementation(async path => {
    if (path === '/api/agents') return { agents: registry };
    if (path === '/api/agents/overview') return { agents: registry.map(agent => ({ agent, sessionId: 'default', selection: null, status: { agents: [] }, contexts: {} })) };
    throw new Error(`Unexpected path: ${path}`);
  });
  const { result } = renderRuntimeAgents('disabled');
  await waitFor(() => expect(result.current.registryState).toBe('ready'));
  expect(result.current.agents[0]).toMatchObject({ id: 'disabled', enabled: false, name: 'Disabled agent' });
  expect(setSelectedAgentId).toHaveBeenLastCalledWith(hasEnabled ? 'enabled' : '');
  const reconcileStream = setSelectedStreamId.mock.lastCall?.[0];
  expect(reconcileStream('disabled-child')).toBe(hasEnabled ? 'enabled' : '');
});

describe('nested minion hydration', () => {
  beforeEach(() => {
    apiMock.mockReset();
    setSelectedAgentId.mockReset();
    setSelectedStreamId.mockReset();
    onNoAgents.mockReset();
    reportError.mockReset();
  });

  it.each(['overview', 'legacy'])('keeps all descendants flat with backend ancestry via %s', async mode => {
    const agent = { id: 'smatchet', name: 'Smatchet', enabled: true };
    const statuses = [
      { sessionId: 'default', status: 'THINKING', depth: 0, maxDepth: 0 },
      { sessionId: 'grandchild', parentSessionId: 'child', parentRunId: 'child-run', runId: 'grandchild-run', rootSessionId: 'default', rootRunId: 'root-run', depth: 2, maxDepth: 3, label: 'Grandchild', status: 'VERIFYING' },
      { sessionId: 'child', parentSessionId: 'default', parentRunId: 'root-run', runId: 'child-run', depth: 1, maxDepth: 3, status: 'THINKING' },
      { sessionId: 'orphan', parentSessionId: 'retained-away', parentRunId: 'missing-run', depth: 2, maxDepth: 3, status: 'ERROR', result: { outcome: 'incomplete', summary: 'Stopped early' } },
    ];
    apiMock.mockImplementation(async (path) => {
      if (path === '/api/agents') return { agents: [agent] };
      if (path === '/api/agents/overview') {
        if (mode === 'legacy') throw Object.assign(new Error('Not found'), { status: 404 });
        return { agents: [{ agent, sessionId: 'default', selection: null, status: { agents: statuses }, contexts: { grandchild: { context: { percent: 27 } } } }] };
      }
      if (path === '/api/settings/identities') return { agents: [] };
      if (path === '/api/agents/smatchet/model-selection') return { selection: null };
      if (path === '/api/agent-status?sessionId=default&agentId=smatchet') return { agents: statuses };
      if (path.startsWith('/api/session/context-status?')) return { status: { context: { percent: path.endsWith('grandchild') ? 27 : 10 } } };
      throw new Error(`Unexpected path: ${path}`);
    });
    const { result } = renderRuntimeAgents('smatchet');
    await waitFor(() => expect(result.current.registryState).toBe('ready'));
    const children = result.current.agents[0].subagents;
    expect(children.map(child => child.id)).toEqual(['grandchild', 'child', 'orphan']);
    expect(children[0]).toMatchObject({ agentId: 'smatchet', id: 'grandchild', resourceId: 'grandchild', stream: 'grandchild', parentSessionId: 'child', parentRunId: 'child-run', runId: 'grandchild-run', rootSessionId: 'default', rootRunId: 'root-run', depth: 2, maxDepth: 3, context: 27, activity: 'Verifying' });
    expect(children[2]).toMatchObject({ parentSessionId: 'retained-away', depth: 2, maxDepth: 3 });
    const reconcile = setSelectedStreamId.mock.lastCall?.[0];
    expect(reconcile('grandchild')).toBe('grandchild');
    expect(reconcile('orphan')).toBe('orphan');
    expect(reconcile('removed')).toBe('smatchet');
    if (mode === 'legacy') {
      for (const session of ['default', 'child', 'grandchild', 'orphan']) {
        expect(apiMock).toHaveBeenCalledWith(`/api/session/context-status?agentId=smatchet&sessionId=${session}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
      }
    } else {
      expect(apiMock).toHaveBeenCalledTimes(2);
      // A capped overview may omit context without omitting the descendant.
      expect(children[2].context).toBeNull();
    }
  });

  it('uses the requested session as the displayed parent even when it has ancestry', async () => {
    apiMock.mockImplementation(async path => {
      if (path === '/api/agents') return { agents: [{ id: 'smatchet' }] };
      if (path === '/api/agents/overview') return { agents: [{ agent: { id: 'smatchet', name: 'Smatchet', enabled: true }, sessionId: 'default', selection: null, status: { agents: [
        { sessionId: 'default', parentSessionId: 'original-root', depth: 1, status: 'STREAMING' },
        { sessionId: 'nested', parentSessionId: 'default', depth: 2, maxDepth: 2, status: 'THINKING' },
      ] }, contexts: {} }] };
      throw new Error(`Unexpected path: ${path}`);
    });
    const { result } = renderRuntimeAgents('smatchet');
    await waitFor(() => expect(result.current.registryState).toBe('ready'));
    expect(result.current.agents[0].activity).toBe('Streaming');
    expect(result.current.agents[0].subagents.map(child => child.id)).toEqual(['nested']);
  });
});
