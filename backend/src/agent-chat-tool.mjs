import { createHash } from 'node:crypto';
import { appendSessionTurnIfAbsent } from './session-store.mjs';

const ID = /^[a-zA-Z0-9._-]{1,96}$/;
const MAX_MESSAGE = 20_000;
const MODES = new Set(['deliver', 'request_reply', 'request_reply_complete']);

// Replies share the recipient session's continuity head. Serialize only the
// nested reply execution for that session; concurrent A2A deliveries remain
// attributed transcript ingress, but cannot supersede each other's replies.
const replyQueues = new Map();
async function serializeRecipientReply({ rootDir, sessionId, operation }) {
  const key = `${String(rootDir)}:${String(sessionId)}`;
  const previous = replyQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  replyQueues.set(key, current);
  try { return await current; }
  finally { if (replyQueues.get(key) === current) replyQueues.delete(key); }
}

function text(value) { return String(value ?? '').trim(); }
function agentId(value, field) {
  const id = text(value);
  if (!id || id === '.' || id === '..' || !ID.test(id)) throw new Error(`${field}_invalid`);
  return id;
}
function sessionId(value) {
  const id = text(value || 'default');
  if (!id || id.length > 120) throw new Error('agent_message_target_session_invalid');
  return id;
}
function mode(value) {
  const resolved = text(value || 'deliver');
  if (!MODES.has(resolved)) throw new Error('agent_message_mode_invalid');
  return resolved;
}
function provenance({ sender, senderRuntime, recipient, sourceSessionId, targetSessionId, sourceRunId, messageMode, direction, replyToEntryId = null }) {
  return {
    kind: 'agent-message',
    fromAgentId: sender,
    fromAgentName: senderRuntime?.agent?.name || sender,
    toAgentId: recipient,
    messageMode,
    direction,
    sourceSessionId: sourceSessionId || null,
    targetSessionId,
    sourceRunId: sourceRunId || null,
    replyToEntryId,
  };
}

async function appendAgentMessage({ rootDir, sessionId: targetSessionId, content, sender, senderRuntime, recipient, sourceSessionId, sourceRunId, messageMode, direction, deliveryId, replyToEntryId = null }) {
  return appendSessionTurnIfAbsent({ idempotencyKey: `${deliveryId}:${direction}`,
    rootDir,
    sessionId: targetSessionId,
    role: 'agent',
    content,
    runId: sourceRunId,
    metadata: provenance({ sender, senderRuntime, recipient, sourceSessionId, targetSessionId, sourceRunId, messageMode, direction, replyToEntryId }),
  });
}

// An agent message is a first-class, attributed transcript turn. It is not a
// user turn; attribution identifies where the message came from.
export async function sendAgentMessage({ senderRuntime, resolveRecipientRuntime, runRecipientReply = null, recipientAgentId, targetSessionId = 'default', content, messageMode = 'request_reply', runId = null, sourceSessionId = null } = {}) {
  const sender = agentId(senderRuntime?.agentId, 'agent_message_sender');
  const requestedRecipient = agentId(recipientAgentId, 'agent_message_recipient');
  const body = text(content);
  if (!body) throw new Error('agent_message_content_required');
  if (body.length > MAX_MESSAGE) throw new Error('agent_message_content_too_large');
  const resolvedMode = mode(messageMode);
  if (typeof resolveRecipientRuntime !== 'function') throw new Error('agent_message_delivery_unavailable');
  const recipientRuntime = await resolveRecipientRuntime(requestedRecipient);
  if (!recipientRuntime?.agentWorkspaceRoot || !recipientRuntime?.agentId) throw new Error('agent_message_recipient_unavailable');
  const recipient = agentId(recipientRuntime.agentId, 'agent_message_recipient');
  if (sender === recipient) throw new Error('agent_message_self_send_forbidden');
  const session = sessionId(targetSessionId);
  const source = sessionId(sourceSessionId || 'default');
  const deliveryId = createHash('sha256').update(JSON.stringify([sender, recipient, source, session, runId || null, resolvedMode, body])).digest('hex');

  const deliver = async () => {
    const recipientEntry = await appendAgentMessage({
      rootDir: recipientRuntime.agentWorkspaceRoot, sessionId: session, content: body,
      sender, senderRuntime, recipient, sourceSessionId: source, sourceRunId: runId,
      messageMode: resolvedMode, direction: 'inbound', deliveryId,
    });
    const sourceEntry = await appendAgentMessage({
      rootDir: senderRuntime.agentWorkspaceRoot, sessionId: source, content: body,
      sender, senderRuntime, recipient, sourceSessionId: source, sourceRunId: runId,
      messageMode: resolvedMode, direction: 'outbound', deliveryId, replyToEntryId: recipientEntry.id,
    });
    return {
      recipientEntry,
      sourceEntry,
      receipt: {
        tool: 'agent_send_message', ok: true, messageMode: resolvedMode,
        deliveryId, senderAgentId: sender, recipientAgentId: recipient, sourceSessionId: source, targetSessionId: session,
        sourceEntryId: sourceEntry.id, recipientEntryId: recipientEntry.id, deliveredAt: recipientEntry.ts,
        autoExecuted: false,
      },
    };
  };
  if (!['request_reply', 'request_reply_complete'].includes(resolvedMode)) return (await deliver()).receipt;
  if (typeof runRecipientReply !== 'function') throw new Error('agent_message_reply_unavailable');

  // Ingress is part of the recipient reply transaction. Appending a second
  // A2A message while the first recipient run owns this session advances the
  // transcript underneath it and makes the first terminal commit stale. Queue
  // both delivery and execution per recipient session instead.
  const { recipientEntry, sourceEntry, receipt, reply } = await serializeRecipientReply({
    rootDir: recipientRuntime.agentWorkspaceRoot,
    sessionId: session,
    operation: async () => {
      const delivery = await deliver();
      const response = await runRecipientReply({ recipientRuntime, recipientSessionId: session, content: body, senderAgentId: sender, sourceSessionId: source, sourceRunId: runId, inboundEntryId: delivery.recipientEntry.id });
      return { ...delivery, reply: response };
    },
  });
  const replyText = text(reply?.answerText);
  if (!replyText) return { ...receipt, reply: { ok: false, error: reply?.error || 'agent_message_reply_empty' } };
  const replyEntry = await appendAgentMessage({
    rootDir: senderRuntime.agentWorkspaceRoot, sessionId: source, content: replyText,
    sender: recipient, senderRuntime: recipientRuntime, recipient: sender,
    sourceSessionId: session, sourceRunId: reply?.runId || null,
    messageMode: 'reply', direction: 'inbound', deliveryId: `${deliveryId}:reply`, replyToEntryId: sourceEntry.id,
  });
  return {
    ...receipt,
    reply: {
      ok: true,
      runId: reply.runId || null,
      entryId: replyEntry.id,
      recipientReplyEntryId: reply.recipientReplyEntryId || null,
      // This bounded reply is the explicit result of the sender's tool call,
      // so it must reach the sender's continuation as well as its transcript.
      content: replyText,
    },
  };
}
