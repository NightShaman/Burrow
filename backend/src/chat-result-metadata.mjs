import { classifyRuntimeOutcome } from './runtime-outcome.mjs';
import { projectModelFailure, projectModelRecoveryMetadata } from './model-recovery-projection.mjs';

export const CHAT_RESULT_VERSION = 2;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'superseded']);

// Terminal state is runtime-owned. Neither answer text nor a transport's HTTP
// success can establish it. Cancellation/reset decisions retain precedence.
export function chatTerminalStatus(result = {}) {
  if (result.decision === 'superseded' || result.status === 'superseded') return 'superseded';
  if (result.cancelled || result.modelFailure?.origin === 'cancelled') return 'cancelled';
  if (result.decision === 'model_failed') return 'failed';
  return classifyRuntimeOutcome(result).status;
}

export function chatResultMetadata(result = {}) {
  return { chatResultVersion: CHAT_RESULT_VERSION, terminalStatus: chatTerminalStatus(result), ...projectModelRecoveryMetadata(result) };
}

// The only legacy marker decoder. Historical producers authored these metadata
// fields alongside their wrapper; text alone is never evidence of a failure.
// This is a read projection, not a rewrite of retained conversation evidence.
export function chatTurnResultProjection(turn = {}) {
  if (turn.type !== 'message' || turn.role !== 'assistant') return { content: turn.content, metadata: {} };
  const source = turn.metadata || {};
  if (source.chatResultVersion !== undefined) {
    return { content: turn.content, metadata: {
      ...(Number.isSafeInteger(source.chatResultVersion) && source.chatResultVersion >= 2 ? { chatResultVersion: source.chatResultVersion } : {}),
      ...(source.chatResultVersion === CHAT_RESULT_VERSION && TERMINAL_STATUSES.has(source.terminalStatus) ? { terminalStatus: source.terminalStatus } : {}),
      ...projectModelRecoveryMetadata(source),
    } };
  }
  const legacyFailure = source.decision === 'model_failed' || source.kind === 'subagent-model-error';
  if (!legacyFailure) return { content: turn.content, metadata: projectModelRecoveryMetadata(source) };
  const recovery = projectModelRecoveryMetadata(source);
  recovery.modelFailure ||= projectModelFailure({ code: source.error });
  const wrapper = typeof turn.content === 'string' && /^\[model_error: [\s\S]*\]$/.test(turn.content);
  return { content: wrapper ? '' : turn.content, metadata: {
    ...chatResultMetadata({ ok: false, decision: 'model_failed', ...recovery }),
  } };
}

export function isStructuredAssistantTurn(entry) {
  return entry?.type === 'message' && entry?.role === 'assistant' && entry?.visibility === 'chat'
    && entry?.metadata?.chatResultVersion === CHAT_RESULT_VERSION && TERMINAL_STATUSES.has(entry.metadata.terminalStatus);
}
