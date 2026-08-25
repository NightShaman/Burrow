import { randomUUID } from 'node:crypto';
import { WorkingMemoryStore } from './working-memory-store.mjs';
import { ContinuityHandoffStore } from './continuity-handoff-store.mjs';

function selectedProject(requestedProject) {
  return String(requestedProject || '').trim() || null;
}

function authorizedProject({ requestedProject, continuityScope }) {
  const project = selectedProject(continuityScope);
  const requested = selectedProject(requestedProject);
  if (!project) return { project: null, error: 'continuity_scope_unavailable' };
  if (requested && requested !== project) return { project, error: 'continuity_scope_mismatch' };
  return { project, error: null };
}

// Working memory is local, agent- and continuity-scope-bound operational
// evidence. A model can select within its scope, never select the scope.
export function executeWorkingMemorySearchTool({ arguments: args = {}, agentId = null, continuityScope = null, store = null } = {}) {
  const query = String(args.query || '').trim();
  const { project, error: scopeError } = authorizedProject({ requestedProject: args.project, continuityScope });
  if (!query) return { tool: 'memory_working_search', ok: false, query: null, project, results: [], error: 'query_required' };
  if (!agentId) return { tool: 'memory_working_search', ok: false, query, project, results: [], error: 'working_memory_agent_unavailable' };
  if (scopeError) return { tool: 'memory_working_search', ok: false, query, project, results: [], error: scopeError };
  const workingStore = store || new WorkingMemoryStore();
  try {
    const results = workingStore.search({ agentId, project, query, limit: args.limit });
    return {
      tool: 'memory_working_search', ok: true, query, project, agentId,
      results: results.map((item) => ({ id: item.id, project: item.project, kind: item.kind, state: item.state, title: item.title, content: item.content, sourceRefs: item.sourceRefs, updatedAt: item.updatedAt, expiresAt: item.expiresAt, score: item.score })),
      resultCount: results.length, error: null,
    };
  } catch (error) {
    return { tool: 'memory_working_search', ok: false, query, project, results: [], error: error?.message || 'working_memory_search_failed' };
  } finally {
    if (!store) workingStore.close();
  }
}


export function executeRollingContinuitySearchTool({ arguments: args = {}, agentId = null, continuityScope = null, store = null } = {}) {
  const query = String(args.query || '').trim();
  const { project, error: scopeError } = authorizedProject({ requestedProject: args.project, continuityScope });
  if (!query) return { tool: 'memory_rolling_search', ok: false, query: null, project, results: [], error: 'query_required' };
  if (!agentId || !project) return { tool: 'memory_rolling_search', ok: false, query, project, results: [], error: 'rolling_continuity_scope_unavailable' };
  if (scopeError) return { tool: 'memory_rolling_search', ok: false, query, project, results: [], error: scopeError };
  const workingStore = store || new WorkingMemoryStore();
  try {
    const results = workingStore.searchRollingContinuityCards({ agentId, project, query, limit: args.limit });
    return {
      tool: 'memory_rolling_search', ok: true, query, project, agentId, owner: 'rolling_continuity', entersPrompt: false,
      results: results.map((item) => ({ id: item.id, project: item.project, title: item.title, summary: item.summary, firstSeen: item.firstSeen, lastSeen: item.lastSeen, recurrence: item.recurrence, recentRefs: item.recentRefs, evidence: item.evidence, score: item.score })),
      resultCount: results.length, error: null,
    };
  } catch (error) {
    return { tool: 'memory_rolling_search', ok: false, query, project, results: [], error: error?.message || 'rolling_continuity_search_failed' };
  } finally { if (!store) workingStore.close(); }
}

export function executeWorkingMemoryRecordTool({ arguments: args = {}, agentId = null, sessionId = null, conversationId = null, continuityScope = null, store = null } = {}) {
  if (!agentId || !sessionId || !conversationId) return { tool: 'memory_working_write', ok: false, error: 'working_memory_scope_unavailable' };
  const { project, error: scopeError } = authorizedProject({ requestedProject: args.project, continuityScope });
  if (scopeError) return { tool: 'memory_working_write', ok: false, error: scopeError };
  const workingStore = store || new WorkingMemoryStore();
  try {
    const item = workingStore.record({
      id: randomUUID(), agentId, sessionId, conversationId, project, kind: args.kind,
      state: args.state || 'active', title: args.title, content: args.content, sourceRefs: args.sourceRefs,
    });
    return { tool: 'memory_working_write', ok: true, record: { id: item.id, agentId: item.agentId, project: item.project, kind: item.kind, state: item.state, title: item.title, sourceRefs: item.sourceRefs, expiresAt: item.expiresAt }, error: null };
  } catch (error) {
    return { tool: 'memory_working_write', ok: false, error: error?.message || 'working_memory_record_failed' };
  } finally { if (!store) workingStore.close(); }
}

export function executeSessionHandoffReadTool({ agentId = null, sessionId = null, dataRoot = null, store = null } = {}) {
  if (!agentId || !sessionId || !dataRoot) return { tool: 'session_read_handoff', ok: false, handoff: null, error: 'session_handoff_scope_unavailable' };
  const continuityStore = store || new ContinuityHandoffStore({ dataRoot });
  try {
    return { tool: 'session_read_handoff', ok: true, handoff: continuityStore.getRecent({ agentId, sessionId }) || null, error: null };
  } catch (error) {
    return { tool: 'session_read_handoff', ok: false, handoff: null, error: error?.message || 'session_handoff_read_failed' };
  } finally { if (!store) continuityStore.close(); }
}

// Continuity is deliberately agent/session-local. The caller supplies no path,
// agent, session, or durable-memory project; those are runtime-owned context.
export function executeContinuityHandoffWriteTool({ arguments: args = {}, agentId = null, sessionId = null, runId = null, dataRoot = null, store = null } = {}) {
  if (!agentId || !sessionId || !runId || !dataRoot) return { tool: 'session_write_handoff', ok: false, error: 'continuity_handoff_scope_unavailable' };
  const continuityStore = store || new ContinuityHandoffStore({ dataRoot });
  try {
    const record = continuityStore.upsert({ id: `continuity:${agentId}:${sessionId}`, agentId, sessionId, runId, source: 'explicit', title: args.title, content: args.content, sourceRefs: args.sourceRefs, evidenceSummary: 'Explicit agent-authored local continuity handoff; verify referenced evidence before relying on claims.' });
    return { tool: 'session_write_handoff', ok: true, handoff: { id: record.id, agentId: record.agentId, sessionId: record.sessionId, runId: record.runId, title: record.title, sourceRefs: record.sourceRefs, expiresAt: record.expiresAt }, error: null };
  } catch (error) {
    return { tool: 'session_write_handoff', ok: false, error: error?.message || 'session_write_handoff_failed' };
  } finally { if (!store) continuityStore.close(); }
}
