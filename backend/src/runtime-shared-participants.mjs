import { resolveSharedModContext } from './mod-agent-runtime.mjs';
import { sharedModContextMessages } from './prompt-assembler.mjs';
import { isOperatorRuntimeSource } from './runtime-provenance.mjs';

// Build the identity list for shared context from Core-owned route provenance.
// Message content and serialized request fields are deliberately absent.
export async function addressedParticipantsForSharedContext({ agentRuntime = null, incomingAgentMessage = null,
  groupChannelContext = null, runSource = null, turnSource = null, command = null, resolveAgentRuntime = null } = {}) {
  const source = runSource || turnSource || command;
  // app-runtime treats an omitted source as a direct `chat` turn. Keep the
  // routing projection aligned with that default so ordinary native runs are
  // not mistaken for background work.
  const directOperator = isOperatorRuntimeSource(source);
  const group = Boolean(groupChannelContext?.channelId && Array.isArray(groupChannelContext.participantAgentIds));
  const a2a = Boolean(incomingAgentMessage?.senderAgentId);
  const includeRecipient = directOperator || group || a2a;
  const participants = includeRecipient ? [agentRuntime].filter(Boolean) : [];
  const addResolved = async id => {
    if (typeof id !== 'string' || typeof resolveAgentRuntime !== 'function') return;
    try {
      const runtime = await resolveAgentRuntime(id);
      if (runtime?.agentId === id && runtime?.agent?.id === id) participants.push(runtime);
    } catch { /* A removed or unavailable participant has no current tags. */ }
  };
  if (a2a) await addResolved(incomingAgentMessage.senderAgentId);
  if (group) for (const id of groupChannelContext.participantAgentIds.slice(0, 32)) await addResolved(id);
  const unique = new Map(participants.map(runtime => [runtime.agentId, runtime]));
  return { participants: [...unique.values()], includeRecipient };
}

// Turn-local routing facts, never session state or model-visible tool receipts.
// Delivery admission supplies canonical identities; a failed/denied lookup does
// not activate anything. A delivered request still counts if its reply fails.
export function sharedContextContinuation({ agentRuntime, sessionId, route, resolveAgentRuntime, signal } = {}) {
  const peerIds = new Set();
  let dirty = false;
  return {
    addressed(runtime) {
      if (runtime?.agentId && runtime.agent?.id === runtime.agentId) {
        peerIds.add(runtime.agentId);
        dirty = true;
      }
    },
    async refresh() {
      if (!dirty) return null;
      const participants = new Map(route.participants.map(runtime => [runtime.agentId, runtime]));
      for (const id of peerIds) {
        try {
          const runtime = await resolveAgentRuntime(id);
          if (runtime?.agentId === id && runtime.agent?.id === id) participants.set(id, runtime);
        } catch { /* A removed peer contributes no current tags. */ }
      }
      participants.set(agentRuntime.agentId, agentRuntime);
      const shared = await resolveSharedModContext(agentRuntime, { sessionId, signal,
        addressedParticipants: [...participants.values()], outgoingRecipientIds: [...peerIds], includeRecipient: true });
      dirty = false;
      return sharedModContextMessages(shared);
    },
  };
}
