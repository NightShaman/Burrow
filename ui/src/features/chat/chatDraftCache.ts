import { readStoredValue, writeStoredValue } from '../../app/browserStorage';

export type DraftRecord = { value: string; updatedAt: number };
export type DraftCache = Record<string, DraftRecord>;

export const draftCacheStorageKey = 'hc.chatDrafts';
const draftCacheVersion = 1;

function isDraftRecord(value: unknown): value is DraftRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<DraftRecord>;
  return (
    typeof record.value === 'string' &&
    Boolean(record.value) &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt)
  );
}

function isDraftCache(value: unknown): value is DraftCache {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(isDraftRecord)
  );
}

function validDrafts(value: unknown): DraftCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, DraftRecord] => Boolean(entry[0]) && isDraftRecord(entry[1]),
    ),
  );
}

export function readDraftCache(storage?: Storage | null): DraftCache {
  const stored = readStoredValue({
    key: draftCacheStorageKey,
    version: draftCacheVersion,
    fallback: {},
    validate: isDraftCache,
    decodeLegacy: (_raw, parsed) => validDrafts(parsed),
    storage,
  });
  return validDrafts(stored);
}

export function writeDraftCache(cache: DraftCache, storage?: Storage | null) {
  writeStoredValue(draftCacheStorageKey, draftCacheVersion, validDrafts(cache), storage);
}
