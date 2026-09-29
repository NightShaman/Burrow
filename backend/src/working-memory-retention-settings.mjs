
export const WORKING_MEMORY_RETENTION_META_KEY = 'working_memory_retention';
export const DEFAULT_WORKING_MEMORY_RETENTION = Object.freeze({
  version: 1,
  workingMemoryTtlDays: 90,
  rollingContinuityTtlDays: 90,
});

function ttlDays(value, name) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 36_500) throw new Error(`${name}_invalid`);
  return days;
}

export function normalizeWorkingMemoryRetention(input = {}, current = DEFAULT_WORKING_MEMORY_RETENTION) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('working_memory_retention_invalid');
  return {
    version: 1,
    workingMemoryTtlDays: input.workingMemoryTtlDays === undefined
      ? current.workingMemoryTtlDays
      : ttlDays(input.workingMemoryTtlDays, 'working_memory_ttl_days'),
    rollingContinuityTtlDays: input.rollingContinuityTtlDays === undefined
      ? current.rollingContinuityTtlDays
      : ttlDays(input.rollingContinuityTtlDays, 'rolling_continuity_ttl_days'),
  };
}

export function readWorkingMemoryRetention({ store = null } = {}) {
  if (!store) throw new Error('postgres_required');
  return store.read();
}

export function saveWorkingMemoryRetention(input = {}, { store = null } = {}) {
  if (!store) throw new Error('postgres_required');
  return store.save(input);
}
