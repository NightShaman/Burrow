// Only explicit operation payloads belong here; never provider/OAuth credentials.
export function retainedOperation<T extends { operationId: string }>(key: string, payload: () => T): T {
  const stored = localStorage.getItem(key);
  if (stored) return JSON.parse(stored) as T;
  const value = payload();
  localStorage.setItem(key, JSON.stringify(value));
  return value;
}
export function completeOperation(key: string, operationId: string) {
  const stored = localStorage.getItem(key);
  if (stored && JSON.parse(stored).operationId === operationId) localStorage.removeItem(key);
}
