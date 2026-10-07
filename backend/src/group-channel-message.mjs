import { readGroupChannel, appendGroupChannelTurn, readGroupChannelTurns } from './group-channel-store.mjs';
import { resolveGroupMentionTargets } from './group-channel-routing.mjs';
import { createChatTurnRunId } from './chat-turn-controller.mjs';
import { persistChatAttachments } from './attachment-store.mjs';
import { attachmentSummary } from './runtime-turn-input.mjs';
export function createGroupChannelMessageStarter({ runtimeDataRoot, resolveAgentRuntime, conversationStore, stores, retentionDays, projectRoot, groupChannelRuns, groupChannelRunKey, runChatTurnFromBody }) {
  return async function startGroupChannelMessage(channelId, body = {}) {
    const rootDir = await runtimeDataRoot();
    const channel = await readGroupChannel({ rootDir, id: channelId });
    if (!channel) return { ok: false, error: 'group_channel_not_found' };
    const message = String(body.message || '').trim();
    const attachments = Array.isArray(body.attachments) ? body.attachments.map(item => ({ name: String(item?.name || 'attachment'), type: String(item?.type || item?.mimeType || 'application/octet-stream'), encoding: String(item?.encoding || 'utf8'), content: String(item?.content || '') })) : [];
    if (attachments.some(item => !item.content)) return { ok: false, error: 'attachment_content_required' };
    if (!message && !attachments.length) return { ok: false, error: 'message_required' };
    const requested = Array.isArray(body.agentIds) ? body.agentIds.map(String) : [];
    const participantProfiles = await Promise.all(channel.participantAgentIds.map(async (agentId) => {
      const runtime = await resolveAgentRuntime(agentId);
      return { id: agentId, name: runtime.agent?.name || agentId };
    }));
    const mentions = resolveGroupMentionTargets({ message, participants: participantProfiles });
    if (mentions.unknown.length) return { ok: false, error: 'group_channel_unknown_mentions', mentions: mentions.unknown };
    const mentionTargets = mentions.targets;
    const targetIds = requested.length ? requested : (mentionTargets.length ? mentionTargets : channel.participantAgentIds);
    const targets = targetIds.filter((agentId) => channel.participantAgentIds.includes(agentId));
    if (!targets.length) return { ok: false, error: 'group_channel_targets_required' };
    // The first routed participant owns the durable operator artifacts. Never trust
    // a client-supplied owner or filesystem reference; every recipient gets bytes.
    const owner = await resolveAgentRuntime(targets[0]);
    const persisted = await persistChatAttachments({ agentWorkspaceRoot: owner.agentWorkspaceRoot, attachments, retentionDays: await retentionDays() });
    const operatorTurn = await appendGroupChannelTurn({ rootDir, conversationStore, channelId, role: 'user', content: message, metadata: { sender: 'operator', ...(persisted.length ? { attachments: attachmentSummary(persisted), attachmentAgentId: owner.agentId } : {}), recipientAgentIds: targets, delivery: requested.length || mentionTargets.length ? 'targeted' : 'broadcast', mentions: mentions.mentions } });
    const room = await readGroupChannelTurns({ rootDir, conversationStore, channelId, limit: 500 });
    const launches = await Promise.all(targets.map(async (agentId) => {
      const agentRuntime = await resolveAgentRuntime(agentId);
      const sessionId = `group-${channelId}`;
      const runId = createChatTurnRunId({ sessionId, prefix: `group-${agentId}` });
      const controller = new AbortController();
      const record = { channelId, agentId, runId, sessionId, controller, startedAt: new Date().toISOString(), phase: 'thinking', cancelled: false, reason: null };
      groupChannelRuns.set(groupChannelRunKey(channelId, agentId, runId), record);
      // Each participant gets its own runtime/session and therefore its own
      // identity, tools, memory scope, and continuity head. The shared channel
      // is only a visible operator transcript.
      void runChatTurnFromBody({
        attachmentInput: attachments,
        body: { message: message || 'Please analyze the attached files.', attachments, sessionId, runId, abortSignal: controller.signal }, rootDir: projectRoot, agentRuntime, stores, resolveAgentRuntime,
        groupChannelContext: { channelId, channelName: channel.name, turns: room?.turns || [] },
      }).then(async (result) => {
        if (!controller.signal.aborted && (result?.answerText || result?.assistantTurn?.metadata?.outputArtifacts?.length)) await appendGroupChannelTurn({ rootDir, conversationStore, channelId, role: 'agent', content: result.answerText || '', runId, metadata: { attachmentAgentId: agentId, outputArtifacts: result?.assistantTurn?.metadata?.outputArtifacts || [], fromAgentId: agentId, fromAgentName: agentRuntime.agent?.name || agentId, recipient: 'group', participantSessionId: sessionId } });
      }).catch(async (error) => {
        if (!controller.signal.aborted) await appendGroupChannelTurn({ rootDir, conversationStore, channelId, role: 'agent', content: `Request failed: ${String(error?.message || error)}`, runId, metadata: { fromAgentId: agentId, fromAgentName: agentRuntime.agent?.name || agentId, recipient: 'group', participantSessionId: sessionId, failed: true } });
      }).finally(() => groupChannelRuns.delete(groupChannelRunKey(channelId, agentId, runId)));
      return { agentId, runId, sessionId };
    }));
    return { ok: true, channelId, operatorTurn, runs: launches };
  };
}
