import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { writeConversationCache } from './chatConversationCache';
import { writeSessionListCache } from './chatSessionRepository';
import { useChatSession } from './useChatSession';
vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
it('waits for the newest transcript instead of showing stale cached history on agent selection', async () => {
  localStorage.clear();
  writeSessionListCache('smatchet', [{ id: 'default' }]);
  writeConversationCache(
    {
      'smatchet:default': [
        { id: 'old', role: 'assistant', type: 'message', content: 'OLD HANDOFF 7:27 PM' },
      ],
    },
    'smatchet:default',
  );
  let resolve!: (value: unknown) => void;
  const pending = new Promise((r) => {
    resolve = r;
  });
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/api/sessions?agentId=smatchet') return { sessions: [{ id: 'default' }] };
    if (path === '/api/sessions/default?agentId=smatchet') return pending;
    if (path.includes('/runs/active')) return { runs: [] };
    if (path === '/api/sessions?agentId=other') return { sessions: [{ id: 'default' }] };
    if (path === '/api/sessions/default?agentId=other')
      return {
        session: {
          id: 'default',
          turns: [{ id: 'other', role: 'assistant', type: 'message', content: 'Other agent' }],
        },
      };
    throw new Error(path);
  });
  const { result, rerender } = renderHook(({ agent }) => useChatSession(agent), {
    initialProps: { agent: 'other' },
  });
  await waitFor(() => expect(result.current.turns[0]?.content).toBe('Other agent'));
  rerender({ agent: 'smatchet' });
  expect(result.current.turns).toEqual([]);
  expect(result.current.isLoadingConversation).toBe(true);
  await act(async () =>
    resolve({
      session: {
        id: 'default',
        turns: [
          { id: 'new', role: 'assistant', type: 'message', content: 'CURRENT COMPLETED ANSWER' },
        ],
      },
    }),
  );
  await waitFor(() => expect(result.current.turns[0]?.content).toBe('CURRENT COMPLETED ANSWER'));
});

it.each(['named', 'child'])(
  'fetches current %s sessions before exposing their cached turns',
  async (target) => {
    localStorage.clear();
    writeConversationCache(
      { [`smatchet:${target}`]: [{ role: 'assistant', content: 'STALE' }] },
      `smatchet:${target}`,
    );
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === '/api/sessions?agentId=smatchet')
        return { sessions: [{ id: 'default' }, { id: 'named' }] };
      if (path === `/api/sessions/${target}?agentId=smatchet`) return pending;
      if (path === '/api/sessions/default?agentId=smatchet')
        return { session: { id: 'default', turns: [{ role: 'assistant', content: 'ROOT' }] } };
      return { runs: [] };
    });
    const { result } = renderHook(() => useChatSession('smatchet'));
    await waitFor(() => expect(result.current.turns[0]?.content).toBe('ROOT'));
    act(() =>
      target === 'child'
        ? result.current.selectChildSession('smatchet', target, 'default')
        : result.current.selectSession(target),
    );
    expect(result.current.turns).toEqual([]);
    expect(result.current.isLoadingConversation).toBe(true);
    await act(async () =>
      finish({ session: { id: target, turns: [{ role: 'assistant', content: 'CURRENT' }] } }),
    );
    await waitFor(() => expect(result.current.turns[0]?.content).toBe('CURRENT'));
    expect(result.current.isLoadingConversation).toBe(false);
    // Reselecting the current destination must not clear it indefinitely.
    act(() =>
      target === 'child'
        ? result.current.selectChildSession('smatchet', target, 'default')
        : result.current.selectSession(target),
    );
    expect(result.current.turns[0]?.content).toBe('CURRENT');
    expect(result.current.isLoadingConversation).toBe(false);
  },
);

it('keeps a loaded parent visible when its rail card is clicked again', async () => {
  localStorage.clear();
  vi.mocked(api).mockImplementation(async (path) =>
    path.includes('/api/sessions?')
      ? { sessions: [{ id: 'default' }] }
      : {
          session: { id: 'default', turns: [{ role: 'assistant', content: 'CURRENT' }] },
          runs: [],
        },
  );
  const { result } = renderHook(() => useChatSession('smatchet'));
  await waitFor(() => expect(result.current.turns[0]?.content).toBe('CURRENT'));
  act(() => result.current.prepareAgentSelection('smatchet'));
  expect(result.current.turns[0]?.content).toBe('CURRENT');
  expect(result.current.isLoadingConversation).toBe(false);
});

it('reports a failed navigation read instead of falling back to old stored history', async () => {
  localStorage.clear();
  writeConversationCache(
    { 'smatchet:default': [{ role: 'assistant', content: 'STALE' }] },
    'smatchet:default',
  );
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/api/sessions?agentId=smatchet') return { sessions: [{ id: 'default' }] };
    if (path === '/api/sessions/default?agentId=smatchet') throw new Error('offline');
    return { runs: [] };
  });
  const { result } = renderHook(() => useChatSession('smatchet'));
  await waitFor(() =>
    expect(result.current.chatError).toBe('Could not load conversation: offline'),
  );
  expect(result.current.turns).toEqual([]);
  expect(result.current.isLoadingConversation).toBe(false);
});
