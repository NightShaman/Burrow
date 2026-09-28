import { normalizeSessionContextState } from './session-context-state.mjs';
import { appendSessionActivity, appendSessionContextState, appendSessionEntry, appendSessionTurn } from './session-store.mjs';
import { conversationAuthority } from './conversation-authority.mjs';

function resolveAuthority({ conversationStore = null, stores = null, agentId = 'hatchet', sessionRoot = null, dataRoot = null } = {}) {
  const store = conversationStore || stores?.conversations || null;
  return store
    ? conversationAuthority({ store, agentId, rootDir: sessionRoot || dataRoot })
    : null;
}

export async function appendRuntimeSessionTurn({
  sessionRoot, dataRoot = null, stores = null, conversationStore = null, agentId = 'hatchet',
  sessionId, role, content, runId, traceDir, metadata = {}, visibility, entersPrompt, parentId,
} = {}) {
  const authority = resolveAuthority({ conversationStore, stores, agentId, sessionRoot, dataRoot });
  const turn = { sessionId, role, content, runId, traceDir, metadata, ...(visibility !== undefined ? { visibility } : {}), ...(entersPrompt !== undefined ? { entersPrompt } : {}), ...(parentId !== undefined ? { parentId } : {}) };
  return authority ? authority.appendTurn(turn) : appendSessionTurn({ rootDir: sessionRoot || dataRoot, ...turn });
}

export async function appendRuntimeSessionEntry({
  sessionRoot, dataRoot = null, stores = null, conversationStore = null, agentId = 'hatchet',
  sessionId, type, role, content, runId, traceDir, metadata = {}, visibility, entersPrompt, parentId,
} = {}) {
  const authority = resolveAuthority({ conversationStore, stores, agentId, sessionRoot, dataRoot });
  const entry = { sessionId, type, role, content, runId, traceDir, metadata, ...(visibility !== undefined ? { visibility } : {}), ...(entersPrompt !== undefined ? { entersPrompt } : {}), ...(parentId !== undefined ? { parentId } : {}) };
  return authority ? authority.append(entry) : appendSessionEntry({ rootDir: sessionRoot || dataRoot, ...entry });
}

export async function appendRuntimeSessionContextState({
  sessionRoot, dataRoot = null, stores = null, conversationStore = null, agentId = 'hatchet',
  sessionId, runId = null, traceDir = null, state,
} = {}) {
  const authority = resolveAuthority({ conversationStore, stores, agentId, sessionRoot, dataRoot });
  if (authority) { const contextState = normalizeSessionContextState(state); return authority.append({ sessionId, type: 'context_state', role: null, content: contextState.title, runId, traceDir, metadata: { contextState }, visibility: 'debug', entersPrompt: false }); }
  return appendSessionContextState({ rootDir: sessionRoot || dataRoot, sessionId, runId, traceDir, state });
}

export async function appendRuntimeActivity({
  sessionRoot, dataRoot = null, stores = null, conversationStore = null, agentId = 'hatchet', sessionId,
  logger, runId = null, traceDir = null, sequence = 0, content, metadata = {},
} = {}) {
  if (!(sessionRoot || dataRoot || stores?.conversations || conversationStore) || !sessionId || !content) return null;
  const authority = resolveAuthority({ conversationStore, stores, agentId, sessionRoot, dataRoot });
  if (!Number.isSafeInteger(Number(sequence)) || Number(sequence) < 0) throw new Error('activity_sequence_invalid');
  if (authority) return authority.append({ sessionId, maxContentChars: 4000, type: 'event', role: null, content, runId: runId || logger?.runId || null, traceDir: traceDir || logger?.traceDir || null, metadata: { ...metadata, activitySequence: Number(sequence) }, visibility: 'activity', entersPrompt: false });
  return appendSessionActivity({ rootDir: sessionRoot || dataRoot, sessionId, runId: runId || logger?.runId || null, traceDir: traceDir || logger?.traceDir || null, sequence, content, metadata });
}
