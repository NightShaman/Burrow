import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clientBudgets } from '../../app/clientBudgets';
import { api } from '../../app/api';
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
