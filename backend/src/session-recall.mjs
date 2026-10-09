// Historical evidence is retrieved only through explicit session_search calls.
// Keep this compatibility helper inert so legacy callers cannot auto-retrieve.
export function sessionRecallPlan({ sessionId = 'default' } = {}) {
  return { shouldRecall: false, reason: 'automatic_recall_disabled', query: null,
    scope: 'agent_sessions', sessionId: String(sessionId || 'default'), cues: [] };
}

export async function recallPriorSessionEvidence(options = {}) {
  return { ...sessionRecallPlan(options), used: false, count: 0, results: [] };
}
