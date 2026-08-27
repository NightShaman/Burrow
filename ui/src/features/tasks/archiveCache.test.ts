import { beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveDetailsCacheStorageKey, archiveSessionsCacheStorageKey, readArchiveDetailCache, readArchiveSessionCache, writeArchiveDetailCache, writeArchiveSessionCache } from './archiveCache';
import type { ArchiveSession } from './archiveTypes';

const session = (id: string): ArchiveSession => ({
  agentId: 'agent', agentName: 'Agent', sessionId: id, id, title: id, summary: '', turnCount: 0, chatTurnCount: 0,
  createdAt: null, updatedAt: null, archived: true, archivedAt: null, kind: null, lastRole: null, lastRunId: null,
});

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('archive cache', () => {
  it('rejects malformed top-level and entry shapes', () => {
    for (const value of ['broken', '[]', JSON.stringify({ query: { savedAt: 'today', sessions: [] } }), JSON.stringify({ query: { savedAt: 1, sessions: [{}] } })]) {
      localStorage.setItem(archiveSessionsCacheStorageKey, value);
      expect(readArchiveSessionCache('query')).toBeNull();
    }

    localStorage.setItem(archiveDetailsCacheStorageKey, JSON.stringify({ 'agent:one': { savedAt: 'today', detail: {} } }));
    expect(readArchiveDetailCache(session('one'))).toBeNull();
  });

  it('keeps the twelve most recent searches and twenty-four most recent details', () => {
    for (let index = 0; index < 13; index += 1) {
      vi.spyOn(Date, 'now').mockReturnValue(index);
      writeArchiveSessionCache(`query-${index}`, [session(String(index))]);
    }
    for (let index = 0; index < 25; index += 1) {
      vi.spyOn(Date, 'now').mockReturnValue(index);
      writeArchiveDetailCache(session(String(index)), { turns: [{ content: String(index) }] });
    }

    const searches = JSON.parse(localStorage.getItem(archiveSessionsCacheStorageKey) ?? '{}');
    const details = JSON.parse(localStorage.getItem(archiveDetailsCacheStorageKey) ?? '{}');
    expect(searches.version).toBe(1);
    expect(Object.keys(searches.value)).toHaveLength(12);
    expect(searches.value).not.toHaveProperty('query-0');
    expect(details.version).toBe(1);
    expect(Object.keys(details.value)).toHaveLength(24);
    expect(details.value).not.toHaveProperty('agent:0');
  });

  it('treats unavailable storage as a cache miss without breaking archive requests', () => {
    const storage: Storage = {
      length: 0, clear: () => undefined, key: () => null, removeItem: () => undefined,
      getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); },
    };

    expect(readArchiveSessionCache('', storage)).toBeNull();
    expect(readArchiveDetailCache(session('one'), storage)).toBeNull();
    expect(() => writeArchiveSessionCache('', [session('one')], storage)).not.toThrow();
    expect(() => writeArchiveDetailCache(session('one'), { turns: [] }, storage)).not.toThrow();
  });
});
