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
  try { return window.localStorage; } catch { return null; }
}

function isEnvelope(value: unknown): value is StoredEnvelope {
  return Boolean(value) && typeof value === 'object' && typeof (value as StoredEnvelope).version === 'number' && 'value' in (value as StoredEnvelope);
}

export function readStorage(key: string, storage: Storage | null = browserStorage()) {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

export function writeStorage(key: string, value: string, storage: Storage | null = browserStorage()) {
  try { storage?.setItem(key, value); } catch { /* Storage may be unavailable or full. */ }
}

export function removeStorage(key: string, storage: Storage | null = browserStorage()) {
  try { storage?.removeItem(key); } catch { /* Storage may be unavailable. */ }
}

export function readStoredValue<T>({ key, version, fallback, validate, decodeLegacy, storage = browserStorage() }: ReadStoredValueOptions<T>): T {
  const raw = readStorage(key, storage);
  if (raw === null) return fallback;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }

  if (isEnvelope(parsed)) {
    return parsed.version === version && validate(parsed.value) ? parsed.value : fallback;
  }

  const legacy = decodeLegacy?.(raw, parsed);
  return legacy !== undefined && validate(legacy) ? legacy : fallback;
}

export function writeStoredValue<T>(key: string, version: number, value: T, storage: Storage | null = browserStorage()) {
  writeStorage(key, JSON.stringify({ version, value }), storage);
}
