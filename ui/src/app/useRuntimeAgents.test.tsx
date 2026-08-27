import { renderHook, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiForTarget } from './api';
import { localApiTarget } from './apiTargets';
import type { SavedProvider } from './types';
import { useRuntimeAgents } from './useRuntimeAgents';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  apiForTarget: vi.fn(),
}));

const apiForTargetMock = vi.mocked(apiForTarget);
const runtimeProviders = { current: [] } as MutableRefObject<SavedProvider[]>;
const setSelectedAgentId = vi.fn();
const setSelectedStreamId = vi.fn();
const onNoAgents = vi.fn();
const reportError = vi.fn();

function renderRuntimeAgents() {
  return renderHook(() => useRuntimeAgents({
    selectedAgentId: '',
    targets: [localApiTarget],
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
    apiForTargetMock.mockReset();
    setSelectedAgentId.mockReset();
    setSelectedStreamId.mockReset();
    onNoAgents.mockReset();
    reportError.mockReset();
  });

  it('reports a successful empty registry as empty', async () => {
    apiForTargetMock.mockImplementation(async (_target, path) => {
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
    apiForTargetMock.mockImplementation(async (_target, path) => {
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

  it('hydrates parent and child state with one request per target', async () => {
    apiForTargetMock.mockImplementation(async (_target, path) => {
      if (path === '/api/agents') return { agents: [{ id: 'smatchet', name: 'Smatchet', enabled: true }] };
      if (path !== '/api/agents/overview') throw new Error(`Unexpected path: ${path}`);
      return { agents: [{
        agent: { id: 'smatchet', name: 'Smatchet', enabled: true },
        identity: { id: 'smatchet', name: 'Smatchet UI', avatar: 'S' },
        sessionId: 'default',
        selection: null,
        status: { agents: [
          { sessionId: 'default', status: 'THINKING' },
          { sessionId: 'child-1', parentSessionId: 'default', label: 'CSS audit', status: 'VERIFYING', subagentId: 'sub-1' },
        ] },
        contexts: {
          default: { context: { percent: 42 } },
          'child-1': { context: { percent: 12 } },
        },
      }], };
    });

    const { result } = renderRuntimeAgents();

    await waitFor(() => expect(result.current.registryState).toBe('ready'));
    expect(apiForTargetMock).toHaveBeenCalledTimes(2);
    expect(apiForTargetMock).toHaveBeenNthCalledWith(1, localApiTarget, '/api/agents');
    expect(apiForTargetMock).toHaveBeenNthCalledWith(2, localApiTarget, '/api/agents/overview', expect.objectContaining({ method: 'POST' }));
    expect(result.current.agents[0]).toMatchObject({ name: 'Smatchet UI', activity: 'Thinking', context: 42 });
    expect(result.current.agents[0].subagents[0]).toMatchObject({ name: 'CSS audit', activity: 'Verifying', context: 12 });
  });
});
