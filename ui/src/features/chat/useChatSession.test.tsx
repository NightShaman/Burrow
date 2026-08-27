import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiForTarget } from '../../app/api';
import { localApiTarget } from '../../app/apiTargets';
import { conversationCacheKey, useChatSession } from './useChatSession';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  apiForTarget: vi.fn(),
}));

const apiMock = vi.mocked(apiForTarget);
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
  apiMock.mockImplementation(async (_target, path) => {
    if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
    if (path === conversationPath) return { session: { id: sessionId, turns: [] } };
    throw new Error(`Unexpected path: ${path}`);
  });
});

describe('useChatSession', () => {
  it('loads the first session and its conversation for the selected agent', async () => {
    apiMock.mockImplementation(async (_target, path) => {
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
    apiMock.mockImplementation(async (_target, path) => {
      if (path === sessionListPath) return { sessions: [{ id: sessionId }] };
      if (path === conversationPath) return { session: { id: sessionId, turns: [] } };
      if (path === childConversationPath) return { session: { id: childSessionId, turns: [{ role: 'assistant', content: 'Child answer' }] } };
      throw new Error(`Unexpected path: ${path}`);
    });
    const { result } = renderHook(() => useChatSession(agentId));
    await waitFor(() => expect(result.current.sessionId).toBe(sessionId));

    act(() => result.current.selectChildSession(agentId, childSessionId));

    await waitFor(() => expect(result.current.turns).toEqual([{ role: 'assistant', content: 'Child answer' }]));
    expect(apiMock).toHaveBeenCalledWith(localApiTarget, childConversationPath);
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
    apiMock.mockImplementation((_target, path) => {
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
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(localApiTarget, conversationPath));

    apiMock.mockResolvedValueOnce({});
    await act(async () => {
      await result.current.resetSession();
      result.current.appendTurn(agentId, 'default', resetSessionTurn);
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
    apiMock.mockImplementation(async (_target, path) => {
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
    apiMock.mockImplementation((_target, path) => {
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
    apiMock.mockImplementation((_target, path) => {
      if (path === sessionListPath) return Promise.reject(new Error('offline'));
      throw new Error(`Unexpected path: ${path}`);
    });

    const { result } = renderHook(() => useChatSession(agentId));

    await waitFor(() => expect(result.current.chatError).toBe('Could not load sessions: offline'));
    expect(result.current.sessionId).toBe('');
    expect(result.current.turns).toEqual([]);
  });
});
