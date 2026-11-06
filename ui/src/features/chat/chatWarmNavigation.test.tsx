import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { clearConversationCache } from './chatConversationCache';
import { useChatSession } from './useChatSession';
vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
const first = '2026-11-06T02:00:00.000Z';
const latest = '2026-11-06T02:01:00.000Z';
function deferred() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function page(agent: string, content = `${agent} CURRENT`, version = first) {
  return {
    session: {
      id: 'default',
      hasMore: true,
      nextCursor: 'older',
      metadata: { updatedAt: version },
      turns: [{ id: content, role: 'assistant', type: 'message', content }],
    },
  };
}
let changed = false;
let delayed: ReturnType<typeof deferred> | undefined;
let fail = false;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.mocked(api).mockReset();
  changed = false;
  delayed = undefined;
  fail = false;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.includes('updatedSince='))
      return {
        sessions:
          changed && path.includes('agentId=a&') ? [{ id: 'default', updatedAt: latest }] : [],
      };
    if (path.startsWith('/api/sessions?')) return { sessions: [{ id: 'default' }] };
    if (path.startsWith('/api/sessions/default')) {
      if (path.includes('agentId=a')) {
        if (fail) throw new Error('offline');
        if (delayed) return delayed.promise;
        return page('a', changed ? 'a NEW' : 'a CURRENT', changed ? latest : first);
      }
      return page('b');
    }
    return { runs: [] };
  });
});
afterEach(() => vi.useRealTimers());
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}
async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
}
it('returns instantly to validated live history while revalidation remains pending', async () => {
  const { result, rerender } = renderHook(({ agent }) => useChatSession(agent), {
    initialProps: { agent: 'a' },
  });
  await settle();
  expect(result.current.turns[0]?.content).toBe('a CURRENT');
  rerender({ agent: 'b' });
  await settle();
  delayed = deferred();
  rerender({ agent: 'a' });
  expect(result.current.turns[0]?.content).toBe('a CURRENT');
  expect(result.current.isLoadingConversation).toBe(false);
  expect(result.current.hasOlder).toBe(true);
  await act(async () => delayed!.resolve(page('a')));
});
it('keeps offscreen completed work current before returning, without a loading screen', async () => {
  const { result, rerender } = renderHook(({ agent }) => useChatSession(agent), {
    initialProps: { agent: 'a' },
  });
  await settle();
  rerender({ agent: 'b' });
  await settle();
  changed = true;
  await tick();
  delayed = deferred();
  rerender({ agent: 'a' });
  expect(result.current.turns[0]?.content).toBe('a NEW');
  expect(result.current.isLoadingConversation).toBe(false);
  await act(async () => delayed!.resolve(page('a', 'a NEW', latest)));
});
it('does not paint known-stale history and shares an in-flight background read on navigation', async () => {
  const { result, rerender } = renderHook(({ agent }) => useChatSession(agent), {
    initialProps: { agent: 'a' },
  });
  await settle();
  rerender({ agent: 'b' });
  await settle();
  changed = true;
  delayed = deferred();
  await tick();
  const reads = () =>
    vi.mocked(api).mock.calls.filter(([p]) => p === '/api/sessions/default?agentId=a').length;
  const count = reads();
  rerender({ agent: 'a' });
  expect(result.current.turns).toEqual([]);
  expect(reads()).toBe(count);
  await act(async () => delayed!.resolve(page('a', 'a NEW', latest)));
  expect(result.current.turns[0]?.content).toBe('a NEW');
  expect(result.current.isLoadingConversation).toBe(false);
});
it('retries failed offscreen refreshes instead of making stale history live', async () => {
  const { result, rerender } = renderHook(({ agent }) => useChatSession(agent), {
    initialProps: { agent: 'a' },
  });
  await settle();
  rerender({ agent: 'b' });
  await settle();
  changed = true;
  fail = true;
  await tick();
  fail = false;
  await tick();
  delayed = deferred();
  rerender({ agent: 'a' });
  expect(result.current.turns[0]?.content).toBe('a NEW');
  await act(async () => delayed!.resolve(page('a', 'a NEW', latest)));
});
it('purge invalidates a pending background read and prevents resurrection on navigation', async () => {
  const { result, rerender } = renderHook(({ agent }) => useChatSession(agent), {
    initialProps: { agent: 'a' },
  });
  await settle();
  rerender({ agent: 'b' });
  await settle();
  changed = true;
  delayed = deferred();
  await tick();
  act(() => clearConversationCache());
  await act(async () => delayed!.resolve(page('a', 'a NEW', latest)));
  delayed = deferred();
  rerender({ agent: 'a' });
  expect(result.current.turns).toEqual([]);
  expect(result.current.isLoadingConversation).toBe(true);
  await act(async () => delayed!.resolve(page('a', 'EMPTY', latest)));
});
it('an offscreen poll cannot erase local work appended after its request began', async () => {
  const { result, rerender } = renderHook(({ agent }) => useChatSession(agent), {
    initialProps: { agent: 'a' },
  });
  await settle();
  rerender({ agent: 'b' });
  await settle();
  changed = true;
  delayed = deferred();
  await tick();
  act(() =>
    result.current.appendTurn('a', 'default', { role: 'user', runId: 'local', content: 'LOCAL' }),
  );
  await act(async () => delayed!.resolve(page('a', 'a NEW', latest)));
  delayed = undefined;
  await tick();
  rerender({ agent: 'a' });
  await settle();
  expect(result.current.turns.some((t) => t.content === 'LOCAL')).toBe(true);
});
