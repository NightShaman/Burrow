import { WorkingMemoryStore } from './working-memory-store.mjs';

export const DEFAULT_WORKING_CONTINUITY_LIMIT = 12_000;
export const DEFAULT_WORKING_CONTINUITY_ITEM_LIMIT = 1_800;
export const DEFAULT_WORKING_CONTINUITY_RECORD_LIMIT = 12;

function text(value) { return String(value ?? '').trim(); }
function bounded(value, limit) { const source = text(value); return source.length <= limit ? source : `${source.slice(0, Math.max(0, limit - 24)).trim()}\n[continuity excerpt clipped]`; }
function chars(record) { return text(record.title).length + text(record.content).length + (record.sourceRefs || []).join(', ').length + 80; }

// Continuity scope is selected by explicit operator/runtime session state. It
// is never derived from chat prose, file paths, or model output.
export function normalizeContinuityScope(value) {
  const scope = text(value);
  return scope && scope.length <= 160 ? scope : null;
}

// Compatibility export for callers not yet migrated to the generic name.
export const normalizeWorkingMemoryProject = normalizeContinuityScope;

export function selectWorkingContinuity({ records = [], agentId = null, continuityScope = null, project = null, maxChars = DEFAULT_WORKING_CONTINUITY_LIMIT, maxItemChars = DEFAULT_WORKING_CONTINUITY_ITEM_LIMIT } = {}) {
  const scope = normalizeContinuityScope(continuityScope ?? project);
  if (!text(agentId)) return { scope: null, reason: 'agent_unavailable', records: [], cards: [], omittedCount: 0, chars: 0, candidateCount: 0, cardCount: 0 };
  if (!scope) return { scope: null, reason: 'scope_unavailable', records: [], cards: [], omittedCount: 0, chars: 0, candidateCount: 0, cardCount: 0 };

  // Tiddle rolling cards are recall-only. They remain in the store and are
  // available through the explicit memory_rolling_search tool, but ordinary
  // prompt assembly must not inject them as ambient context.
  const activeRecords = (Array.isArray(records) ? records : [])
    .filter((record) => record?.agentId === agentId && record?.project === scope && record?.state === 'active');
  return {
    scope,
    reason: activeRecords.length ? 'legacy_records_available_for_explicit_search_only' : 'no_ambient_records',
    records: [],
    cards: [],
    omittedCount: 0,
    chars: 0,
    candidateCount: activeRecords.length,
    cardCount: 0,
  };
}

export function loadWorkingContinuity({ databasePath = null, agentId = null, continuityScope = null, project = null, store = null, ...limits } = {}) {
  const scope = normalizeContinuityScope(continuityScope ?? project);
  // No scope means no ambient STM by design. Avoid even opening the shared
  // SQLite database on ordinary unscoped turns, which also keeps the read path
  // out of unrelated settings-store contention.
  if (!scope || !text(agentId)) return selectWorkingContinuity({ records: [], agentId, continuityScope: scope, ...limits });
  let workingStore = store;
  try {
    workingStore ||= new WorkingMemoryStore(databasePath ? { databasePath } : {});
    const records = workingStore.list({ agentId, project: scope, includeInactive: false, limit: DEFAULT_WORKING_CONTINUITY_RECORD_LIMIT });
    return selectWorkingContinuity({ records, agentId, continuityScope: scope, ...limits });
  } catch (error) {
    // Ambient continuity is optional support, never a reason to fail a normal
    // chat turn when another SQLite connection is briefly initializing.
    if (String(error?.code || '').includes('SQLITE') || /database is locked/i.test(String(error?.message || ''))) {
      return { scope, reason: 'store_unavailable', records: [], omittedCount: 0, candidateCount: 0, chars: 0 };
    }
    throw error;
  } finally { if (!store && workingStore) workingStore.close(); }
}

export function projectHandoffsIntoWorkingContinuity({ continuity = null, handoffs = [], agentId = null, continuityScope = null } = {}) {
  const scope = normalizeContinuityScope(continuity?.scope ?? continuityScope);
  const base = continuity && typeof continuity === 'object'
    ? { ...continuity, records: [], cards: [] }
    : selectWorkingContinuity({ records: [], agentId, continuityScope: scope });
  if (!scope || !text(agentId)) return base;
  const matchingHandoffs = (Array.isArray(handoffs) ? handoffs : [])
    .filter((handoff) => handoff?.agentId === agentId && handoff?.title && handoff?.content);
  if (!matchingHandoffs.length) return base;
  // Handoffs are now recall metadata only. They can be found through explicit
  // session handoff/search tools; they are not projected as active handoff rows.
  return {
    ...base,
    records: [],
    handoffCount: Number(base.handoffCount || 0) + matchingHandoffs.length,
    reason: `${base.reason || 'rolling_continuity_available'}+handoff_metadata_only`,
  };
}
