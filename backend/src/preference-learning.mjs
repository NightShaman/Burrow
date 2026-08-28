import { randomUUID } from 'node:crypto';
import { openSettingsDatabase, settingsDatabasePath } from './settings-database.mjs';

const text = (value) => String(value ?? '').trim();
const bounded = (value, limit) => { const source = text(value); return source.length <= limit ? source : source.slice(0, limit).trim(); };
const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const signalKey = (agentId) => `preference-signals:${agentId}`;
const stateKey = (agentId) => `preference-learning:${agentId}`;
const auditKey = (agentId) => `preference-audit:${agentId}`;
const MAX_SIGNALS = 240;
const MAX_AUDIT = 100;

function meta(db, key, fallback = null) { return parse(db.prepare('SELECT value_json FROM settings_meta WHERE key=?').get(key)?.value_json, fallback); }
function setMeta(db, key, value, at) { db.prepare('INSERT INTO settings_meta (key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').run(key, JSON.stringify(value), at); }

export function normalizePreferenceSignal(value, { sourceRefs = [], at = new Date().toISOString() } = {}) {
  const kind = text(value?.kind).toLowerCase();
  const scope = bounded(value?.scope || 'general', 120);
  const guidance = bounded(value?.guidance, 600);
  const reason = bounded(value?.reason, 240);
  if (!['reinforce', 'contradict', 'replace'].includes(kind) || !scope || !guidance || !reason) return null;
  return { id: `preference-signal:${randomUUID()}`, kind, scope, guidance, reason, sourceRefs: [...new Set(sourceRefs.map(text).filter(Boolean))].slice(0, 20), observedAt: at };
}

export function appendPreferenceSignal({ agentId, signal, databasePath = null, at = new Date().toISOString() } = {}) {
  const id = text(agentId); const normalized = normalizePreferenceSignal(signal, { sourceRefs: signal?.sourceRefs, at });
  if (!id || !normalized) return null;
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try {
    const current = meta(db, signalKey(id), { version: 1, agentId: id, signals: [] });
    const signals = [normalized, ...(Array.isArray(current?.signals) ? current.signals : [])].slice(0, MAX_SIGNALS);
    setMeta(db, signalKey(id), { version: 1, agentId: id, signals, updatedAt: at }, at);
    return normalized;
  } finally { db.close(); }
}

export function preferenceSignals({ agentId, databasePath = null, since = null, limit = 100 } = {}) {
  const id = text(agentId); if (!id) throw new Error('preference_agent_required');
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try {
    const signals = meta(db, signalKey(id), { signals: [] })?.signals || [];
    return signals.filter((signal) => !text(since) || signal.observedAt > since).slice(0, Math.max(1, Math.min(240, Number(limit) || 100)));
  } finally { db.close(); }
}

export function preferenceLearningState({ agentId, databasePath = null } = {}) {
  const id = text(agentId); if (!id) throw new Error('preference_agent_required');
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try { return meta(db, stateKey(id), { version: 1, agentId: id, lastAutomatedAt: null, lastSignalAt: null }); }
  finally { db.close(); }
}

export function applyPreferenceUpdate({ agentId, markdown, sourceSignals = [], profileStore, databasePath = null, at = new Date().toISOString() } = {}) {
  const id = text(agentId); const document = typeof markdown === 'string' ? markdown.trim() : '';
  if (!id || !document || !profileStore) throw new Error('preference_update_invalid');
  const current = profileStore.get(id, 'PREFERENCES');
  const state = preferenceLearningState({ agentId: id, databasePath });
  // A profile edit after automated output is operator truth. Old observations cannot
  // immediately resurrect guidance the operator changed or removed.
  const newestSignalAt = sourceSignals.map((item) => item.observedAt).sort().at(-1) || null;
  if (!newestSignalAt || (current?.updatedAt && ((state.lastAutomatedAt && current.updatedAt > state.lastAutomatedAt) || (!state.lastAutomatedAt && current.updatedAt > newestSignalAt)))) return { applied: false, reason: 'operator_baseline_newer' };
  if (current?.markdown === document) return { applied: false, reason: 'unchanged' };
  profileStore.replacePreferences(id, document);
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try {
    const nextState = { version: 1, agentId: id, lastAutomatedAt: at, lastSignalAt: newestSignalAt || state.lastSignalAt || null };
    const audit = meta(db, auditKey(id), { version: 1, agentId: id, entries: [] });
    const entry = { id: `preference-audit:${randomUUID()}`, at, actor: 'dream', disposition: 'updated', sourceSignalIds: sourceSignals.map((item) => item.id), previousMarkdown: current?.markdown || '', nextMarkdown: document };
    setMeta(db, stateKey(id), nextState, at);
    setMeta(db, auditKey(id), { version: 1, agentId: id, entries: [entry, ...(audit.entries || [])].slice(0, MAX_AUDIT), updatedAt: at }, at);
    return { applied: true, entry, state: nextState };
  } finally { db.close(); }
}

export function preferenceAdjudicationPrompt({ preferences, signals }) {
  return [
    'You are a bounded curator for an operator-authored PREFERENCES.md profile. Return JSON only; never address the operator.',
    'Preferences are current operator-specific behavioral corrections learned through friction. They may be directive. RULES, SOUL, ORIENTATION, and TOOLS are outside your authority.',
    'Use only supplied grounded Tiddle signals. Do not infer preferences from task instructions, moods, generic conversation, or old evidence. Preserve operator wording unless the new signals clearly require a change.',
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
  if (!/^\s*#\s+operator preferences\b/imu.test(proposal.markdown)) return { ok: false, reason: 'preferences_markdown_heading_required' };
  return { ok: true, disposition: 'replace', signals: selected };
}
