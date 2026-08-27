import { beforeEach, describe, expect, it } from 'vitest';
import { draftCacheStorageKey, readDraftCache, writeDraftCache } from './chatDraftCache';

beforeEach(() => localStorage.clear());

describe('chatDraftCache', () => {
  it('migrates legacy drafts while discarding empty, malformed, and expired entries', () => {
    const now = Date.now();
    localStorage.setItem(draftCacheStorageKey, JSON.stringify({
      current: { value: 'Keep me', updatedAt: now },
      expired: { value: 'Too old', updatedAt: now - 2 * 24 * 60 * 60 * 1_000 },
      empty: { value: '', updatedAt: now },
      malformed: { value: 42, updatedAt: now },
    }));

    expect(readDraftCache(localStorage, now)).toEqual({ current: { value: 'Keep me', updatedAt: now } });
  });

  it('writes a versioned cache limited to the 50 newest drafts', () => {
    const now = Date.now();
    const cache = Object.fromEntries(Array.from({ length: 55 }, (_, index) => [`draft-${index}`, { value: String(index), updatedAt: now - index }]));

    writeDraftCache(cache, localStorage, now);

    const stored = JSON.parse(localStorage.getItem(draftCacheStorageKey) ?? '{}');
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.value)).toHaveLength(50);
    expect(stored.value).toHaveProperty('draft-0');
    expect(stored.value).not.toHaveProperty('draft-54');
  });

  it('rejects outdated or malformed versioned payloads', () => {
    localStorage.setItem(draftCacheStorageKey, JSON.stringify({ version: 0, value: { current: { value: 'Old', updatedAt: Date.now() } } }));
    expect(readDraftCache()).toEqual({});
    localStorage.setItem(draftCacheStorageKey, JSON.stringify({ version: 1, value: { current: { value: 42, updatedAt: Date.now() } } }));
    expect(readDraftCache()).toEqual({});
  });
});
