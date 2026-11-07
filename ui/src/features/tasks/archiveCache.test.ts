import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveSessionsCacheStorageKey,
  readArchiveSessionCache,
  writeArchiveSessionCache,
} from './archiveCache';
import type { ArchiveSession } from './archiveTypes';

const session = (id: string): ArchiveSession => ({
  agentId: 'agent',
  agentName: 'Agent',
  sessionId: id,
  id,
  title: id,
  summary: '',
  turnCount: 0,
  chatTurnCount: 0,
  createdAt: null,
  updatedAt: null,
  archived: true,
  archivedAt: null,
  kind: null,
  lastRole: null,
  lastRunId: null,
});

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('archive cache', () => {
  it('rejects malformed top-level and entry shapes', () => {
    for (const value of [
      'broken',
      '[]',
      JSON.stringify({ query: { savedAt: 'today', sessions: [] } }),
      JSON.stringify({ query: { savedAt: 1, sessions: [{}] } }),
    ]) {
      localStorage.setItem(archiveSessionsCacheStorageKey, value);
      expect(readArchiveSessionCache('query')).toBeNull();
    }
  });

  it('keeps the twelve most recent searches', () => {
    for (let index = 0; index < 13; index += 1) {
      vi.spyOn(Date, 'now').mockReturnValue(index);
      writeArchiveSessionCache(`query-${index}`, [session(String(index))]);
    }
    const searches = JSON.parse(localStorage.getItem(archiveSessionsCacheStorageKey) ?? '{}');
    expect(searches.version).toBe(1);
    expect(Object.keys(searches.value)).toHaveLength(12);
    expect(searches.value).not.toHaveProperty('query-0');
  });

  it('treats unavailable storage as a cache miss without breaking archive requests', () => {
    const storage: Storage = {
      length: 0,
      clear: () => undefined,
      key: () => null,
      removeItem: () => undefined,
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };

    expect(readArchiveSessionCache('', storage)).toBeNull();
    expect(() => writeArchiveSessionCache('', [session('one')], storage)).not.toThrow();
  });
});

it('FE-021 isolates every query scope dimension and detail identity', async () => {
  const { archiveQueryCacheKey } = await import('./archiveCache');
  const scope = {
    target: 'local',
    agent: 'a',
    query: ' hello ',
    date: '',
    timezone: 'UTC',
    kind: 'chat',
  };
  const key = archiveQueryCacheKey(scope);
  writeArchiveSessionCache(key, [session('one')]);
  expect(
    readArchiveSessionCache(archiveQueryCacheKey({ ...scope, query: 'hello' }))?.sessions,
  ).toHaveLength(1);
  for (const field of ['target', 'agent', 'query', 'date', 'timezone', 'kind', 'detail'] as const) {
    expect(
      readArchiveSessionCache(archiveQueryCacheKey({ ...scope, [field]: 'different' })),
    ).toBeNull();
  }
});

it('purge clears browser-default archive storage', async () => {
  const { clearArchiveCaches, archiveSessionsCacheStorageKey } = await import('./archiveCache');
  localStorage.setItem(archiveSessionsCacheStorageKey, 'secret');
  localStorage.setItem('hc.archiveDetails.v1', 'secret');
  localStorage.setItem('unrelated-user-data', 'keep');
  clearArchiveCaches();
  expect(localStorage.getItem(archiveSessionsCacheStorageKey)).toBeNull();
  expect(localStorage.getItem('hc.archiveDetails.v1')).toBeNull();
  expect(localStorage.getItem('unrelated-user-data')).toBe('keep');
});

it('leaves retired detail storage inert during normal session cache use', () => {
  localStorage.setItem('hc.archiveDetails.v1', 'legacy');
  localStorage.setItem('unrelated-user-data', 'keep');
  writeArchiveSessionCache('query', [session('one')]);
  expect(readArchiveSessionCache('query')?.sessions).toEqual([session('one')]);
  expect(localStorage.getItem('hc.archiveDetails.v1')).toBe('legacy');
  expect(localStorage.getItem('unrelated-user-data')).toBe('keep');
});
