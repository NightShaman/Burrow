import { act, renderHook, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type { SavedProvider } from './types';
import { useRuntimeAgents } from './useRuntimeAgents';
import { childStreamId } from './useRuntimeSelection';

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
    selectedStreamId: selectedAgentId,
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
    expect(result.current.agents[0].minionScope).toBe('session');
    expect(children.map(child => child.resourceId)).toEqual(['grandchild', 'child', 'orphan']);
    expect(children[0]).toMatchObject({ agentId: 'smatchet', id: childStreamId('smatchet', 'grandchild'), resourceId: 'grandchild', stream: childStreamId('smatchet', 'grandchild'), parentSessionId: 'child', parentRunId: 'child-run', runId: 'grandchild-run', rootSessionId: 'default', rootRunId: 'root-run', depth: 2, maxDepth: 3, context: 27, activity: 'Verifying' });
    expect(children[2]).toMatchObject({ parentSessionId: 'retained-away', depth: 2, maxDepth: 3 });
    const reconcile = setSelectedStreamId.mock.lastCall?.[0];
    expect(reconcile(childStreamId('smatchet', 'grandchild'))).toBe(childStreamId('smatchet', 'grandchild'));
    expect(reconcile(childStreamId('smatchet', 'orphan'))).toBe(childStreamId('smatchet', 'orphan'));
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
    expect(result.current.agents[0].subagents.map(child => child.resourceId)).toEqual(['default', 'nested']);
  });
});

it('requests agent-wide coverage, retains minion anchors, and deduplicates session IDs', async () => {
  apiMock.mockImplementation(async (path, options) => {
    if (path === '/api/agents') return { agents: [{ id: 'smatchet' }] };
    if (path === '/api/agents/overview') {
      expect(JSON.parse(String(options?.body))).toMatchObject({ minionScope: 'agent' });
      return { agents: [{ agent: { id: 'smatchet', name: 'Smatchet', enabled: true }, sessionId: 'default', selection: null, status: { minionScope: 'agent', agents: [
        { sessionId: 'default', depth: 1, rootSessionId: 'named', status: 'THINKING' },
        { sessionId: 'child', rootSessionId: 'other', status: 'IDLE' },
        { sessionId: 'child', rootSessionId: 'other', status: 'IDLE' },
      ] }, contexts: {} }] };
    }
    throw new Error(`Unexpected path: ${path}`);
  });
  const { result } = renderRuntimeAgents('smatchet');
  await waitFor(() => expect(result.current.registryState).toBe('ready'));
  expect(result.current.agents[0].minionScope).toBe('agent');
  expect(result.current.agents[0].subagents.map(child => child.resourceId)).toEqual(['default', 'child']);
});

it('retains the selected missing child through an overview refresh', async () => {
  let includeChild = true;
  apiMock.mockImplementation(async path => {
    if (path === '/api/agents') return { agents: [{ id: 'smatchet' }] };
    if (path === '/api/agents/overview') return { agents: [{ agent: { id: 'smatchet', name: 'Smatchet', enabled: true }, sessionId: 'default', selection: null, status: { minionScope: 'agent', agents: includeChild ? [{ sessionId: 'child', rootSessionId: 'named', depth: 1 }] : [] }, contexts: {} }] };
    throw new Error(`Unexpected path: ${path}`);
  });
  const { result } = renderHook(() => useRuntimeAgents({ selectedAgentId: 'smatchet', selectedStreamId: childStreamId('smatchet', 'child'), setSelectedAgentId, parentSessionIdForAgent: () => 'default', runtimeProviders, setSelectedStreamId, onNoAgents, reportError }));
  await waitFor(() => expect(result.current.agents[0]?.subagents).toHaveLength(1));
  includeChild = false;
  await act(async () => { await result.current.refreshAgents(); });
  expect(result.current.agents[0].subagents[0]).toMatchObject({ id: childStreamId('smatchet', 'child'), resourceId: 'child', rootSessionId: 'named' });
  expect(setSelectedStreamId.mock.lastCall?.[0](childStreamId('smatchet', 'child'))).toBe(childStreamId('smatchet', 'child'));
});


describe('agent-wide overview polling and per-agent errors', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('POSTs agent scope and each agent’s current anchor on initial load and interval polls', async () => {
    vi.useFakeTimers();
    const registry = [
      { id: 'smatchet', name: 'Smatchet', enabled: true },
      { id: 'hatchet', name: 'Hatchet', enabled: true },
    ];
    let sessions: Record<string, string> = { smatchet: 'named / session', hatchet: 'default' };
    const parentSessionIdForAgent = (agentId: string) => sessions[agentId];
    apiMock.mockImplementation(async path => {
      if (path === '/api/agents') return { agents: registry };
      if (path === '/api/agents/overview') return { agents: registry.map((agent, index) => ({
        agent, sessionId: sessions[agent.id], selection: null,
        status: { minionScope: 'agent', agents: [
          { sessionId: sessions[agent.id], status: index === 0 ? 'THINKING' : 'STREAMING' },
          { sessionId: `${agent.id}-child`, parentSessionId: 'another-root', depth: 1, status: 'IDLE' },
        ] },
        contexts: { [sessions[agent.id]]: { context: { percent: 20 + index } } },
      })) };
      throw new Error(`Unexpected path: ${path}`);
    });
    const { result, unmount } = renderHook(() => useRuntimeAgents({
      selectedAgentId: 'smatchet', selectedStreamId: 'smatchet', setSelectedAgentId,
      parentSessionIdForAgent, runtimeProviders, setSelectedStreamId, onNoAgents, reportError,
    }));
    const expectOverviewRequest = (call: number, anchors: Record<string, string>) => {
      const requests = apiMock.mock.calls.filter(([path]) => path === '/api/agents/overview');
      expect(requests).toHaveLength(call);
      const [, options] = requests[call - 1];
      expect(options).toMatchObject({
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: expect.any(AbortSignal),
      });
      expect(JSON.parse(String(options?.body))).toEqual({ sessions: anchors, minionScope: 'agent' });
    };
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.registryState).toBe('ready');
      expectOverviewRequest(1, { smatchet: 'named / session', hatchet: 'default' });
      expect(result.current.agents.map(agent => ({ id: agent.id, activity: agent.activity, context: agent.context }))).toEqual([
        { id: 'smatchet', activity: 'Thinking', context: 20 },
        { id: 'hatchet', activity: 'Streaming', context: 21 },
      ]);

      // Poll with updated per-agent anchors without manually calling refreshAgents.
      sessions = { smatchet: 'selected-minion', hatchet: 'hatchet / named' };
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expectOverviewRequest(2, sessions);
      expect(apiMock.mock.calls.filter(([path]) => path === '/api/agents')).toHaveLength(1);
      expect(result.current.agents.map(agent => agent.minionScope)).toEqual(['agent', 'agent']);
      expect(result.current.agents.map(agent => agent.subagents.map(child => child.resourceId))).toEqual([
        ['smatchet-child'], ['hatchet-child'],
      ]);
      expect(reportError).not.toHaveBeenCalled();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it.each([undefined, 'agent'] as const)('does not infer coverage from an initial agent error (reported scope: %s)', async minionScope => {
    const agent = { id: 'smatchet', name: 'Smatchet', enabled: true };
    apiMock.mockImplementation(async path => {
      if (path === '/api/agents') return { agents: [agent] };
      if (path === '/api/agents/overview') return { agents: [{
        agent, sessionId: 'default', selection: null, error: 'Agent status unavailable',
        status: { agents: [], minionScope }, contexts: {},
      }] };
      throw new Error(`Unexpected path: ${path}`);
    });
    const { result } = renderRuntimeAgents('smatchet');
    await waitFor(() => expect(result.current.registryState).toBe('ready'));
    expect(result.current.agents[0].minionScope).toBe('session');
    expect(result.current.agents[0].subagents).toEqual([]);
  });

  it.each([undefined, 'agent'] as const)('preserves known children and healthy updates on an agent error, then recovers (reported scope: %s)', async errorScope => {
    const registry = [
      { id: 'smatchet', name: 'Smatchet', enabled: true },
      { id: 'hatchet', name: 'Hatchet', enabled: true },
    ];
    let phase: 'loaded' | 'error' | 'recovered' = 'loaded';
    apiMock.mockImplementation(async path => {
      if (path === '/api/agents') return { agents: registry };
      if (path === '/api/agents/overview') return { agents: registry.map(agent => ({
        agent, sessionId: 'default', selection: null,
        ...(agent.id === 'smatchet' && phase === 'error' ? { error: 'Agent status unavailable' } : {}),
        // Even a scope marker alongside an error is not proof of coverage.
        status: { minionScope: agent.id === 'smatchet' && phase === 'error' ? errorScope : 'agent', agents: agent.id === 'smatchet'
          ? phase === 'loaded' ? [
            { sessionId: 'child', rootSessionId: 'named', depth: 1, status: 'THINKING' },
            { sessionId: 'unselected-child', parentSessionId: 'child', depth: 2, status: 'VERIFYING' },
          ] : []
          : [{ sessionId: 'healthy-child', parentSessionId: 'other-root', depth: 1, status: phase === 'loaded' ? 'THINKING' : 'VERIFYING' }],
        },
        contexts: {},
      })) };
      throw new Error(`Unexpected path: ${path}`);
    });
    const { result } = renderHook(() => useRuntimeAgents({
      selectedAgentId: 'smatchet', selectedStreamId: childStreamId('smatchet', 'child'), setSelectedAgentId,
      parentSessionIdForAgent: () => 'default', runtimeProviders, setSelectedStreamId, onNoAgents, reportError,
    }));
    await waitFor(() => expect(result.current.agents[0]?.subagents).toHaveLength(2));
    const knownChildren = result.current.agents[0].subagents;
    expect(result.current.agents[0].minionScope).toBe('agent');

    phase = 'error';
    await act(async () => { await result.current.refreshAgents(); });
    expect(result.current.agents[0].subagents).toEqual(knownChildren.map(child => ({ ...child, retained: true })));
    expect(result.current.agents[0].minionScope).toBe('session');
    expect(setSelectedStreamId.mock.lastCall?.[0](childStreamId('smatchet', 'child'))).toBe(childStreamId('smatchet', 'child'));
    expect(result.current.agents[1].minionScope).toBe('agent');
    expect(result.current.agents[1].subagents[0].activity).toBe('Verifying');
    expect(result.current.registryState).toBe('ready');
    expect(onNoAgents).not.toHaveBeenCalled();

    phase = 'recovered';
    await act(async () => { await result.current.refreshAgents(); });
    expect(result.current.agents[0].minionScope).toBe('agent');
    // A successful empty response may remove unselected children; the active
    // transcript keeps its existing retention behavior.
    expect(result.current.agents[0].subagents).toHaveLength(1);
    expect(result.current.agents[0].subagents[0]).toMatchObject({ id: childStreamId('smatchet', 'child'), resourceId: 'child', retained: true });
  });
});

describe('coverage evidence and anchor fencing', () => {
  beforeEach(() => {
    apiMock.mockReset();
    setSelectedAgentId.mockReset();
    setSelectedStreamId.mockReset();
    onNoAgents.mockReset();
    reportError.mockReset();
  });

  it('marks copied children last seen and distinguishes stale from unavailable coverage', async () => {
    const agent = { id: 'smatchet', name: 'Smatchet', enabled: true };
    let failed = false;
    apiMock.mockImplementation(async path => {
      if (path === '/api/agents') return { agents: [agent] };
      if (path === '/api/agents/overview') return { agents: [{
        agent, sessionId: 'default', selection: null,
        ...(failed ? { error: 'Agent status unavailable' } : {}),
        status: { minionScope: 'agent', agents: failed ? [] : [{ sessionId: 'child', status: 'THINKING', depth: 1 }] },
        contexts: {},
      }] };
      throw new Error(`Unexpected path: ${path}`);
    });
    const { result } = renderRuntimeAgents('smatchet');
    await waitFor(() => expect(result.current.agents[0]?.subagents).toHaveLength(1));
    expect(result.current.agents[0].minionCoverage).toBe('current');

    failed = true;
    await act(async () => { await result.current.refreshAgents(); });
    expect(result.current.agents[0]).toMatchObject({ minionCoverage: 'stale', minionScope: 'session' });
    expect(result.current.agents[0].subagents[0]).toMatchObject({ id: childStreamId('smatchet', 'child'), resourceId: 'child', activity: 'Thinking', retained: true });

    apiMock.mockReset();
    apiMock.mockImplementation(async path => {
      if (path === '/api/agents') return { agents: [agent] };
      if (path === '/api/agents/overview') return { agents: [{ agent, sessionId: 'default', selection: null, error: 'Agent status unavailable', status: { agents: [], minionScope: 'agent' }, contexts: {} }] };
      throw new Error(`Unexpected path: ${path}`);
    });
    const initial = renderRuntimeAgents('smatchet');
    await waitFor(() => expect(initial.result.current.registryState).toBe('ready'));
    expect(initial.result.current.agents[0]).toMatchObject({ minionCoverage: 'unavailable', subagents: [] });
  });

  it('does not treat a failed legacy status request as successful empty coverage', async () => {
    const agent = { id: 'smatchet', name: 'Smatchet', enabled: true };
    apiMock.mockImplementation(async path => {
      if (path === '/api/agents') return { agents: [agent] };
      if (path === '/api/agents/overview') throw Object.assign(new Error('Not found'), { status: 404 });
      if (path === '/api/settings/identities') return { agents: [] };
      if (path === '/api/agent-status?sessionId=default&agentId=smatchet') throw new Error('Legacy status failed');
      if (path === '/api/session/context-status?agentId=smatchet&sessionId=default') return { status: { context: { percent: 12 } } };
      if (path === '/api/agents/smatchet/model-selection') return { selection: null };
      throw new Error(`Unexpected path: ${path}`);
    });
    const { result } = renderRuntimeAgents('smatchet');
    await waitFor(() => expect(result.current.registryState).toBe('ready'));
    expect(result.current.agents[0]).toMatchObject({ minionCoverage: 'unavailable', minionScope: 'session', subagents: [] });
  });

  it('discards parent activity and context whose requested or returned anchor changed in flight', async () => {
    const agent = { id: 'smatchet', name: 'Smatchet', enabled: true };
    let anchor = 'default';
    let resolveOld!: (value: unknown) => void;
    let overviewCalls = 0;
    const overview = (sessionId: string, status: string, percent: number) => ({ agents: [{ agent, sessionId, selection: null, status: { minionScope: 'agent', agents: [{ sessionId, status }, { sessionId: 'child', status: 'THINKING', depth: 1 }] }, contexts: { [sessionId]: { context: { percent, estimatedTokens: 123 } } } }] });
    apiMock.mockImplementation(async path => {
      if (path === '/api/agents') return { agents: [agent] };
      if (path === '/api/agents/overview') {
        overviewCalls += 1;
        if (overviewCalls === 1) return overview('default', 'IDLE', 10);
        if (overviewCalls === 2) return new Promise(resolve => { resolveOld = resolve; });
        if (overviewCalls === 4) return overview('wrong-anchor', 'STREAMING', 99);
        return overview(anchor, 'THINKING', 75);
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const { result } = renderHook(() => useRuntimeAgents({ selectedAgentId: 'smatchet', selectedStreamId: 'smatchet', setSelectedAgentId, parentSessionIdForAgent: () => anchor, runtimeProviders, setSelectedStreamId, onNoAgents, reportError }));
    await waitFor(() => expect(result.current.agents[0]?.context).toBe(10));
    let old!: Promise<void>;
    act(() => { old = result.current.refreshAgents(); });
    await waitFor(() => expect(resolveOld).toBeDefined());
    anchor = 'named';
    await act(async () => { resolveOld(overview('default', 'STREAMING', 99)); await old; });
    expect(result.current.agents[0]).toMatchObject({ activity: 'Unknown', context: null, contextDetails: undefined, minionCoverage: 'stale', subagents: [{ resourceId: 'child', retained: true }] });

    await act(async () => { await result.current.refreshAgents(); });
    expect(result.current.agents[0]).toMatchObject({ activity: 'Thinking', context: 75 });

    anchor = 'other';
    await act(async () => { await result.current.refreshAgents(); });
    // A response claiming a different entry anchor is fenced even if the request
    // anchor itself was current when sent.
    expect(result.current.agents[0]).toMatchObject({ activity: 'Unknown', context: null, contextDetails: undefined, minionCoverage: 'stale', subagents: [{ resourceId: 'child', retained: true }] });

    await act(async () => { await result.current.refreshAgents(); });
    expect(result.current.agents[0]).toMatchObject({ activity: 'Thinking', context: 75, contextDetails: { estimatedTokens: 123 }, minionCoverage: 'current', subagents: [{ resourceId: 'child' }] });
    expect(result.current.agents[0].subagents[0].retained).toBeUndefined();
  });
});
