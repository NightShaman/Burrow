import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { useChatComposers } from './useChatComposers';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  api: vi.fn(),
}));

const apiMock = vi.mocked(api);

function renderComposers(overrides: Partial<Parameters<typeof useChatComposers>[0]> = {}) {
  const options: Parameters<typeof useChatComposers>[0] = {
    selectedAgentId: 'smatchet',
    activeRunId: null,
    sessions: [{ id: 'default' }],
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
    apiMock.mockResolvedValue({ id: 'design', name: 'Design' });
  });

  it('creates named sessions through the owning runtime and selects the result', async () => {
    const { result, options } = renderComposers();
    act(() => {
      result.current.session.open();
      result.current.session.setName('planning');
    });
    await act(() => result.current.session.create());

    expect(apiMock).toHaveBeenNthCalledWith(1, '/api/sessions/default/fork?agentId=smatchet', expect.objectContaining({ method: 'POST', body: JSON.stringify({ targetSessionId: 'planning' }) }));
    expect(apiMock).toHaveBeenNthCalledWith(2, '/api/sessions/planning/reset?agentId=smatchet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(options.refreshSessions).toHaveBeenCalledWith('smatchet');
    expect(options.selectSession).toHaveBeenCalledWith('planning');
    expect(result.current.session.isOpen).toBe(false);
  });

  it.each(['agent', 'session'])('discards late create after %s navigation', async (navigation) => {
    let resolve!: (value: unknown) => void;
    apiMock.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { result, options, rerender } = renderComposers();
    act(() => result.current.session.setName('planning'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.session.create(); });
    if (navigation === 'agent') options.selectedAgentId = 'other';

    if (navigation === 'session') options.sessionId = 'other';
    rerender();
    await act(async () => { resolve({}); await pending; });
    expect(options.selectSession).not.toHaveBeenCalled();
    expect(options.reportError).not.toHaveBeenCalled();
  });

  it('discards a late reset failure after session navigation away and back', async () => {
    let reject!: (reason: Error) => void;
    apiMock.mockResolvedValueOnce({}).mockReturnValueOnce(new Promise((_done, fail) => { reject = fail; }));
    const { result, options, rerender } = renderComposers();
    act(() => result.current.session.setName('planning'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.session.create(); });
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    options.sessionId = 'other'; rerender();
    options.sessionId = ''; rerender();
    await act(async () => { reject(new Error('offline')); await pending; });
    expect(options.reportError).not.toHaveBeenCalled();
    expect(options.selectSession).not.toHaveBeenCalled();
    expect(result.current.session.error).toBe('');
  });

  it('exposes copied-history partial success and retries reset without another fork', async () => {
    apiMock.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('reset offline'));
    const { result, options } = renderComposers();
    act(() => result.current.session.setName('planning'));
    await act(() => result.current.session.create());
    expect(result.current.session.error).toContain('copied history');
    expect(options.selectSession).not.toHaveBeenCalled();
    await act(() => result.current.session.create());
    expect(apiMock.mock.calls.filter(([path]) => path.includes('/fork'))).toHaveLength(1);
    expect(options.selectSession).toHaveBeenCalledWith('planning');
  });

  it('keeps invalid or duplicate session names in the dialog without network work', async () => {
    const { result } = renderComposers({ sessions: [{ id: 'planning' }] });
    act(() => {
      result.current.session.open();
      result.current.session.setName('planning');
    });
    await act(() => result.current.session.create());

    expect(result.current.session.error).toContain('already exists');
    expect(apiMock).not.toHaveBeenCalled();
  });


  it('discovers server rooms, reopens a restored tab without duplication, and reloads after closing', async () => {
    apiMock.mockResolvedValue({ ok: true, channels: [{ id: 'design', name: 'Design', participantAgentIds: ['smatchet', 'hatchet'] }] });
    const existing = { id: 'group:local:design', label: 'Design', kind: 'group' as const, channelId: 'design' };
    const { result, options, rerender } = renderComposers({ tabs: [existing] });
    act(() => result.current.group.open());
    await waitFor(() => expect(result.current.group.rooms).toHaveLength(1));
    act(() => result.current.group.openExisting(result.current.group.rooms[0]));
    expect(options.setTabs).not.toHaveBeenCalled();
    expect(options.setActiveTabId).toHaveBeenCalledWith(existing.id);
    act(() => result.current.group.open());
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    // Closing a tab is a local view operation: the next fetch still discovers the server room.
    rerender();
    expect(result.current.group.rooms[0].id).toBe('design');
  });

  it('opens a server room in a fresh browser without saved tabs', async () => {
    apiMock.mockResolvedValue({ ok: true, channels: [{ id: 'from-server', name: 'Saved room', participantAgentIds: [] }] });
    const { result, options } = renderComposers();
    act(() => result.current.group.open());
    await waitFor(() => expect(result.current.group.rooms).toHaveLength(1));
    act(() => result.current.group.openExisting(result.current.group.rooms[0]));
    const updater = vi.mocked(options.setTabs).mock.calls[0][0] as (tabs: never[]) => Array<{ id: string; channelId?: string; targetId?: string }>;
    expect(updater([])).toEqual([expect.objectContaining({ id: 'group:from-server', channelId: 'from-server' })]);
    expect(options.setActiveTabId).toHaveBeenCalledWith('group:from-server');
  });

  it('keeps a failed discovery distinct from an empty room inventory', async () => {
    apiMock.mockRejectedValue(new Error('offline'));
    const { result } = renderComposers();
    act(() => result.current.group.open());
    await waitFor(() => expect(result.current.group.roomsError).toContain('offline'));
    expect(result.current.group.roomsLoading).toBe(false);
    expect(result.current.group.rooms).toEqual([]);
  });
});
