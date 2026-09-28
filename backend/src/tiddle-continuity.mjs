import { runSync, runAsync, tiddlePersistence } from './tiddle-persistence.mjs';
import { randomUUID } from 'node:crypto';
import { AgentRegistryStore } from './agent-registry.mjs';
import { completeCurator, curatorRoot, readCuratorSelection } from './curator-runtime.mjs';
import { settingsDatabasePath } from './settings-database.mjs';
import { appendPreferenceSignal, appendPreferenceSignalAsync, normalizePreferenceSignal } from './preference-learning.mjs';

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

function* meta(db, key, fallback = null) { return (yield () => db.get(key)) ?? fallback; }
function* setMeta(db, key, value, at) { return yield () => db.set(key, value, at); }
function* activeCards(db, agentId, scope, at) {
  const value = yield* meta(db, cardKey(agentId, scope), { cards: [] });
  return (Array.isArray(value?.cards) ? value.cards : []).filter((card) => !card.expiresAt || card.expiresAt >= at);
}
function* appendHistory(db, { agentId, entry, at }) {
  const current = yield* meta(db, historyKey(agentId), { version: 1, agentId, entries: [] });
  const cutoff = iso(new Date(at).getTime() - HISTORY_RETENTION_MS);
  const entries = [entry, ...(Array.isArray(current?.entries) ? current.entries : []).filter((item) => item?.at >= cutoff)];
  yield* setMeta(db, historyKey(agentId), { version: 1, agentId, entries, updatedAt: at }, at);
  return entry;
}
async function commitScopePass(db, { agentId, scope, at, entry, cardUpdate = null }) {
  return db.transaction(agentId, function* (tx) {
    const update = cardUpdate ? yield* upsertCard(tx, cardUpdate) : null;
    yield* appendHistory(tx, { agentId, at, entry: entry(update) });
    yield* setMeta(tx, scopePassKey(agentId, scope), { version: 1, agentId, scope, lastSuccessAt: at, updatedAt: at }, at);
    return update;
  });
}
function selectionIdentity(selection) { return selection ? { kind: selection.kind, connectionId: selection.connectionId || null, model: selection.model || selection.modelPath || null, temperature: selection.temperature ?? 0 } : null; }
export function parseTiddleProposal(value) {
  const source = text(value);
  const candidates = [source, ...[...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)].map((match) => typeof match === 'string' ? match : match[1])];
  for (const candidate of candidates) {
    const proposal = parse(candidate);
    const action = text(proposal?.action).toUpperCase();
    if (action === 'NOOP') return { action, reason: bounded(proposal.reason, 240) || 'no_warm_continuity', preferenceSignal: normalizePreferenceSignal(proposal.preferenceSignal) };
    if (action === 'UPSERT' && text(proposal.title) && text(proposal.summary) && (proposal.targetId === null || text(proposal.targetId))) return { action, targetId: text(proposal.targetId) || null, title: bounded(proposal.title, 240), summary: bounded(proposal.summary, 2400), reason: bounded(proposal.reason, 240) || 'persistence across the window', preferenceSignal: normalizePreferenceSignal(proposal.preferenceSignal) };
  }
  return null;
}

function residueUpdate(current, { agentId, scope, sessionId, conversationId, runId, message, answerText, toolResults = [], at }) {
    const item = {
      ref: `session:${sessionId}:run:${runId}`,
      scope: text(scope), sessionId: text(sessionId), conversationId: text(conversationId) || text(sessionId), runId: text(runId), at,
      // Residue is a bounded conversation projection, so preserve the user's and
      // assistant's words exactly. Credential material must enter through typed
      // protected tool fields rather than heuristic rewriting of ordinary prose.
      message: bounded(message, 1200), answer: bounded(answerText, 1800),
      tools: (Array.isArray(toolResults) ? toolResults : []).filter((tool) => tool?.ok === true).slice(0, 8).map((tool) => ({ tool: bounded(tool.tool, 120), path: bounded(tool.filePath || tool.path, 240) || null, command: bounded(tool.command, 240) || null })),
    };
    const cutoff = iso(new Date(at).getTime() - LOOKBACK_MS);
    const items = [item, ...(Array.isArray(current?.items) ? current.items : []).filter((entry) => entry?.at >= cutoff && entry?.ref !== item.ref)].slice(0, MAX_RESIDUE);
    return { item, value: { version: 1, agentId: text(agentId), items, updatedAt: at } };
}

export async function appendTiddleResidueAsync({ metadataStore, ...input } = {}) {
  metadataStore ||= input.stores?.metadata;
  if (!metadataStore) return appendTiddleResidue(input);
  const { agentId, scope, sessionId, runId, answerText } = input;
  if (!text(agentId) || !text(scope) || !text(sessionId) || !text(runId) || !text(answerText)) return null;
  const at = input.at || iso();
  let item;
  await metadataStore.atomicUpdate(residueKey(agentId), current => {
    const update = residueUpdate(current, { ...input, at }); item = update.item; return update.value;
  }, at);
  return item;
}

/** Cheap terminal residue only: no model call, no warm-card mutation. */
function* appendTiddleResidueOperation({ databasePath = null, stores = null, agentId, scope, sessionId, conversationId, runId, message, answerText, toolResults = [], at = iso() } = {}) {
  if (!text(agentId) || !text(scope) || !text(sessionId) || !text(runId) || !text(answerText)) return null;
  const db = tiddlePersistence({ databasePath, stores });
  try {
    const current = (yield* meta(db, residueKey(agentId), { version: 1, agentId, items: [] }));
    const { item, value } = residueUpdate(current, { agentId, scope, sessionId, conversationId, runId, message, answerText, toolResults, at });
    yield* setMeta(db, residueKey(agentId), value, at);
    return item;
  } finally { db.close(); }
}

function prompt({ agentId, scope, residue, cards }) {
  return [
    'You are Tiddle. You reconcile rolling conversational continuity on a four-hour cadence. Return JSON only; never address the user.',
    'Warm continuity means a concept persisted, resumed, or recurred across the window. A single vivid turn is not warmth. Default to NOOP.',
    'Do not create tasks, decisions, emotional/therapy notes, transcript summaries, raw tool dumps, verified external state, or instructions for the agent. This is recall metadata only.',
    'Separately, notice only a clear operator behavioral correction (especially an explicit correction). You may emit at most one preferenceSignal when grounded in this residue. It is an observation, never a profile edit. Do not infer a preference from mood, one-off task instructions, or generic conversation. Use {kind:reinforce|contradict|replace,scope,guidance,reason}.',
    'Return JSON with the normal action fields and optional preferenceSignal. Use UPSERT only when the supplied residue demonstrates a compact future-turn-relevant thread that persisted or recurred. If it is an existing concept, set targetId to that exact existing card id even if you improve its title. Set targetId:null only for a genuinely new concept. Output either {"action":"NOOP","reason":"..."} or {"action":"UPSERT","targetId":"existing-card-id-or-null","title":"...","summary":"...","reason":"..."}.',
    `Agent: ${agentId}; continuity scope: ${scope}`,
    `Existing warm cards: ${JSON.stringify(cards.map((card) => ({ id: card.id, title: card.title, summary: card.summary, recurrence: card.recurrence, lastSeen: card.lastSeen })).slice(0, 24))}`,
    `24-hour context residue (newSinceLastPass marks what arrived after the prior successful pass): ${JSON.stringify(residue.map((item) => ({ ref: item.ref, at: item.at, newSinceLastPass: item.newSinceLastPass === true, sessionId: item.sessionId, message: item.message, answer: item.answer, tools: item.tools })).slice(0, 48))}`,
  ].join('\n\n');
}
function schema() { return { oneOf: [
  { type: 'object', additionalProperties: false, required: ['action', 'reason'], properties: { action: { const: 'NOOP' }, reason: { type: 'string', minLength: 8, maxLength: 240 }, preferenceSignal: { type: 'object', additionalProperties: false, required: ['kind','scope','guidance','reason'], properties: { kind: { enum: ['reinforce','contradict','replace'] }, scope: { type: 'string', minLength: 1, maxLength: 120 }, guidance: { type: 'string', minLength: 1, maxLength: 600 }, reason: { type: 'string', minLength: 1, maxLength: 240 } } } } },
  { type: 'object', additionalProperties: false, required: ['action', 'targetId', 'title', 'summary', 'reason'], properties: { action: { const: 'UPSERT' }, targetId: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 120 }] }, title: { type: 'string', minLength: 1, maxLength: 240 }, summary: { type: 'string', minLength: 1, maxLength: 2400 }, reason: { type: 'string', minLength: 8, maxLength: 240 }, preferenceSignal: { type: 'object', additionalProperties: false, required: ['kind','scope','guidance','reason'], properties: { kind: { enum: ['reinforce','contradict','replace'] }, scope: { type: 'string', minLength: 1, maxLength: 120 }, guidance: { type: 'string', minLength: 1, maxLength: 600 }, reason: { type: 'string', minLength: 1, maxLength: 240 } } } } },
] }; }

function* synthesisCandidates(db, agentId, at) {
  const cutoff = new Date(new Date(at).getTime() - SYNTHESIS_WINDOW_MS).toISOString();
  const rows = (yield () => db.rows(`rolling-continuity:${agentId}:`)).filter(row => row.key !== globalCardKey(agentId)).sort((a,b) => a.key.localeCompare(b.key));
  return rows.flatMap(({ key, value_json }) => (parse(value_json, { cards: [] })?.cards || []).map((card) => ({ ...card, sourceScope: card.project || key.split(':').slice(2).join(':') })))
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
function* upsertGlobalCluster(db, { agentId, cluster, at }) {
  const cards = (yield* activeCards(db, agentId, GLOBAL_SCOPE, at));
  const existing = cluster.targetId ? cards.find((card) => card.id === cluster.targetId) : null;
  if (cluster.targetId && !existing) throw new Error('tiddle_global_target_invalid');
  const id = existing?.id || `warm-global:${randomUUID()}`;
  const sourceCardIds = [...new Set([...(existing?.sourceCardIds || []), ...cluster.sourceCardIds])].slice(-100);
  const scopes = [...new Set([...(existing?.scopes || []), ...cluster.scopes])];
  const card = { id, agentId, project: GLOBAL_SCOPE, title: cluster.title, summary: cluster.summary, firstSeen: existing?.firstSeen || at, lastSeen: at, recurrence: Number(existing?.recurrence || 0) + 1, sourceCardIds, scopes, confidence: cluster.confidence, evidence: 'cross-scope-synthesis', reason: bounded(cluster.reason, 240), expiresAt: iso(new Date(new Date(at).getTime() + CARD_TTL_MS)) };
  yield* setMeta(db, globalCardKey(agentId), { version: 1, agentId, project: GLOBAL_SCOPE, cards: [card, ...cards.filter((entry) => entry.id !== id)].slice(0, MAX_CARDS), updatedAt: at }, at);
  return { card, prior: existing || null };
}

export async function runTiddleSynthesis({ agentId, databasePath = null, stores = null, runtimeRoot = null, settingsKey = undefined, temperature = undefined, at = iso(), traceLogger = null } = {}) {
  const id = text(agentId); if (!id) throw new Error('tiddle_agent_required');
  const db = tiddlePersistence({ databasePath, stores });
  const runId = `tiddle-synthesis-${randomUUID()}`;
  try {
    const candidates = (await runAsync(synthesisCandidates(db, id, at))); const globals = (await runAsync(activeCards(db, id, GLOBAL_SCOPE, at)));
    if (candidates.length < 2) { const receipt = { version: 1, ok: true, runId, agentId: id, generatedAt: at, windowDays: 21, candidateCount: candidates.length, disposition: 'noop', reason: 'insufficient_candidates' }; await runAsync(setMeta(db, synthesisKey(id), { ...receipt, lastSuccessAt: at }, at)); await runAsync(setMeta(db, receiptKey(id, runId), receipt, at)); return receipt; }
    const configuredSelection = await readCuratorSelection({ stores, databasePath, root: curatorRoot({ runtimeRoot: runtimeRoot || undefined }) }); if (!configuredSelection) throw new Error('curator_selection_required');
    const selection = temperature === undefined ? configuredSelection : { ...configuredSelection, temperature };
    const completion = await completeCurator({ selection, stores, databasePath, settingsKey, root: curatorRoot({ runtimeRoot: runtimeRoot || undefined }), prompt: synthesisPrompt({ agentId: id, at, candidates, globalCards: globals }), jsonSchema: synthesisSchema(), traceLogger });
    const proposal = parseTiddleSynthesis(completion?.choice?.text); const clusters = validateSynthesisClusters(proposal, candidates, globals, at); const updates = await db.transaction(id, function* (tx) {
      const results = [];
      for (const cluster of clusters) results.push(yield* upsertGlobalCluster(tx, { agentId: id, cluster, at }));
      return results;
    });
    const receipt = { version: 1, ok: true, runId, agentId: id, generatedAt: at, windowDays: 21, candidateCount: candidates.length, clusterCount: updates.length, disposition: updates.length ? 'upserted' : 'noop', model: selectionIdentity(selection) };
    await runAsync(setMeta(db, synthesisKey(id), { ...receipt, lastSuccessAt: at }, at)); await runAsync(setMeta(db, receiptKey(id, runId), receipt, at)); await traceLogger?.event?.('tiddle-synthesis', receipt); return receipt;
  } catch (error) { const receipt = { version: 1, ok: false, runId, agentId: id, generatedAt: at, error: String(error?.message || error) }; await runAsync(setMeta(db, receiptKey(id, runId), receipt, at)); await traceLogger?.event?.('tiddle-synthesis', receipt); return receipt; }
  finally { db.close(); }
}

function* upsertCard(db, { agentId, scope, proposal, residue, at }) {
  const cards = (yield* activeCards(db, agentId, scope, at));
  const existing = proposal.targetId ? cards.find((card) => card.id === proposal.targetId) : null;
  if (proposal.targetId && !existing) throw new Error('tiddle_card_target_invalid');
  const id = existing?.id || `warm:${randomUUID()}`;
  const refs = [...new Set([...(existing?.recentRefs || []), ...residue.map((item) => item.ref)])].slice(-20);
  const card = { id, agentId, project: scope, title: proposal.title, summary: proposal.summary, firstSeen: existing?.firstSeen || at, lastSeen: at, recurrence: Number(existing?.recurrence || 0) + 1, recentRefs: refs, evidence: 'windowed-conversation', reason: proposal.reason, expiresAt: iso(new Date(at).getTime() + CARD_TTL_MS) };
  yield* setMeta(db, cardKey(agentId, scope), { version: 1, agentId, project: scope, cards: [card, ...cards.filter((entry) => entry.id !== id)].slice(0, MAX_CARDS), updatedAt: at }, at);
  return { card, prior: existing || null };
}

export async function runTiddlePass({ agentId, databasePath = null, stores = null, runtimeRoot = null, settingsKey = undefined, temperature = undefined, at = iso(), traceLogger = null } = {}) {
  const id = text(agentId);
  if (!id) throw new Error('tiddle_agent_required');
  const db = tiddlePersistence({ databasePath, stores });
  const runId = `tiddle-pass-${randomUUID()}`;
  try {
    const lookbackStart = new Date(at).getTime() - LOOKBACK_MS;
    const contextStart = iso(lookbackStart);
    const allResidue = ((await runAsync(meta(db, residueKey(id), { items: [] })))?.items || []).filter((item) => item?.at >= contextStart && item?.at <= at);
    const groups = new Map();
    for (const item of allResidue) { const group = groups.get(item.scope) || { context: [] }; group.context.push(item); groups.set(item.scope, group); }
    const scopeGroups = await Promise.all([...groups].map(async ([scope, group]) => {
      const priorSuccess = Date.parse((await runAsync(meta(db, scopePassKey(id, scope), {})))?.lastSuccessAt || '');
      const newResidueStart = iso(Number.isFinite(priorSuccess) ? priorSuccess : lookbackStart);
      return [scope, { ...group, newRefs: new Set(group.context.filter((item) => item.at >= newResidueStart).map((item) => item.ref)) }];
    }));
    const newResidueCount = scopeGroups.reduce((count, [, group]) => count + group.newRefs.size, 0);
    const outcomes = [];
    if (!newResidueCount) {
      const receipt = { version: 1, ok: true, runId, agentId: id, generatedAt: at, contextWindowStart: contextStart, windowHours: 24, passHours: 4, scopes: outcomes, residueCount: 0, disposition: 'no_residue', nextRunAt: iso(new Date(at).getTime() + PASS_INTERVAL_MS) };
      await runAsync(appendHistory(db, { agentId: id, at, entry: { version: 1, id: `tiddle-history-${randomUUID()}`, at, runId, agentId: id, scope: null, disposition: 'no_residue', model: null, contextResidueCount: 0, newResidueCount: 0, cardId: null, recurrenceBefore: 0, recurrenceAfter: 0, titleBefore: null, titleAfter: null, summaryBefore: null, summaryAfter: null, reason: 'no_new_residue', sourceRefs: [] } }));
      await runAsync(setMeta(db, passKey(id), { version: 1, agentId: id, lastSuccessAt: at, nextRunAt: receipt.nextRunAt, updatedAt: at }, at));
      await runAsync(setMeta(db, receiptKey(id, runId), receipt, at));
      await traceLogger?.event?.('tiddle-pass', receipt);
      return receipt;
    }
    const configuredSelection = await readCuratorSelection({ stores, databasePath, root: curatorRoot({ runtimeRoot: runtimeRoot || undefined }) });
    if (!configuredSelection) throw new Error('curator_selection_required');
    const selection = temperature === undefined ? configuredSelection : { ...configuredSelection, temperature };
    for (const [scope, group] of scopeGroups) {
      const { context: items, newRefs } = group;
      if (!newRefs.size) continue;
      const cards = (await runAsync(activeCards(db, id, scope, at)));
      const completion = await completeCurator({ selection, stores, databasePath, settingsKey, root: curatorRoot({ runtimeRoot: runtimeRoot || undefined }), prompt: prompt({ agentId: id, scope, residue: items.map((item) => ({ ...item, newSinceLastPass: newRefs.has(item.ref) })), cards }), jsonSchema: schema(), traceLogger });
      const proposal = parseTiddleProposal(completion?.choice?.text);
      const observedPreference = proposal?.preferenceSignal ? await (stores?.metadata ? appendPreferenceSignalAsync({ metadataStore: stores.metadata, agentId: id, signal: { ...proposal.preferenceSignal, sourceRefs: [...newRefs] }, at }) : appendPreferenceSignal({ databasePath, agentId: id, signal: { ...proposal.preferenceSignal, sourceRefs: [...newRefs] }, at })) : null;
      const cardUpdate = proposal?.action === 'UPSERT' ? { agentId: id, scope, proposal, residue: items, at } : null;
      const update = await commitScopePass(db, { agentId: id, scope, at, cardUpdate, entry: (cardUpdateResult) => {
        const card = cardUpdateResult?.card || null;
        const prior = cardUpdateResult?.prior || null;
        const disposition = card ? (prior ? 'updated' : 'created') : 'noop';
        return { version: 1, id: `tiddle-history-${randomUUID()}`, at, runId, agentId: id, scope, disposition, model: selectionIdentity(selection), contextResidueCount: items.length, newResidueCount: newRefs.size, cardId: card?.id || null, recurrenceBefore: prior?.recurrence || 0, recurrenceAfter: card?.recurrence || 0, titleBefore: prior?.title || null, titleAfter: card?.title || null, summaryBefore: prior?.summary || null, summaryAfter: card?.summary || null, reason: proposal?.reason || null, sourceRefs: card ? card.recentRefs : [...newRefs].slice(-20) };
      } });
      const card = update?.card || null;
      const disposition = card ? (update.prior ? 'updated' : 'created') : 'noop';
      outcomes.push({ scope, contextResidueCount: items.length, newResidueCount: newRefs.size, disposition, preferenceSignal: observedPreference ? { id: observedPreference.id, scope: observedPreference.scope } : null, card: card ? { id: card.id, title: card.title, recurrence: card.recurrence } : null });
    }
    const receipt = { version: 1, ok: true, runId, agentId: id, generatedAt: at, contextWindowStart: contextStart, windowHours: 24, passHours: 4, model: selectionIdentity(selection), scopes: outcomes, residueCount: newResidueCount, nextRunAt: iso(new Date(at).getTime() + PASS_INTERVAL_MS) };
    await runAsync(setMeta(db, passKey(id), { version: 1, agentId: id, lastSuccessAt: at, nextRunAt: receipt.nextRunAt, updatedAt: at }, at));
    await runAsync(setMeta(db, receiptKey(id, runId), receipt, at));
    await traceLogger?.event?.('tiddle-pass', receipt);
    return receipt;
  } catch (error) {
    const receipt = { version: 1, ok: false, runId, agentId: id, generatedAt: at, error: String(error?.message || error) };
    await runAsync(appendHistory(db, { agentId: id, at, entry: { version: 1, id: `tiddle-history-${randomUUID()}`, at, runId, agentId: id, scope: null, disposition: 'failed', model: null, contextResidueCount: 0, newResidueCount: 0, cardId: null, recurrenceBefore: 0, recurrenceAfter: 0, titleBefore: null, titleAfter: null, summaryBefore: null, summaryAfter: null, reason: receipt.error, sourceRefs: [] } }));
    await runAsync(setMeta(db, receiptKey(id, runId), receipt, at));
    await traceLogger?.event?.('tiddle-pass', receipt);
    return receipt;
  } finally { db.close(); }
}

function* listTiddleCardsOperation({ agentId, scope = null, databasePath = null, stores = null, limit = 100, at = iso() } = {}) {
  const id = text(agentId);
  if (!id) throw new Error('tiddle_agent_required');
  const db = tiddlePersistence({ databasePath, stores });
  try {
    const keys = scope ? [cardKey(id, text(scope))] : (yield () => db.rows(`rolling-continuity:${id}:`)).map((row) => row.key);
    const allCards = []; for (const key of keys) allCards.push(...((yield* meta(db, key, { cards: [] }))?.cards || []));
    const cards = allCards.filter((card) => !card.expiresAt || card.expiresAt >= at).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))).slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
    return { ok: true, agentId: id, scope: text(scope) || null, cards };
  } finally { db.close(); }
}

function* tiddleHistoryOperation({ agentId, cardId = null, since = null, limit = 100, databasePath = null, stores = null } = {}) {
  const id = text(agentId);
  if (!id) throw new Error('tiddle_agent_required');
  const db = tiddlePersistence({ databasePath, stores });
  try {
    const entries = ((yield* meta(db, historyKey(id), { entries: [] }))?.entries || []).filter((entry) => (!text(cardId) || entry.cardId === text(cardId)) && (!text(since) || entry.at >= text(since))).slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
    return { ok: true, agentId: id, cardId: text(cardId) || null, entries };
  } finally { db.close(); }
}

function* tiddleStatusOperation({ agentId, databasePath = null, stores = null, limit = 10 } = {}) {
  const id = text(agentId);
  const db = tiddlePersistence({ databasePath, stores });
  try {
    const state = id ? (yield* meta(db, passKey(id), null)) : null;
    const rows = (yield () => db.rows(id ? `tiddle-pass-receipt:${id}:` : 'tiddle-pass-receipt:')).slice(0, Math.max(1, Math.min(100, Number(limit) || 10)));
    const selection = yield () => readCuratorSelection({ stores, databasePath: databasePath || settingsDatabasePath(), root: curatorRoot() });
    return { ok: true, agentId: id || null, cadenceHours: 4, lookbackHours: 24, cardTtlDays: 30, temperature: selection?.temperature ?? 0, state, receipts: rows.map((row) => parse(row.value_json, {})) };
  } finally { db.close(); }
}

function* listDueTiddlePassesOperation({ databasePath = null, stores = null, at = iso() } = {}) {
  const agents = stores?.agents || new AgentRegistryStore({ databasePath });
  const db = tiddlePersistence({ databasePath, stores });
  try { const due = []; for (const agent of (yield () => agents.list({ includeDisabled: false }))) { const state = yield* meta(db, passKey(agent.id), {}); if (!state.nextRunAt || state.nextRunAt <= at) due.push(agent); } return due; }
  finally { db.close(); if (!stores?.agents) agents.close(); }
}

export function createTiddleScheduler({ databasePath = null, stores = null, intervalMs = 60_000, clock = iso, runtimeRoot = null } = {}) {
  let timer = null; let ticking = false;
  async function tick() {
    if (ticking) return [];
    ticking = true;
    try {
      const at = clock();
      const due = await listDueTiddlePasses({ databasePath, stores, at });
      // Await the batch so the reentrancy guard remains held through synthesis.
      return await Promise.all(due.map(async (agent) => {
        const options = { agentId: agent.id, databasePath, stores, runtimeRoot, at };
        const pass = await runTiddlePass(options);
        const db = tiddlePersistence({ databasePath, stores });
        let last;
        try { last = (await runAsync(meta(db, synthesisKey(agent.id), {})))?.lastSuccessAt; }
        finally { db.close(); }
        const nightly = !last || new Date(last).toISOString().slice(0, 10) !== new Date(at).toISOString().slice(0, 10);
        if (nightly) await runTiddleSynthesis(options);
        return pass;
      }));
    } finally { ticking = false; }
  }
  function start() { if (!timer) { timer = setInterval(() => { void tick(); }, intervalMs); timer.unref?.(); } return tick(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { start, stop, tick };
}

export function appendTiddleResidue(options = {}) { return options.stores?.metadata ? appendTiddleResidueAsync(options) : runSync(appendTiddleResidueOperation(options)); }

export function listTiddleCards(options = {}) { return (options.stores?.metadata ? runAsync : runSync)(listTiddleCardsOperation(options)); }

export function tiddleHistory(options = {}) { return (options.stores?.metadata ? runAsync : runSync)(tiddleHistoryOperation(options)); }

export function tiddleStatus(options = {}) { return (options.stores?.metadata ? runAsync : runSync)(tiddleStatusOperation(options)); }

export function listDueTiddlePasses(options = {}) { return (options.stores?.metadata ? runAsync : runSync)(listDueTiddlePassesOperation(options)); }

export function upsertTiddleCard(db, input) {
  return runSync(upsertCard({ get: key => parse(db.prepare('SELECT value_json FROM settings_meta WHERE key=?').get(key)?.value_json), set: (key,value,at) => db.prepare('INSERT INTO settings_meta(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').run(key,JSON.stringify(value),at) }, input));
}
