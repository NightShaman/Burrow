import { searchAgentSessionEvidence } from './session-search.mjs';

const PRIOR_CONTEXT_CUES = [
  /\b(?:we|you|i) (?:already )?(?:discussed|decided|agreed|planned|worked on|implemented|changed)\b/iu,
  /\b(?:earlier|before|previous(?:ly)?|prior|last (?:time|session)|yesterday)\b/iu,
  /\b(?:continue|resume|pick up|keep going|go ahead|start (?:there|with|phase))\b/iu,
  /\b(?:that|it|the same) (?:thing|decision|plan|work|issue|task|approach)\b/iu,
  /\b(?:what did we|do you) (?:decide|agree|say|remember)\b/iu,
  /\b(?:contradict|conflict|doesn't match|does not match)\b/iu,
];

function text(value = '') { return String(value || '').trim(); }

function terseContinuation(message = '') {
  return /^(?:ok[,.! ]*)?(?:continue|resume|pick up|keep going|go ahead|start (?:there|with(?: phase)?|phase \d+))[!. ]*$/iu.test(text(message));
}

function recallQuery(message = '') {
  const ignored = new Set(['about', 'after', 'again', 'answer', 'before', 'concisely', 'could', 'decide', 'discussed', 'earlier', 'from', 'have', 'history', 'last', 'needed', 'previous', 'prior', 'search', 'session', 'should', 'that', 'the', 'this', 'what', 'when', 'where', 'which', 'with', 'would', 'yesterday', 'you']);
  if (terseContinuation(message)) return '';
  const terms = text(message).toLowerCase().match(/[a-z0-9][a-z0-9._-]*/gu) || [];
  return terms.filter((term) => term.length >= 4 && !ignored.has(term.replace(/[._-]+$/u, ''))).at(-1)?.replace(/[._-]+$/u, '') || text(message);
}

export function sessionRecallPlan({ message = '', sessionId = 'default', priorSession = null } = {}) {
  const query = text(message);
  const cues = PRIOR_CONTEXT_CUES.filter((pattern) => pattern.test(query)).map((pattern) => pattern.source);
  // A genuine new session is a stronger continuity boundary. In an ongoing
  // conversation, the live transcript already carries normal continuity.
  const isFreshSession = !priorSession?.summary && Number(priorSession?.turnCount || 0) === 0;
  const shortContinuation = terseContinuation(query);
  const shouldRecall = Boolean(query && cues.length && (isFreshSession || shortContinuation || /\b(?:earlier|before|previous(?:ly)?|prior|last session|yesterday|what did we|do you remember|continue|resume|pick up|keep going|go ahead|start (?:there|with|phase)|contradict|conflict)\b/iu.test(query)));
  return {
    shouldRecall,
    reason: shouldRecall ? (shortContinuation ? 'terse_continuation_recovery' : 'prior_context_reference') : cues.length ? 'current_session_continuity_sufficient' : 'no_prior_context_cue',
    query: recallQuery(query) || null,
    scope: 'agent_sessions',
    sessionId: String(sessionId || 'default'),
    cues,
  };
}

export async function recallPriorSessionEvidence({ rootDir, additionalRootDirs = [], sessionId = 'default', message = '', priorSession = null, limit = 6 } = {}) {
  const plan = sessionRecallPlan({ message, sessionId, priorSession });
  if (!plan.shouldRecall) return { ...plan, used: false, count: 0, results: [] };
  const result = await searchAgentSessionEvidence({ rootDir, additionalRootDirs, sessionId, query: plan.query, scope: plan.scope, limit });
  return {
    ...plan,
    used: result.count > 0,
    count: result.count,
    totalMatches: result.totalMatches,
    searchedSessionCount: result.searchedSessionCount,
    results: result.results,
  };
}
