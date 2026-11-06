import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { isChatRunNotFoundError, useLiveSteering } from './useLiveSteering';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
const input = {
  id: 'durable-1',
  status: 'pending',
  message: 'change direction',
  createdAt: '2026-10-10',
};
it('recognizes only the exact unknown-run 404 used for normal-send reconciliation', () => {
  const missing = Object.assign(new Error('chat_run_not_found'), { status: 404 });
  expect(isChatRunNotFoundError(missing)).toBe(true);
  expect(
    isChatRunNotFoundError(Object.assign(new Error('chat_run_not_found'), { status: 503 })),
  ).toBe(false);
  expect(isChatRunNotFoundError(Object.assign(new Error('other_not_found'), { status: 404 }))).toBe(
    false,
  );
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api).mockResolvedValue({ steering: [] });
});
it('submits to the existing run and merges durable acceptance without starting chat', async () => {
  const { result, unmount } = renderHook(() => useLiveSteering('agent', 'session', 'run'));
  await waitFor(() => expect(api).toHaveBeenCalled());
  vi.mocked(api).mockResolvedValueOnce({ steering: input });
  await act(async () => {
    await result.current.submit('change direction', []);
  });
  expect(result.current.inputs).toEqual([input]);
  const [path, request] = vi
    .mocked(api)
    .mock.calls.filter(([, request]) => request?.method === 'POST')
    .at(-1)!;
  expect(path).toBe('/api/chat/run/steer');
  expect(JSON.parse(request!.body as string)).toMatchObject({
    agentId: 'agent',
    sessionId: 'session',
    message: 'change direction',
    idempotencyKey: expect.any(String),
  });
  unmount();
});
it('retains the retry identity on rejection and exposes no pretend accepted message', async () => {
  const { result, unmount } = renderHook(() => useLiveSteering('agent', 'session', 'run'));
  await waitFor(() => expect(api).toHaveBeenCalled());
  vi.mocked(api).mockRejectedValueOnce(new Error('404'));
  await act(async () => {
    await expect(result.current.submit('change direction', [])).rejects.toThrow('404');
  });
  const first = JSON.parse(
    vi
      .mocked(api)
      .mock.calls.filter(([, request]) => request?.method === 'POST')
      .at(-1)![1]!.body as string,
  );
  expect(result.current.inputs).toEqual([]);
  vi.mocked(api).mockResolvedValueOnce({ steering: { ...input, status: 'follow_up' } });
  await act(async () => {
    await result.current.submit('change direction', []);
  });
  const second = JSON.parse(
    vi
      .mocked(api)
      .mock.calls.filter(([, request]) => request?.method === 'POST')
      .at(-1)![1]!.body as string,
  );
  expect(second.idempotencyKey).toBe(first.idempotencyKey);
  expect(result.current.inputs[0].status).toBe('follow_up');
  unmount();
});
it('does not leak a late acceptance into another session', async () => {
  const { result, rerender, unmount } = renderHook(
    ({ session }) => useLiveSteering('agent', session, 'run'),
    { initialProps: { session: 'one' } },
  );
  await waitFor(() => expect(api).toHaveBeenCalled());
  let resolve!: (value: unknown) => void;
  vi.mocked(api).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }) as ReturnType<typeof api>,
  );
  let pending!: ReturnType<typeof result.current.submit>;
  act(() => {
    pending = result.current.submit('change direction', []);
  });
  rerender({ session: 'two' });
  await act(async () => {
    resolve({ steering: input });
    expect(await pending).toBeNull();
  });
  expect(result.current.inputs).toEqual([]);
  unmount();
});
it('ignores old A visit acceptance after A→B→A', async () => {
  const { result, rerender, unmount } = renderHook(
    ({ session }) => useLiveSteering('agent', session, 'run'),
    { initialProps: { session: 'A' } },
  );
  await waitFor(() => expect(api).toHaveBeenCalled());
  let resolve!: (v: unknown) => void;
  vi.mocked(api).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }) as ReturnType<typeof api>,
  );
  let old!: ReturnType<typeof result.current.submit>;
  act(() => {
    old = result.current.submit('old', []);
  });
  rerender({ session: 'B' });
  rerender({ session: 'A' });
  await act(async () => {
    resolve({ steering: input });
    expect(await old).toBeNull();
  });
  expect(result.current.inputs).toEqual([]);
  unmount();
});

it('retains ambiguous steering identity across navigation/remount, but not after acceptance or for a new reset', async () => {
  const posts: Array<Record<string, unknown>> = [];
  vi.mocked(api).mockImplementation(async (_path, request) => {
    if (request?.method !== 'POST') return { steering: [] } as never;
    posts.push(JSON.parse(request.body as string));
    if (posts.length < 4) throw new Error('lost');
    return { steering: { ...input, status: 'delivered' } } as never;
  });
  const props = { agent: 'steer-agent', session: 'A', run: 'run', reset: 0 };
  const h = renderHook(
    ({ agent, session, run, reset }) => useLiveSteering(agent, session, run, reset),
    { initialProps: props },
  );
  const send = () =>
    h.result.current.submit('steer-again', [], { promotedFrom: 'source', generation: 4 });
  await act(async () => {
    await expect(send()).rejects.toThrow('lost');
  });
  h.rerender({ agent: 'other', session: 'B', run: 'other-run', reset: 0 });
  h.rerender(props);
  await act(async () => {
    await expect(send()).rejects.toThrow('lost');
  });
  h.unmount();
  const remount = renderHook(({ reset }) => useLiveSteering('steer-agent', 'A', 'run', reset), {
    initialProps: { reset: 0 },
  });
  const submit = () =>
    remount.result.current.submit('steer-again', [], { promotedFrom: 'source', generation: 4 });
  await act(async () => {
    await expect(submit()).rejects.toThrow('lost');
  });
  expect(posts[0].idempotencyKey).toBe(posts[1].idempotencyKey);
  expect(posts[0].idempotencyKey).toBe(posts[2].idempotencyKey);
  await act(async () => {
    await submit();
  });
  await act(async () => {
    await submit();
  });
  expect(posts[3].idempotencyKey).toBe(posts[0].idempotencyKey);
  expect(posts[4].idempotencyKey).not.toBe(posts[0].idempotencyKey);
  remount.rerender({ reset: 1 });
  await act(async () => {
    await submit();
  });
  expect(posts[5].idempotencyKey).not.toBe(posts[4].idempotencyKey);
  remount.unmount();
});

it('retries transient terminal polling failures while pending and stops once delivered', async () => {
  vi.useFakeTimers();
  const reads: Array<{ steering: (typeof input)[] }> = [
    { steering: [input] },
    { steering: [input] },
    { steering: [{ ...input, status: 'delivered' as const }] },
  ];
  let polls = 0;
  vi.mocked(api).mockImplementation(async () => {
    polls++;
    if (polls === 3) throw new Error('offline');
    return (reads.shift() ?? { steering: [] }) as never;
  });
  try {
    const h = renderHook(({ run }) => useLiveSteering('poll-agent', 'poll-session', run), {
      initialProps: { run: 'poll-run' },
    });
    await act(async () => {});
    h.rerender({ run: '' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(polls).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(polls).toBe(4);
    expect(h.result.current.inputs[0].status).toBe('delivered');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(polls).toBe(4);
    h.unmount();
  } finally {
    vi.useRealTimers();
  }
});
