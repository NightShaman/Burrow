export const RECOVERY_TRANSCRIPT_MAX_MESSAGES = 20;
export const RECOVERY_TRANSCRIPT_MAX_CHARS = 256 * 1024;

function boundedText(value, limit) {
  const text = String(value || '').trim();
  return text ? text.slice(0, limit) : null;
}

export async function readRecoveryTranscriptTail({ rootDir, sessionId, readChatMessages } = {}) {
  if (typeof readChatMessages !== 'function') throw new Error('recovery_transcript_reader_required');
  const messages = await readChatMessages({ rootDir, sessionId, limit: RECOVERY_TRANSCRIPT_MAX_MESSAGES });
  let remaining = RECOVERY_TRANSCRIPT_MAX_CHARS;
  const tail = [];
  for (const message of [...messages].reverse()) {
    const content = boundedText(message?.content, remaining);
    if (!content) continue;
    tail.unshift({ role: message.role, content, ts: message.ts || null, runId: message.runId || null, metadata: message?.metadata?.kind === 'agent-message' ? { kind: 'agent-message' } : null });
    remaining -= content.length;
    if (remaining <= 0) break;
  }
  return tail;
}

// Conservative, deterministic gate. It decides whether a continuation may be
// scheduled, not whether its work is correct: reconcile-first remains a normal
// same-session runtime turn with the manifest and bounded transcript available.
export function decideInterruptedRunRecovery({ manifest = null, transcript = [] } = {}) {
  const objective = boundedText(manifest?.objective, 2_000);
  // A2A ingress is a durable attributed transcript turn, not a user turn, but
  // it is still a reliable same-session objective. Requiring a user turn here
  // stranded interrupted recipient replies and made them ask the sender for a
  // resend after every restart.
  const latestObjectiveTurn = [...(Array.isArray(transcript) ? transcript : [])].reverse().find((entry) => {
    if (!boundedText(entry?.content, 2_000)) return false;
    return entry?.role === 'user' || (entry?.role === 'agent' && entry?.metadata?.kind === 'agent-message');
  });
  if (!objective || !latestObjectiveTurn) {
    return { action: 'needs_user_input', autoResume: false, reason: 'missing_reliable_session_objective', transcriptMessages: transcript.length };
  }
  const requiresReconciliation = (Array.isArray(manifest?.pendingVerification) && manifest.pendingVerification.length > 0)
    || (Array.isArray(manifest?.changedFiles) && manifest.changedFiles.length > 0)
    || ['superseded_by_newer_session_run', 'terminal_finalization_failed', 'terminal_finalization_abandoned', 'interrupted_run_abandoned', 'process_lost'].includes(String(manifest?.reason || ''));
  if (requiresReconciliation) {
    return { action: 'reconcile_first', autoResume: true, reason: 'durable_state_may_have_changed', transcriptMessages: transcript.length };
  }
  return { action: 'resume', autoResume: true, reason: 'bounded_transcript_and_objective_available', transcriptMessages: transcript.length };
}

export async function assessInterruptedRunRecovery({ rootDir, sessionId, manifest, readChatMessages } = {}) {
  const transcript = await readRecoveryTranscriptTail({ rootDir, sessionId, readChatMessages });
  return { ...decideInterruptedRunRecovery({ manifest, transcript }), transcript };
}
