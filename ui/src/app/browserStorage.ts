import { isUiPreferenceKey, uiPreferenceKeys } from './uiPreferenceKeys';

export type StoredValueValidator<T> = (value: unknown) => value is T;

type StoredEnvelope = { version: number; value: unknown };

type ReadStoredValueOptions<T> = {
  key: string;
  version: number;
  fallback: T;
  validate: StoredValueValidator<T>;
  decodeLegacy?: (raw: string, parsed: unknown) => T | undefined;
  storage?: Storage | null;
};

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isEnvelope(value: unknown): value is StoredEnvelope {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as StoredEnvelope).version === 'number' &&
    'value' in (value as StoredEnvelope)
  );
}

type StorageWrite = (key: string, value: string | null) => void;
const storageWriters = new Set<StorageWrite>();
// Once hydrated, memory is authoritative even when browser storage is blocked/full.
let restoredPreferences: Map<string, string> | null = null;

export function subscribeStorageWrites(listener: StorageWrite) {
  storageWriters.add(listener);
  return () => {
    storageWriters.delete(listener);
  };
}

export function restoreBrowserPreferences(values: Record<string, string> | null) {
  if (values === null) {
    restoredPreferences = null;
    return;
  }
  restoredPreferences = new Map();
  const storage = browserStorage();
  for (const key of uiPreferenceKeys) {
    const value = values[key];
    if (typeof value === 'string') restoredPreferences.set(key, value);
    try {
      if (typeof value === 'string') storage?.setItem(key, value);
      else storage?.removeItem(key);
    } catch {
      /* The in-memory copy still restores preferences. */
    }
  }
}

function notifyStorageWrite(key: string, value: string | null, storage: Storage | null) {
  if (storage !== browserStorage() || !isUiPreferenceKey(key)) return;
  if (restoredPreferences) {
    if (value === null) restoredPreferences.delete(key);
    else restoredPreferences.set(key, value);
  }
  storageWriters.forEach((listener) => listener(key, value));
}

export function readStorage(key: string, storage: Storage | null = browserStorage()) {
  if (restoredPreferences && storage === browserStorage() && isUiPreferenceKey(key))
    return restoredPreferences.get(key) ?? null;
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorage(
  key: string,
  value: string,
  storage: Storage | null = browserStorage(),
) {
  try {
    storage?.setItem(key, value);
  } catch {
    /* Storage may be unavailable or full. */
  }
  notifyStorageWrite(key, value, storage);
}

export function removeStorage(key: string, storage: Storage | null = browserStorage()) {
  try {
    storage?.removeItem(key);
  } catch {
    /* Storage may be unavailable. */
  }
  notifyStorageWrite(key, null, storage);
}

export function readStoredValue<T>({
  key,
  version,
  fallback,
  validate,
  decodeLegacy,
  storage = browserStorage(),
}: ReadStoredValueOptions<T>): T {
  const raw = readStorage(key, storage);
  if (raw === null) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }

  if (isEnvelope(parsed)) {
    return parsed.version === version && validate(parsed.value) ? parsed.value : fallback;
  }

  const legacy = decodeLegacy?.(raw, parsed);
  return legacy !== undefined && validate(legacy) ? legacy : fallback;
}

export function writeStoredValue<T>(
  key: string,
  version: number,
  value: T,
  storage: Storage | null = browserStorage(),
) {
  writeStorage(key, JSON.stringify({ version, value }), storage);
}
