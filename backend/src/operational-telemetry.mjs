// Ephemeral producer -> OTel observation bus. This is not an evidence store or
// a lifecycle owner. The SDK projection separately allowlists every field;
// producers must never publish secrets, content, SQL, URLs or exception prose.
const observers = new Set();
let authOverride = null;
export function hasOperationalTelemetryObservers() {
  for (const entry of observers) { try { if (!entry.active || entry.active()) return true; } catch {} }
  return false;
}
export function operationalTelemetrySnapshot() { return authOverride ? [{...authOverride}] : []; }
export function observeOperationalTelemetry(observer, {active = null} = {}) {
  const entry = {observer, active};
  observers.add(entry);
  return () => observers.delete(entry);
}
export function operationalTelemetry(type, fields = {}) {
  const record = { type, ...fields };
  if (type === 'auth-environment-override') authOverride = {type, mode:['none','basic','oidc','trusted-proxy'].includes(fields.mode) ? fields.mode : 'unknown',outcome:'activated',durationMs:0};
  if (type === 'auth-environment-inactive') authOverride = null;
  for (const {observer} of observers) {
    try { observer(record); } catch { /* Telemetry must not change producer outcomes. */ }
  }
}
