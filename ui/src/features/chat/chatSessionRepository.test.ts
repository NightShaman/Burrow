import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clientBudgets } from '../../app/clientBudgets';
import { api } from '../../app/api';
import { clearConversationCache } from './chatConversationCache';
import {
  createChatSessionRepository,
  readSessionListCache,
  sessionListCacheStorageKey,
  writeSessionListCache,
} from './chatSessionRepository';
vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
const request = vi.mocked(api);
beforeEach(() => {
  localStorage.clear();
  request.mockReset();
});
describe('chatSessionRepository local runtime', () => {
  it('lists sessions through local API and caches by agent id', async () => {
    request.mockResolvedValue({ sessions: [{ id: 'default' }] });
    const repository = createChatSessionRepository();
    await expect(repository.listSessions('agent/name')).resolves.toEqual([{ id: 'default' }]);
    expect(request).toHaveBeenCalledWith('/api/sessions?agentId=agent%2Fname');
    expect(readSessionListCache('agent/name')).toEqual([{ id: 'default' }]);
  });
  it('loads and resets sessions using encoded path identifiers', async () => {
    request
      .mockResolvedValueOnce({ session: { id: 'child/session', turns: [] } })
      .mockResolvedValueOnce(undefined);
    const repository = createChatSessionRepository();
    await expect(repository.loadSession('agent/name', 'child/session')).resolves.toEqual({
      id: 'child/session',
      turns: [],
    });
    await repository.resetSession('agent/name', 'child/session');
    expect(request).toHaveBeenNthCalledWith(
      1,
      '/api/sessions/child%2Fsession?agentId=agent%2Fname',
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      '/api/sessions/child%2Fsession/reset?agentId=agent%2Fname',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: expect.any(String),
      },
      { deadlineMs: clientBudgets.sessionResetDeadlineMs },
    );
    expect(JSON.parse(request.mock.calls[1][1]!.body as string)).toEqual({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('resets on LAN HTTP where native randomUUID is unavailable', async () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(undefined as never);
    request.mockResolvedValue(undefined);
    await createChatSessionRepository().resetSession('agent', 'named');
    expect(JSON.parse(request.mock.calls[0][1]!.body as string).operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('recovers a lost reset response only by reading the exact committed reset identity', async () => {
    let operationId = '';
    request.mockImplementation(async (_path, init) => {
      if (init?.method === 'POST') {
        operationId = JSON.parse(init.body as string).operationId;
        throw new DOMException('Request deadline exceeded', 'TimeoutError');
      }
      return {
        session: {
          id: 'named',
          turns: [],
          metadata: { resetOperationId: operationId, resetGeneration: 3 },
        },
      };
    });
    await expect(
      createChatSessionRepository().resetSession('agent', 'named'),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith('/api/sessions/named?agentId=agent', {
      cache: 'no-store',
    });
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each([
    [
      'unchanged generation',
      { id: 'named', turns: [], metadata: { resetOperationId: 'older', resetGeneration: 2 } },
    ],
    [
      'unrelated reset',
      { id: 'named', turns: [], metadata: { resetOperationId: 'another-tab', resetGeneration: 4 } },
    ],
    ['empty transcript alone', { id: 'named', turns: [] }],
    ['wrong session', { id: 'other', turns: [], metadata: { resetGeneration: 3 } }],
    ['missing generation', { id: 'named', turns: [], metadata: {} }],
    [
      'newer messages',
      {
        id: 'named',
        turns: [{ role: 'user', content: 'Keep this' }],
        metadata: { resetGeneration: 3 },
      },
    ],
    ['missing turns', { id: 'named', metadata: { resetGeneration: 3 } }],
    ['invalid generation', { id: 'named', turns: [], metadata: { resetGeneration: -1 } }],
  ])('does not claim reset success or retry for %s', async (_label, session) => {
    request.mockImplementation(async (_path, init) => {
      if (init?.method === 'POST') {
        const operationId = JSON.parse(init.body as string).operationId;
        if ('metadata' in session && session.metadata && !('resetOperationId' in session.metadata))
          Object.assign(session.metadata, { resetOperationId: operationId });
        throw new TypeError('Failed to fetch');
      }
      return { session };
    });
    await expect(createChatSessionRepository().resetSession('agent', 'named')).rejects.toThrow(
      'Reset outcome could not be confirmed',
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('verifies an HTTP 408 without replaying the reset mutation', async () => {
    request.mockImplementation(async (_path, init) => {
      if (init?.method === 'POST')
        throw Object.assign(new Error('Request timeout'), { status: 408 });
      return { session: { id: 'named', turns: [] } };
    });
    await expect(createChatSessionRepository().resetSession('agent', 'named')).rejects.toThrow(
      'Reset outcome could not be confirmed',
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('preserves uncertainty when verification also fails', async () => {
    request.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createChatSessionRepository().resetSession('agent', 'named')).rejects.toThrow(
      'Refresh the session before trying again',
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('propagates explicit rejection without treating it as an uncertain commit', async () => {
    request.mockRejectedValue(Object.assign(new Error('session_busy'), { status: 409 }));
    await expect(createChatSessionRepository().resetSession('agent', 'named')).rejects.toThrow(
      'session_busy',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('propagates failures without replacing cached session list', async () => {
    writeSessionListCache('agent', [{ id: 'cached' }]);
    request.mockRejectedValueOnce(new Error('offline'));
    await expect(createChatSessionRepository().listSessions('agent')).rejects.toThrow('offline');
    expect(readSessionListCache('agent')).toEqual([{ id: 'cached' }]);
  });
});
describe('session list cache', () => {
  it('rejects malformed storage', () => {
    localStorage.setItem(sessionListCacheStorageKey, '{broken');
    expect(readSessionListCache('agent')).toBeNull();
  });
  it('retains only sixteen most recently written agents', () => {
    for (let i = 0; i < 17; i++) writeSessionListCache(`agent-${i}`, [{ id: 'default' }]);
    const stored = JSON.parse(localStorage.getItem(sessionListCacheStorageKey) ?? '{}');
    expect(Object.keys(stored.value)).toHaveLength(16);
    expect(stored.value).not.toHaveProperty('agent-0');
  });
});

describe('active scrollback', () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  const turn = (id: string) => ({ id, type: 'message', role: 'user', content: id });
  const page = (ids: string[], cursor: string | null, generation = 0) => ({
    session: {
      id: 'default',
      turns: ids.map(turn),
      hasMore: Boolean(cursor),
      nextCursor: cursor,
      metadata: { resetGeneration: generation },
    },
  });
  it('loads older only on demand, deduplicates overlap and preserves loaded prefix on compaction refresh', async () => {
    request
      .mockResolvedValueOnce(page(['c', 'd'], 'one'))
      .mockResolvedValueOnce(page(['a', 'b', 'c'], null))
      .mockResolvedValueOnce(page(['d', 'e'], 'fresh'));
    const repo = createChatSessionRepository();
    await repo.loadSession('agent', 'default');
    expect(request).toHaveBeenCalledTimes(1);
    expect((await repo.loadOlder('agent', 'default')).turns?.map((t) => t.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(request.mock.calls[1][0]).toContain('&before=one');
    expect((await repo.loadSession('agent', 'default')).turns?.map((t) => t.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });
  it('preserves distinct identical-content fallback occurrences across older pages and refresh', async () => {
    // API display IDs identify persisted occurrences, not a hash of message content.
    const firstId = 'display-occurrence:row-41:0';
    const secondId = 'display-occurrence:row-41:1';
    const fallbackPage = (ids: string[], cursor: string | null) => ({
      session: {
        ...page(ids, cursor).session,
        turns: ids.map((id) => ({ ...turn(id), content: 'Identical legacy message' })),
      },
    });
    request
      .mockResolvedValueOnce(fallbackPage([secondId], 'older'))
      .mockResolvedValueOnce(fallbackPage([firstId, secondId], null))
      .mockResolvedValueOnce(fallbackPage([secondId], 'fresh'))
      .mockResolvedValueOnce(fallbackPage([firstId, secondId], null));
    const repo = createChatSessionRepository();
    await repo.loadSession('agent', 'default');
    const older = await repo.loadOlder('agent', 'default');
    expect(older.turns?.map((item) => item.id)).toEqual([firstId, secondId]);
    expect(older.turns?.map((item) => item.content)).toEqual([
      'Identical legacy message',
      'Identical legacy message',
    ]);
    expect(older.hasMore).toBe(false);
    const refreshed = await repo.loadSession('agent', 'default');
    expect(refreshed.turns).toEqual(older.turns);
    // A refresh adopts a fresh API cursor; redundant traversal must not duplicate occurrences.
    expect(refreshed.hasMore).toBe(true);
    const revisited = await repo.loadOlder('agent', 'default');
    expect(revisited.turns).toEqual(older.turns);
    expect(revisited.hasMore).toBe(false);
    expect(request).toHaveBeenCalledTimes(4);
  });
  it.each([false, true])('recovers stale cursor; reset=%s', async (reset) => {
    request
      .mockResolvedValueOnce(page(['c'], 'old'))
      .mockRejectedValueOnce(new Error('archive_cursor_invalid'))
      .mockResolvedValueOnce(page(['d'], 'new', reset ? 1 : 0));
    const repo = createChatSessionRepository();
    await repo.loadSession('agent', 'default');
    expect((await repo.loadOlder('agent', 'default')).turns?.map((t) => t.id)).toEqual(['d']);
    expect(request.mock.calls[2][0]).not.toContain('before=');
  });
  it('keeps current conversation after an older-page network failure', async () => {
    request.mockResolvedValueOnce(page(['c'], 'old')).mockRejectedValueOnce(new Error('offline'));
    const repo = createChatSessionRepository();
    await repo.loadSession('agent', 'default');
    await expect(repo.loadOlder('agent', 'default')).rejects.toThrow('offline');
    request.mockResolvedValueOnce(page(['a', 'b'], null));
    expect((await repo.loadOlder('agent', 'default')).turns?.map((t) => t.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
  it.each(['older-first', 'refresh-first', 'refresh-refresh'])(
    'merges concurrent %s without losing turns or cursor',
    async (order) => {
      const repo = createChatSessionRepository();
      request.mockResolvedValueOnce(page(['c'], 'initial'));
      await repo.loadSession('agent', 'default');
      const firstResponse = deferred<ReturnType<typeof page>>();
      const secondStarted = deferred<void>();
      request.mockImplementationOnce(() => firstResponse.promise);
      request.mockImplementationOnce(async () => {
        secondStarted.resolve();
        return order === 'refresh-first' ? page(['a', 'b'], 'oldest') : page(['d', 'e'], 'fresh');
      });
      const first =
        order === 'older-first'
          ? repo.loadOlder('agent', 'default')
          : repo.loadSession('agent', 'default');
      const second =
        order === 'refresh-first'
          ? repo.loadOlder('agent', 'default')
          : repo.loadSession('agent', 'default');
      await Promise.resolve();
      expect(request).toHaveBeenCalledTimes(3);
      firstResponse.resolve(
        order === 'older-first' ? page(['a', 'b'], 'oldest') : page(['c', 'd'], 'middle'),
      );
      await first;
      await secondStarted.promise;
      await second;
      const result = await first;
      expect(result.turns?.map((t) => t.id)).toEqual(
        order === 'refresh-first'
          ? ['a', 'b', 'c', 'd']
          : order === 'older-first'
            ? ['a', 'b', 'c', 'd', 'e']
            : ['d', 'e'],
      );
      expect(result.nextCursor).toBe(
        order === 'refresh-first' ? 'middle' : order === 'older-first' ? 'oldest' : 'fresh',
      );
      if (order === 'refresh-first') expect(request.mock.calls[2][0]).toContain('before=initial');
    },
  );

  it('does not retain rows omitted from a fresh newest page when no older page was fetched', async () => {
    request
      .mockResolvedValueOnce(page(['removed', 'kept'], null))
      .mockResolvedValueOnce(page(['kept'], null));
    const repo = createChatSessionRepository();
    await repo.loadSession('agent', 'default');
    expect((await repo.loadSession('agent', 'default')).turns?.map((t) => t.id)).toEqual(['kept']);
  });

  it('drops loaded prefixes after explicit browser cache invalidation, even with unchanged reset metadata', async () => {
    request
      .mockResolvedValueOnce(page(['new'], 'older'))
      .mockResolvedValueOnce(page(['old', 'new'], null))
      .mockResolvedValueOnce(page([], null));
    const repo = createChatSessionRepository();
    await repo.loadSession('agent', 'default');
    expect((await repo.loadOlder('agent', 'default')).turns?.map((t) => t.id)).toEqual([
      'old',
      'new',
    ]);
    clearConversationCache();
    expect((await repo.loadSession('agent', 'default')).turns).toEqual([]);
  });

  it('cannot reinstate a pre-invalidation in-flight response in a subsequent read', async () => {
    request.mockResolvedValueOnce(page(['old'], null));
    const repo = createChatSessionRepository();
    await repo.loadSession('agent', 'default');
    const delayed = deferred<ReturnType<typeof page>>();
    request
      .mockImplementationOnce(() => delayed.promise)
      .mockResolvedValueOnce(page([], null))
      .mockResolvedValueOnce(page([], null));
    const obsolete = repo.loadSession('agent', 'default');
    clearConversationCache();
    const fresh = repo.loadSession('agent', 'default');
    delayed.resolve(page(['old'], null));
    await obsolete;
    expect((await fresh).turns).toEqual([]);
    expect((await repo.loadSession('agent', 'default')).turns).toEqual([]);
  });

  it('orders an in-flight read, reset and new load without resurrecting the old generation', async () => {
    const repo = createChatSessionRepository();
    const oldResponse = deferred<ReturnType<typeof page>>();
    const resetResponse = deferred<void>();
    const resetStarted = deferred<void>();
    request.mockImplementationOnce(() => oldResponse.promise);
    request.mockImplementationOnce(() => {
      resetStarted.resolve();
      return resetResponse.promise;
    });
    request.mockResolvedValueOnce(page(['new'], null, 1));
    const old = repo.loadSession('agent', 'default');
    const reset = repo.resetSession('agent', 'default');
    const fresh = repo.loadSession('agent', 'default');
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    oldResponse.resolve(page(['old'], 'old-cursor'));
    await old;
    await resetStarted.promise;
    expect(request).toHaveBeenCalledTimes(2);
    resetResponse.resolve();
    await reset;
    expect((await fresh).turns?.map((t) => t.id)).toEqual(['new']);
    expect((await repo.loadOlder('agent', 'default')).nextCursor).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not block another session and allows refresh after failure', async () => {
    const repo = createChatSessionRepository();
    const blocked = deferred<ReturnType<typeof page>>();
    request.mockImplementationOnce(() => blocked.promise);
    const first = repo.loadSession('agent', 'default');
    await Promise.resolve();
    request.mockResolvedValueOnce(page(['independent'], null));
    await expect(repo.loadSession('other-agent', 'default')).resolves.toHaveProperty(
      'nextCursor',
      null,
    );
    blocked.resolve(page(['c'], 'cursor'));
    await first;
    request.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page(['d'], 'fresh'));
    const failed = repo.loadOlder('agent', 'default');
    const next = repo.loadSession('agent', 'default');
    await expect(failed).rejects.toThrow('offline');
    expect((await next).turns?.map((t) => t.id)).toEqual(['d']);
  });
});

it('does not let an old same-session older page overwrite the newer request after returning', async () => {
  const pending: ((value: unknown) => void)[] = [];
  request.mockImplementation(async (path) => {
    if (String(path).includes('before=')) return new Promise((resolve) => pending.push(resolve));
    return {
      session: {
        id: 'a',
        turns: [{ id: 'newest', role: 'user', content: 'newest' }],
        hasMore: true,
        nextCursor: 'older',
      },
    };
  });
  const repo = createChatSessionRepository();
  await repo.loadSession('agent', 'a');
  const old = repo.loadOlder('agent', 'a');
  const current = repo.loadOlder('agent', 'a');
  pending[1]({
    session: {
      id: 'a',
      turns: [{ id: 'current', role: 'user', content: 'current' }],
      hasMore: false,
    },
  });
  await current;
  pending[0]({
    session: {
      id: 'a',
      turns: [{ id: 'stale', role: 'user', content: 'stale' }],
      hasMore: true,
      nextCursor: 'stale',
    },
  });
  expect((await old).turns?.map((turn) => turn.id)).toEqual(['current', 'newest']);
  const loaded = await repo.loadSession('agent', 'a');
  expect(loaded.turns?.some((turn) => turn.id === 'stale')).toBe(false);
});
