import type { SessionTurn } from '../../app/api';
import { readStoredValue, writeStoredValue } from '../../app/browserStorage';

export type ConversationCache = Record<string, SessionTurn[]>;
type ConversationCacheEntry = { savedAt: number; turns: SessionTurn[] };
type StoredConversationCache = Record<string, ConversationCacheEntry>;

export const conversationCacheStorageKey = 'hc.chatConversations.v1';
const conversationCacheVersion = 1;
const conversationCacheLimit = 24;

function isCacheEntry(value: unknown): value is ConversationCacheEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.savedAt === 'number' && Number.isFinite(entry.savedAt) && Array.isArray(entry.turns);
}

function isStoredConversationCache(value: unknown): value is StoredConversationCache {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(isCacheEntry);
}

function readEntries(storage?: Storage | null): StoredConversationCache {
  return readStoredValue({
    key: conversationCacheStorageKey,
    version: conversationCacheVersion,
    fallback: {},
    validate: isStoredConversationCache,
    decodeLegacy: (_raw, parsed) => isStoredConversationCache(parsed) ? parsed : undefined,
    storage,
  });
}

export function conversationCacheKey(agentId: string, sessionId: string) {
  return `${agentId}:${sessionId}`;
}

export function readConversationCache(storage?: Storage | null): ConversationCache {
  return Object.fromEntries(Object.entries(readEntries(storage))
    .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, conversationCacheLimit)
    .map(([key, entry]) => [key, entry.turns]));
}

export function writeConversationCache(cache: ConversationCache, touchedKey?: string, storage?: Storage | null) {
  const stored = readEntries(storage);
  const now = Date.now();
  const next = { ...stored };
  Object.entries(cache).forEach(([key, turns]) => {
    next[key] = { savedAt: key === touchedKey ? now : next[key]?.savedAt ?? now, turns };
  });
  const entries = Object.entries(next)
    .sort(([aKey, a], [bKey, b]) => b.savedAt - a.savedAt || aKey.localeCompare(bKey))
    .slice(0, conversationCacheLimit);
  writeStoredValue(conversationCacheStorageKey, conversationCacheVersion, Object.fromEntries(entries), storage);
}
