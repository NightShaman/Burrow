import { readStoredValue, writeStoredValue } from '../../app/browserStorage';
import type { ArchiveDetail, ArchiveSession } from './archiveTypes';

export const archiveSessionsCacheStorageKey = 'hc.archiveSessions.v1';
export const archiveDetailsCacheStorageKey = 'hc.archiveDetails.v1';
const archiveCacheVersion = 1;
const archiveSessionsCacheLimit = 12;
const archiveDetailsCacheLimit = 24;

type ArchiveSessionCache = { savedAt: number; sessions: ArchiveSession[] };
type ArchiveDetailCache = { savedAt: number; detail: ArchiveDetail };
type ArchiveSessionEntries = Record<string, ArchiveSessionCache>;
type ArchiveDetailEntries = Record<string, ArchiveDetailCache>;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isArchiveSession(value: unknown): value is ArchiveSession {
  return isObject(value)
    && typeof value.sessionId === 'string'
    && typeof value.id === 'string'
    && typeof value.title === 'string'
    && typeof value.summary === 'string';
}

function isArchiveSessionCache(value: unknown): value is ArchiveSessionCache {
  return isObject(value) && typeof value.savedAt === 'number' && Number.isFinite(value.savedAt)
    && Array.isArray(value.sessions) && value.sessions.every(isArchiveSession);
}

function isArchiveDetailCache(value: unknown): value is ArchiveDetailCache {
  return isObject(value) && typeof value.savedAt === 'number' && Number.isFinite(value.savedAt) && isObject(value.detail);
}

function isArchiveSessionEntries(value: unknown): value is ArchiveSessionEntries {
  return isObject(value) && Object.values(value).every(isArchiveSessionCache);
}

function isArchiveDetailEntries(value: unknown): value is ArchiveDetailEntries {
  return isObject(value) && Object.values(value).every(isArchiveDetailCache);
}

function readSessionEntries(storage?: Storage | null) {
  return readStoredValue({
    key: archiveSessionsCacheStorageKey,
    version: archiveCacheVersion,
    fallback: {},
    validate: isArchiveSessionEntries,
    decodeLegacy: (_raw, parsed) => isArchiveSessionEntries(parsed) ? parsed : undefined,
    storage,
  });
}

function readDetailEntries(storage?: Storage | null) {
  return readStoredValue({
    key: archiveDetailsCacheStorageKey,
    version: archiveCacheVersion,
    fallback: {},
    validate: isArchiveDetailEntries,
    decodeLegacy: (_raw, parsed) => isArchiveDetailEntries(parsed) ? parsed : undefined,
    storage,
  });
}

function archiveDetailCacheKey(session: ArchiveSession) {
  return `${session.agentId ?? ''}:${session.sessionId}`;
}

export function readArchiveDetailCache(session: ArchiveSession, storage?: Storage | null): ArchiveDetail | null {
  return readDetailEntries(storage)[archiveDetailCacheKey(session)]?.detail ?? null;
}

export function writeArchiveDetailCache(session: ArchiveSession, detail: ArchiveDetail, storage?: Storage | null) {
  const next = { ...readDetailEntries(storage), [archiveDetailCacheKey(session)]: { savedAt: Date.now(), detail } };
  const entries = Object.entries(next)
    .sort(([aKey, a], [bKey, b]) => b.savedAt - a.savedAt || aKey.localeCompare(bKey))
    .slice(0, archiveDetailsCacheLimit);
  writeStoredValue(archiveDetailsCacheStorageKey, archiveCacheVersion, Object.fromEntries(entries), storage);
}

export function readArchiveSessionCache(query: string, storage?: Storage | null): ArchiveSessionCache | null {
  return readSessionEntries(storage)[query] ?? null;
}

export function writeArchiveSessionCache(query: string, sessions: ArchiveSession[], storage?: Storage | null) {
  const next = { ...readSessionEntries(storage), [query]: { savedAt: Date.now(), sessions } };
  const entries = Object.entries(next)
    .sort(([aKey, a], [bKey, b]) => b.savedAt - a.savedAt || aKey.localeCompare(bKey))
    .slice(0, archiveSessionsCacheLimit);
  writeStoredValue(archiveSessionsCacheStorageKey, archiveCacheVersion, Object.fromEntries(entries), storage);
}
