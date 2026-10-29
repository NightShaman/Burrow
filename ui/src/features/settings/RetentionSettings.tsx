import { useUnsavedChanges } from '../../app/UnsavedChanges';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../app/api';
import { Field, SettingSection } from './SettingsPrimitives';
import './retention.css';

type RetentionPolicy = { version: 1; enabled: boolean; traceMaxAgeDays: number | null; traceMaxBytes: number | null; intervalMinutes: number };
type RetentionState = { lastRunAt?: string | null; lastResult?: { counts?: { deleteTraces?: number; deleteTraceBytes?: number; traceBytes?: number }; deleted?: { traces?: number } } | null; lastError?: string | null; nextRunAt?: string | null };
type RetentionPlan = { counts?: { deleteTraces?: number; deleteTraceBytes?: number; traceBytes?: number } };
type RetentionResponse = { ok: true; policy: RetentionPolicy; state: RetentionState; plan?: RetentionPlan };
type CleanupResponse = RetentionResponse & { dryRun: boolean; counts: NonNullable<RetentionPlan['counts']> };

const emptyPolicy: RetentionPolicy = { version: 1, enabled: false, traceMaxAgeDays: null, traceMaxBytes: null, intervalMinutes: 1440 };
const formatBytes = (value?: number | null) => { if (!value) return '0 B'; const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1); return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`; };
const storageUnits = { MiB: 1024 ** 2, GiB: 1024 ** 3 };
type StorageUnit = keyof typeof storageUnits;
const storageValue = (bytes: number | null, unit: StorageUnit) => bytes == null ? '' : String(bytes / storageUnits[unit]);
const formatDate = (value?: string | null) => value ? new Date(value).toLocaleString() : '—';

// Validate endpoint ACKs before advancing a baseline or authorizing cleanup.
// GET includes a plan; the actual PUT response is { ok, policy, state }.
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integerIn = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const isPolicy = (value: unknown): value is RetentionPolicy => isObject(value)
  && value.version === 1 && typeof value.enabled === 'boolean'
  && (value.traceMaxAgeDays === null || integerIn(value.traceMaxAgeDays, 1, 36500))
  && (value.traceMaxBytes === null || integerIn(value.traceMaxBytes, 1))
  && integerIn(value.intervalMinutes, 15, 10080)
  && (!value.enabled || value.traceMaxAgeDays !== null || value.traceMaxBytes !== null);
const isCounts = (value: unknown) => isObject(value) && integerIn(value.deleteTraces, 0) && integerIn(value.deleteTraceBytes, 0)
  && (value.traceBytes === undefined || integerIn(value.traceBytes, 0));
const isState = (value: unknown) => {
  if (!isObject(value) || !['lastRunAt', 'nextRunAt', 'lastError'].every(key => value[key] == null || typeof value[key] === 'string')) return false;
  if (value.lastResult == null) return true;
  if (!isObject(value.lastResult)) return false;
  const counts = value.lastResult.counts;
  return counts == null || (isObject(counts) && ['deleteTraces', 'deleteTraceBytes', 'traceBytes'].every(key => counts[key] === undefined || integerIn(counts[key], 0)));
};
const isPlan = (value: unknown) => isObject(value) && value.ok === true && value.dryRun === true && isObject(value.retention) && isCounts(value.counts);
const policyIdentity = (value: RetentionPolicy) => JSON.stringify([value.version, value.enabled, value.traceMaxAgeDays, value.traceMaxBytes, value.intervalMinutes]);
function retentionAck(value: unknown, requirePlan = false): RetentionResponse {
  if (!isObject(value) || value.ok !== true || !isPolicy(value.policy) || !isState(value.state)
    || (requirePlan ? !isPlan(value.plan) : value.plan !== undefined && !isPlan(value.plan))) {
    throw new Error('Invalid retention response. Reload settings to verify the applied policy.');
  }
  return value as RetentionResponse;
}
function cleanupAck(value: unknown, policy: RetentionPolicy, dryRun: boolean): CleanupResponse {
  const ack = retentionAck(value);
  if (!isObject(value) || value.dryRun !== dryRun || !isObject(value.retention) || !isCounts(value.counts)
    || policyIdentity(ack.policy) !== policyIdentity(policy)) {
    throw new Error('Invalid cleanup response. Preview again before running cleanup.');
  }
  return value as CleanupResponse;
}

export function RetentionSettings() {
  const mounted = useRef(true);
  const working = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [policy, setPolicy] = useState<RetentionPolicy>(emptyPolicy);
  // Bytes remain canonical: changing presentation must never rewrite a saved limit.
  const [storageUnit, setStorageUnit] = useState<StorageUnit>('MiB');
  const [storageDraft, setStorageDraft] = useState('');
  const [state, setState] = useState<RetentionState>({});
  const [plan, setPlan] = useState<RetentionPlan>({});
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'previewing' | 'running' | 'error'>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [savedPolicy, setSavedPolicy] = useState<RetentionPolicy>(emptyPolicy);
  const [savedPolicyKey, setSavedPolicyKey] = useState('');
  const [previewPolicyKey, setPreviewPolicyKey] = useState('');
  const policyKey = JSON.stringify(policy);
  const dirty = policyKey !== savedPolicyKey;
  useEffect(() => { setPreviewPolicyKey(''); if (policyKey !== savedPolicyKey) setNotice(''); }, [policyKey, savedPolicyKey]);

  const load = async () => { setStatus('loading'); setError(''); try { const result = retentionAck(await api<unknown>('/api/settings/retention'), true); if (!mounted.current) return; const nextPolicy = result.policy; const unit = (nextPolicy.traceMaxBytes ?? 0) >= storageUnits.GiB ? 'GiB' : 'MiB'; setStorageUnit(unit); setStorageDraft(storageValue(nextPolicy.traceMaxBytes, unit)); setPolicy(nextPolicy); setSavedPolicy(nextPolicy); setSavedPolicyKey(JSON.stringify(nextPolicy)); setPreviewPolicyKey(''); setState(result.state || {}); setPlan(result.plan || {}); setStatus('idle'); } catch (cause) { setStatus('error'); setError(cause instanceof Error ? `Could not load retention settings: ${cause.message}` : 'Could not load retention settings.'); } };
  useEffect(() => { void load(); }, []);

  const updateNumber = (key: 'traceMaxAgeDays' | 'intervalMinutes', value: string) => setPolicy((current) => ({ ...current, [key]: value === '' ? null : Number(value) }));
  const validationError = useMemo(() => {
    if (policy.traceMaxBytes != null && (!Number.isSafeInteger(policy.traceMaxBytes) || policy.traceMaxBytes < 1)) return 'Storage limit must be at least 1 byte and within the supported range.';
    if (policy.traceMaxAgeDays != null && (!Number.isInteger(policy.traceMaxAgeDays) || policy.traceMaxAgeDays < 1 || policy.traceMaxAgeDays > 36500)) return 'Maximum age must be a whole number between 1 and 36500 days.';
    if (!Number.isInteger(policy.intervalMinutes) || policy.intervalMinutes < 15 || policy.intervalMinutes > 10080) return 'Cadence must be a whole number between 15 minutes and 7 days.';
    if (policy.enabled && policy.traceMaxAgeDays == null && policy.traceMaxBytes == null) return 'Enable at least one limit before turning on managed cleanup.';
    return '';
  }, [policy]);
  // Explicit Apply (or guard Save) changes the live scheduler policy.
  const applyPolicy = async () => {
    if (status !== 'idle' || working.current) return false;
    if (validationError) { setError(validationError); return false; }
    if (!dirty) return true;
    working.current = true;
    setError(''); setNotice('');
    try {
      setStatus('saving');
      const result = retentionAck(await api<unknown>('/api/settings/retention', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(policy) }));
      if (!mounted.current) return false;
      const nextPolicy = result.policy;
      setStorageDraft(storageValue(nextPolicy.traceMaxBytes, storageUnit));
      setPolicy(nextPolicy); setSavedPolicy(nextPolicy); setSavedPolicyKey(JSON.stringify(nextPolicy)); setPreviewPolicyKey('');
      setState(result.state || {}); setPlan(result.plan || {});
      setNotice(nextPolicy.enabled ? 'Retention policy applied. Scheduled deletion is active; preview is not required for automatic cleanup.' : 'Retention policy applied. Managed trace cleanup is disabled.');
      return true;
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? `Could not apply retention policy: ${cause.message}` : 'Could not apply retention policy.');
      return false;
    } finally { working.current = false; if (mounted.current) setStatus('idle'); }
  };
  const preview = async () => {
    if (status !== 'idle' || working.current) return;
    if (validationError) { setError(validationError); return; }
    if (dirty) { setError('Apply this retention policy before previewing cleanup. Applying an enabled policy starts scheduled deletion.'); return; }
    working.current = true; setStatus('previewing'); setError(''); setNotice(''); setPreviewPolicyKey('');
    try {
      const result = cleanupAck(await api<unknown>('/api/settings/retention/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ policy }) }), policy, true);
      if (!mounted.current) return;
      setPlan({ counts: result.counts }); setPreviewPolicyKey(policyKey);
      setNotice(`Preview: ${result.counts?.deleteTraces ?? 0} traces, ${formatBytes(result.counts?.deleteTraceBytes)} reclaimable.`);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? `Could not preview retention cleanup: ${cause.message}` : 'Could not preview retention cleanup.'); }
    finally { working.current = false; if (mounted.current) setStatus('idle'); }
  };
  const runNow = async () => {
    if (status !== 'idle' || working.current || !policy.enabled || validationError) return;
    if (dirty || policyKey !== previewPolicyKey) { setError('Apply and preview this retention policy before running cleanup.'); return; }
    working.current = true; setStatus('running'); setError(''); setNotice(''); setPreviewPolicyKey('');
    try {
      const result = cleanupAck(await api<unknown>('/api/settings/retention/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ policy }) }), policy, false);
      if (!mounted.current) return;
      setState(result.state || {}); setPlan({ counts: result.counts });
      setNotice(`Cleanup complete: ${result.counts?.deleteTraces ?? 0} traces removed, ${formatBytes(result.counts?.deleteTraceBytes)} reclaimed.`);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? `Could not run retention cleanup: ${cause.message}` : 'Could not run retention cleanup.'); }
    finally { working.current = false; if (mounted.current) setStatus('idle'); }
  };

  useUnsavedChanges({ dirty: status !== 'loading' && status !== 'error' && policyKey !== savedPolicyKey, busy: status !== 'idle', save: applyPolicy, discard: () => { setPolicy(savedPolicy); setStorageDraft(storageValue(savedPolicy.traceMaxBytes, storageUnit)); setError(''); setNotice(''); } });
  return <SettingSection title="Managed trace retention"><p className="settings-section-description">Automatically remove old or oversized trace data. Edits stay on this screen until you apply the policy. Applying an enabled policy starts scheduled deletion, which may begin on the next scheduler check without a preview or Run now. Disabling this policy does not stop other retention policies or cleanup already in progress.</p><label className="retention-enabled"><input type="checkbox" checked={policy.enabled} disabled={status !== 'idle'} onChange={(event) => setPolicy((current) => ({ ...current, enabled: event.target.checked }))} /> Enable managed cleanup</label><div className="field-pair retention-fields"><Field label="Maximum age (days)"><input type="number" min="1" max="36500" value={policy.traceMaxAgeDays ?? ''} disabled={status !== 'idle'} onChange={(event) => updateNumber('traceMaxAgeDays', event.target.value)} placeholder="No age limit" /></Field><Field label="Run every (minutes)"><input type="number" min="15" max="10080" value={policy.intervalMinutes ?? ''} disabled={status !== 'idle'} onChange={(event) => updateNumber('intervalMinutes', event.target.value)} /></Field><div className="field retention-storage-field"><label htmlFor="retention-storage">Maximum storage</label><div className="retention-storage"><input id="retention-storage" type="number" min={1 / storageUnits[storageUnit]} step="any" value={storageDraft} disabled={status !== 'idle'} onChange={(event) => { const value = event.target.value; setStorageDraft(value); setPolicy((current) => ({ ...current, traceMaxBytes: value === '' ? null : Math.round(Number(value) * storageUnits[storageUnit]) })); }} placeholder="No storage limit" /><select aria-label="Storage unit" value={storageUnit} disabled={status !== 'idle'} onChange={(event) => { const unit = event.target.value as StorageUnit; setStorageUnit(unit); setStorageDraft(storageValue(policy.traceMaxBytes, unit)); }}><option value="MiB">MiB</option><option value="GiB">GiB</option></select></div></div></div>{validationError && <p className="settings-request-error" role="alert">{validationError}</p>}<div className="retention-summary"><span>Applied policy estimate<strong>{plan.counts ? `${plan.counts.deleteTraces ?? 0} traces · ${formatBytes(plan.counts.deleteTraceBytes)}` : 'Preview to estimate'}</strong></span><span>Last run<strong>{formatDate(state.lastRunAt)}</strong></span><span>Next run<strong>{savedPolicy.enabled ? (state.nextRunAt ? formatDate(state.nextRunAt) : 'Next scheduler check') : 'Disabled'}</strong></span><span>Last reclaimed<strong>{formatBytes(state.lastResult?.counts?.deleteTraceBytes)}</strong></span></div>{state.lastError && <p className="settings-request-error" role="alert">Last run failed: {state.lastError}</p>}{status === 'error' && <button onClick={() => void load()}>Retry</button>}{error && <p className="settings-request-error" role="alert">{error}</p>}{notice && <p className="retention-notice" role="status">{notice}</p>}{dirty && status !== 'loading' && status !== 'error' && <p role="status">Unapplied changes. Scheduled cleanup still uses the applied policy.</p>}<div className="retention-actions"><button className="secondary" type="button" onClick={preview} disabled={status !== 'idle' || dirty || !!validationError}>{status === 'previewing' ? 'Previewing…' : 'Preview cleanup'}</button><button className="secondary" type="button" onClick={runNow} disabled={status !== 'idle' || !policy.enabled || dirty || policyKey !== previewPolicyKey || !!validationError}>{status === 'running' ? 'Running…' : 'Run now'}</button><button className="primary" type="button" onClick={() => void applyPolicy()} disabled={status !== 'idle' || !dirty}>{status === 'saving' ? 'Applying…' : 'Apply policy'}</button></div></SettingSection>;
}
