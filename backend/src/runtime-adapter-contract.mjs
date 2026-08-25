export const RUNTIME_ADAPTER_CONTRACT_VERSION = 1;

export const RUNTIME_ADAPTER_CAPABILITIES = Object.freeze([
  'sessionResume',
  'eventStreaming',
  'assistantDeltas',
  'dynamicTools',
  'nativeTools',
  'approvals',
  'cancellation',
  'compactionStatus',
  'tokenUsage',
  'stdioTransport',
]);

export const RUNTIME_SESSION_STATES = Object.freeze(['new', 'active', 'detached', 'closed', 'failed']);
export const RUNTIME_RUN_STATES = Object.freeze(['new', 'starting', 'active', 'cancelling', 'completed', 'cancelled', 'failed']);
export const RUNTIME_EVENT_TYPES = Object.freeze([
  'activity',
  'assistant_delta',
  'tool_request',
  'tool_result',
  'context_status',
  'completed',
  'cancelled',
  'failed',
]);

function text(value) { return String(value ?? '').trim(); }
function known(value, values, fallback = null) { return values.includes(value) ? value : fallback; }
function finiteSequence(value) { return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null; }

export function createAdapterDescriptor({ id, generation = 1, capabilities = [] } = {}) {
  const adapterId = text(id);
  if (!adapterId || !/^[a-z][a-z0-9._-]{0,95}$/i.test(adapterId)) throw new Error('runtime_adapter_id_invalid');
  const adapterGeneration = Number(generation);
  if (!Number.isSafeInteger(adapterGeneration) || adapterGeneration < 1) throw new Error('runtime_adapter_generation_invalid');
  const allowed = new Set(RUNTIME_ADAPTER_CAPABILITIES);
  return Object.freeze({
    contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    id: adapterId,
    generation: adapterGeneration,
    capabilities: Object.freeze([...new Set((Array.isArray(capabilities) ? capabilities : []).map(text).filter((capability) => allowed.has(capability)))]),
  });
}

export function createRuntimeSessionRef({ adapterId, agentId, sessionId, nativeThreadId = null, adapterGeneration = 1, state = 'new' } = {}) {
  const normalizedState = known(state, RUNTIME_SESSION_STATES);
  if (!text(adapterId)) throw new Error('runtime_adapter_id_required');
  if (!text(agentId)) throw new Error('runtime_agent_id_required');
  if (!text(sessionId)) throw new Error('runtime_session_id_required');
  if (!normalizedState) throw new Error('runtime_session_state_invalid');
  return Object.freeze({
    adapterId: text(adapterId),
    agentId: text(agentId),
    sessionId: text(sessionId),
    nativeThreadId: text(nativeThreadId) || null,
    adapterGeneration: Number(adapterGeneration),
    state: normalizedState,
  });
}

export function createRuntimeRunRef({ adapterId, agentId, sessionId, runId, nativeTurnId = null, state = 'new' } = {}) {
  const normalizedState = known(state, RUNTIME_RUN_STATES);
  if (!text(adapterId)) throw new Error('runtime_adapter_id_required');
  if (!text(agentId)) throw new Error('runtime_agent_id_required');
  if (!text(sessionId)) throw new Error('runtime_session_id_required');
  if (!text(runId)) throw new Error('runtime_run_id_required');
  if (!normalizedState) throw new Error('runtime_run_state_invalid');
  return Object.freeze({
    adapterId: text(adapterId),
    agentId: text(agentId),
    sessionId: text(sessionId),
    runId: text(runId),
    nativeTurnId: text(nativeTurnId) || null,
    state: normalizedState,
  });
}

export function createRuntimeEvent({ adapterId, sessionId, runId, sequence, timestamp = new Date().toISOString(), type, payload = {} } = {}) {
  const normalizedType = known(type, RUNTIME_EVENT_TYPES);
  const normalizedSequence = finiteSequence(sequence);
  if (!text(adapterId)) throw new Error('runtime_event_adapter_id_required');
  if (!text(sessionId)) throw new Error('runtime_event_session_id_required');
  if (!text(runId)) throw new Error('runtime_event_run_id_required');
  if (normalizedSequence === null) throw new Error('runtime_event_sequence_invalid');
  if (!normalizedType) throw new Error('runtime_event_type_invalid');
  if (!text(timestamp)) throw new Error('runtime_event_timestamp_required');
  return Object.freeze({
    contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    adapterId: text(adapterId),
    sessionId: text(sessionId),
    runId: text(runId),
    sequence: normalizedSequence,
    timestamp: text(timestamp),
    type: normalizedType,
    payload: payload && typeof payload === 'object' ? { ...payload } : {},
  });
}

export function isTerminalRunState(state) { return ['completed', 'cancelled', 'failed'].includes(state); }

/** A fallback may select a different adapter only before a native turn exists. */
export function mayFallbackBeforeRun(run = null) {
  if (!run) return true;
  return !text(run.nativeTurnId) && ['new', 'starting'].includes(run.state || 'new');
}

/**
 * Runtime adapter interface, intentionally expressed as required methods rather
 * than a plugin registry. `startSession`/`resumeSession` own persistent native
 * thread lifecycle; `startRun`/`cancelRun` own one native turn.
 */
export function assertRuntimeAdapter(adapter) {
  const required = ['startSession', 'resumeSession', 'startRun', 'cancelRun', 'subscribeEvents', 'getSessionStatus', 'getRunStatus', 'closeSession'];
  for (const method of required) if (typeof adapter?.[method] !== 'function') throw new Error(`runtime_adapter_method_missing:${method}`);
  return adapter;
}
