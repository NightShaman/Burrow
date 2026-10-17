const SUMMARY_FIELDS = Object.freeze([
  'sessionId',
  'kind',
  'chatType',
  'archived',
  'createdAt',
  'updatedAt',
  'archivedAt',
  'completedAt',
  'resetAt',
  'turnCount',
  'chatTurnCount',
  'lastRole',
  'lastRunId',
  'parentSessionId',
  'ownerTaskId',
]);

export function runtimeDiagnosticSessionSummary(session = {}) {
  const summary = {};
  for (const field of SUMMARY_FIELDS) {
    if (session[field] !== undefined) summary[field] = session[field];
  }
  summary.id = String(session.sessionId || session.id || '');
  return summary;
}

export function runtimeDiagnosticSessionSummaries(sessions = []) {
  return sessions.map(runtimeDiagnosticSessionSummary);
}
