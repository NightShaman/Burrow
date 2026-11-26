// Shared interpretation of ingress labels. Unknown/background labels remain
// non-operator; explicit peer and scheduled ingress always take precedence.
const OPERATOR_SOURCES = new Set(['operator-chat', 'queue_next', 'chat', 'operator', 'task-board']);
const NON_OPERATOR_SOURCES = new Set(['scheduled', 'a2a', 'group-channel', 'workflow-event', 'mod/external', 'mod/follow-through', 'recovery']);

export function isOperatorRuntimeSource(source) {
  if (source == null || source === '') return true; // app-runtime's native chat default
  if (NON_OPERATOR_SOURCES.has(source)) return false;
  return OPERATOR_SOURCES.has(source);
}

export function isOperatorRuntimeTurn({ source = null, incomingAgentMessage = null, externalTurnMetadata = null, completionEvent = null } = {}) {
  return !incomingAgentMessage && !externalTurnMetadata && !completionEvent && isOperatorRuntimeSource(source);
}
