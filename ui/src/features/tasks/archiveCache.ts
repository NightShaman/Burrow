import { readStoredValue, writeStoredValue, removeStorage } from '../../app/browserStorage';
import type { ArchiveSession } from './archiveTypes';
import { clientBudgets } from '../../app/clientBudgets';

export const archiveSessionsCacheStorageKey = 'hc.archiveSessions.v1';
// Retain the retired detail key only for explicit cache reset. No reads, writes,
// or automatic migration: existing entries remain inert until the user purges caches.
const legacyArchiveDetailsCacheStorageKey = 'hc.archiveDetails.v1';

export const archiveCacheInvalidated = 'burrow:archive-cache-invalidated';
export function clearArchiveCaches(storage?: Storage | null) {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(archiveCacheInvalidated));
  try {
    removeStorage(archiveSessionsCacheStorageKey, storage);
    removeStorage(legacyArchiveDetailsCacheStorageKey, storage);
  } catch {
    /* unavailable storage is already empty for this owner */
  }
}
const archiveCacheVersion = 1;
const archiveSessionsCacheLimit = clientBudgets.archiveSessionCacheEntries;

type ArchiveSessionCache = { savedAt: number; sessions: ArchiveSession[] };
type ArchiveSessionEntries = Record<string, ArchiveSessionCache>;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isArchiveSession(value: unknown): value is ArchiveSession {
  return (
    isObject(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.summary === 'string'
  );
}

function isArchiveSessionCache(value: unknown): value is ArchiveSessionCache {
  return (
    isObject(value) &&
    typeof value.savedAt === 'number' &&
    Number.isFinite(value.savedAt) &&
    Array.isArray(value.sessions) &&
    value.sessions.length <= clientBudgets.archiveSessionRowsPerQuery &&
    value.sessions.every(isArchiveSession)
  );
}

function isArchiveSessionEntries(value: unknown): value is ArchiveSessionEntries {
  return isObject(value) && Object.values(value).every(isArchiveSessionCache);
}

function readSessionEntries(storage?: Storage | null) {
  return readStoredValue({
    key: archiveSessionsCacheStorageKey,
    version: archiveCacheVersion,
    fallback: {},
    validate: isArchiveSessionEntries,
    decodeLegacy: (_raw, parsed) => (isArchiveSessionEntries(parsed) ? parsed : undefined),
    storage,
  });
}

export function readArchiveSessionCache(
  query: string,
  storage?: Storage | null,
): ArchiveSessionCache | null {
  return readSessionEntries(storage)[query] ?? null;
}

export function writeArchiveSessionCache(
  query: string,
  sessions: ArchiveSession[],
  storage?: Storage | null,
) {
  const next = { ...readSessionEntries(storage), [query]: { savedAt: Date.now(), sessions } };
  const entries = Object.entries(next)
    .sort(([aKey, a], [bKey, b]) => b.savedAt - a.savedAt || aKey.localeCompare(bKey))
    .slice(0, archiveSessionsCacheLimit);
  writeStoredValue(
    archiveSessionsCacheStorageKey,
    archiveCacheVersion,
    Object.fromEntries(entries),
    storage,
  );
}

export type ArchiveQueryScope = {
  target: string;
  agent: string;
  query: string;
  date: string;
  timezone: string;
  kind: string;
  detail?: string;
};
export function archiveQueryCacheKey(scope: ArchiveQueryScope) {
  return JSON.stringify([
    scope.target,
    scope.agent,
    scope.query.trim(),
    scope.date,
    scope.timezone,
    scope.kind,
    scope.detail ?? '',
  ]);
}
