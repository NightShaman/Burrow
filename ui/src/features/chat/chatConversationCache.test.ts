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

  it('stores durable artifact metadata without caching large optimistic image data', () => {
    const key = conversationCacheKey('hatchet', 'default');
    const turn = { role: 'user', content: 'Image', metadata: { attachments: [{ name: 'memory.png', type: 'image/png', artifactPath: 'artifacts/attachments/memory.png', preview: 'data:image/png;base64,YQ==' }] } };
    writeConversationCache({ [key]: [turn] }, key);
    expect(readConversationCache()[key][0].metadata?.attachments).toEqual([{ name: 'memory.png', type: 'image/png', artifactPath: 'artifacts/attachments/memory.png' }]);
    expect(turn.metadata.attachments[0].preview).toBe('data:image/png;base64,YQ==');
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

it('purge removes browser-default persistent storage and emits memory invalidation', async () => {
  const { clearConversationCache, conversationCacheGeneration, conversationCacheInvalidated } = await import('./chatConversationCache');
  writeConversationCache({ 'a:s': [{ role: 'user', content: 'secret' }] });
  const listener = vi.fn(); window.addEventListener(conversationCacheInvalidated, listener);
  clearConversationCache();
  expect(readConversationCache()).toEqual({});
  expect(localStorage.getItem(conversationCacheStorageKey)).toBeNull();
  expect(listener).toHaveBeenCalledOnce();
  expect((await import('./chatConversationCache')).conversationCacheGeneration).toBe(conversationCacheGeneration + 1);
  window.removeEventListener(conversationCacheInvalidated, listener);
});

it('rejects malformed attachment metadata on read and write without throwing', () => {
  for (const attachments of [{}, [null], [{ name: 'bad', type: 3 }]]) {
    const turns = [{ role: 'user', content: 'bad', metadata: { attachments } }];
    localStorage.setItem(conversationCacheStorageKey, JSON.stringify({ 'a:s': { savedAt: 1, turns } }));
    expect(readConversationCache()).toEqual({});
    expect(() => writeConversationCache({ 'a:s': turns as never })).not.toThrow();
    expect(readConversationCache()['a:s']).toEqual([]);
  }
});

it('bounds aggregate serialized content and metadata, retaining newest entries', () => {
  const turns = Array.from({ length: 30 }, () => ({ role: 'assistant', content: 'x'.repeat(240 * 1024) }));
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } as unknown as Storage;
  writeConversationCache({ older: turns, newer: turns }, 'newer', storage);
  const stored = storage.getItem(conversationCacheStorageKey)!;
  expect(new TextEncoder().encode(stored).byteLength).toBeLessThan(8 * 1024 * 1024);
  expect(readConversationCache(storage)).toHaveProperty('newer');
  expect(readConversationCache(storage)).not.toHaveProperty('older');
});
