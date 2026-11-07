import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useConversationAuthority } from './useConversationAuthority';
import { conversationCacheInvalidated, writeConversationCache } from './chatConversationCache';
import { clientBudgets } from '../../app/clientBudgets';

beforeEach(() => localStorage.clear());

it('restores disk input without granting live freshness and retains authority across renders', () => {
  writeConversationCache({ 'a:s': [{ role: 'user', content: 'disk' }] }, 'a:s');
  const { result, rerender } = renderHook(() => useConversationAuthority(vi.fn()));
  const repository = result.current.sessionRepository;
  expect(result.current.conversationCacheRef.current['a:s'][0].content).toBe('disk');
  expect(result.current.liveSnapshots.current.size).toBe(0);
  rerender();
  expect(result.current.sessionRepository).toBe(repository);
});

it('bridges local persistence lag until the server acknowledges run and role', () => {
  const { result } = renderHook(() => useConversationAuthority(vi.fn()));
  const turn = { role: 'user' as const, content: 'local', runId: 'run' };
  result.current.appendLocalTurn('a:s', turn);
  expect(result.current.pendingTurnsRef.current.get('a:s')).toEqual([turn]);
  result.current.reconcileSnapshot('a:s', { id: 's', turns: [turn] }, [turn]);
  expect(result.current.pendingTurnsRef.current.has('a:s')).toBe(false);
  result.current.resetSnapshot('a:s');
  expect(result.current.conversationCacheRef.current['a:s']).toEqual([]);
});

it('bounds live freshness and clears all authority state on invalidation', () => {
  const invalidated = vi.fn();
  const { result, unmount } = renderHook(() => useConversationAuthority(invalidated));
  for (let i = 0; i <= clientBudgets.conversationCacheEntries; i++)
    result.current.rememberLiveSnapshot(`a:${i}`, 'v');
  expect(result.current.liveSnapshots.current.has('a:0')).toBe(false);
  result.current.appendLocalTurn('a:s', { role: 'user', content: 'x', runId: 'r' });
  result.current.staleSnapshots.current.add('a:s');
  act(() => window.dispatchEvent(new Event(conversationCacheInvalidated)));
  expect(result.current.conversationCacheRef.current).toEqual({});
  expect(result.current.pendingTurnsRef.current.size).toBe(0);
  expect(result.current.liveSnapshots.current.size).toBe(0);
  expect(result.current.staleSnapshots.current.size).toBe(0);
  expect(invalidated).toHaveBeenCalledTimes(1);
  unmount();
  window.dispatchEvent(new Event(conversationCacheInvalidated));
  expect(invalidated).toHaveBeenCalledTimes(1);
});

it('deduplicates concurrent navigation reads and permits a later fresh read', async () => {
  const { result } = renderHook(() => useConversationAuthority(vi.fn()));
  let resolve!: (session: { id: string; turns: [] }) => void;
  const load = vi.spyOn(result.current.sessionRepository, 'loadSession').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = result.current.loadNavigationSession('a', 's');
  expect(result.current.loadNavigationSession('a', 's')).toBe(first);
  expect(load).toHaveBeenCalledTimes(1);
  resolve({ id: 's', turns: [] });
  await first;
  load.mockResolvedValue({ id: 's', turns: [] });
  await result.current.loadNavigationSession('a', 's');
  expect(load).toHaveBeenCalledTimes(2);
});

it('owns paging exclusion and rejects navigation-away responses independently of attachments', async () => {
  const { result, rerender } = renderHook(({ id }) => useConversationAuthority(vi.fn(), 'a', id), {
    initialProps: { id: 's' },
  });
  let resolve!: (value: { id: string; turns: [] }) => void;
  const read = vi.spyOn(result.current.sessionRepository, 'loadOlder').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const display = vi.fn();
  const error = vi.fn();
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.loadOlder('a', 's', display, error);
  });
  await act(async () => {
    await result.current.loadOlder('a', 's', display, error);
  });
  expect(read).toHaveBeenCalledTimes(1);
  rerender({ id: 'other' });
  await act(async () => {
    resolve({ id: 's', turns: [] });
    await pending;
  });
  expect(display).not.toHaveBeenCalled();
  expect(result.current.conversationCacheRef.current['a:s']).toBeUndefined();
  expect(error).not.toHaveBeenCalled();
});
