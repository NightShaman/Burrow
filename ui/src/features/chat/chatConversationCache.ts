import type { SessionTurn } from '../../app/api';
import { clientBudgets } from '../../app/clientBudgets';
import { readStoredValue, writeStoredValue, removeStorage } from '../../app/browserStorage';

export type ConversationCache = Record<string, SessionTurn[]>;
type ConversationCacheEntry = { savedAt: number; turns: SessionTurn[] };
type StoredConversationCache = Record<string, ConversationCacheEntry>;

export const conversationCacheStorageKey = 'hc.chatConversations.v1';
const conversationCacheVersion = 1;
const conversationCacheLimit = clientBudgets.conversationCacheEntries;

function isCacheEntry(value: unknown): value is ConversationCacheEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.savedAt !== 'number' || !Number.isFinite(entry.savedAt) || !Array.isArray(entry.turns) || entry.turns.length > clientBudgets.conversationCacheTurnsPerEntry) return false;
  return entry.turns.every((turn) => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return false;
    const record = turn as Record<string, unknown>;
    if ('content' in record && typeof record.content !== 'string') return false;
    if (typeof record.content === 'string' && new TextEncoder().encode(record.content).byteLength > clientBudgets.conversationCacheTextBytesPerTurn) return false;
    if (!('metadata' in record)) return true;
    if (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) return false;
    const attachments = (record.metadata as Record<string, unknown>).attachments;
    return attachments === undefined || Array.isArray(attachments) && attachments.length <= clientBudgets.attachmentCount && attachments.every((item) => item && typeof item === 'object' && typeof item.name === 'string' && typeof item.type === 'string' && (item.artifactPath === undefined || typeof item.artifactPath === 'string') && (item.preview === undefined || typeof item.preview === 'string'));
  });
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

/** Purge invalidation is explicit: no stale conversation can resurrect from browser storage. */
export let conversationCacheGeneration = 0;
export const conversationCacheInvalidated = 'burrow:conversation-cache-invalidated';

export function clearConversationCache(storage?: Storage | null) {
  conversationCacheGeneration++;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(conversationCacheInvalidated));
  try { removeStorage(conversationCacheStorageKey, storage); } catch { /* unavailable storage is already empty for this owner */ }
}

export function readConversationCache(storage?: Storage | null): ConversationCache {
  let bytes = 0;
  return Object.fromEntries(Object.entries(readEntries(storage))
    .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, conversationCacheLimit)
    .filter((entry) => { const size = new TextEncoder().encode(JSON.stringify(entry)).byteLength; if (bytes + size > clientBudgets.conversationCacheTotalTextBytes) return false; bytes += size; return true; })
    .map(([key, entry]) => [key, entry.turns]));
}

export function writeConversationCache(cache: ConversationCache, touchedKey?: string, storage?: Storage | null) {
  const stored = readEntries(storage);
  const now = Date.now();
  const next = { ...stored };
  Object.entries(cache).forEach(([key, turns]) => {
    // Optimistic image previews may be multi-megabyte data URLs. Keep them in
    // memory for the send-to-artifact handoff, not in browser storage.
    const boundedTurns = turns.slice(-clientBudgets.conversationCacheTurnsPerEntry).filter((turn) => isCacheEntry({ savedAt: now, turns: [turn] }));
    const storedTurns = boundedTurns.map((turn) => turn.metadata?.attachments?.some((item) => item.preview)
      ? { ...turn, metadata: { ...turn.metadata, attachments: turn.metadata.attachments.map(({ preview: _preview, ...item }) => item) } }
      : turn);
    next[key] = { savedAt: key === touchedKey ? now : next[key]?.savedAt ?? now, turns: storedTurns };
  });
  const entries = Object.entries(next)
    .sort(([aKey, a], [bKey, b]) => b.savedAt - a.savedAt || aKey.localeCompare(bKey))
    .slice(0, conversationCacheLimit);
  let bytes = 0;
  const boundedEntries = entries.filter((entry) => {
    const size = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    if (bytes + size > clientBudgets.conversationCacheTotalTextBytes) return false;
    bytes += size; return true;
  });
  writeStoredValue(conversationCacheStorageKey, conversationCacheVersion, Object.fromEntries(boundedEntries), storage);
}
