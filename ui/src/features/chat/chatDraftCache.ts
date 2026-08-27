import { readStoredValue, writeStoredValue } from '../../app/browserStorage';

export type DraftRecord = { value: string; updatedAt: number };
export type DraftCache = Record<string, DraftRecord>;

export const draftCacheStorageKey = 'hc.chatDrafts';
const draftCacheVersion = 1;
const draftRetentionMs = 24 * 60 * 60 * 1_000;
const draftCacheLimit = 50;

function isDraftRecord(value: unknown): value is DraftRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<DraftRecord>;
  return typeof record.value === 'string' && Boolean(record.value) && typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt);
}

function isDraftCache(value: unknown): value is DraftCache {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(isDraftRecord);
}

function validDrafts(value: unknown, now: number): DraftCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const oldestAllowed = now - draftRetentionMs;
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, DraftRecord] => Boolean(entry[0]) && isDraftRecord(entry[1]) && entry[1].updatedAt >= oldestAllowed)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt || a[0].localeCompare(b[0]))
    .slice(0, draftCacheLimit));
}

export function readDraftCache(storage?: Storage | null, now = Date.now()): DraftCache {
  const stored = readStoredValue({
    key: draftCacheStorageKey,
    version: draftCacheVersion,
    fallback: {},
    validate: isDraftCache,
    decodeLegacy: (_raw, parsed) => validDrafts(parsed, now),
    storage,
  });
  return validDrafts(stored, now);
}

export function writeDraftCache(cache: DraftCache, storage?: Storage | null, now = Date.now()) {
  writeStoredValue(draftCacheStorageKey, draftCacheVersion, validDrafts(cache, now), storage);
}
