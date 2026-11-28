import { conversationAuthority } from './conversation-authority.mjs';
import { buildConversationContext, isPromptChatMessage } from './conversation-context.mjs';
import { conversationProviderMessages } from './provider-messages.mjs';
import { workflowOrigin } from './workflow-follow-through-tools.mjs';
import { buildSessionEntry } from './session-entry.mjs';

// Copy conversational context into the private execution namespace, never the
// reverse. Existing context budgeting/compaction owns the imported history.
// Operator and peer roles, provider-turn provenance and source IDs survive.
export function createFollowThroughConversation({ stores, wait, signal }) {
  const conversations = stores.conversations;
  const authority = conversationAuthority({ store: conversations, agentId: wait.agentId });
  const originScope = { agentId: wait.agentId, sessionId: wait.sessionId };
  const executionScope = { agentId: wait.agentId, sessionId: wait.executionSessionId };
  const seen = new Set();
  let after = 0;
  function assertOrigin(metadata) {
    const origin = workflowOrigin(metadata, wait.sessionId);
    if (origin?.conversationId !== wait.conversationId || origin?.resetIdentity !== wait.resetIdentity) {
      throw new Error('workflow_follow_through_origin_changed');
    }
  }
  async function copy(entries, initial = false) {
    const fresh = [];
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.sequence != null) after = entry.sequence;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const retained = isPromptChatMessage(entry) || entry.type === 'provider_history'
        || (initial && (entry.type === 'context_state' || entry.metadata?.compressionSummary));
      if (!retained) continue;
      const { sequence: _sequence, ...original } = entry;
      await conversations.appendIfAbsent({ ...executionScope, idempotencyKey: `follow-through-context:${entry.id}`,
        entry: { ...original, sessionId: wait.executionSessionId, metadata: { ...entry.metadata,
          followThroughContext: { sessionId: wait.sessionId, entryId: entry.id } } } });
      fresh.push(entry);
    }
    return fresh;
  }
  async function initialize() {
    const snapshot = await authority.sessionSnapshot(wait.sessionId, { signal });
    assertOrigin(snapshot.metadata);
    await copy(snapshot.entries, true);
    assertOrigin(await authority.metadata(wait.sessionId, { signal }));
  }
  async function updates() {
    signal?.throwIfAborted();
    assertOrigin(await authority.metadata(wait.sessionId, { signal }));
    const fresh = [];
    for (;;) {
      const page = typeof conversations.page === 'function'
        ? await conversations.page({ ...originScope, after, limit: 256, signal })
        : { entries: await conversations.read({ ...originScope, after, limit: 256, signal }) };
      const entries = page.entries || [];
      const previous = after;
      fresh.push(...entries.filter(entry => !seen.has(entry.id)));
      if (entries.at(-1)?.sequence != null) after = entries.at(-1).sequence;
      if (typeof conversations.page === 'function' ? !page.hasMore : !entries.length) break;
      if (!entries.length || String(after) === String(previous)) throw new Error('conversation_store_paging_invalid');
    }
    assertOrigin(await authority.metadata(wait.sessionId, { signal }));
    const context = buildConversationContext({ transcript: fresh, limits: { rawRecentChars: Infinity, priorSummaryChars: Infinity } });
    return { entries: fresh, providerMessages: conversationProviderMessages(context).slice(0, -1) };
  }
  // Reuse the existing model-boundary drain. No prompt regex, verdict parser,
  // policy engine, polling timer, or new operator workflow is introduced.
  const steering = stores.steering && new Proxy(stores.steering, {
    get(target, property) {
      if (property === 'boundary') return async (identity, options = {}) => {
        if (identity.agentId !== wait.agentId || identity.sessionId !== wait.executionSessionId || identity.runId !== wait.executionRunId || options.finish) {
          return target.boundary(identity, options);
        }
        const { entries, providerMessages } = await updates();
        if (providerMessages.length && options.terminal && options.precedingAssistant) {
          await conversations.append({ ...executionScope, entry: buildSessionEntry({ sessionId: wait.executionSessionId, role: 'assistant',
            content: options.precedingAssistant, runId: wait.executionRunId, metadata: { steeringContinuation: true } }) });
        }
        await copy(entries);
        const inputs = await target.boundary(identity, providerMessages.length
          ? { ...options, terminal: false, precedingAssistant: null } : options);
        return [...(providerMessages.length ? [{ providerMessages }] : []), ...inputs];
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { initialize, stores: { ...stores, ...(steering ? { steering } : {}) } };
}
