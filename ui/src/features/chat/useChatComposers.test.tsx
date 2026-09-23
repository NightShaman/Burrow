import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiForTarget } from '../../app/api';
import type { ApiTarget } from '../../app/apiTargets';
import { useChatComposers } from './useChatComposers';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  apiForTarget: vi.fn(),
}));

const apiForTargetMock = vi.mocked(apiForTarget);
const targets: ApiTarget[] = [
  { id: 'local', name: 'Local', baseUrl: '', enabled: true },
  { id: 'node-1', name: 'Node One', baseUrl: 'http://node-one:8787', enabled: true },
];

function renderComposers(overrides: Partial<Parameters<typeof useChatComposers>[0]> = {}) {
  const options: Parameters<typeof useChatComposers>[0] = {
    selectedAgentId: 'node-1::smatchet',
    activeRunId: null,
    sessions: [{ id: 'default' }],
    targets,
    activeTarget: targets[1],
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    selectSession: vi.fn(),
    reportError: vi.fn(),
    clearError: vi.fn(),
    tabs: [],
    setTabs: vi.fn(),
    setActiveTabId: vi.fn(),
    ...overrides,
  };
  return { ...renderHook(() => useChatComposers(options)), options };
}

describe('useChatComposers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiForTargetMock.mockResolvedValue({ id: 'design', name: 'Design' });
  });

  it('creates named sessions through the owning runtime and selects the result', async () => {
    const { result, options } = renderComposers();
    act(() => {
      result.current.session.open();
      result.current.session.setName('planning');
    });
    await act(() => result.current.session.create());

    expect(apiForTargetMock).toHaveBeenNthCalledWith(1, targets[1], '/api/sessions/default/fork?agentId=smatchet', expect.objectContaining({ method: 'POST', body: JSON.stringify({ targetSessionId: 'planning' }) }));
    expect(apiForTargetMock).toHaveBeenNthCalledWith(2, targets[1], '/api/sessions/planning/reset?agentId=smatchet', { method: 'POST' });
    expect(options.refreshSessions).toHaveBeenCalledWith('node-1::smatchet');
    expect(options.selectSession).toHaveBeenCalledWith('planning');
    expect(result.current.session.isOpen).toBe(false);
  });

  it('keeps invalid or duplicate session names in the dialog without network work', async () => {
    const { result } = renderComposers({ sessions: [{ id: 'planning' }] });
    act(() => {
      result.current.session.open();
      result.current.session.setName('planning');
    });
    await act(() => result.current.session.create());

    expect(result.current.session.error).toContain('already exists');
    expect(apiForTargetMock).not.toHaveBeenCalled();
  });


  it('discovers server rooms, reopens a restored tab without duplication, and reloads after closing', async () => {
    apiForTargetMock.mockResolvedValue({ ok: true, channels: [{ id: 'design', name: 'Design', participantAgentIds: ['smatchet', 'hatchet'] }] });
    const existing = { id: 'group:node-1:design', label: 'Design', kind: 'group' as const, targetId: 'node-1', channelId: 'design' };
    const { result, options, rerender } = renderComposers({ tabs: [existing] });
    act(() => result.current.group.open());
    await waitFor(() => expect(result.current.group.rooms).toHaveLength(1));
    act(() => result.current.group.openExisting(result.current.group.rooms[0]));
    expect(options.setTabs).not.toHaveBeenCalled();
    expect(options.setActiveTabId).toHaveBeenCalledWith(existing.id);
    act(() => result.current.group.open());
    await waitFor(() => expect(apiForTargetMock).toHaveBeenCalledTimes(2));
    // Closing a tab is a local view operation: the next fetch still discovers the server room.
    rerender();
    expect(result.current.group.rooms[0].id).toBe('design');
  });

  it('opens a server room in a fresh browser without saved tabs', async () => {
    apiForTargetMock.mockResolvedValue({ ok: true, channels: [{ id: 'from-server', name: 'Saved room', participantAgentIds: [] }] });
    const { result, options } = renderComposers();
    act(() => result.current.group.open());
    await waitFor(() => expect(result.current.group.rooms).toHaveLength(1));
    act(() => result.current.group.openExisting(result.current.group.rooms[0]));
    const updater = vi.mocked(options.setTabs).mock.calls[0][0] as (tabs: never[]) => Array<{ id: string; channelId?: string; targetId?: string }>;
    expect(updater([])).toEqual([expect.objectContaining({ id: 'group:node-1:from-server', channelId: 'from-server', targetId: 'node-1' })]);
    expect(options.setActiveTabId).toHaveBeenCalledWith('group:node-1:from-server');
  });

  it('does not expose old runtime rooms or accept stale responses after switching targets', async () => {
    let resolveOld!: (value: unknown) => void;
    apiForTargetMock.mockImplementation((target) => target?.baseUrl === targets[1].baseUrl
      ? new Promise((resolve) => { resolveOld = resolve; })
      : Promise.resolve({ ok: true, channels: [{ id: 'local-room', name: 'Local room', participantAgentIds: [] }] }));
    const options: Parameters<typeof useChatComposers>[0] = {
      selectedAgentId: 'node-1::smatchet', activeRunId: null, sessions: [], targets,
      activeTarget: targets[1], refreshSessions: vi.fn(), selectSession: vi.fn(), reportError: vi.fn(), clearError: vi.fn(),
      tabs: [], setTabs: vi.fn(), setActiveTabId: vi.fn(),
    };
    const { result, rerender } = renderHook((props) => useChatComposers(props), { initialProps: options });
    act(() => result.current.group.open());
    rerender({ ...options, activeTarget: targets[0] });
    await waitFor(() => expect(result.current.group.rooms.map((room) => room.id)).toEqual(['local-room']));
    await act(async () => resolveOld({ ok: true, channels: [{ id: 'old', name: 'Old', participantAgentIds: [] }] }));
    expect(result.current.group.rooms.map((room) => room.id)).toEqual(['local-room']);
    expect(apiForTargetMock).toHaveBeenCalledWith(targets[0], '/api/group-channels');
  });

  it('keeps a failed discovery distinct from an empty room inventory', async () => {
    apiForTargetMock.mockRejectedValue(new Error('offline'));
    const { result } = renderComposers();
    act(() => result.current.group.open());
    await waitFor(() => expect(result.current.group.roomsError).toContain('offline'));
    expect(result.current.group.roomsLoading).toBe(false);
    expect(result.current.group.rooms).toEqual([]);
  });
  it('creates remote groups with backend resource IDs and target-qualified tabs', async () => {
    const setTabs = vi.fn();
    const setActiveTabId = vi.fn();
    const { result } = renderComposers({ setTabs, setActiveTabId });
    act(() => {
      result.current.group.open();
      result.current.group.setName('Design');
      result.current.group.toggleAgent('node-1::smatchet');
      result.current.group.toggleAgent('node-1::hatchet');
    });
    await act(() => result.current.group.create());

    expect(apiForTargetMock).toHaveBeenCalledWith(targets[1], '/api/group-channels', expect.objectContaining({ body: JSON.stringify({ name: 'Design', participantAgentIds: ['smatchet', 'hatchet'] }) }));
    const updater = setTabs.mock.calls[0][0] as (tabs: never[]) => Array<{ id: string; targetId?: string }>;
    expect(updater([])).toEqual([expect.objectContaining({ id: 'group:node-1:design', targetId: 'node-1' })]);
    expect(setActiveTabId).toHaveBeenCalledWith('group:node-1:design');
    await waitFor(() => expect(result.current.group.isOpen).toBe(false));
  });

  it('rejects group participants owned by another runtime', async () => {
    const { result } = renderComposers();
    act(() => {
      result.current.group.open();
      result.current.group.setName('Mixed');
      result.current.group.toggleAgent('node-1::smatchet');
      result.current.group.toggleAgent('hatchet');
    });
    await act(() => result.current.group.create());

    expect(result.current.group.error).toContain('selected runtime');
    expect(apiForTargetMock).not.toHaveBeenCalledWith(targets[1], '/api/group-channels', expect.objectContaining({ method: 'POST' }));
  });
});
