import { readStoredValue, writeStoredValue } from './browserStorage';

const accountOrderVersion = 1;
const accountOrderLimit = 100;

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function normalizeAccountOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((id) => {
    if (typeof id !== 'string' || !id || seen.has(id) || seen.size >= accountOrderLimit) return [];
    seen.add(id);
    return [id];
  });
}

export function readAccountOrder(key: string, storage?: Storage | null): string[] {
  const stored = readStoredValue({
    key,
    version: accountOrderVersion,
    fallback: [],
    validate: isStringList,
    decodeLegacy: (_raw, parsed) => normalizeAccountOrder(parsed),
    storage,
  });
  return normalizeAccountOrder(stored);
}

export function writeAccountOrder(key: string, order: string[], storage?: Storage | null) {
  writeStoredValue(key, accountOrderVersion, normalizeAccountOrder(order), storage);
}
