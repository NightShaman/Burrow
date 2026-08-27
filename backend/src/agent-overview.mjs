export const MAX_OVERVIEW_CHILD_CONTEXTS = 12;

export function normalizeOverviewBody(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('request_body_object_required'), { statusCode: 400 });
  if (body.sessions === undefined) return body;
  if (!body.sessions || typeof body.sessions !== 'object' || Array.isArray(body.sessions)) throw Object.assign(new Error('sessions_invalid'), { statusCode: 400 });
  const entries = Object.entries(body.sessions);
  if (entries.some(([agentId, sessionId]) => !agentId.trim() || typeof sessionId !== 'string' || !sessionId.trim())) throw Object.assign(new Error('sessions_invalid'), { statusCode: 400 });
  body.sessions = Object.fromEntries(entries.map(([agentId, sessionId]) => [agentId.trim(), sessionId.trim()]));
  return body;
}

export function overviewSessionIds(parentSessionId, childSessionIds = []) {
  const all = [...new Set([parentSessionId, ...childSessionIds].filter(Boolean))];
  const hydrated = all.slice(0, MAX_OVERVIEW_CHILD_CONTEXTS + 1);
  return { all, hydrated, truncated: hydrated.length < all.length };
}
