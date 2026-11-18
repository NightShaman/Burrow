import { listSessionAttachments } from './attachment-store.mjs';
import { runtimeHostContext } from './runtime-prompt-context.mjs';

// No model-selected agent, session, host or path. Inspect the same admitted
// execution environment and attachment namespace the turn already uses.
export async function inspectRuntimeContext({ section, executionContext, agentId, sessionId, conversationStore, agentRuntime, signal } = {}) {
  const tool = 'runtime_context_inspect';
  signal?.throwIfAborted();
  if (section === 'environment') {
    const runtime = executionContext?.agentRuntime || agentRuntime;
    const uiTarget = runtime?.contextConfig?.uiTarget || runtime?.agent?.contextConfig?.uiTarget;
    const host = await runtimeHostContext(executionContext);
    signal?.throwIfAborted();
    return { tool, ok: true, section, environment: { ...host,
      workspaceRoot: executionContext?.workspaceRoot || null,
      uiTarget: uiTarget?.url ? { url: uiTarget.url, label: uiTarget.label || null } : null,
    } };
  }
  if (section === 'attachments') {
    const agentWorkspaceRoot = executionContext?.agentWorkspaceRoot;
    if (!(agentId && sessionId && agentWorkspaceRoot && conversationStore?.exportTranscript)) return { tool, ok: false, section, error: 'attachment_scope_unavailable' };
    const transcript = await conversationStore.exportTranscript({ agentId, sessionId });
    signal?.throwIfAborted();
    // Match the existing session attachment listing (including compacted, but
    // not reset, history). No filesystem scan or byte payload in this result.
    const entries = (transcript?.entries || []).filter(entry => entry?.metadata?.lane !== 'side_question');
    const attachments = await listSessionAttachments({ agentWorkspaceRoot, sessionTurns: entries, sessionId, limit: 24 });
    signal?.throwIfAborted();
    return { tool, ok: true, section, references: attachments.map(({ artifactPath, ...item }) => item) };
  }
  return { tool, ok: false, error: 'runtime_context_section_invalid' };
}
