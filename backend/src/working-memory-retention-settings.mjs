import { getSettingsMeta, openSettingsDatabase, setSettingsMeta, settingsDatabasePath } from './settings-database.mjs';

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

export function readWorkingMemoryRetention({ databasePath = null, db = null } = {}) {
  const ownedDb = db || openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try {
    return normalizeWorkingMemoryRetention(
      getSettingsMeta(ownedDb, WORKING_MEMORY_RETENTION_META_KEY) || {},
      DEFAULT_WORKING_MEMORY_RETENTION,
    );
  } catch {
    return { ...DEFAULT_WORKING_MEMORY_RETENTION };
  } finally {
    if (!db) ownedDb.close();
  }
}

export function saveWorkingMemoryRetention(input = {}, { databasePath = null } = {}) {
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try {
    const current = normalizeWorkingMemoryRetention(
      getSettingsMeta(db, WORKING_MEMORY_RETENTION_META_KEY) || {},
      DEFAULT_WORKING_MEMORY_RETENTION,
    );
    const policy = normalizeWorkingMemoryRetention(input, current);
    setSettingsMeta(db, WORKING_MEMORY_RETENTION_META_KEY, policy);
    return policy;
  } finally {
    db.close();
  }
}
