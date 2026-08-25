import { getSettingsMeta, openSettingsDatabase, setSettingsMeta, settingsDatabasePath } from './settings-database.mjs';

export const RETENTION_SETTINGS_META_KEY = 'retention_policy';
export const RETENTION_STATE_META_KEY = 'retention_policy_state';
export const DEFAULT_RETENTION_POLICY = Object.freeze({ version: 1, enabled: false, traceMaxAgeDays: null, traceMaxBytes: null, intervalMinutes: 1440 });

function positiveInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name}_invalid`);
  return value;
}
function nullablePositiveInteger(value, name, limits = {}) {
  if (value === undefined || value === null || value === '') return null;
  return positiveInteger(Number(value), name, limits);
}
function bool(value, fallback) { return value === undefined ? fallback : value === true; }

export function normalizeRetentionPolicy(input = {}, current = DEFAULT_RETENTION_POLICY) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('retention_policy_invalid');
  const enabled = bool(input.enabled, current.enabled);
  const traceMaxAgeDays = input.traceMaxAgeDays === undefined ? current.traceMaxAgeDays : nullablePositiveInteger(input.traceMaxAgeDays, 'retention_trace_max_age_days', { min: 1, max: 36500 });
  const traceMaxBytes = input.traceMaxBytes === undefined ? current.traceMaxBytes : nullablePositiveInteger(input.traceMaxBytes, 'retention_trace_max_bytes', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const intervalMinutes = input.intervalMinutes === undefined ? current.intervalMinutes : positiveInteger(Number(input.intervalMinutes), 'retention_interval_minutes', { min: 15, max: 10080 });
  if (enabled && traceMaxAgeDays === null && traceMaxBytes === null) throw new Error('retention_policy_limit_required');
  return { version: 1, enabled, traceMaxAgeDays, traceMaxBytes, intervalMinutes };
}

export function readRetentionPolicy({ databasePath = null } = {}) {
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try { return normalizeRetentionPolicy(getSettingsMeta(db, RETENTION_SETTINGS_META_KEY) || {}, DEFAULT_RETENTION_POLICY); }
  catch { return { ...DEFAULT_RETENTION_POLICY }; }
  finally { db.close(); }
}

export function saveRetentionPolicy(input = {}, { databasePath = null } = {}) {
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try {
    const current = normalizeRetentionPolicy(getSettingsMeta(db, RETENTION_SETTINGS_META_KEY) || {}, DEFAULT_RETENTION_POLICY);
    const policy = normalizeRetentionPolicy(input, current);
    setSettingsMeta(db, RETENTION_SETTINGS_META_KEY, policy);
    return policy;
  } finally { db.close(); }
}

export function readRetentionPolicyState({ databasePath = null } = {}) {
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try { return getSettingsMeta(db, RETENTION_STATE_META_KEY) || { lastRunAt: null, lastResult: null, lastError: null, nextRunAt: null }; }
  finally { db.close(); }
}

export function writeRetentionPolicyState(state, { databasePath = null } = {}) {
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try { return setSettingsMeta(db, RETENTION_STATE_META_KEY, state); }
  finally { db.close(); }
}

export function retentionPolicySuccessState({ policy, result, at = new Date(), previous = null } = {}) {
  const completedAt = at instanceof Date ? at : new Date(at);
  return {
    ...(previous || {}),
    lastRunAt: completedAt.toISOString(),
    lastResult: { counts: result?.counts || null, deleted: { sessions: result?.deleted?.sessions?.length || 0, traces: result?.deleted?.traces?.length || 0 } },
    lastError: null,
    nextRunAt: new Date(completedAt.getTime() + policy.intervalMinutes * 60_000).toISOString(),
  };
}

export function retentionPolicyFailureState({ policy, error, at = new Date(), previous = null } = {}) {
  const failedAt = at instanceof Date ? at : new Date(at);
  return { ...(previous || {}), lastRunAt: failedAt.toISOString(), lastError: String(error?.message || error), nextRunAt: new Date(failedAt.getTime() + policy.intervalMinutes * 60_000).toISOString() };
}
