// Cache transport only. The PostgreSQL store owns persistence and the callers
// own cache keys, freshness, fallback policy and diagnostic transitions.

export function safeCacheRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

export async function cacheGetAsync(target, key) {
  if (!target) return {};
  if (typeof target.cacheGet !== 'function') throw new Error('postgres_required');
  return safeCacheRecord(await target.cacheGet(key));
}

export async function cacheSetAsync(target, key, value, nowMs) {
  if (!target) return value;
  if (typeof target.cacheSet !== 'function') throw new Error('postgres_required');
  await target.cacheSet(key, value, new Date(nowMs).toISOString());
  return value;
}
