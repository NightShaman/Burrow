export function createCompatibilityObserver({ onRead = null } = {}) {
  const reads = [];
  return {
    reads,
    record(event = {}) {
      const record = {
        kind: 'legacy-read-fallback',
        operation: event.operation || 'read',
        legacyPath: event.legacyPath || null,
        replacementPath: event.replacementPath || null,
        reason: event.reason || 'compatibility-read',
        sessionId: event.sessionId || null,
        runId: event.runId || null,
      };
      reads.push(record);
      if (typeof onRead === 'function') onRead(record);
      return record;
    },
  };
}

export function observeCompatibilityRead(observer, event = {}) {
  if (!observer) return null;
  if (typeof observer.record === 'function') return observer.record(event);
  if (typeof observer === 'function') return observer({ kind: 'legacy-read-fallback', ...event });
  return null;
}
