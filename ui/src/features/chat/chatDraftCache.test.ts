import { beforeEach, describe, expect, it } from 'vitest';
import { draftCacheStorageKey, readDraftCache, writeDraftCache } from './chatDraftCache';

beforeEach(() => localStorage.clear());

describe('chatDraftCache', () => {
  it('migrates legacy drafts while discarding only empty and malformed entries', () => {
    const now = Date.now();
    localStorage.setItem(
      draftCacheStorageKey,
      JSON.stringify({
        current: { value: 'Keep me', updatedAt: now },
        expired: { value: 'Still authored', updatedAt: now - 2 * 24 * 60 * 60 * 1_000 },
        empty: { value: '', updatedAt: now },
        malformed: { value: 42, updatedAt: now },
      }),
    );

    expect(readDraftCache(localStorage)).toEqual({
      current: { value: 'Keep me', updatedAt: now },
      expired: { value: 'Still authored', updatedAt: now - 2 * 24 * 60 * 60 * 1_000 },
    });
  });

  it('round trips every authored draft without age or count eviction', () => {
    const now = Date.now();
    const cache = Object.fromEntries(
      Array.from({ length: 155 }, (_, index) => [
        `draft-${index}`,
        { value: String(index), updatedAt: now - index * 365 * 24 * 60 * 60 * 1_000 },
      ]),
    );

    writeDraftCache(cache, localStorage);

    const stored = JSON.parse(localStorage.getItem(draftCacheStorageKey) ?? '{}');
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.value)).toHaveLength(155);
    expect(stored.value).toHaveProperty('draft-0');
    expect(stored.value).toHaveProperty('draft-154');
    expect(readDraftCache(localStorage)).toEqual(cache);

    // Only an explicit removal (send/discard) removes the record.
    const { ['draft-54']: removed, ...remaining } = cache;
    expect(removed).toBeTruthy();
    writeDraftCache(remaining, localStorage);
    expect(readDraftCache(localStorage)).toEqual(remaining);
  });

  it('rejects outdated or malformed versioned payloads', () => {
    localStorage.setItem(
      draftCacheStorageKey,
      JSON.stringify({ version: 0, value: { current: { value: 'Old', updatedAt: Date.now() } } }),
    );
    expect(readDraftCache()).toEqual({});
    localStorage.setItem(
      draftCacheStorageKey,
      JSON.stringify({ version: 1, value: { current: { value: 42, updatedAt: Date.now() } } }),
    );
    expect(readDraftCache()).toEqual({});
  });
});
