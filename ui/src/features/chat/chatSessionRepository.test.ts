import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiForTarget } from '../../app/api';
import { localApiTarget, type ApiTarget } from '../../app/apiTargets';
import { createChatSessionRepository, readSessionListCache, sessionListCacheStorageKey, writeSessionListCache } from './chatSessionRepository';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  apiForTarget: vi.fn(),
}));

const apiForTargetMock = vi.mocked(apiForTarget);
const remoteTarget: ApiTarget = { id: 'remote', name: 'Remote', baseUrl: 'https://remote.example', enabled: true };

beforeEach(() => {
  localStorage.clear();
  apiForTargetMock.mockReset();
});

describe('chatSessionRepository', () => {
  it('routes qualified agents through their owning target and backend resource id', async () => {
    apiForTargetMock.mockResolvedValueOnce({ sessions: [{ id: 'default' }] });
    const repository = createChatSessionRepository([localApiTarget, remoteTarget]);

    await expect(repository.listSessions('remote::agent/name')).resolves.toEqual([{ id: 'default' }]);

    expect(apiForTargetMock).toHaveBeenCalledWith(remoteTarget, '/api/sessions?agentId=agent%2Fname');
    expect(readSessionListCache('remote::agent/name')).toEqual([{ id: 'default' }]);
  });

  it('loads and resets sessions with encoded target-owned paths', async () => {
    apiForTargetMock.mockResolvedValueOnce({ session: { id: 'child/session', turns: [] } }).mockResolvedValueOnce(undefined);
    const repository = createChatSessionRepository([localApiTarget, remoteTarget]);

    await expect(repository.loadSession('remote::agent/name', 'child/session')).resolves.toEqual({ id: 'child/session', turns: [] });
    await repository.resetSession('remote::agent/name', 'child/session');

    expect(apiForTargetMock).toHaveBeenNthCalledWith(1, remoteTarget, '/api/sessions/child%2Fsession?agentId=agent%2Fname');
    expect(apiForTargetMock).toHaveBeenNthCalledWith(2, remoteTarget, '/api/sessions/child%2Fsession/reset?agentId=agent%2Fname', { method: 'POST' });
  });

  it('propagates request failures without replacing the cached session list', async () => {
    writeSessionListCache('agent', [{ id: 'cached' }]);
    apiForTargetMock.mockRejectedValueOnce(new Error('offline'));
    const repository = createChatSessionRepository([localApiTarget]);

    await expect(repository.listSessions('agent')).rejects.toThrow('offline');
    expect(readSessionListCache('agent')).toEqual([{ id: 'cached' }]);
  });
});

describe('session list cache', () => {
  it('rejects malformed storage and invalid entries', () => {
    localStorage.setItem(sessionListCacheStorageKey, '{broken');
    expect(readSessionListCache('agent')).toBeNull();

    localStorage.setItem(sessionListCacheStorageKey, JSON.stringify({ agent: { savedAt: 'yesterday', sessions: [] } }));
    expect(readSessionListCache('agent')).toBeNull();
  });

  it('retains only the sixteen most recently written agents', () => {
    for (let index = 0; index < 17; index += 1) writeSessionListCache(`agent-${index}`, [{ id: 'default' }]);

    const stored = JSON.parse(localStorage.getItem(sessionListCacheStorageKey) ?? '{}') as { version: number; value: Record<string, unknown> };
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.value)).toHaveLength(16);
    expect(stored.value).not.toHaveProperty('agent-0');
    expect(stored.value).toHaveProperty('agent-16');
  });
});
