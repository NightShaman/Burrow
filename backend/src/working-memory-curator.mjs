import { completeCurator, curatorRoot, readCuratorSelection } from './curator-runtime.mjs';
import { WorkingMemoryStore } from './working-memory-store.mjs';

const ACTIONS = new Set(['ADD', 'UPDATE', 'RESOLVE', 'SUPERSEDE', 'NOOP']);
const KINDS = new Set(['decision', 'finding', 'blocker', 'handoff', 'task']);

function text(value) { return String(value ?? '').trim(); }
function bounded(value, limit) { const source = text(value); return source.length <= limit ? source : source.slice(0, limit).trim(); }
function compactTools(results = []) {
  return (Array.isArray(results) ? results : []).filter((item) => item?.ok === true).slice(0, 8).map((item) => ({ tool: text(item.tool), filePath: text(item.filePath || item.path) || null, command: bounded(item.command, 240) || null, reason: bounded(item.reason, 240) || null, error: item.error || null }));
}

export function workingMemoryCurationCandidate({ toolResults = [] } = {}) {
  return { eligible: true, reason: 'terminal_turn', successfulTools: compactTools(toolResults) };
}


export function workingMemoryCuratorJsonSchema({ sessionId, runId, records = [] } = {}) {
  const sourceRef = `session:${text(sessionId)}:run:${text(runId)}`;
  const targetIds = [...new Set((records || []).filter((record) => record?.state === 'active').map((record) => text(record.id)).filter(Boolean))];
  const reason = { type: 'string', minLength: 12, maxLength: 240 };
  const mutationBase = (action) => ({
    type: 'object', additionalProperties: false,
    required: ['action', 'targetId', 'kind', 'title', 'content', 'sourceRefs', 'reason'],
    properties: {
      action: { const: action },
      targetId: action === 'ADD' ? { type: 'null' } : { enum: targetIds },
      kind: { enum: ['decision', 'finding', 'blocker', 'handoff', 'task'] },
      title: { type: 'string', minLength: 1, maxLength: 240 },
      content: { type: 'string', minLength: 1, maxLength: 1800 },
      sourceRefs: { type: 'array', items: { const: sourceRef }, minItems: 1, maxItems: 1 },
      reason,
    },
  });
  return {
    oneOf: [
      { type: 'object', additionalProperties: false, required: ['action', 'reason'], properties: { action: { const: 'NOOP' }, reason } },
      mutationBase('ADD'),
      ...(targetIds.length ? ['UPDATE', 'RESOLVE', 'SUPERSEDE'].map(mutationBase) : []),
    ],
  };
}

export function workingMemoryCuratorPrompt({ agentId, project, sessionId, runId, message, answerText, toolResults, records = [] } = {}) {
  return [
    'You are Tiddle, the bounded rolling conversational continuity curator. Return JSON only. Do not address the user.',
    'STM stores only continuity likely to matter on a future turn. It is not durable knowledge, a transcript mirror, raw tool dump, therapy notes, conversation summary, or verified current external state. Your default answer is NOOP.',
    'Ordinary conversation flow is NOOP: the user expressing feelings, baiting, joking, asking for advice, receiving support, or the assistant merely responding does not create STM. Topic changes and emotional beats are not tasks.',
    'Never record the assistant response strategy itself. Bad STM: "handle user frustration", "respond empathetically", "provide support", "add response to user turn", "assess emotional impact". Those are ordinary conversation flow and must be NOOP.',
    'Only ADD, UPDATE, RESOLVE, or SUPERSEDE when the completed turn creates, changes, resolves, or supersedes a compact future-turn-useful fact. Ask: would the next turn be materially worse without this record? If no, return NOOP. Do not record routine success, ordinary pushes, generic build/test success, raw tool activity, advice given, support offered, or summaries already covered by existing STM.',
    'Kinds: decision means a choice or boundary with future consequences, including choosing not to do something until a later time. Finding means a useful discovered fact; blocker means a current impediment; handoff means future handling/context. Task means explicit unfinished work with a concrete next action or owner. If there is no unfinished next action/owner, do not use task. A reminder, follow-up, verification, or unfinished action is always kind:"task", never kind:"decision". A choice such as "do not deploy until Monday" is kind:"decision".',
    'Allowed actions are exactly ADD, UPDATE, RESOLVE, SUPERSEDE, NOOP. Never create more than one proposal. You have no authority to write Brain, alter projects, alter agents, or invent evidence.',
    'For NOOP return only action and a concrete reason that mentions the actual turn facts. Do not use template or placeholder wording. For ADD return action, kind, title, content, sourceRefs, reason, and targetId:null. For UPDATE, RESOLVE, or SUPERSEDE, targetId must be an existing same-agent same-project record ID.',
    'If action is not NOOP, sourceRefs must be exactly the JSON array shown in Exact sourceRefs below. Never output placeholders such as "exact sourceRef".',
    'The examples below are decision patterns only. Never copy example titles/content into your answer. Examples are not evidence; only the User turn, Assistant terminal response, Successful tool receipt summary, and Existing same-scope active STM are evidence.',
    'Counterexamples that must be NOOP: user says "thanks" and assistant responds -> {"action":"NOOP","reason":"Courtesy exchange created no future-turn continuity."}. User insults/baits the assistant and the assistant refuses -> {"action":"NOOP","reason":"Bait/refusal did not create a future-useful fact."}. User describes distress and assistant gives supportive advice -> {"action":"NOOP","reason":"Supportive conversation did not create an explicit preference, boundary, or follow-up."}.',
    'Positive action-choice examples without copyable record text: a future-answer preference -> ADD handoff; a choice/boundary such as delaying an action until Monday -> ADD decision; an explicit reminder/follow-up/verification request -> ADD task. For any ADD, write title/content only from the current User turn and Assistant terminal response below, never from examples.',
    `Agent: ${text(agentId)}; project: ${text(project)}; session: ${text(sessionId)}; run: ${text(runId)}`,
    `Exact sourceRefs: ${JSON.stringify([`session:${text(sessionId)}:run:${text(runId)}`])}`,
    `User turn:\n${bounded(message, 1600)}`,
    `Assistant terminal response:\n${bounded(answerText, 2400)}`,
    `Successful tool receipt summary:\n${JSON.stringify(compactTools(toolResults))}`,
    `Existing same-scope active STM:\n${JSON.stringify((records || []).filter((record) => record?.agentId === agentId && record?.project === project && record?.state === 'active').slice(0, 12).map((record) => ({ id: record.id, kind: record.kind, state: record.state, title: bounded(record.title, 240), content: bounded(record.content, 1200), sourceRefs: record.sourceRefs, updatedAt: record.updatedAt, expiresAt: record.expiresAt })))}`,
  ].join('\n\n');
}

function normalizedFact(value) {
  return text(value).toLowerCase().replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim();
}
const STOP_WORDS = new Set(['the','a','an','and','or','but','to','of','in','on','for','with','without','as','is','are','was','were','be','been','being','this','that','these','those','it','its','from','by','at','into','out','up','down','new','turn','session','default','successful','successfully','receipt','summary','tool','action','actions','state','task','finding','decision','content','title','reason']);
function evidenceTokens(value) {
  return [...new Set(normalizedFact(value).split(/[^a-z0-9.:/_-]+/u).map((token) => token.trim()).filter((token) => token.length >= 4 && !STOP_WORDS.has(token)))];
}
function evidenceCorpus({ message, answerText, toolResults = [], records = [], target = null } = {}) {
  const tools = compactTools(toolResults).flatMap((tool) => [tool.tool, tool.filePath, tool.command, tool.reason, tool.error]).join(' ');
  const targetText = target ? `${target.title || ''} ${target.content || ''}` : '';
  const activeRecords = (records || []).map((record) => `${record.title || ''} ${record.content || ''}`).join(' ');
  return normalizedFact(`${message || ''} ${answerText || ''} ${tools} ${targetText} ${activeRecords}`);
}
function hasTextualGrounding({ proposal, message, answerText, toolResults, records, target }) {
  const corpus = evidenceCorpus({ message, answerText, toolResults, records, target });
  const tokens = evidenceTokens(`${proposal.title || ''} ${proposal.content || ''}`).filter((token) => !/^session:/u.test(token));
  if (!tokens.length) return false;
  const hits = tokens.filter((token) => corpus.includes(token));
  if (hits.length >= Math.min(3, tokens.length)) return true;
  const title = normalizedFact(proposal.title);
  const content = normalizedFact(proposal.content);
  return Boolean((title && corpus.includes(title)) || (content && corpus.includes(content)));
}

function sameOperationalFact(a = {}, b = {}) {
  const at = normalizedFact(a.title); const bt = normalizedFact(b.title);
  const ac = normalizedFact(a.content); const bc = normalizedFact(b.content);
  if (!at || !bt) return false;
  if (at === bt) return true;
  if (ac && bc && (ac === bc || ac.includes(bc) || bc.includes(ac))) return true;
  return false;
}

function usefulReason(value) {
  const reason = bounded(value, 240);
  const normalized = reason.toLowerCase().replace(/[\s._-]+/g, ' ').trim();
  if (reason.length < 12) return null;
  if (['short reason', 'reason', 'no reason', 'n/a', 'none', 'placeholder', 'specific explanation of why stm should not change', 'concrete reason', 'actual turn facts'].includes(normalized)) return null;
  if (/^(short|brief|specific|concrete) reason\b/u.test(normalized)) return null;
  return reason;
}

export function parseWorkingMemoryCuration(value = '') {
  const source = text(value);
  const candidates = [source, ...[...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)].map((match) => typeof match === 'string' ? match : match[1]), ...[...source.matchAll(/\{\s*"action"\s*:\s*"(?:ADD|UPDATE|RESOLVE|SUPERSEDE|NOOP)"[\s\S]*?\}/giu)].map((match) => match[0])];
  let proposal = null;
  for (const candidate of candidates) {
    try { proposal = JSON.parse(text(candidate)); break; } catch {}
  }
  const action = text(proposal?.action).toUpperCase();
  if (!ACTIONS.has(action)) return null;
  if (action === 'NOOP') return { action, reason: usefulReason(proposal.reason) || bounded(proposal.reason, 240) || 'no_operational_change' };
  return {
    action,
    targetId: text(proposal.targetId) || null,
    kind: text(proposal.kind),
    title: bounded(proposal.title, 240),
    content: bounded(proposal.content, 1800),
    sourceRefs: Array.isArray(proposal.sourceRefs) ? proposal.sourceRefs.map(text).filter(Boolean).slice(0, 4) : [],
    reason: usefulReason(proposal.reason),
  };
}

export function validateWorkingMemoryCuration({ proposal, agentId, project, sessionId, runId, message = '', answerText = '', toolResults = [], records = [] } = {}) {
  if (!proposal) return { ok: false, error: 'curation_proposal_invalid' };
  if (proposal.action === 'NOOP') return usefulReason(proposal.reason) ? { ok: true, disposition: 'noop', proposal } : { ok: false, error: 'curation_reason_invalid' };
  const expectedSource = `session:${text(sessionId)}:run:${text(runId)}`;
  if (!text(agentId) || !text(project)) return { ok: false, error: 'curation_scope_unavailable' };
  if (proposal.sourceRefs.length !== 1 || proposal.sourceRefs[0] !== expectedSource) return { ok: false, error: 'curation_source_ref_invalid' };
  if (!KINDS.has(proposal.kind) || !proposal.title || !proposal.content || !usefulReason(proposal.reason)) return { ok: false, error: 'curation_content_invalid' };
  const target = proposal.targetId ? records.find((record) => record.id === proposal.targetId && record.agentId === agentId && record.project === project) : null;
  if (proposal.action === 'ADD') {
    if (proposal.targetId) return { ok: false, error: 'curation_add_target_forbidden' };
    if (!hasTextualGrounding({ proposal, message, answerText, toolResults, records })) return { ok: false, error: 'curation_evidence_ungrounded' };
    const duplicate = records.find((record) => record.agentId === agentId && record.project === project && record.state === 'active' && sameOperationalFact(record, proposal));
    return duplicate ? { ok: true, disposition: 'recurrence', proposal, target: duplicate } : { ok: true, disposition: 'candidate', proposal };
  }
  if (!target) return { ok: false, error: 'curation_target_invalid' };
  if (!hasTextualGrounding({ proposal, message, answerText, toolResults, records, target })) return { ok: false, error: 'curation_evidence_ungrounded' };
  return { ok: true, disposition: proposal.action.toLowerCase(), proposal, target };
}

export async function curateWorkingMemory({ databasePath, runtimeRoot = null, agentId, project, sessionId, conversationId, runId, message, answerText, toolResults, traceLogger = null } = {}) {
  const candidate = workingMemoryCurationCandidate({ toolResults });
  if (!text(agentId) || !text(project) || !text(conversationId) || !text(sessionId) || !text(runId)) {
    const result = { attempted: false, ...candidate, disposition: 'not_attempted', reason: 'curation_scope_unavailable' };
    await traceLogger?.event?.('working-memory-curation', { attempted: false, candidate: candidate.reason, disposition: result.disposition, reason: result.reason });
    return result;
  }
  const root = curatorRoot({ runtimeRoot: runtimeRoot || undefined });
  let selection = null;
  try { selection = readCuratorSelection({ databasePath, root }); }
  catch (error) {
    const result = { attempted: false, ...candidate, disposition: 'not_attempted', reason: 'curator_selection_unavailable', error: String(error?.message || error) };
    await traceLogger?.event?.('working-memory-curation', { attempted: false, candidate: candidate.reason, disposition: result.disposition, reason: result.reason, error: result.error });
    return result;
  }
  if (!selection) {
    const result = { attempted: false, ...candidate, disposition: 'not_attempted', reason: 'curator_selection_required' };
    await traceLogger?.event?.('working-memory-curation', { attempted: false, candidate: candidate.reason, disposition: result.disposition, reason: result.reason });
    return result;
  }
  const store = new WorkingMemoryStore({ databasePath });
  try {
    const safeToolResults = Array.isArray(toolResults) ? toolResults : [];
    const records = store.list({ agentId, project, includeInactive: true, limit: 24 });
    const prompt = workingMemoryCuratorPrompt({ agentId, project, sessionId, runId, message, answerText, toolResults, records });
    const completion = await completeCurator({ selection, databasePath, root, prompt, jsonSchema: workingMemoryCuratorJsonSchema({ sessionId, runId, records }), traceLogger });
    const proposal = parseWorkingMemoryCuration(completion?.choice?.text);
    const validation = validateWorkingMemoryCuration({ proposal, agentId, project, sessionId, runId, message, answerText, toolResults, records });
    if (!validation.ok || validation.disposition === 'noop') {
      const result = { attempted: true, ...candidate, proposal, validation, disposition: validation.disposition || 'rejected', record: null, rollingCard: null };
      await traceLogger?.event?.('working-memory-curation', { attempted: true, source: completion.implementation, model: selection.kind === 'external' ? selection.model : selection.modelPath, candidate: candidate.reason, disposition: result.disposition, reason: validation.error || proposal?.reason || null });
      return result;
    }
    const sourceRefs = [...new Set([...(validation.target?.sourceRefs || []), ...proposal.sourceRefs])].slice(-12);
    const rollingCard = store.upsertRollingContinuityCard({
      agentId,
      project,
      title: proposal.title,
      content: proposal.content,
      sourceRefs,
      evidence: safeToolResults.length ? 'tool-backed' : 'conversation-backed',
      reason: validation.disposition === 'recurrence' ? `Tiddle signal: recurring ${proposal.kind} matched ${validation.target.id}.` : `Curator candidate captured as rolling continuity, not active task state.`,
    });
    await traceLogger?.event?.('working-memory-curation', { attempted: true, source: completion.implementation, model: selection.kind === 'external' ? selection.model : selection.modelPath, candidate: candidate.reason, disposition: validation.disposition, proposal: { action: proposal.action, targetId: proposal.targetId, kind: proposal.kind, sourceRefs: proposal.sourceRefs }, rollingCard: { id: rollingCard.id, title: rollingCard.title, recurrence: rollingCard.recurrence, project: rollingCard.project } });
    return { attempted: true, ...candidate, proposal, validation, disposition: validation.disposition, record: null, rollingCard };
  } catch (error) {
    await traceLogger?.event?.('working-memory-curation', { attempted: true, source: 'curator-runtime', error: String(error?.message || error) });
    return { attempted: true, ...candidate, disposition: 'failed', error: String(error?.message || error), record: null };
  } finally { store.close(); }
}
