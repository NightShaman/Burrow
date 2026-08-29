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
    tail.unshift({ role: message.role, content, ts: message.ts || null, runId: message.runId || null });
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
  const latestUser = [...(Array.isArray(transcript) ? transcript : [])].reverse().find((entry) => entry?.role === 'user' && boundedText(entry.content, 2_000));
  if (!objective || !latestUser) {
    return { action: 'needs_user_input', autoResume: false, reason: 'missing_reliable_user_objective', transcriptMessages: transcript.length };
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
