import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type ActiveChatRunsResponse } from '../../app/api';
import { useChatRecovery } from './useChatRecovery';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()), api: vi.fn(),
}));
const apiMock = vi.mocked(api);
const run = { runId: 'old', agentId: 'a', sessionId: 's', status: 'running' };
const response = (runId = 'old'): ActiveChatRunsResponse => ({ ok: true, runs: [{ ...run, runId }] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}
function options() {
  return { agentId: 'a', sessionId: 's', enabled: true, isChildSession: false, onRefresh: vi.fn().mockResolvedValue(undefined), onError: vi.fn() };
}
beforeEach(() => { vi.useFakeTimers(); apiMock.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it.each(['success', 'not_found'])('retires a recovered run immediately on %s, reconciles, and rejects a stale in-flight poll', async (outcome) => {
  const latePoll = deferred<ActiveChatRunsResponse>();
  let polls = 0;
  apiMock.mockImplementation(async (path) => {
    if (path.endsWith('/cancel')) {
      if (outcome === 'not_found') throw Object.assign(new Error('chat_run_not_found'), { status: 404 });
      return { ok: true };
    }
    return ++polls === 2 ? latePoll.promise : response();
  });
  const opts = options();
  const { result, unmount } = renderHook(() => useChatRecovery(opts));
  await act(async () => {});
  expect(result.current.runtimeRun?.runId).toBe('old');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  opts.onRefresh.mockClear();
  await act(async () => { await result.current.cancelRuntimeRun(result.current.runtimeRun!); });
  expect(result.current.runtimeRun).toBeNull();
  expect(opts.onRefresh).toHaveBeenCalledTimes(1);
  expect(opts.onError).not.toHaveBeenCalled();
  await act(async () => { latePoll.resolve(response()); });
  expect(result.current.runtimeRun).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(result.current.runtimeRun).toBeNull();
  apiMock.mockResolvedValue(response('new'));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(result.current.runtimeRun?.runId).toBe('new');
  unmount();
});

it('retries retired-run transcript reconciliation after runtime disappearance until refresh succeeds', async () => {
  let active: ActiveChatRunsResponse = response();
  let allowRefresh = false;
  apiMock.mockImplementation(async (path) => path.endsWith('/cancel') ? { ok: true } : active);
  const opts = options();
  opts.onRefresh.mockImplementation(async () => { if (!allowRefresh) throw new Error('transcript not ready'); });
  const { result, unmount } = renderHook(() => useChatRecovery(opts));
  await act(async () => {});
  await act(async () => { await result.current.cancelRuntimeRun(result.current.runtimeRun!); });
  expect(result.current.runtimeRun).toBeNull();
  active = { ok: true, runs: [] };
  const before = opts.onRefresh.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(opts.onRefresh.mock.calls.length).toBeGreaterThan(before);
  const afterFailure = opts.onRefresh.mock.calls.length;
  allowRefresh = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(opts.onRefresh.mock.calls.length).toBeGreaterThan(afterFailure);
  const afterSuccess = opts.onRefresh.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(opts.onRefresh.mock.calls.length).toBe(afterSuccess);
  unmount();
});

it('retries reconciliation while a retired terminal summary remains retained', async () => {
  let allowRefresh = false;
  const terminal = { ...response().runs[0], status: 'cancelled' };
  apiMock.mockImplementation(async (path) => path.endsWith('/cancel') ? { ok: true } : { ok: true, runs: [terminal] });
  const opts = options();
  opts.onRefresh.mockImplementation(async () => { if (!allowRefresh) throw new Error('transcript not ready'); });
  const { result, unmount } = renderHook(() => useChatRecovery(opts));
  await act(async () => {});
  await act(async () => { await result.current.cancelRuntimeRun(result.current.runtimeRun!); });
  const before = opts.onRefresh.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(opts.onRefresh.mock.calls.length).toBeGreaterThan(before);
  const afterFailure = opts.onRefresh.mock.calls.length;
  allowRefresh = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(opts.onRefresh.mock.calls.length).toBeGreaterThan(afterFailure);
  unmount();
});

it('keeps terminal reconciliation scoped to its original session across navigation', async () => {
  let active = response();
  const refreshes: string[] = [];
  apiMock.mockImplementation(async (path) => path.endsWith('/cancel') ? { ok: true } : active);
  const base = options();
  base.onRefresh.mockImplementation(async () => { refreshes.push(base.sessionId); if (base.sessionId === 's') throw new Error('not ready'); });
  const { result, rerender, unmount } = renderHook((props: typeof base) => useChatRecovery(props), { initialProps: base });
  await act(async () => {});
  await act(async () => { await result.current.cancelRuntimeRun(result.current.runtimeRun!); });
  active = { ok: true, runs: [] };
  const other = { ...base, sessionId: 'other' };
  rerender(other);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  const failedOriginalRefreshes = refreshes.filter((value) => value === 's').length;
  rerender(base);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(refreshes.filter((value) => value === 's').length).toBeGreaterThan(failedOriginalRefreshes);
  unmount();
});

it('does not clear a replacement run when an older Stop completes late', async () => {
  const stop = deferred<unknown>();
  let active = response();
  apiMock.mockImplementation(path => path.endsWith('/cancel') ? stop.promise : Promise.resolve(active));
  const { result, unmount } = renderHook(() => useChatRecovery(options()));
  await act(async () => {});
  let pending!: Promise<void>;
  act(() => { pending = result.current.cancelRuntimeRun(result.current.runtimeRun!); });
  active = response('new');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(result.current.runtimeRun?.runId).toBe('new');
  await act(async () => { stop.resolve({ ok: true }); await pending; });
  expect(result.current.runtimeRun?.runId).toBe('new');
  unmount();
});

it('fences Stop completion after navigation and preserves unrelated failures', async () => {
  const stop = deferred<unknown>();
  const opts = options();
  apiMock.mockImplementation(path => path.endsWith('/cancel') ? stop.promise : Promise.resolve(response()));
  const { result, rerender, unmount } = renderHook(({ sessionId }) => useChatRecovery({ ...opts, sessionId }), { initialProps: { sessionId: 's' } });
  await act(async () => {});
  let pending!: Promise<void>;
  act(() => { pending = result.current.cancelRuntimeRun(result.current.runtimeRun!); });
  rerender({ sessionId: 'other' });
  await act(async () => {});
  opts.onRefresh.mockClear();
  await act(async () => { stop.resolve({ ok: true }); await pending; });
  expect(opts.onRefresh).not.toHaveBeenCalled();
  expect(opts.onError).not.toHaveBeenCalled();
  rerender({ sessionId: 's' });
  await act(async () => {});
  apiMock.mockRejectedValue(Object.assign(new Error('chat_run_not_found'), { status: 503 }));
  await act(async () => { await result.current.cancelRuntimeRun(result.current.runtimeRun!); });
  expect(result.current.runtimeRun?.runId).toBe('old');
  expect(opts.onError).toHaveBeenCalledWith('Could not stop run: chat_run_not_found');
  unmount();
});

it('retires a local Stop projection by exact identity without hiding another session or run', async () => {
  let active = response();
  apiMock.mockImplementation(async () => active);
  const { result, unmount } = renderHook(() => useChatRecovery(options()));
  await act(async () => {});
  act(() => result.current.retireRuntimeRun({ ...run, sessionId: 'other' }));
  expect(result.current.runtimeRun?.runId).toBe('old');
  act(() => result.current.retireRuntimeRun(run));
  expect(result.current.runtimeRun).toBeNull();
  active = response('new');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(result.current.runtimeRun?.runId).toBe('new');
  unmount();
});

it('waits for each poll/refresh, retries failures, and cancels timers and requests on unmount', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api).mockReturnValueOnce(new Promise(r => { resolve = r; }));
  const opts = options(); const view = renderHook(() => useChatRecovery(opts));
  const signal = vi.mocked(api).mock.calls[0][1]?.signal;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ ok: true, runs: [] }));
  vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true, runs: [] });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(opts.onError).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(api).toHaveBeenCalledTimes(3);
  view.unmount(); expect(signal?.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(api).toHaveBeenCalledTimes(3);
});
it('ignores a late previous-selection response and lets only the current scope refresh', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api).mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValue({ ok: true, runs: [] });
  const opts = options(); const view = renderHook(({ sessionId }) => useChatRecovery({ ...opts, sessionId }), { initialProps: { sessionId: 'one' } });
  const signal = vi.mocked(api).mock.calls[0][1]?.signal;
  view.rerender({ sessionId: 'two' });
  await act(async () => resolve({ ok: true, runs: [{ runId: 'old', agentId: 'a', sessionId: 'one', progress: [] }] }));
  expect(signal?.aborted).toBe(true); expect(view.result.current.runtimeRun).toBeNull();
  expect(opts.onRefresh).not.toHaveBeenCalled();
});
it('invalidates an already-started reconciliation callback on scope change', async () => {
  let finish!: () => void;
  const opts = options();
  opts.onRefresh.mockImplementation(() => new Promise<void>(r => { finish = r; }));
  vi.mocked(api).mockResolvedValue({ ok: true, runs: [] });
  const view = renderHook(({ sessionId }) => useChatRecovery({ ...opts, sessionId, isChildSession: true }), { initialProps: { sessionId: 'one' } });
  await act(async () => {});
  const context = (opts.onRefresh.mock.calls as unknown as [{ current: () => boolean }][])[0][0];
  expect(context.current()).toBe(true);
  view.rerender({ sessionId: 'two' });
  expect(context.current()).toBe(false);
  await act(async () => finish());
});
