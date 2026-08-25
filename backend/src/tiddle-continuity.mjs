import { randomUUID } from 'node:crypto';
import { redactText } from './redaction.mjs';
import { AgentRegistryStore } from './agent-registry.mjs';
import { completeCurator, curatorRoot, readCuratorSelection } from './curator-runtime.mjs';
import { openSettingsDatabase, settingsDatabasePath } from './settings-database.mjs';

const PASS_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const SYNTHESIS_WINDOW_MS = 21 * 24 * 60 * 60 * 1_000;
const MAX_SYNTHESIS_CANDIDATES = 120;
const GLOBAL_SCOPE = 'global';
const CARD_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_RESIDUE = 240;
const MAX_CARDS = 100;
export const TIDDLE_HISTORY_RETENTION_DAYS = 180;
const HISTORY_RETENTION_MS = TIDDLE_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

const text = (value) => String(value ?? '').trim();
const bounded = (value, limit) => { const source = text(value); return source.length <= limit ? source : source.slice(0, limit).trim(); };
const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const iso = (value = Date.now()) => new Date(value).toISOString();
const residueKey = (agentId) => `tiddle-residue:${agentId}`;
const passKey = (agentId) => `tiddle-pass:${agentId}`;
const scopePassKey = (agentId, scope) => `tiddle-pass-scope:${agentId}:${scope}`;
const receiptKey = (agentId, runId) => `tiddle-pass-receipt:${agentId}:${runId}`;
const cardKey = (agentId, scope) => `rolling-continuity:${agentId}:${scope}`;
const historyKey = (agentId) => `tiddle-history:${agentId}`;
const synthesisKey = (agentId) => `tiddle-synthesis:${agentId}`;
const globalCardKey = (agentId) => cardKey(agentId, GLOBAL_SCOPE);

function meta(db, key, fallback = null) { return parse(db.prepare('SELECT value_json FROM settings_meta WHERE key=?').get(key)?.value_json, fallback); }
function setMeta(db, key, value, at) { db.prepare(`INSERT INTO settings_meta (key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(key, JSON.stringify(value), at); }
function activeCards(db, agentId, scope, at) {
  const value = meta(db, cardKey(agentId, scope), { cards: [] });
  return (Array.isArray(value?.cards) ? value.cards : []).filter((card) => !card.expiresAt || card.expiresAt >= at);
}
function appendHistory(db, { agentId, entry, at }) {
  const current = meta(db, historyKey(agentId), { version: 1, agentId, entries: [] });
  const cutoff = iso(new Date(at).getTime() - HISTORY_RETENTION_MS);
  const entries = [entry, ...(Array.isArray(current?.entries) ? current.entries : []).filter((item) => item?.at >= cutoff)];
  setMeta(db, historyKey(agentId), { version: 1, agentId, entries, updatedAt: at }, at);
  return entry;
}
function commitScopePass(db, { agentId, scope, at, entry, cardUpdate = null }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const update = cardUpdate ? upsertTiddleCard(db, cardUpdate) : null;
    appendHistory(db, { agentId, at, entry: entry(update) });
    setMeta(db, scopePassKey(agentId, scope), { version: 1, agentId, scope, lastSuccessAt: at, updatedAt: at }, at);
    db.exec('COMMIT');
    return update;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
function selectionIdentity(selection) { return selection ? { kind: selection.kind, connectionId: selection.connectionId || null, model: selection.model || selection.modelPath || null, temperature: selection.temperature ?? 0 } : null; }
export function parseTiddleProposal(value) {
  const source = text(value);
  const candidates = [source, ...[...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)].map((match) => typeof match === 'string' ? match : match[1])];
  for (const candidate of candidates) {
    const proposal = parse(candidate);
    const action = text(proposal?.action).toUpperCase();
    if (action === 'NOOP') return { action, reason: bounded(proposal.reason, 240) || 'no_warm_continuity' };
    if (action === 'UPSERT' && text(proposal.title) && text(proposal.summary) && (proposal.targetId === null || text(proposal.targetId))) return { action, targetId: text(proposal.targetId) || null, title: bounded(proposal.title, 240), summary: bounded(proposal.summary, 2400), reason: bounded(proposal.reason, 240) || 'persistence across the window' };
  }
  return null;
}

/** Cheap terminal residue only: no model call, no warm-card mutation. */
export function appendTiddleResidue({ databasePath = null, agentId, scope, sessionId, conversationId, runId, message, answerText, toolResults = [], at = iso() } = {}) {
  if (!text(agentId) || !text(scope) || !text(sessionId) || !text(runId) || !text(answerText)) return null;
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try {
    const current = meta(db, residueKey(agentId), { version: 1, agentId, items: [] });
    const item = {
      ref: `session:${sessionId}:run:${runId}`,
      scope: text(scope), sessionId: text(sessionId), conversationId: text(conversationId) || text(sessionId), runId: text(runId), at,
      // Residue persists beyond this turn, so it must never retain raw chat secrets.
      message: bounded(redactText(message), 1200), answer: bounded(redactText(answerText), 1800),
      tools: (Array.isArray(toolResults) ? toolResults : []).filter((tool) => tool?.ok === true).slice(0, 8).map((tool) => ({ tool: bounded(tool.tool, 120), path: bounded(tool.filePath || tool.path, 240) || null, command: bounded(tool.command, 240) || null })),
    };
    const cutoff = iso(new Date(at).getTime() - LOOKBACK_MS);
    const items = [item, ...(Array.isArray(current?.items) ? current.items : []).filter((entry) => entry?.at >= cutoff && entry?.ref !== item.ref)].slice(0, MAX_RESIDUE);
    setMeta(db, residueKey(agentId), { version: 1, agentId: text(agentId), items, updatedAt: at }, at);
    return item;
  } finally { db.close(); }
}

function prompt({ agentId, scope, residue, cards }) {
  return [
    'You are Tiddle. You reconcile rolling conversational continuity on a four-hour cadence. Return JSON only; never address the user.',
    'Warm continuity means a concept persisted, resumed, or recurred across the window. A single vivid turn is not warmth. Default to NOOP.',
    'Do not create tasks, decisions, emotional/therapy notes, transcript summaries, raw tool dumps, verified external state, or instructions for the agent. This is recall metadata only.',
    'Use UPSERT only when the supplied residue demonstrates a compact future-turn-relevant thread that persisted or recurred. If it is an existing concept, set targetId to that exact existing card id even if you improve its title. Set targetId:null only for a genuinely new concept. Output either {"action":"NOOP","reason":"..."} or {"action":"UPSERT","targetId":"existing-card-id-or-null","title":"...","summary":"...","reason":"..."}.',
    `Agent: ${agentId}; continuity scope: ${scope}`,
    `Existing warm cards: ${JSON.stringify(cards.map((card) => ({ id: card.id, title: card.title, summary: card.summary, recurrence: card.recurrence, lastSeen: card.lastSeen })).slice(0, 24))}`,
    `24-hour context residue (newSinceLastPass marks what arrived after the prior successful pass): ${JSON.stringify(residue.map((item) => ({ ref: item.ref, at: item.at, newSinceLastPass: item.newSinceLastPass === true, sessionId: item.sessionId, message: item.message, answer: item.answer, tools: item.tools })).slice(0, 48))}`,
  ].join('\n\n');
}
function schema() { return { oneOf: [
  { type: 'object', additionalProperties: false, required: ['action', 'reason'], properties: { action: { const: 'NOOP' }, reason: { type: 'string', minLength: 8, maxLength: 240 } } },
  { type: 'object', additionalProperties: false, required: ['action', 'targetId', 'title', 'summary', 'reason'], properties: { action: { const: 'UPSERT' }, targetId: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 120 }] }, title: { type: 'string', minLength: 1, maxLength: 240 }, summary: { type: 'string', minLength: 1, maxLength: 2400 }, reason: { type: 'string', minLength: 8, maxLength: 240 } } },
] }; }

function synthesisCandidates(db, agentId, at) {
  const cutoff = new Date(new Date(at).getTime() - SYNTHESIS_WINDOW_MS).toISOString();
  const rows = db.prepare('SELECT key FROM settings_meta WHERE key LIKE ? AND key NOT LIKE ? ORDER BY key').all(`rolling-continuity:${agentId}:%`, globalCardKey(agentId));
  return rows.flatMap(({ key }) => (meta(db, key, { cards: [] })?.cards || []).map((card) => ({ ...card, sourceScope: card.project || key.split(':').slice(2).join(':') })))
    .filter((card) => card.lastSeen >= cutoff && card.expiresAt >= at)
    .sort((a, b) => String(a.lastSeen).localeCompare(String(b.lastSeen)) || String(a.id).localeCompare(String(b.id)))
    .slice(-MAX_SYNTHESIS_CANDIDATES);
}

function synthesisPrompt({ agentId, at, candidates, globalCards }) {
  return [
    'You are Tiddle performing nightly cross-scope continuity synthesis. Return JSON only; never address the user.',
    'Propose semantic clusters only when the evidence describes the same future-turn-relevant concept across at least two distinct continuity scopes within the supplied 21-day window. Do not summarize transcripts or promote one-off residue.',
    'The runtime will validate every source card id, scope, and window before mutation. Confidence is metadata, not an admission rule. Return NOOP when no supported cluster exists.',
    'Output either {"action":"NOOP","reason":"..."} or {"action":"UPSERT_CLUSTERS","clusters":[{"targetId":null,"title":"...","summary":"...","sourceCardIds":["..."],"confidence":0.0,"reason":"..."}]}. Use targetId only for an existing global card id.',
    `Agent: ${agentId}; synthesis window ends: ${at}; candidates: ${JSON.stringify(candidates.map((card) => ({ id: card.id, scope: card.sourceScope, title: card.title, summary: card.summary, recurrence: card.recurrence, firstSeen: card.firstSeen, lastSeen: card.lastSeen })))}`,
    `Existing global warm cards: ${JSON.stringify(globalCards.map((card) => ({ id: card.id, title: card.title, summary: card.summary, sourceCardIds: card.sourceCardIds, scopes: card.scopes })))}`,
  ].join('\\n\\n');
}
function synthesisSchema() { return { oneOf: [
  { type: 'object', additionalProperties: false, required: ['action', 'reason'], properties: { action: { const: 'NOOP' }, reason: { type: 'string', minLength: 1, maxLength: 240 } } },
  { type: 'object', additionalProperties: false, required: ['action', 'clusters'], properties: { action: { const: 'UPSERT_CLUSTERS' }, clusters: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['targetId', 'title', 'summary', 'sourceCardIds', 'confidence', 'reason'], properties: { targetId: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 120 }] }, title: { type: 'string', minLength: 1, maxLength: 240 }, summary: { type: 'string', minLength: 1, maxLength: 2400 }, sourceCardIds: { type: 'array', minItems: 2, maxItems: 50, items: { type: 'string' } }, confidence: { type: 'number', minimum: 0, maximum: 1 }, reason: { type: 'string', minLength: 1, maxLength: 240 } } } } } },
] }; }
export function parseTiddleSynthesis(value) {
  const source = text(value);
  const candidates = [source, ...[...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)].map((match) => match[1])];
  for (const candidate of candidates) {
    const proposal = parse(candidate);
    const action = text(proposal?.action).toUpperCase();
    if (action === 'NOOP') return { action, reason: bounded(proposal.reason, 240) || 'no_supported_cross_scope_cluster' };
    if (action === 'UPSERT_CLUSTERS' && Array.isArray(proposal.clusters)) return { action, clusters: proposal.clusters, reason: 'cross_scope_synthesis' };
  }
  return null;
}
function validateSynthesisClusters(proposal, candidates, globalCards, at) {
  if (!proposal || proposal.action !== 'UPSERT_CLUSTERS') return [];
  const byId = new Map(candidates.map((card) => [card.id, card]));
  const globalById = new Set(globalCards.map((card) => card.id));
  const validated = proposal.clusters.flatMap((cluster) => {
    const sources = [...new Set(Array.isArray(cluster.sourceCardIds) ? cluster.sourceCardIds.map(text) : [])].map((id) => byId.get(id)).filter(Boolean);
    const scopes = [...new Set(sources.map((card) => card.sourceScope))];
    if (!text(cluster.title) || !text(cluster.summary) || sources.length < 2 || scopes.length < 2) return [];
    if (cluster.targetId !== null && (!text(cluster.targetId) || !globalById.has(text(cluster.targetId)))) return [];
    return [{ ...cluster, targetId: text(cluster.targetId) || null, title: bounded(cluster.title, 240), summary: bounded(cluster.summary, 2400), sourceCardIds: sources.map((card) => card.id), scopes, confidence: Number.isFinite(Number(cluster.confidence)) ? Math.max(0, Math.min(1, Number(cluster.confidence))) : null, sourceCards: sources, at }];
  });
  return validated.length === proposal.clusters.length ? validated : [];
}
function upsertGlobalCluster(db, { agentId, cluster, at }) {
  const cards = activeCards(db, agentId, GLOBAL_SCOPE, at);
  const existing = cluster.targetId ? cards.find((card) => card.id === cluster.targetId) : null;
  if (cluster.targetId && !existing) throw new Error('tiddle_global_target_invalid');
  const id = existing?.id || `warm-global:${randomUUID()}`;
  const sourceCardIds = [...new Set([...(existing?.sourceCardIds || []), ...cluster.sourceCardIds])].slice(-100);
  const scopes = [...new Set([...(existing?.scopes || []), ...cluster.scopes])];
  const card = { id, agentId, project: GLOBAL_SCOPE, title: cluster.title, summary: cluster.summary, firstSeen: existing?.firstSeen || at, lastSeen: at, recurrence: Number(existing?.recurrence || 0) + 1, sourceCardIds, scopes, confidence: cluster.confidence, evidence: 'cross-scope-synthesis', reason: bounded(cluster.reason, 240), expiresAt: iso(new Date(new Date(at).getTime() + CARD_TTL_MS)) };
  setMeta(db, globalCardKey(agentId), { version: 1, agentId, project: GLOBAL_SCOPE, cards: [card, ...cards.filter((entry) => entry.id !== id)].slice(0, MAX_CARDS), updatedAt: at }, at);
  return { card, prior: existing || null };
}

export async function runTiddleSynthesis({ agentId, databasePath = null, runtimeRoot = null, settingsKey = undefined, temperature = undefined, at = iso(), traceLogger = null } = {}) {
  const id = text(agentId); if (!id) throw new Error('tiddle_agent_required');
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  const runId = `tiddle-synthesis-${randomUUID()}`;
  try {
    const candidates = synthesisCandidates(db, id, at); const globals = activeCards(db, id, GLOBAL_SCOPE, at);
    if (candidates.length < 2) { const receipt = { version: 1, ok: true, runId, agentId: id, generatedAt: at, windowDays: 21, candidateCount: candidates.length, disposition: 'noop', reason: 'insufficient_candidates' }; setMeta(db, synthesisKey(id), { ...receipt, lastSuccessAt: at }, at); setMeta(db, receiptKey(id, runId), receipt, at); return receipt; }
    const configuredSelection = readCuratorSelection({ databasePath, root: curatorRoot({ runtimeRoot: runtimeRoot || undefined }) }); if (!configuredSelection) throw new Error('curator_selection_required');
    const selection = temperature === undefined ? configuredSelection : { ...configuredSelection, temperature };
    const completion = await completeCurator({ selection, databasePath, settingsKey, root: curatorRoot({ runtimeRoot: runtimeRoot || undefined }), prompt: synthesisPrompt({ agentId: id, at, candidates, globalCards: globals }), jsonSchema: synthesisSchema(), traceLogger });
    const proposal = parseTiddleSynthesis(completion?.choice?.text); const clusters = validateSynthesisClusters(proposal, candidates, globals, at); const updates = clusters.map((cluster) => upsertGlobalCluster(db, { agentId: id, cluster, at }));
    const receipt = { version: 1, ok: true, runId, agentId: id, generatedAt: at, windowDays: 21, candidateCount: candidates.length, clusterCount: updates.length, disposition: updates.length ? 'upserted' : 'noop', model: selectionIdentity(selection) };
    setMeta(db, synthesisKey(id), { ...receipt, lastSuccessAt: at }, at); setMeta(db, receiptKey(id, runId), receipt, at); await traceLogger?.event?.('tiddle-synthesis', receipt); return receipt;
  } catch (error) { const receipt = { version: 1, ok: false, runId, agentId: id, generatedAt: at, error: String(error?.message || error) }; setMeta(db, receiptKey(id, runId), receipt, at); await traceLogger?.event?.('tiddle-synthesis', receipt); return receipt; }
  finally { db.close(); }
}

export function upsertTiddleCard(db, { agentId, scope, proposal, residue, at }) {
  const cards = activeCards(db, agentId, scope, at);
  const existing = proposal.targetId ? cards.find((card) => card.id === proposal.targetId) : null;
  if (proposal.targetId && !existing) throw new Error('tiddle_card_target_invalid');
  const id = existing?.id || `warm:${randomUUID()}`;
  const refs = [...new Set([...(existing?.recentRefs || []), ...residue.map((item) => item.ref)])].slice(-20);
  const card = { id, agentId, project: scope, title: proposal.title, summary: proposal.summary, firstSeen: existing?.firstSeen || at, lastSeen: at, recurrence: Number(existing?.recurrence || 0) + 1, recentRefs: refs, evidence: 'windowed-conversation', reason: proposal.reason, expiresAt: iso(new Date(at).getTime() + CARD_TTL_MS) };
  setMeta(db, cardKey(agentId, scope), { version: 1, agentId, project: scope, cards: [card, ...cards.filter((entry) => entry.id !== id)].slice(0, MAX_CARDS), updatedAt: at }, at);
  return { card, prior: existing || null };
}

export async function runTiddlePass({ agentId, databasePath = null, runtimeRoot = null, settingsKey = undefined, temperature = undefined, at = iso(), traceLogger = null } = {}) {
  const id = text(agentId);
  if (!id) throw new Error('tiddle_agent_required');
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  const runId = `tiddle-pass-${randomUUID()}`;
  try {
    const state = meta(db, passKey(id), {});
    const lookbackStart = new Date(at).getTime() - LOOKBACK_MS;
    const contextStart = iso(lookbackStart);
    const allResidue = (meta(db, residueKey(id), { items: [] })?.items || []).filter((item) => item?.at >= contextStart && item?.at <= at);
    const groups = new Map();
    for (const item of allResidue) { const group = groups.get(item.scope) || { context: [] }; group.context.push(item); groups.set(item.scope, group); }
    const scopeGroups = [...groups].map(([scope, group]) => {
      const priorSuccess = Date.parse(meta(db, scopePassKey(id, scope), {})?.lastSuccessAt || '');
      const newResidueStart = iso(Number.isFinite(priorSuccess) ? priorSuccess : lookbackStart);
      return [scope, { ...group, newRefs: new Set(group.context.filter((item) => item.at >= newResidueStart).map((item) => item.ref)) }];
    });
    const newResidueCount = scopeGroups.reduce((count, [, group]) => count + group.newRefs.size, 0);
    const outcomes = [];
    if (!newResidueCount) {
      const receipt = { version: 1, ok: true, runId, agentId: id, generatedAt: at, contextWindowStart: contextStart, windowHours: 24, passHours: 4, scopes: outcomes, residueCount: 0, disposition: 'no_residue', nextRunAt: iso(new Date(at).getTime() + PASS_INTERVAL_MS) };
      appendHistory(db, { agentId: id, at, entry: { version: 1, id: `tiddle-history-${randomUUID()}`, at, runId, agentId: id, scope: null, disposition: 'no_residue', model: null, contextResidueCount: 0, newResidueCount: 0, cardId: null, recurrenceBefore: 0, recurrenceAfter: 0, titleBefore: null, titleAfter: null, summaryBefore: null, summaryAfter: null, reason: 'no_new_residue', sourceRefs: [] } });
      setMeta(db, passKey(id), { version: 1, agentId: id, lastSuccessAt: at, nextRunAt: receipt.nextRunAt, updatedAt: at }, at);
      setMeta(db, receiptKey(id, runId), receipt, at);
      await traceLogger?.event?.('tiddle-pass', receipt);
      return receipt;
    }
    const configuredSelection = readCuratorSelection({ databasePath, root: curatorRoot({ runtimeRoot: runtimeRoot || undefined }) });
    if (!configuredSelection) throw new Error('curator_selection_required');
    const selection = temperature === undefined ? configuredSelection : { ...configuredSelection, temperature };
    for (const [scope, group] of scopeGroups) {
      const { context: items, newRefs } = group;
      if (!newRefs.size) continue;
      const cards = activeCards(db, id, scope, at);
      const completion = await completeCurator({ selection, databasePath, settingsKey, root: curatorRoot({ runtimeRoot: runtimeRoot || undefined }), prompt: prompt({ agentId: id, scope, residue: items.map((item) => ({ ...item, newSinceLastPass: newRefs.has(item.ref) })), cards }), jsonSchema: schema(), traceLogger });
      const proposal = parseTiddleProposal(completion?.choice?.text);
      const cardUpdate = proposal?.action === 'UPSERT' ? { agentId: id, scope, proposal, residue: items, at } : null;
      const update = commitScopePass(db, { agentId: id, scope, at, cardUpdate, entry: (cardUpdateResult) => {
        const card = cardUpdateResult?.card || null;
        const prior = cardUpdateResult?.prior || null;
        const disposition = card ? (prior ? 'updated' : 'created') : 'noop';
        return { version: 1, id: `tiddle-history-${randomUUID()}`, at, runId, agentId: id, scope, disposition, model: selectionIdentity(selection), contextResidueCount: items.length, newResidueCount: newRefs.size, cardId: card?.id || null, recurrenceBefore: prior?.recurrence || 0, recurrenceAfter: card?.recurrence || 0, titleBefore: prior?.title || null, titleAfter: card?.title || null, summaryBefore: prior?.summary || null, summaryAfter: card?.summary || null, reason: proposal?.reason || null, sourceRefs: card ? card.recentRefs : [...newRefs].slice(-20) };
      } });
      const card = update?.card || null;
      const disposition = card ? (update.prior ? 'updated' : 'created') : 'noop';
      outcomes.push({ scope, contextResidueCount: items.length, newResidueCount: newRefs.size, disposition, card: card ? { id: card.id, title: card.title, recurrence: card.recurrence } : null });
    }
    const receipt = { version: 1, ok: true, runId, agentId: id, generatedAt: at, contextWindowStart: contextStart, windowHours: 24, passHours: 4, model: selectionIdentity(selection), scopes: outcomes, residueCount: newResidueCount, nextRunAt: iso(new Date(at).getTime() + PASS_INTERVAL_MS) };
    setMeta(db, passKey(id), { version: 1, agentId: id, lastSuccessAt: at, nextRunAt: receipt.nextRunAt, updatedAt: at }, at);
    setMeta(db, receiptKey(id, runId), receipt, at);
    await traceLogger?.event?.('tiddle-pass', receipt);
    return receipt;
  } catch (error) {
    const receipt = { version: 1, ok: false, runId, agentId: id, generatedAt: at, error: String(error?.message || error) };
    appendHistory(db, { agentId: id, at, entry: { version: 1, id: `tiddle-history-${randomUUID()}`, at, runId, agentId: id, scope: null, disposition: 'failed', model: null, contextResidueCount: 0, newResidueCount: 0, cardId: null, recurrenceBefore: 0, recurrenceAfter: 0, titleBefore: null, titleAfter: null, summaryBefore: null, summaryAfter: null, reason: receipt.error, sourceRefs: [] } });
    setMeta(db, receiptKey(id, runId), receipt, at);
    await traceLogger?.event?.('tiddle-pass', receipt);
    return receipt;
  } finally { db.close(); }
}

export function listTiddleCards({ agentId, scope = null, databasePath = null, limit = 100, at = iso() } = {}) {
  const id = text(agentId);
  if (!id) throw new Error('tiddle_agent_required');
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try {
    const keys = scope ? [cardKey(id, text(scope))] : db.prepare('SELECT key FROM settings_meta WHERE key LIKE ?').all(`rolling-continuity:${id}:%`).map((row) => row.key);
    const cards = keys.flatMap((key) => (meta(db, key, { cards: [] })?.cards || [])).filter((card) => !card.expiresAt || card.expiresAt >= at).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))).slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
    return { ok: true, agentId: id, scope: text(scope) || null, cards };
  } finally { db.close(); }
}

export function tiddleHistory({ agentId, cardId = null, since = null, limit = 100, databasePath = null } = {}) {
  const id = text(agentId);
  if (!id) throw new Error('tiddle_agent_required');
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try {
    const entries = (meta(db, historyKey(id), { entries: [] })?.entries || []).filter((entry) => (!text(cardId) || entry.cardId === text(cardId)) && (!text(since) || entry.at >= text(since))).slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
    return { ok: true, agentId: id, cardId: text(cardId) || null, entries };
  } finally { db.close(); }
}

export function tiddleStatus({ agentId, databasePath = null, limit = 10 } = {}) {
  const id = text(agentId);
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try {
    const state = id ? meta(db, passKey(id), null) : null;
    const rows = id
      ? db.prepare('SELECT value_json FROM settings_meta WHERE key LIKE ? ORDER BY updated_at DESC LIMIT ?').all(`tiddle-pass-receipt:${id}:%`, Math.max(1, Math.min(100, Number(limit) || 10)))
      : db.prepare("SELECT value_json FROM settings_meta WHERE key LIKE 'tiddle-pass-receipt:%' ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(100, Number(limit) || 10)));
    const selection = readCuratorSelection({ databasePath: databasePath || settingsDatabasePath(), root: curatorRoot() });
    return { ok: true, agentId: id || null, cadenceHours: 4, lookbackHours: 24, cardTtlDays: 30, temperature: selection?.temperature ?? 0, state, receipts: rows.map((row) => parse(row.value_json, {})) };
  } finally { db.close(); }
}

export function listDueTiddlePasses({ databasePath = null, at = iso() } = {}) {
  const agents = new AgentRegistryStore({ databasePath });
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try { return agents.list({ includeDisabled: false }).filter((agent) => { const state = meta(db, passKey(agent.id), {}); return !state.nextRunAt || state.nextRunAt <= at; }); }
  finally { db.close(); agents.close(); }
}

export function createTiddleScheduler({ databasePath = null, intervalMs = 60_000, clock = iso, runtimeRoot = null } = {}) {
  let timer = null; let ticking = false;
  async function tick() { if (ticking) return []; ticking = true; try { const at = clock(); const due = listDueTiddlePasses({ databasePath, at }); return Promise.all(due.map(async (agent) => { const pass = await runTiddlePass({ agentId: agent.id, databasePath, runtimeRoot, at }); const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() }); let last; try { last = meta(db, synthesisKey(agent.id), {})?.lastSuccessAt; } finally { db.close(); } const nightly = (!last || new Date(last).toISOString().slice(0, 10) !== new Date(at).toISOString().slice(0, 10)); if (nightly) await runTiddleSynthesis({ agentId: agent.id, databasePath, runtimeRoot, at }); return pass; })); } finally { ticking = false; } }
  function start() { if (!timer) { timer = setInterval(() => { void tick(); }, intervalMs); timer.unref?.(); } return tick(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { start, stop, tick };
}
