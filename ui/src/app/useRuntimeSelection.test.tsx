import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiForTarget, setActiveApiTarget } from './api';
import type { ApiTarget } from './apiTargets';
import { usePersistedAgentSelection, usePersistedTargetSelection } from './usePersistedLayout';
import { useRuntimeSelection } from './useRuntimeSelection';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  apiForTarget: vi.fn(),
  setActiveApiTarget: vi.fn(),
}));

vi.mock('./usePersistedLayout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./usePersistedLayout')>()),
  usePersistedAgentSelection: vi.fn(),
  usePersistedTargetSelection: vi.fn(),
}));

const apiForTargetMock = vi.mocked(apiForTarget);
const setActiveApiTargetMock = vi.mocked(setActiveApiTarget);
const usePersistedAgentSelectionMock = vi.mocked(usePersistedAgentSelection);
const usePersistedTargetSelectionMock = vi.mocked(usePersistedTargetSelection);
const setSelectedAgentId = vi.fn();
const setSelectedTargetId = vi.fn();
const targets: ApiTarget[] = [
  { id: 'local', name: 'Local', baseUrl: '', enabled: true },
  { id: 'node-1', name: 'Node One', baseUrl: 'http://node-one:8787', enabled: true },
];

function renderSelection(selectedTargetId = 'local', targetsLoaded = true) {
  usePersistedTargetSelectionMock.mockReturnValue([selectedTargetId, setSelectedTargetId]);
  usePersistedAgentSelectionMock.mockReturnValue(['smatchet', setSelectedAgentId]);
  return renderHook(() => useRuntimeSelection({ targets, targetsLoaded }));
}

describe('useRuntimeSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiForTargetMock.mockResolvedValue({ version: '1.2.3' });
  });

  it('synchronizes the explicit active target and loads its version', async () => {
    const { result } = renderSelection('node-1');

    expect(result.current.activeTarget).toBe(targets[1]);
    expect(setActiveApiTargetMock).toHaveBeenCalledWith(targets[1]);
    await waitFor(() => expect(result.current.runtimeVersion).toBe('1.2.3'));
    expect(apiForTargetMock).toHaveBeenCalledWith(targets[1], '/api/health');
  });

  it('keeps the active target collection stable across internal rerenders', async () => {
    const { result } = renderSelection('node-1');
    const initialActiveTargets = result.current.activeTargets;

    await waitFor(() => expect(result.current.runtimeVersion).toBe('1.2.3'));

    expect(result.current.activeTargets).toBe(initialActiveTargets);
  });

  it('repairs a persisted target that is no longer registered', () => {
    renderSelection('missing');

    expect(setSelectedTargetId).toHaveBeenCalledWith('local');
  });

  it('clears agent and stream ownership when changing targets', () => {
    const { result } = renderSelection();

    act(() => {
      result.current.selectParentStream('smatchet');
      result.current.toggleAgentExpanded('smatchet');
    });
    expect(result.current.selectedStreamId).toBe('smatchet');
    expect(result.current.expandedAgents.has('smatchet')).toBe(true);

    act(() => result.current.selectTarget('node-1'));

    expect(setSelectedTargetId).toHaveBeenCalledWith('node-1');
    expect(setSelectedAgentId).toHaveBeenCalledWith('');
    expect(result.current.selectedStreamId).toBe('');
    expect(result.current.expandedAgents.size).toBe(0);
  });

  it('keeps parent and child stream transitions target-qualified', () => {
    const { result } = renderSelection('node-1');

    act(() => result.current.selectChildStream('node-1::smatchet', 'node-1::child'));
    expect(setSelectedAgentId).toHaveBeenLastCalledWith('node-1::smatchet');
    expect(result.current.selectedStreamId).toBe('node-1::child');

    act(() => result.current.selectParentStream('node-1::smatchet'));
    expect(result.current.selectedStreamId).toBe('node-1::smatchet');
  });
});
