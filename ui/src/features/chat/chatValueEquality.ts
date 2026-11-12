/** Value equality for immutable JSON-shaped chat API/projection data. Object key
 * order is not meaningful; array order and every field (including metadata) are.
 */
export function chatValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && chatValuesEqual(left[key], right[key]))
  );
}

/** Keep unchanged rows as well as the containing array stable across polls. */
export function shareChatRows<T>(previous: T[], next: T[]): T[] {
  const shared = next.map((row, index) =>
    chatValuesEqual(previous[index], row) ? previous[index] : row,
  );
  return previous.length === shared.length && shared.every((row, index) => row === previous[index])
    ? previous
    : shared;
}
