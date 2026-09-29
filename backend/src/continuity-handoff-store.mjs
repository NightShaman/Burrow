const DEFAULT_TTL_DAYS = 14;
function text(value) { return String(value ?? '').trim(); }
function bounded(value, limit) { const source = text(value); return source.length <= limit ? source : source.slice(0, limit).trim(); }

export { publicRecord } from './postgres-continuity-handoff-store.mjs';

/** Legacy entry points cannot reopen local storage; inject the PostgreSQL store. */
export class ContinuityHandoffStore {
  constructor() { throw new Error('continuity_handoff_postgres_store_required'); }
}

export function listContinuityHandoffs() {
  throw new Error('continuity_handoff_postgres_store_required');
}

export function buildContinuityHandoff({ agentId, sessionId, runId, message = '', answerText = '', toolResults = [], curated = null } = {}) {
  const user = text(message);
  const answer = text(answerText);
  const successful = (Array.isArray(toolResults) ? toolResults : []).filter((result) => result?.ok === true);
  // This is support context rather than durable memory. Avoid replacing useful
  // handoffs with greetings or acknowledgements, but retain substantive
  // non-tool conversations such as planning and troubleshooting.
  if (!user || !answer || (!successful.length && user.length + answer.length < 240)) return null;
  const actions = successful.slice(0, 6).map((result) => text(result.tool || result.label || 'tool')).filter(Boolean);
  return {
    id: `continuity:${text(agentId)}:${text(sessionId)}`,
    agentId, sessionId, runId, source: 'runtime',
    title: bounded(curated?.title || user.replace(/\s+/g, ' '), 180),
    content: curated?.content
      ? `User goal/request:\n${user}\n\nHandoff:\n${text(curated.content)}`
      : `User goal/request:\n${user}\n\nLatest outcome:\n${answer}`,
    sourceRefs: [`session:${text(sessionId)}`, `run:${text(runId)}`],
    evidenceSummary: actions.length ? `Successful runtime actions: ${[...new Set(actions)].join(', ')}` : 'Conversation-backed continuity; verify live state before relying on claims.',
    ttlDays: DEFAULT_TTL_DAYS,
  };
}
