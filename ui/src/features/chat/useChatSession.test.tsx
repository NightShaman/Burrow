import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { conversationCacheKey, useChatSession } from './useChatSession';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  api: vi.fn(),
}));

const apiMock = vi.mocked(api);
const agentId = 'luna';
const sessionId = 'session-1';
const sessionListPath = `/api/sessions?agentId=${agentId}`;
const conversationPath = `/api/sessions/${sessionId}?agentId=${agentId}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  apiMock.mockReset();
  apiMock.mockImplementation(async (path) => {
    if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
    if (path === conversationPath) return { session: { id: sessionId, turns: [] } };
    throw new Error(`Unexpected path: ${path}`);
  });
});

describe('useChatSession', () => {
  it('discards late reset after agent navigation', async () => {
    const { result, rerender } = renderHook(({ selected }) => useChatSession(selected), { initialProps: { selected: agentId } });
    await waitFor(() => expect(result.current.sessionId).toBe(sessionId));
    const delayed = deferred<unknown>();
    apiMock.mockImplementation((_path, init) => init?.method === 'POST' ? delayed.promise : Promise.resolve({ sessions: [{ id: sessionId }], session: { id: sessionId, turns: [] } }));
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.resetSession(); });
    rerender({ selected: 'other' });
    await act(async () => { delayed.resolve({}); await pending; });
    expect(result.current.isNewSession).toBe(false);
  });

  it('discards a late reset after navigating to a different session and back', async () => {
    const { result } = renderHook(() => useChatSession(agentId));
    await waitFor(() => expect(result.current.sessionId).toBe(sessionId));
    const delayed = deferred<unknown>();
    apiMock.mockReturnValueOnce(delayed.promise);
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.resetSession(); });
    act(() => result.current.selectSession('other'));
    act(() => result.current.selectSession(sessionId));
    act(() => result.current.appendTurn(agentId, sessionId, { role: 'user', content: 'newer' }));
    await act(async () => { delayed.resolve({}); await pending; });
    expect(result.current.turns).toContainEqual({ role: 'user', content: 'newer' });
  });

  it.each(['session-1', 'child-session', 'default'])('keeps reset destination %s and leaves unrelated default cache intact', async (destination) => {
    apiMock.mockImplementation(async (path) => {
      if (path === sessionListPath) return { sessions: [{ id: destination }] };
      if (path.endsWith('/reset?agentId=luna')) return { ok: true };
      if (path.startsWith('/api/sessions/')) return { session: { id: destination, turns: [{ role: 'assistant', content: 'Old context' }] } };
      throw new Error(`Unexpected path: ${path}`);
    });
    const { result } = renderHook(() => useChatSession(agentId));
    await waitFor(() => expect(result.current.turns).toHaveLength(1));
    act(() => result.current.appendTurn(agentId, 'default', { role: 'assistant', content: 'Unrelated default' }));
    await act(async () => { await result.current.resetSession(); });
    expect(result.current.sessionId).toBe(destination);
    expect(result.current.turns).toEqual([]);
    expect(apiMock).toHaveBeenCalledWith(`/api/sessions/${destination}/reset?agentId=luna`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    act(() => {
      result.current.leaveNewSessionForMessage();
      result.current.appendTurn(agentId, result.current.sessionId, { role: 'user', content: 'Next message' });
    });
    expect(result.current.turns).toEqual([{ role: 'user', content: 'Next message' }]);
    if (destination !== 'default') {
      act(() => result.current.selectSession('default'));
      expect(result.current.turns).toContainEqual({ role: 'assistant', content: 'Unrelated default' });
    }
  });

  it('loads the first session and its conversation for the selected agent', async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === sessionListPath) return { sessions: [{ id: sessionId }, { id: 'older' }] };
      if (path === conversationPath) return { session: { id: sessionId, turns: [{ role: 'assistant', content: 'Hello' }] } };
      throw new Error(`Unexpected path: ${path}`);
    });

    const { result } = renderHook(() => useChatSession(agentId));

    await waitFor(() => expect(result.current.sessionId).toBe(sessionId));
    await waitFor(() => expect(result.current.turns).toEqual([{ role: 'assistant', content: 'Hello' }]));
    expect(result.current.sessions).toHaveLength(2);
  });

  it('loads a selected child session through its parent agent even when it is absent from that agent’s session list', async () => {
    const childSessionId = 'child-session';
    const childConversationPath = `/api/sessions/${childSessionId}?agentId=${agentId}`;
    apiMock.mockImplementation(async (path) => {
      if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
      if (path === conversationPath) return { session: { id: sessionId, turns: [] } };
      if (path === childConversationPath) return { session: { id: childSessionId, turns: [{ role: 'assistant', content: 'Child answer' }] } };
      throw new Error(`Unexpected path: ${path}`);
    });
    const { result } = renderHook(() => useChatSession(agentId));
    await waitFor(() => expect(result.current.sessionId).toBe(sessionId));

    act(() => result.current.selectChildSession(agentId, childSessionId));

    await waitFor(() => expect(result.current.turns).toEqual([{ role: 'assistant', content: 'Child answer' }]));
    expect(apiMock).toHaveBeenCalledWith(childConversationPath);
  });

  it('keeps drafts per agent/session and writes them to local storage', async () => {
    const { result } = renderHook(() => useChatSession(agentId));
    await waitFor(() => expect(result.current.sessionId).toBe(sessionId));

    act(() => result.current.setDraft('Finish the tests'));

    await waitFor(() => expect(localStorage.getItem('hc.chatDrafts')).toContain('Finish the tests'));
    expect(result.current.draft).toBe('Finish the tests');
    expect(JSON.parse(localStorage.getItem('hc.chatDrafts') ?? '{}')).toEqual({
      version: 1,
      value: { [conversationCacheKey(agentId, sessionId)]: expect.objectContaining({ value: 'Finish the tests' }) },
    });
  });

  it('does not let an in-flight refresh erase a direct message appended after it started', async () => {
    const staleRefresh = deferred<{ session: { id: string; turns: { role: string; content: string }[] } }>();
    const { result } = renderHook(() => useChatSession(agentId));
    await waitFor(() => expect(result.current.sessionId).toBe(sessionId));
    await waitFor(() => expect(result.current.isLoadingConversation).toBe(false));

    apiMock.mockReturnValueOnce(staleRefresh.promise);
    let refreshPromise!: Promise<void>;
    act(() => { refreshPromise = result.current.refreshConversation(); });
    const optimisticTurn = { role: 'user' as const, content: 'Direct message after A2A' };
    act(() => result.current.appendTurn(agentId, sessionId, optimisticTurn));
    expect(result.current.turns).toEqual([optimisticTurn]);

    await act(async () => {
      staleRefresh.resolve({ session: { id: sessionId, turns: [{ role: 'assistant', content: 'Earlier A2A reply' }] } });
      await refreshPromise;
    });

    expect(result.current.turns).toEqual([optimisticTurn]);
  });

  it('does not let an older conversation request overwrite a refreshed conversation', async () => {
    const initialConversation = deferred<{ session: { id: string; turns: [{ role: string; content: string }] } }>();
    apiMock.mockImplementation((path) => {
      if (path === sessionListPath) return Promise.resolve({ sessions: [{ id: sessionId }] });
      if (path === conversationPath) return initialConversation.promise;
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });
    const { result } = renderHook(() => useChatSession(agentId));
    await waitFor(() => expect(result.current.sessionId).toBe(sessionId));

    apiMock.mockResolvedValueOnce({ session: { id: sessionId, turns: [{ role: 'assistant', content: 'Fresh answer' }] } });
    await act(async () => { await result.current.refreshConversation(); });
    expect(result.current.turns).toEqual([{ role: 'assistant', content: 'Fresh answer' }]);

    await act(async () => { initialConversation.resolve({ session: { id: sessionId, turns: [{ role: 'assistant', content: 'Stale answer' }] } }); });
    await waitFor(() => expect(result.current.isLoadingConversation).toBe(false));
    expect(result.current.turns).toEqual([{ role: 'assistant', content: 'Fresh answer' }]);
  });

  it('restores only non-empty, unexpired drafts from local storage', async () => {
    localStorage.setItem('hc.chatDrafts', JSON.stringify({
      [conversationCacheKey(agentId, sessionId)]: { value: 'Saved draft', updatedAt: Date.now() },
      stale: { value: 'Old draft', updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1_000 },
      empty: { value: '', updatedAt: Date.now() },
    }));

    const { result } = renderHook(() => useChatSession(agentId));
    await waitFor(() => expect(result.current.sessionId).toBe(sessionId));

    expect(result.current.draft).toBe('Saved draft');
    expect(JSON.parse(localStorage.getItem('hc.chatDrafts') ?? '{}').value).not.toHaveProperty('stale');
  });

  it('keeps the first optimistic turn when a reset session starts sending', async () => {
    const resetSessionTurn = { role: 'user' as const, content: 'First message' };
    const { result } = renderHook(() => useChatSession(agentId));
    await waitFor(() => expect(result.current.sessionId).toBe(sessionId));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(conversationPath));

    apiMock.mockResolvedValueOnce({});
    await act(async () => {
      await result.current.resetSession();
      result.current.appendTurn(agentId, sessionId, resetSessionTurn);
      result.current.leaveNewSessionForMessage();
    });

    expect(result.current.isNewSession).toBe(false);
    expect(result.current.turns).toEqual([resetSessionTurn]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.turns).toEqual([resetSessionTurn]);
  });

  it('keeps an optimistic user turn when a terminal refresh contains only its assistant reply', async () => {
    const { result } = renderHook(() => useChatSession(agentId));
    await waitFor(() => expect(result.current.sessionId).toBe(sessionId));

    const userTurn = { role: 'user' as const, content: 'Follow-up after A2A', runId: 'run-follow-up', ts: '2026-08-23T00:00:00.000Z' };
    const localAssistantTurn = { role: 'assistant' as const, content: 'Local reply', runId: 'run-follow-up', ts: '2026-08-23T00:00:01.000Z' };
    act(() => {
      result.current.appendTurn(agentId, sessionId, userTurn);
      result.current.appendTurn(agentId, sessionId, localAssistantTurn);
    });

    apiMock.mockResolvedValueOnce({ session: { id: sessionId, turns: [{ role: 'assistant', content: 'Persisted reply', runId: 'run-follow-up', ts: '2026-08-23T00:00:01.000Z' }] } });
    await act(async () => { await result.current.refreshConversation(); });

    expect(result.current.turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'Follow-up after A2A', runId: 'run-follow-up' }),
      expect.objectContaining({ role: 'assistant', content: 'Persisted reply', runId: 'run-follow-up' }),
    ]));
  });

  it('does not resurrect cached turns from before a server-side reset', async () => {
    const resetAt = '2026-08-26T10:00:00.000Z';
    localStorage.setItem('hc.chatConversations.v1', JSON.stringify({
      [conversationCacheKey(agentId, sessionId)]: {
        savedAt: Date.now(),
        turns: [{ role: 'assistant', content: 'Yesterday afternoon', runId: 'old-run', ts: '2026-08-25T15:00:00.000Z' }],
      },
    }));
    apiMock.mockImplementation(async (path) => {
      if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
      if (path === conversationPath) return { session: { id: sessionId, metadata: { resetAt, transcriptGeneration: 'new-generation' }, turns: [] } };
      throw new Error(`Unexpected path: ${path}`);
    });

    const { result } = renderHook(() => useChatSession(agentId));

    await waitFor(() => expect(result.current.isLoadingConversation).toBe(false));
    expect(result.current.turns).toEqual([]);
    expect(JSON.parse(localStorage.getItem('hc.chatConversations.v1') ?? '{}').value[conversationCacheKey(agentId, sessionId)].turns).toEqual([]);
  });

  it('merges stored tool activity into refreshed assistant turns', async () => {
    const { result } = renderHook(() => useChatSession(agentId));
    await waitFor(() => expect(result.current.sessionId).toBe(sessionId));

    act(() => result.current.storeToolActivity({ runId: 'run-1', items: [{ id: 'tool-1', label: 'Read file', status: 'ok' }] }));
    apiMock.mockResolvedValueOnce({ session: { id: sessionId, turns: [{ role: 'assistant', runId: 'run-1', content: 'Answer' }] } });

    await act(async () => { await result.current.refreshConversation(); });

    expect(result.current.turns[0]).toMatchObject({
      content: 'Answer',
      metadata: { toolActivity: { runId: 'run-1', items: [{ id: 'tool-1', label: 'Read file', status: 'ok' }] } },
    });
  });

  it('stays in a loading state while an agent switch waits for its session list', async () => {
    const nextAgentId = 'smatchet';
    const nextSessionId = 'session-2';
    const nextSessionListPath = `/api/sessions?agentId=${nextAgentId}`;
    const nextConversationPath = `/api/sessions/${nextSessionId}?agentId=${nextAgentId}`;
    const nextSessions = deferred<{ sessions: { id: string }[] }>();
    apiMock.mockImplementation((path) => {
      if (path === sessionListPath) return Promise.resolve({ sessions: [{ id: sessionId }] });
      if (path === conversationPath) return Promise.resolve({ session: { id: sessionId, turns: [{ role: 'assistant', content: 'Previous conversation' }] } });
      if (path === nextSessionListPath) return nextSessions.promise;
      if (path === nextConversationPath) return Promise.resolve({ session: { id: nextSessionId, turns: [] } });
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    const { result, rerender } = renderHook(({ agent }) => useChatSession(agent), { initialProps: { agent: agentId } });
    await waitFor(() => expect(result.current.sessionId).toBe(sessionId));

    rerender({ agent: nextAgentId });

    expect(result.current.sessionId).toBe('');
    expect(result.current.turns).toEqual([{ role: 'assistant', content: 'Previous conversation' }]);
    expect(result.current.isLoadingConversation).toBe(true);

    await act(async () => { nextSessions.resolve({ sessions: [{ id: nextSessionId }] }); });
    await waitFor(() => expect(result.current.isLoadingConversation).toBe(false));
  });

  it('surfaces session loading failures without pretending a conversation loaded', async () => {
    apiMock.mockImplementation((path) => {
      if (path === sessionListPath) return Promise.reject(new Error('offline'));
      throw new Error(`Unexpected path: ${path}`);
    });

    const { result } = renderHook(() => useChatSession(agentId));

    await waitFor(() => expect(result.current.chatError).toBe('Could not load sessions: offline'));
    expect(result.current.sessionId).toBe('');
    expect(result.current.turns).toEqual([]);
  });
});

it('polls selected worker child activity and late terminal turns with no active chat runs', async () => {
  let childTurns = [{ role: 'user', content: 'Delegated task' }];
  apiMock.mockImplementation(async (path) => {
    if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
    if (path === conversationPath) return { session: { turns: [] } };
    if (path.startsWith('/api/chat/runs/active?')) return { runs: [] };
    if (path === `/api/sessions/child?agentId=${agentId}`) return { session: { turns: childTurns } };
    throw new Error(path);
  });
  const { result, unmount } = renderHook(() => useChatSession(agentId));
  await waitFor(() => expect(result.current.sessionId).toBe(sessionId));
  act(() => result.current.selectChildSession(agentId, 'child'));
  await waitFor(() => expect(result.current.turns).toEqual(childTurns));
  childTurns = [...childTurns, { role: 'assistant', content: 'Working' }];
  await waitFor(() => expect(result.current.turns).toEqual(childTurns), { timeout: 2500 });
  childTurns = [...childTurns, { role: 'assistant', content: 'Final response' }];
  await waitFor(() => expect(result.current.turns).toEqual(childTurns), { timeout: 2500 });
  unmount();
});

it('discards an in-flight child poll after selecting the parent, including its cached result', async () => {
  const pending = deferred<{ session: { turns: { role: string; content: string }[] } }>();
  let hold = false;
  let requested = false;
  apiMock.mockImplementation(async (path) => {
    if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
    if (path === conversationPath) return { session: { turns: [{ role: 'assistant', content: 'Parent' }] } };
    if (path.startsWith('/api/chat/runs/active?')) return { runs: [] };
    if (path === `/api/sessions/child?agentId=${agentId}`) {
      if (hold) { requested = true; return pending.promise; }
      return { session: { turns: [{ role: 'assistant', content: 'Child' }] } };
    }
    throw new Error(path);
  });
  const { result, unmount } = renderHook(() => useChatSession(agentId));
  await waitFor(() => expect(result.current.sessionId).toBe(sessionId));
  act(() => result.current.selectChildSession(agentId, 'child'));
  await waitFor(() => expect(result.current.turns[0]?.content).toBe('Child'));
  hold = true;
  await waitFor(() => expect(requested).toBe(true), { timeout: 2500 });
  act(() => result.current.selectSession(sessionId));
  await waitFor(() => expect(result.current.turns[0]?.content).toBe('Parent'));
  await act(async () => pending.resolve({ session: { turns: [{ role: 'assistant', content: 'Stale child' }] } }));
  expect(result.current.turns[0]?.content).toBe('Parent');
  expect(JSON.stringify(localStorage)).not.toContain('Stale child');
  unmount();
});

it('exposes a destination session task run with live tools, thoughts, and A2A activity', async () => {
  apiMock.mockImplementation(async (path) => {
    if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
    if (path === conversationPath) return { session: { id: sessionId, turns: [] } };
    if (path.startsWith('/api/chat/runs/active?')) return {
      runs: [{
        runId: 'task-run', agentId, sessionId, status: 'running', phase: 'streaming', source: 'task',
        progress: [
          { type: 'assistant.thought', ts: '2026-09-15T12:00:00.000Z', data: { delta: 'Checking', modelCall: 2 } },
          { type: 'assistant.thought', data: { delta: ' the runtime.', modelCall: 2 } },
          { type: 'assistant.thought', data: { delta: '\nSecond call.', modelCall: 3 } },
          { type: 'tool.started', data: { activityId: 'tool-1', tool: 'shell_exec', label: 'Inspect status' } },
        ],
        a2aActivities: [{ id: 'a2a-1', status: 'running', parentAgentId: agentId, recipient: { agentId: 'minion', sessionId: 'child' }, progress: [] }],
      }],
    };
    throw new Error(path);
  });

  const { result, unmount } = renderHook(() => useChatSession(agentId));
  await waitFor(() => expect(result.current.sessionId).toBe(sessionId));
  await waitFor(() => expect(result.current.runtimeRun).toMatchObject({
    runId: 'task-run',
    progress: [
      expect.objectContaining({ text: 'Checking the runtime.', modelCall: 2 }),
      expect.objectContaining({ text: '\nSecond call.', modelCall: 3 }),
    ],
    toolActivity: { runId: 'task-run', items: [expect.objectContaining({ label: 'Inspect status', status: 'pending' })] },
  }));
  expect(result.current.a2aActivities).toEqual([expect.objectContaining({ id: 'a2a-1' })]);
  unmount();
});

it('exposes active subagent activity when no chat run is registered', async () => {
  const now = Date.now();
  const startedAt = new Date(now - 120_000).toISOString();
  const lastActualActivityAt = new Date(now - 420_000).toISOString();
  apiMock.mockImplementation(async (path) => {
    if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
    if (path === conversationPath || path === `/api/sessions/child-session?agentId=${agentId}`) return { session: { id: sessionId, turns: [] } };
    if (path.startsWith('/api/chat/runs/active?')) return { runs: [], subagents: [{
      id: 'child-1', agentId, runId: 'child-run', sessionId: 'child-session', parentSessionId: sessionId, status: 'running', phase: 'tool', final: false,
      label: 'Repo check', purpose: 'Inspect UI activity', lastActualActivityAt,
      activity: { kind: 'tool', status: 'running', phase: 'tool', label: 'shell_exec', tool: 'shell_exec', sequence: 3, startedAt, lastActualActivityAt },
      trace: { runId: 'child-run', childSessionId: 'child-session' },
    }] };
    throw new Error(path);
  });
  const { result, unmount } = renderHook(() => useChatSession(agentId));
  await waitFor(() => expect(result.current.sessionId).toBe(sessionId));
  act(() => result.current.selectChildSession(agentId, 'child-session'));
  await waitFor(() => expect(result.current.runtimeRun).toMatchObject({ runId: 'child-run', latestUserMessage: 'Inspect UI activity' }));
  expect(result.current.runtimeRun?.toolActivity?.items?.[0]).toMatchObject({ label: 'shell_exec', status: 'pending', detail: expect.stringContaining('last actual event 7m ago') });
  expect(result.current.runtimeRun?.toolActivity?.items?.[0].detail).toContain('elapsed 2m');
  unmount();
});

it('keeps parent runtime identity while surfacing all matching child activity', async () => {
  apiMock.mockImplementation(async (path) => {
    if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
    if (path === conversationPath) return { session: { id: sessionId, turns: [] } };
    if (path.startsWith('/api/chat/runs/active?')) return { runs: [{ runId: 'parent-run', agentId, sessionId, status: 'running', latestUserMessage: 'Parent prompt', progress: [] }], subagents: [
      { id: 'child-1', agentId, runId: 'child-run-1', parentRunId: 'parent-run', sessionId: 'child-a', parentSessionId: sessionId, final: false, activity: { label: 'shell_exec', tool: 'shell_exec', status: 'running' } },
      { id: 'child-2', agentId, runId: 'child-run-2', parentRunId: 'parent-run', sessionId: 'child-b', parentSessionId: sessionId, final: false, activity: { label: 'files_read', tool: 'files_read', status: 'running' } },
      { id: 'child-other-session', agentId, runId: 'child-run-3', parentRunId: 'parent-run', sessionId: 'child-c', parentSessionId: 'other-session', final: false, activity: { label: 'ignored', tool: 'ignored', status: 'running' } },
      { id: 'child-other-agent', agentId: 'smatchet', runId: 'child-run-4', parentRunId: 'parent-run', sessionId: 'child-d', parentSessionId: sessionId, final: false, activity: { label: 'ignored', tool: 'ignored', status: 'running' } },
      { id: 'child-other-run', agentId, runId: 'child-run-5', parentRunId: 'other-run', sessionId: 'child-e', parentSessionId: sessionId, final: false, activity: { label: 'ignored', tool: 'ignored', status: 'running' } },
    ] };
    throw new Error(path);
  });
  const { result, unmount } = renderHook(() => useChatSession(agentId));
  await waitFor(() => expect(result.current.runtimeRun?.runId).toBe('parent-run'));
  expect(result.current.runtimeRun).toMatchObject({ agentId, sessionId, latestUserMessage: 'Parent prompt' });
  expect(result.current.runtimeChildActivities.map((activity) => activity.runId)).toEqual(['child-run-1', 'child-run-2']);
  unmount();
});

it('uses child-only runtime activity only for selected child sessions, without assigning child identity to the parent selection', async () => {
  apiMock.mockImplementation(async (path) => {
    if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
    if (path === conversationPath) return { session: { id: sessionId, turns: [] } };
    if (path.startsWith('/api/chat/runs/active?')) return { runs: [], subagents: [{
      id: 'child-1', agentId, runId: 'child-run', sessionId: 'child-session', parentSessionId: sessionId, final: false,
      purpose: 'Child work', activity: { label: 'shell_exec', tool: 'shell_exec', status: 'running' },
    }] };
    throw new Error(path);
  });
  const { result, unmount } = renderHook(() => useChatSession(agentId));
  await waitFor(() => expect(result.current.runtimeChildActivities.map((activity) => activity.runId)).toEqual(['child-run']));
  expect(result.current.runtimeRun).toBeNull();
  unmount();
});

it('cleans up child activity when children become terminal', async () => {
  let final = false;
  apiMock.mockImplementation(async (path) => {
    if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
    if (path === conversationPath) return { session: { id: sessionId, turns: [] } };
    if (path.startsWith('/api/chat/runs/active?')) return { runs: [{ runId: 'parent-run', agentId, sessionId, status: 'running', progress: [] }], subagents: final ? [] : [{ id: 'child-1', agentId, runId: 'child-run', parentRunId: 'parent-run', sessionId: 'child-session', parentSessionId: sessionId, final: false, activity: { label: 'shell_exec', tool: 'shell_exec', status: 'running' } }] };
    throw new Error(path);
  });
  const { result, unmount } = renderHook(() => useChatSession(agentId));
  await waitFor(() => expect(result.current.runtimeChildActivities).toHaveLength(1));
  final = true;
  await waitFor(() => expect(result.current.runtimeChildActivities).toHaveLength(0), { timeout: 2500 });
  unmount();
});

it('reduces task tool completion onto its started activity and exposes the task prompt', async () => {
  apiMock.mockImplementation(async (path) => {
    if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
    if (path === conversationPath) return { session: { id: sessionId, turns: [] } };
    if (path.startsWith('/api/chat/runs/active?')) return { runs: [{
      runId: 'task-run', agentId, sessionId, status: 'running', phase: 'tool', source: 'task', latestUserMessage: 'Inspect the destination session.',
      progress: [
        { type: 'tool.started', data: { activityId: 'tool-1', tool: 'shell_exec', label: 'Inspect status' } },
        { type: 'tool.completed', data: { activityId: 'tool-1', tool: 'shell_exec', label: 'Inspect status', ok: true, status: 'completed' } },
      ],
    }] };
    throw new Error(path);
  });
  const { result, unmount } = renderHook(() => useChatSession(agentId));
  await waitFor(() => expect(result.current.runtimeRun).toMatchObject({ runId: 'task-run', latestUserMessage: 'Inspect the destination session.' }));
  expect(result.current.runtimeRun?.toolActivity?.items).toEqual([{ id: 'tool-1', label: 'Inspect status', status: 'ok' }]);
  unmount();
});

it('cancels the selected external task run with its resource owner', async () => {
  apiMock.mockImplementation(async (path, init) => {
    if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
    if (path === conversationPath) return { session: { id: sessionId, turns: [] } };
    if (path.startsWith('/api/chat/runs/active?')) return { runs: [{ runId: 'task-run', agentId, sessionId, status: 'running', latestUserMessage: 'Stop me', progress: [] }] };
    if (path === '/api/chat/task-run/cancel') { expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ agentId, reason: 'Stopped by operator' }) }); return { ok: true }; }
    throw new Error(path);
  });
  const { result, unmount } = renderHook(() => useChatSession(agentId));
  await waitFor(() => expect(result.current.runtimeRun?.runId).toBe('task-run'));
  await act(async () => { await result.current.cancelRuntimeRun(result.current.runtimeRun!); });
  expect(apiMock).toHaveBeenCalledWith('/api/chat/task-run/cancel', expect.objectContaining({ method: 'POST' }));
  unmount();
});

it('clears a task run immediately when selecting another session', async () => {
  const otherSessionId = 'session-2';
  apiMock.mockImplementation(async (path) => {
    if (path === sessionListPath) return { sessions: [{ id: sessionId }, { id: otherSessionId }] };
    if (path === conversationPath || path === `/api/sessions/${otherSessionId}?agentId=${agentId}`) return { session: { id: sessionId, turns: [] } };
    if (path.startsWith('/api/chat/runs/active?')) return { runs: [{ runId: 'task-run', agentId, sessionId, status: 'running', latestUserMessage: 'Old session task', progress: [] }] };
    throw new Error(path);
  });
  const { result, unmount } = renderHook(() => useChatSession(agentId));
  await waitFor(() => expect(result.current.runtimeRun?.runId).toBe('task-run'));
  act(() => result.current.selectSession(otherSessionId));
  expect(result.current.runtimeRun).toBeNull();
  unmount();
});

 it('discards pending attachments on agent navigation and rejects delayed completion', async () => {
 const { result, rerender } = renderHook(({ agent }) => useChatSession(agent), { initialProps: { agent: agentId } });
 await waitFor(() => expect(result.current.sessionId).toBe(sessionId));
 const oldSetter = result.current.setAttachment;
 const file = { name: 'secret.txt', type: 'text/plain', size: 6, encoding: 'data-url' as const, content: 'secret' };
 act(() => result.current.setAttachment([file]));
 expect(result.current.attached).toHaveLength(1);
 rerender({ agent: 'other' });
 expect(result.current.attached).toEqual([]);
 act(() => oldSetter([file]));
 expect(result.current.attached).toEqual([]);
 });

it('purge clears mounted memory and fences a delayed refresh from repersisting it', async () => {
  const { clearConversationCache, readConversationCache } = await import('./chatConversationCache');
  const { result, unmount } = renderHook(() => useChatSession(agentId));
  await waitFor(() => expect(result.current.sessionId).toBe(sessionId));
  await waitFor(() => expect(result.current.isLoadingConversation).toBe(false));
  act(() => result.current.appendTurn(agentId, sessionId, { role: 'assistant', content: 'secret', runId: 'old' }));
  const delayed = deferred<unknown>();
  apiMock.mockImplementation((path) => path === conversationPath ? delayed.promise : Promise.resolve({ runs: [], sessions: [{ id: sessionId }] }));
  let refresh!: Promise<void>;
  act(() => { refresh = result.current.refreshConversation(); });
  act(() => clearConversationCache());
  expect(result.current.turns).toEqual([]);
  await act(async () => { delayed.resolve({ session: { id: sessionId, turns: [{ role: 'assistant', content: 'secret', runId: 'old' }] } }); await refresh; });
  expect(result.current.turns).toEqual([]);
  expect(readConversationCache()).toEqual({});
  unmount();
});

it('admits attachment batches cumulatively including concurrent read completions', () => {
  const { result } = renderHook(() => useChatSession(agentId));
  const file = { name: 'a.txt', type: 'text/plain', size: 1, content: 'x', encoding: 'data-url' as const };
  act(() => result.current.setAttachment(Array(9).fill(file)));
  expect(result.current.attached).toHaveLength(8);
  act(() => result.current.setAttachment([file]));
  expect(result.current.attached).toHaveLength(8);
});

it('keeps submitted user visible through empty polling snapshots without duplicate persisted turns or draft loss', async () => {
 const {result} = renderHook(() => useChatSession(agentId));
 await waitFor(() => expect(result.current.sessionId).toBe(sessionId));
 const submitted = {role:'user' as const,content:'submitted now',runId:'pending-run',ts:new Date().toISOString()};
 act(() => { result.current.appendTurn(agentId,sessionId,submitted); result.current.setDraft('next draft'); });
 expect(result.current.turns).toContainEqual(submitted);
 await act(async () => { await result.current.refreshConversation(); });
 expect(result.current.turns).toContainEqual(submitted);
 expect(result.current.draft).toBe('next draft');
 apiMock.mockImplementation(async path => path === conversationPath ? {session:{id:sessionId,turns:[submitted]}} : {sessions:[{id:sessionId}]});
 await act(async () => { await result.current.refreshConversation(); });
 expect(result.current.turns.filter(turn => turn.runId === 'pending-run')).toHaveLength(1);
});

it('audit: preserves interrupted pending turn before reset but filters it after backend resetAt',async()=>{
 let reset=false;
 apiMock.mockImplementation(async(path,init)=>{
  if(path===sessionListPath)return {sessions:[{id:sessionId}]};
  if(init?.method==='POST' && path.includes('/reset')){reset=true;return {ok:true,metadata:{resetAt:'2026-10-07T12:01:00.000Z'}};}
  if(path===conversationPath)return {session:{id:sessionId,turns:[],...(reset?{metadata:{resetAt:'2026-10-07T12:01:00.000Z'}}:{})}};
  return {runs:[],subagents:[]};
 });
 const {result}=renderHook(()=>useChatSession(agentId));
 await waitFor(()=>expect(result.current.sessionId).toBe(sessionId));
 act(()=>result.current.appendTurn(agentId,sessionId,{role:'user',runId:'interrupted-run',content:'Interrupted submitted message',ts:'2026-10-07T12:00:00.000Z'}));
 await act(async()=>{await result.current.refreshConversation();});
 expect(result.current.turns).toEqual([expect.objectContaining({content:'Interrupted submitted message'})]);
 await act(async()=>{await result.current.resetSession();});
 await act(async()=>{await result.current.refreshConversation();});
 expect(result.current.turns).toEqual([]);
});

it.each([
  [[], undefined],
  [[{ type: 'run.started' }, { type: 'route.decided' }], 'preparing'],
  [[{ type: 'model.started' }], 'request-intent'],
  [[{ type: 'model.dispatched', data: { modelCall: 1 } }], 'dispatched'],
  [[{ type: 'model.started', data: { modelCall: 2 } }, { type: 'model.dispatched', data: { modelCall: 1 } }], 'request-intent'],
  [[{ type: 'model.started' }, { type: 'model.dispatched', runId: 'wrong', data: { modelCall: 1 } }], 'request-intent'],
  [[{ type: 'model.started' }, { type: 'model.completed' }], 'model-completed'],
] as const)('recovers live stage from polling events, never the streaming phase: %j', async (events, stage) => {
  apiMock.mockImplementation(async (path) => {
    if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
    if (path === conversationPath) return { session: { id: sessionId, turns: [] } };
    if (path.startsWith('/api/chat/runs/active?')) return { runs: [{ runId: 'recovered', agentId, sessionId, status: 'running', phase: 'streaming', progress: events }] };
    throw new Error(path);
  });
  const { result, unmount } = renderHook(() => useChatSession(agentId));
  await waitFor(() => expect(result.current.runtimeRun?.runId).toBe('recovered'));
  expect(result.current.runtimeRun?.stage).toBe(stage);
  expect(result.current.runtimeRun?.progress).toEqual([]);
  act(() => result.current.selectSession('other-session'));
  expect(result.current.runtimeRun).toBeNull();
  unmount();
});

it.each([
  [{ blockers: 1, blockerReasons: ['needs_review'], outcome: 'incomplete' }, undefined, 'Incomplete'],
  [{ blockers: ['subagent_incomplete'] }, undefined, 'Incomplete'],
  [{ blockerReasons: ['subagent_incomplete', 'subagent_model_failed:offline'], outcome: 'incomplete' }, undefined, 'Error'],
  [{ blockerReasons: ['needs_review'], outcome: 'incomplete' }, 'dispatch failed', 'Error'],
])('shows terminal incomplete as warning and execution failures as Error', async (childResult, error, label) => {
  apiMock.mockImplementation(async (path) => {
    if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
    if (path === conversationPath) return { session: { id: sessionId, turns: [] } };
    if (path.startsWith('/api/chat/runs/active?')) return { runs: [], subagents: [{
      id: 'child-warning', agentId, runId: 'child-run', sessionId: 'child-session', parentSessionId: sessionId,
      status: 'failed', final: false, result: childResult, activity: { status: 'failed', error },
    }] };
    throw new Error(path);
  });
  const { result, unmount } = renderHook(() => useChatSession(agentId));
  await waitFor(() => expect(result.current.runtimeChildActivities).toHaveLength(1));
  expect(result.current.runtimeChildActivities[0]).toMatchObject({ status: 'warn', items: [{ label, status: 'error' }] });
  unmount();
});

it('recovers externally dispatched work on assigned agent and after navigation away/return', async () => {
 const target = 'assigned'; const dispatched = 'task-session';
 apiMock.mockImplementation(async path => {
  if (path.startsWith('/api/sessions?')) return { sessions: [{ id: 'default' }] };
  if (path.startsWith('/api/sessions/')) return { session: { turns: [{ role: 'user', content: 'External task', ts: '2026-01-01' }] } };
  if (path.startsWith('/api/chat/runs/active?')) {
   const query = new URLSearchParams(path.split('?')[1]);
   return { runs: query.get('agentId') === target && query.get('sessionId') === dispatched ? [{ runId: 'external-run', agentId: target, sessionId: dispatched, status: 'running', answerText: 'Partial answer\nwith whitespace ', progress: [{ type: 'model.dispatched', data: { modelCall: 1 } }] }] : [] };
  }
  throw new Error(path);
 });
 const { result, rerender, unmount } = renderHook(({ selected }) => useChatSession(selected), { initialProps: { selected: agentId } });
 await waitFor(() => expect(result.current.sessionId).toBe('default'));
 act(() => result.current.selectSession(dispatched, target));
 rerender({ selected: target });
 await waitFor(() => expect(result.current.runtimeRun?.runId).toBe('external-run'));
 expect(result.current.sessionId).toBe(dispatched);
 expect(result.current.runtimeRun?.stage).toBe('dispatched');
 expect(result.current.runtimeRun?.answerText).toBe('Partial answer\nwith whitespace ');
 await waitFor(() => expect(result.current.turns[0]?.content).toBe('External task'));
 rerender({ selected: agentId });
 await waitFor(() => expect(result.current.runtimeRun).toBeNull());
 rerender({ selected: target });
 await waitFor(() => expect(result.current.runtimeRun?.runId).toBe('external-run'));
 expect(result.current.sessionId).toBe(dispatched);
 expect(result.current.runtimeRun?.answerText).toBe('Partial answer\nwith whitespace ');
 unmount();
});
