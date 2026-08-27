import { beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationCacheKey, conversationCacheStorageKey, readConversationCache, writeConversationCache } from './chatConversationCache';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('chat conversation cache', () => {
  it('returns an empty cache for malformed and outdated storage shapes', () => {
    for (const value of ['not-json', '[]', JSON.stringify({ legacy: ['old turn'] }), JSON.stringify({ broken: { savedAt: 'today', turns: [] } })]) {
      localStorage.setItem(conversationCacheStorageKey, value);
      expect(readConversationCache()).toEqual({});
    }
  });

  it('keeps only the 24 most recently saved conversations', () => {
    const stored = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`agent:session-${index}`, {
      savedAt: index,
      turns: [{ role: 'assistant', content: `Turn ${index}` }],
    }]));
    localStorage.setItem(conversationCacheStorageKey, JSON.stringify(stored));

    const cache = readConversationCache();

    expect(Object.keys(cache)).toHaveLength(24);
    expect(cache).toHaveProperty('agent:session-29');
    expect(cache).not.toHaveProperty('agent:session-0');
  });

  it('writes a touched conversation without erasing valid untouched entries', () => {
    const untouchedKey = conversationCacheKey('luna', 'default');
    const touchedKey = conversationCacheKey('smatchet', 'default');
    localStorage.setItem(conversationCacheStorageKey, JSON.stringify({
      [untouchedKey]: { savedAt: 10, turns: [{ role: 'assistant', content: 'Untouched' }] },
    }));
    vi.spyOn(Date, 'now').mockReturnValue(100);

    writeConversationCache({ [touchedKey]: [{ role: 'assistant', content: 'Fresh' }] }, touchedKey);

    const stored = JSON.parse(localStorage.getItem(conversationCacheStorageKey) ?? '{}');
    expect(stored.version).toBe(1);
    expect(stored.value[untouchedKey]).toEqual({ savedAt: 10, turns: [{ role: 'assistant', content: 'Untouched' }] });
    expect(stored.value[touchedKey]).toEqual({ savedAt: 100, turns: [{ role: 'assistant', content: 'Fresh' }] });
  });

  it('treats storage write failures as a cache miss rather than a chat failure', () => {
    const storage: Storage = {
      length: 0,
      clear: () => undefined,
      getItem: () => { throw new Error('blocked'); },
      key: () => null,
      removeItem: () => undefined,
      setItem: () => { throw new Error('full'); },
    };

    expect(readConversationCache(storage)).toEqual({});
    expect(() => writeConversationCache({ key: [] }, 'key', storage)).not.toThrow();
  });
});
