import { randomUUID } from 'node:crypto';

const text = (value) => String(value ?? '').trim();
const bounded = (value, limit) => { const source = text(value); return source.length <= limit ? source : source.slice(0, limit).trim(); };
const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const signalKey = (agentId) => `preference-signals:${agentId}`;
const stateKey = (agentId) => `preference-learning:${agentId}`;
const auditKey = (agentId) => `preference-audit:${agentId}`;
const MAX_SIGNALS = 240;
const MAX_AUDIT = 100;


export function normalizePreferenceSignal(value, { sourceRefs = [], at = new Date().toISOString() } = {}) {
  const kind = text(value?.kind).toLowerCase();
  const scope = bounded(value?.scope || 'general', 120);
  const guidance = bounded(value?.guidance, 600);
  const reason = bounded(value?.reason, 240);
  if (!['reinforce', 'contradict', 'replace'].includes(kind) || !scope || !guidance || !reason) return null;
  return { id: `preference-signal:${randomUUID()}`, kind, scope, guidance, reason, sourceRefs: [...new Set(sourceRefs.map(text).filter(Boolean))].slice(0, 20), observedAt: at };
}

export function preferenceAdjudicationPrompt({ preferences, signals }) {
  return [
    'You are a bounded curator for an operator-authored PREFERENCES.md profile. Return JSON only; never address the operator.',
    'Preferences are current operator-specific behavioral corrections learned through friction. They may be directive. RULES, SOUL, ORIENTATION, and TOOLS are outside your authority.',
    'Use only supplied grounded session-derived signals. Do not infer preferences from task instructions, moods, generic conversation, or old evidence. Preserve operator wording unless the new signals clearly require a change.',
    'The Markdown must contain only current guidance: no audit history, evidence, timestamps, confidence, or explanations. Do not remove a preference merely because it was not mentioned recently.',
    'Return NOOP unless the supplied new signals clearly support a current-profile change. A directly stated correction can be sufficient; ambiguous or conflicting signals require NOOP. Return either {"action":"NOOP","reason":"..."} or {"action":"REPLACE","markdown":"...","signalIds":["..."],"reason":"..."}.',
    `Current PREFERENCES.md:\n${preferences || '(empty)'}`,
    `New grounded signals: ${JSON.stringify(signals.map((signal) => ({ id: signal.id, kind: signal.kind, scope: signal.scope, guidance: signal.guidance, reason: signal.reason, observedAt: signal.observedAt, sourceRefs: signal.sourceRefs })))}`,
  ].join('\n\n');
}

export function parsePreferenceAdjudication(value) {
  const source = text(value);
  const candidates = [source, ...[...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)].map((match) => typeof match === 'string' ? match : match[1])];
  for (const candidate of candidates) {
    const proposal = parse(candidate); const action = text(proposal?.action).toUpperCase();
    if (action === 'NOOP') return { action, reason: bounded(proposal.reason, 240) || 'no_preference_change' };
    if (action === 'REPLACE' && typeof proposal.markdown === 'string' && text(proposal.markdown) && Array.isArray(proposal.signalIds)) return { action, markdown: proposal.markdown.trim(), signalIds: [...new Set(proposal.signalIds.map(text).filter(Boolean))].slice(0, 20), reason: bounded(proposal.reason, 240) || 'grounded_preference_change' };
  }
  return null;
}

export function validatePreferenceAdjudication({ proposal, signals = [] } = {}) {
  if (!proposal) return { ok: false, reason: 'proposal_invalid' };
  if (proposal.action === 'NOOP') return { ok: true, disposition: 'noop', signals: [] };
  const byId = new Map(signals.map((signal) => [signal.id, signal]));
  const selected = proposal.signalIds.map((id) => byId.get(id)).filter(Boolean);
  if (!selected.length || selected.length !== proposal.signalIds.length || proposal.markdown.length > 48_000) return { ok: false, reason: 'proposal_ungrounded' };
  if (!/^\s*#\s+(?:PREFERENCES|Operator Preferences)\s*$/imu.test(proposal.markdown)) return { ok: false, reason: 'preferences_markdown_heading_required' };
  return { ok: true, disposition: 'replace', signals: selected };
}

/** Async PG-compatible metadata adapter. atomicUpdate(key, updater, at) must lock/update in one transaction. */
function requireAsyncStores(agentId, metadataStore) { if (!text(agentId)) throw new Error('preference_agent_required'); if (!metadataStore?.atomicUpdate || !metadataStore?.get) throw new Error('preference_metadata_store_required'); }
export async function appendPreferenceSignalAsync({ agentId, signal, metadataStore, at = new Date().toISOString() } = {}) { const id = text(agentId); const normalized = normalizePreferenceSignal(signal, { sourceRefs: signal?.sourceRefs, at }); if (!id || !normalized) return null; requireAsyncStores(id, metadataStore); await metadataStore.atomicUpdate(signalKey(id), (current) => ({ version: 1, agentId: id, signals: [normalized, ...(Array.isArray(current?.signals) ? current.signals : [])].slice(0, MAX_SIGNALS), updatedAt: at }), at); return normalized; }
export async function preferenceSignalsAsync({ agentId, metadataStore, since = null, limit = 100 } = {}) { const id = text(agentId); requireAsyncStores(id, metadataStore); const value = await metadataStore.get(signalKey(id)); return (Array.isArray(value?.signals) ? value.signals : []).filter((s) => !text(since) || s.observedAt > since).slice(0, Math.max(1, Math.min(240, Number(limit) || 100))); }
export async function preferenceLearningStateAsync({ agentId, metadataStore } = {}) { const id = text(agentId); requireAsyncStores(id, metadataStore); return (await metadataStore.get(stateKey(id))) || { version: 1, agentId: id, lastAutomatedAt: null, lastSignalAt: null }; }


/** PostgreSQL implementation: profile, learning state, and audit share one transaction and profile lock. */
export async function applyPreferenceUpdateAsync({ agentId, markdown, sourceSignals = [], profileStore, at = new Date().toISOString() } = {}) {
  const id = text(agentId); const document = typeof markdown === 'string' ? markdown.trim() : '';
  if (!id || !document || !profileStore?.atomicPreferenceUpdate) throw new Error('preference_update_invalid');
  const stateKeyName = stateKey(id); const auditKeyName = auditKey(id);
  const newestSignalAt = sourceSignals.map((item) => item.observedAt).sort().at(-1) || null;
  return profileStore.atomicPreferenceUpdate(id, {
    markdown: document, stateKey: stateKeyName, auditKey: auditKeyName, at,
    state: { version: 1, agentId: id, lastAutomatedAt: at, lastSignalAt: newestSignalAt },
    decide: ({ current, priorState }) => {
      if (!newestSignalAt || (current?.updatedAt && ((priorState?.lastAutomatedAt && current.updatedAt > priorState.lastAutomatedAt) || (!priorState?.lastAutomatedAt && current.updatedAt > newestSignalAt)))) return { apply: false, reason: 'operator_baseline_newer' };
      if (current?.markdown === document) return { apply: false, reason: 'unchanged' };
      return { apply: true };
    },
    audit: (prior, current) => ({ version: 1, agentId: id, entries: [{ id: `preference-audit:${randomUUID()}`, at, actor: 'dream', disposition: 'updated', sourceSignalIds: sourceSignals.map((item) => item.id), previousMarkdown: current?.markdown || '', nextMarkdown: document }, ...(prior?.entries || [])].slice(0, MAX_AUDIT), updatedAt: at }),
  });
}

export { appendPreferenceSignalAsync as appendPreferenceSignal, preferenceSignalsAsync as preferenceSignals, preferenceLearningStateAsync as preferenceLearningState, applyPreferenceUpdateAsync as applyPreferenceUpdate };
