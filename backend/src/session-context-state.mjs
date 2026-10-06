import { randomUUID } from 'node:crypto';

export const CONTEXT_STATE_KINDS = new Set(['decision', 'blocker', 'task', 'operator_instruction', 'pin', 'evidence', 'side_effect']);
export const CONTEXT_STATE_LIFECYCLES = new Set(['active', 'resolved', 'superseded', 'completed', 'withdrawn', 'expired']);

function text(value) { return String(value ?? '').trim(); }
function strings(value) { return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : []; }

// This is deliberately explicit. It does not infer an instruction, decision, or
// blocker from conversational prose. Callers must record the semantic event.
export function normalizeSessionContextState(input = {}) {
  const kind = text(input.kind);
  const lifecycle = text(input.lifecycle || 'active');
  const title = text(input.title);
  const content = text(input.content);
  if (!CONTEXT_STATE_KINDS.has(kind)) throw new Error('context_state_kind_invalid');
  if (!CONTEXT_STATE_LIFECYCLES.has(lifecycle)) throw new Error('context_state_lifecycle_invalid');
  if (!title || !content) throw new Error('context_state_content_required');
  return {
    id: text(input.id) || randomUUID(), kind, lifecycle, title, content,
    scopeKey: text(input.scopeKey) || null,
    supersedes: text(input.supersedes) || null,
    sourceRefs: strings(input.sourceRefs),
    pinned: input.pinned === true,
    expiresAt: text(input.expiresAt) || null,
  };
}

export function contextStatesFromTranscript(transcript = []) {
  const records = [];
  for (const entry of Array.isArray(transcript) ? transcript : []) {
    const state = entry?.metadata?.contextState;
    if (!state || typeof state !== 'object') continue;
    try { records.push({ ...normalizeSessionContextState(state), entryId: entry.id || null, ts: entry.ts || null, runId: entry.runId || null }); } catch {}
  }
  const superseded = new Set(records.map((state) => state.supersedes).filter(Boolean));
  const latestByScope = new Map();
  for (const state of records) if (state.scopeKey) latestByScope.set(state.scopeKey, state.id);
  const now = Date.now();
  return records.filter((state) => {
    if (state.lifecycle !== 'active' && !state.pinned) return false;
    if (state.expiresAt && Date.parse(state.expiresAt) < now && !state.pinned) return false;
    if (superseded.has(state.id)) return false;
    return !state.scopeKey || latestByScope.get(state.scopeKey) === state.id;
  });
}

export function renderContextStates(states = [], { maxChars = 2_400 } = {}) {
  const lines = [];
  for (const state of states) {
    const refs = state.sourceRefs.length ? ` [sources: ${state.sourceRefs.join(', ')}]` : '';
    lines.push(`- [${state.kind}${state.pinned ? ', pinned' : ''}] ${state.title}: ${state.content}${refs}`);
  }
  const textValue = lines.join('\n');
  if (textValue.length > maxChars) throw Object.assign(new Error('context_mandatory_material_over_budget'), { statusCode: 413 });
  return textValue;
}
