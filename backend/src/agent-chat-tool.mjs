import { appendSessionTurn } from './session-store.mjs';

const ID = /^[a-zA-Z0-9._-]{1,96}$/;
const MAX_MESSAGE = 20_000;
const MODES = new Set(['deliver', 'request_reply', 'request_reply_complete']);

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

async function appendAgentMessage({ rootDir, sessionId: targetSessionId, content, sender, senderRuntime, recipient, sourceSessionId, sourceRunId, messageMode, direction, replyToEntryId = null }) {
  return appendSessionTurn({
    rootDir,
    sessionId: targetSessionId,
    role: 'agent',
    content,
    runId: sourceRunId,
    metadata: provenance({ sender, senderRuntime, recipient, sourceSessionId, targetSessionId, sourceRunId, messageMode, direction, replyToEntryId }),
  });
}

// An agent message is a first-class, attributed transcript turn. It is not a
// user turn and does not grant the sender's authority to the recipient.
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

  const recipientEntry = await appendAgentMessage({
    rootDir: recipientRuntime.agentWorkspaceRoot, sessionId: session, content: body,
    sender, senderRuntime, recipient, sourceSessionId: source, sourceRunId: runId,
    messageMode: resolvedMode, direction: 'inbound',
  });
  const sourceEntry = await appendAgentMessage({
    rootDir: senderRuntime.agentWorkspaceRoot, sessionId: source, content: body,
    sender, senderRuntime, recipient, sourceSessionId: source, sourceRunId: runId,
    messageMode: resolvedMode, direction: 'outbound', replyToEntryId: recipientEntry.id,
  });
  const receipt = {
    tool: 'agent_send_message', ok: true, messageMode: resolvedMode,
    senderAgentId: sender, recipientAgentId: recipient, sourceSessionId: source, targetSessionId: session,
    sourceEntryId: sourceEntry.id, recipientEntryId: recipientEntry.id, deliveredAt: recipientEntry.ts,
    autoExecuted: false,
  };
  if (!['request_reply', 'request_reply_complete'].includes(resolvedMode)) return receipt;
  if (typeof runRecipientReply !== 'function') throw new Error('agent_message_reply_unavailable');

  const reply = await runRecipientReply({ recipientRuntime, recipientSessionId: session, content: body, senderAgentId: sender, sourceSessionId: source, sourceRunId: runId, inboundEntryId: recipientEntry.id });
  const replyText = text(reply?.answerText);
  if (!replyText) return { ...receipt, reply: { ok: false, error: reply?.error || 'agent_message_reply_empty' } };
  const replyEntry = await appendAgentMessage({
    rootDir: senderRuntime.agentWorkspaceRoot, sessionId: source, content: replyText,
    sender: recipient, senderRuntime: recipientRuntime, recipient: sender,
    sourceSessionId: session, sourceRunId: reply?.runId || null,
    messageMode: 'reply', direction: 'inbound', replyToEntryId: sourceEntry.id,
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
