import { createHash } from 'node:crypto';
import { contextSessionId } from './model-context-boundary.mjs';
import { conversationAuthority } from './conversation-authority.mjs';
import { assertModAgentAvailable } from './mod-agent-runtime.mjs';
import { chatTerminalStatus } from './chat-result-metadata.mjs';
import { projectModelFailure } from './model-recovery-projection.mjs';

const ID = /^[a-zA-Z0-9._-]{1,96}$/;
const MAX_MESSAGE = 20_000;
const MODES = new Set(['deliver', 'request_reply', 'request_reply_complete']);

// Replies share the recipient session's continuity head. Serialize only the
// nested reply execution for that session; concurrent A2A deliveries remain
// attributed transcript ingress, but cannot supersede each other's replies.
const replyQueues = new Map();
async function serializeRecipientReply({ rootDir, sessionId, operation, abortSignal = null }) {
  const key = `${String(rootDir)}:${String(sessionId)}`;
  const previous = replyQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => {
    abortSignal?.throwIfAborted();
    return operation();
  });
  replyQueues.set(key, current);
  try { return await current; }
  finally { if (replyQueues.get(key) === current) replyQueues.delete(key); }
}

// Track waits before entering either reply/session queue. This includes independent
// concurrent exchanges, not only nested calls sharing an async execution context.
// Session serialization remains intact; cyclic requests fail before transcript ingress.
const replyWaits = new Set();
function replySessionKey(rootDir, session) { return JSON.stringify([String(rootDir), session]); }
function beginReplyWait(from, to) {
  const pending = [to];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current === from) {
      throw new Error('agent_message_reply_cycle: recipient is waiting on this session; return your question or result as your final reply to the existing exchange instead of requesting another reply');
    }
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of replyWaits) if (edge.from === current) pending.push(edge.to);
  }
  const edge = { from, to };
  replyWaits.add(edge);
  return () => replyWaits.delete(edge);
}

function text(value) { return String(value ?? '').trim(); }
function agentId(value, field) {
  const id = text(value);
  if (!id || id === '.' || id === '..' || !ID.test(id)) throw new Error(`${field}_invalid`);
  return id;
}
// Both participants must opt in, including direct sends that bypass discovery.
function assertA2AParticipant(agent) {
  if (!agent?.modAgent) return;
  if (agent.enabled === false) throw new Error('mod_agent_unavailable');
  if (agent.modAgent.capabilities?.a2a !== true) throw new Error('agent_message_a2a_disabled');
  assertModAgentAvailable(agent);
}
// A turn can outlive an owner capability update. Re-resolve mod identities
// before admission/queued ingress instead of trusting a stale turn snapshot.
async function assertFreshA2AParticipant(runtime, resolveRuntime) {
  const original = runtime?.agent;
  assertA2AParticipant(original);
  if (!original?.modAgent) return runtime;
  let current;
  try { current = await resolveRuntime(runtime.agentId); } catch { throw new Error('mod_agent_unavailable'); }
  if (current?.agentId !== runtime.agentId || current.agent?.id !== runtime.agentId
      || current.agent?.modAgent?.ownerModId !== original.modAgent.ownerModId) throw new Error('mod_agent_unavailable');
  assertA2AParticipant(current.agent);
  return current;
}
function recipientReference(value) {
  // References are registry input, not path components. Validate the canonical
  // ID only after resolution so multiword and Unicode display names work too.
  const reference = text(value);
  if (!reference || reference.length > 96) throw new Error('agent_message_recipient_invalid');
  return reference;
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

async function appendAgentMessage({ conversationStore, agentId: transcriptAgentId, sessionId: targetSessionId, content, sender, senderRuntime, recipient, sourceSessionId, sourceRunId, messageMode, direction, deliveryId, replyToEntryId = null, entersPrompt = undefined, replyOutcome = null }) {
  return conversationAuthority({ store: conversationStore, agentId: transcriptAgentId }).appendTurnIfAbsent({
    sessionId: targetSessionId,
    role: 'agent',
    content,
    runId: sourceRunId,
    ...(entersPrompt === undefined ? {} : { entersPrompt }),
    metadata: { ...provenance({ sender, senderRuntime, recipient, sourceSessionId, targetSessionId, sourceRunId, messageMode, direction, replyToEntryId }), ...(replyOutcome || {}) },
  }, { idempotencyKey: `${deliveryId}:${direction}` });
}

// An agent message is a first-class, attributed transcript turn. It is not a
// user turn; attribution identifies where the message came from.
// parentTraceContext is runtime-only transport: never add it to delivery identity,
// persisted requests, transcript provenance, or model-visible content.
export async function sendAgentMessage({ conversationStore = null, senderRuntime, resolveRecipientRuntime, runRecipientReply = null, recipientAgentId, targetSessionId = null, replyTo = null, content, messageMode = 'request_reply', runId = null, sourceSessionId = null, parentTraceContext = null, abortSignal = null } = {}) {
  if (!conversationStore) throw new Error('conversation_store_required');
  const sender = agentId(senderRuntime?.agentId, 'agent_message_sender');
  assertA2AParticipant(senderRuntime?.agent);
  const requestedRecipient = recipientReference(recipientAgentId);
  const body = text(content);
  if (!body) throw new Error('agent_message_content_required');
  if (body.length > MAX_MESSAGE) throw new Error('agent_message_content_too_large');
  const resolvedMode = mode(messageMode);
  if (typeof resolveRecipientRuntime !== 'function') throw new Error('agent_message_delivery_unavailable');
  await assertFreshA2AParticipant(senderRuntime, resolveRecipientRuntime);
  const recipientRuntime = await resolveRecipientRuntime(requestedRecipient);
  if (!recipientRuntime?.agentWorkspaceRoot || !recipientRuntime?.agentId) throw new Error('agent_message_recipient_unavailable');
  const recipient = agentId(recipientRuntime.agentId, 'agent_message_recipient');
  if (sender === recipient) throw new Error('agent_message_self_send_forbidden');
  await assertFreshA2AParticipant(senderRuntime, resolveRecipientRuntime);
  await assertFreshA2AParticipant(recipientRuntime, resolveRecipientRuntime);
  // Only runtime-attested exchange context supplies an implicit return address.
  // Resolve agent aliases first, and never infer routes from transcript/prose.
  const implicitReplySession = replyTo?.recipientAgentId === recipient ? replyTo.sessionId : null;
  const separateInbox = recipientRuntime.agent?.contextConfig?.a2aInDefault === false;
  const incomingSession = separateInbox ? `a2a-${sender}` : 'default';
  const explicitSession = text(targetSessionId);
  const requestedSession = sessionId(explicitSession || implicitReplySession || incomingSession);
  const session = separateInbox && requestedSession === 'default' ? incomingSession : requestedSession;
  const peerInbox = separateInbox && ((!explicitSession && !implicitReplySession) || requestedSession === 'default');
  const sourceMetadata = await conversationStore.getMetadata({ agentId: sender, sessionId: sourceSessionId || 'default' });
  const source = sessionId(sourceMetadata?.contextIsolation?.historySessionId || sourceSessionId || 'default');
  const deliveryId = createHash('sha256').update(JSON.stringify([sender, recipient, source, session, runId || null, resolvedMode, body])).digest('hex');
  // A runtime-attested return is part of the original conversation, not a
  // new independent A2A ingress (even when that agent has a dedicated inbox).
  const contextBoundary = session !== implicitReplySession && session !== 'default' && recipientRuntime.agent?.contextConfig?.a2aInDefault === false
    ? { key: `a2a:${sender}:${source}:${runId || deliveryId}` } : null;
  const executionSession = contextBoundary ? contextSessionId({ agentId: recipient, historySessionId: session, key: contextBoundary.key }) : null;
  const deliveryRequest = { sender, recipient, sourceSessionId: source, targetSessionId: session, runId: runId || null, messageMode: resolvedMode, content: body };

  const deliver = async () => {
    // A queued request must not enter either transcript if its owner went away.
    abortSignal?.throwIfAborted();
    await assertFreshA2AParticipant(senderRuntime, resolveRecipientRuntime);
    await assertFreshA2AParticipant(recipientRuntime, resolveRecipientRuntime);
    abortSignal?.throwIfAborted();
    // Only automatic ingress owns peer-inbox metadata. Labels are presentation,
    // never routing keys; a display-name change cannot create another lane.
    // Materialize on contact, not on the preference toggle, and retain unrelated
    // metadata (including the existing archive/reset lifecycle).
    if (peerInbox) {
      await conversationStore.updateMetadata({ agentId: recipient, sessionId: session,
        update: metadata => ({ ...metadata, a2aPeerAgentId: sender,
          label: `A2A - ${text(senderRuntime.agent?.name) || sender}` }) });
    }
    abortSignal?.throwIfAborted();
    const recipientEntry = await appendAgentMessage({
      conversationStore, agentId: recipient, sessionId: session, content: body,
      sender, senderRuntime, recipient, sourceSessionId: source, sourceRunId: runId,
      messageMode: resolvedMode, direction: 'inbound', deliveryId,
    });
    const sourceEntry = await appendAgentMessage({
      conversationStore, agentId: sender, sessionId: source, content: body,
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
  if (typeof conversationStore.claimAgentMessageDelivery !== 'function' || typeof conversationStore.completeAgentMessageDelivery !== 'function' || typeof conversationStore.readAgentMessageDelivery !== 'function') throw new Error('agent_message_delivery_store_required');

  // Claim before recipient ingress or execution. A concurrent/restarted retry
  // observes the same durable terminal result rather than waking the recipient twice.
  const claim = await conversationStore.claimAgentMessageDelivery({ deliveryId, request: deliveryRequest });
  if (!claim.execute) {
    if (claim.status === 'completed' || claim.status === 'unowned') return claim.result;
    for (;;) {
      abortSignal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const observed = await conversationStore.readAgentMessageDelivery({ deliveryId });
      if (observed?.status === 'completed' || observed?.status === 'unowned') return observed.result;
      if (!observed) throw new Error('agent_message_delivery_claim_missing');
    }
  }

  const ownership = { deliveryId, ownerId: claim.ownerId };
  const complete = result => conversationStore.completeAgentMessageDelivery({ ...ownership, result });
  const assertOwner = () => conversationStore.assertAgentMessageDeliveryOwner?.(ownership);
  const execute = work => typeof conversationStore.executeAgentMessageDelivery === 'function'
    ? conversationStore.executeAgentMessageDelivery(ownership, work) : work();
  return execute(async () => {
    let releaseWait;
    let exchange;
    try {
      // Ingress is part of the recipient reply transaction. Appending a second
      // A2A message while the first recipient run owns this session advances the
      // transcript underneath it and makes the first terminal commit stale. Queue
      // both delivery and execution per recipient session instead.
      releaseWait = beginReplyWait(
        replySessionKey(senderRuntime.agentWorkspaceRoot, source),
        replySessionKey(recipientRuntime.agentWorkspaceRoot, session),
      );
      exchange = await serializeRecipientReply({
        rootDir: recipientRuntime.agentWorkspaceRoot,
        sessionId: session,
        abortSignal,
        operation: async () => {
          abortSignal?.throwIfAborted();
          await assertOwner();
          await assertFreshA2AParticipant(senderRuntime, resolveRecipientRuntime);
          await assertFreshA2AParticipant(recipientRuntime, resolveRecipientRuntime);
          // Reserve/rotate before ingress, never after the new inbound exists.
          if (executionSession && typeof conversationStore.prepareA2AHistory === 'function') {
            await conversationStore.prepareA2AHistory({ agentId: recipient, sessionId: session, executionSessionId: executionSession, sourceAgentId: sender, sourceSessionId: sourceSessionId || 'default', sourceRunId: runId });
          }
          const delivery = await deliver();
          abortSignal?.throwIfAborted();
          await assertOwner();
          await assertFreshA2AParticipant(senderRuntime, resolveRecipientRuntime);
          const currentRecipientRuntime = await assertFreshA2AParticipant(recipientRuntime, resolveRecipientRuntime);
          const response = await runRecipientReply({ recipientRuntime: currentRecipientRuntime, recipientSessionId: session, content: body, senderAgentId: sender, sourceSessionId: source, sourceRunId: runId, messageMode: resolvedMode, inboundEntryId: delivery.recipientEntry.id, contextBoundary, parentTraceContext, parentSignal: abortSignal });
          return { ...delivery, reply: response };
        },
      });
      const { sourceEntry, receipt, reply } = exchange;
      const replyText = text(reply?.answerText);
      if (!replyText) {
        const failed = { ...receipt, ok: false, reply: { ok: Boolean(reply?.ok), decision: reply?.decision || reply?.reply?.decision || null, error: reply?.error || reply?.reply?.error || 'agent_message_reply_empty', content: null } };
        return await complete(failed);
      }
      await assertOwner();
      // A blocked peer answer is a legitimate attributed answer. Failed, cancelled
      // and incomplete partials remain visible, but never become prompt history.
      const replyDecision = reply?.decision || null;
      const replyStatus = chatTerminalStatus({ ...reply, ok: reply?.ok !== false });
      const failedPartial = replyDecision !== 'blocked' && replyStatus !== 'completed';
      // Mirrored final answers are incoming A2A too, not an exception to the
      // sender's inbox preference. Resolve afresh: the owner may toggle mid-run.
      const replyRecipientRuntime = await resolveRecipientRuntime(sender);
      const replySession = source === 'default' && replyRecipientRuntime?.agent?.contextConfig?.a2aInDefault === false
        ? `a2a-${recipient}` : source;
      if (replySession !== source) {
        await conversationStore.updateMetadata({ agentId: sender, sessionId: replySession,
          update: metadata => ({ ...metadata, a2aPeerAgentId: recipient,
            label: `A2A - ${text(recipientRuntime.agent?.name) || recipient}` }) });
      }
      const replyEntry = await appendAgentMessage({
        conversationStore, agentId: sender, sessionId: replySession, content: replyText,
        sender: recipient, senderRuntime: recipientRuntime, recipient: sender,
        sourceSessionId: session, sourceRunId: reply?.runId || null,
        messageMode: 'reply', direction: 'inbound', deliveryId: `${deliveryId}:reply`, replyToEntryId: sourceEntry.id,
        entersPrompt: !failedPartial, replyOutcome: { decision: replyDecision, terminalStatus: replyDecision === 'blocked' ? 'blocked' : replyStatus, ...(failedPartial ? { modelFailure: projectModelFailure(reply?.modelFailure || { code: replyDecision || 'model_failed' }) } : {}) },
      });
      const result = {
        ...receipt,
        ok: reply?.ok !== false && !failedPartial && replyDecision !== 'blocked',
        reply: {
          ok: reply?.ok !== false && !failedPartial && replyDecision !== 'blocked',
          decision: reply?.decision || null,
          error: reply?.error || null,
          runId: reply.runId || null,
          entryId: replyEntry.id,
          recipientReplyEntryId: reply.recipientReplyEntryId || null,
          // This bounded reply is the explicit result of the sender's tool call,
          // so it must reach the sender's continuation as well as its transcript.
          content: replyText,
        },
      };
      const completed = await complete(result);
      if (executionSession && resolvedMode === 'request_reply_complete' && completed.ok && completed.reply?.ok) {
        await conversationStore.updateMetadata({ agentId: recipient, sessionId: executionSession,
          update: metadata => ({ ...metadata, a2aExchange: { ...metadata.a2aExchange, state: 'closed' } }) });
      }
      return completed;
    } catch (error) {
      const reply = exchange?.reply;
      const failed = {
        ...(exchange?.receipt || {}), tool: 'agent_send_message', ok: false,
        messageMode: resolvedMode, deliveryId, senderAgentId: sender, recipientAgentId: recipient,
        sourceSessionId: source, targetSessionId: session, autoExecuted: false,
        reply: { ok: false, decision: reply?.decision || null, error: error?.message || String(error),
          content: null, runId: reply?.runId || null, recipientReplyEntryId: reply?.recipientReplyEntryId || null,
          executionOutcome: reply ? 'returned' : 'unknown', retryable: false },
      };
      // If persistence acknowledged an earlier terminal result, the store returns
      // that exact winner. If it is unavailable, propagate rather than invent one.
      return await complete(failed);
    } finally { releaseWait?.(); }
  });
}
