import { createHash } from 'node:crypto';

// A context session is a durable execution namespace, not a transcript reset.
// Named history is append-only from this adapter; compression/recovery operate
// exclusively on the context session. Reopening its id preserves all tool state.
export function contextSessionId({ agentId, historySessionId, key }) {
  if (!key || !historySessionId || historySessionId === 'default') throw new Error('context_boundary_named_session_required');
  return `ctx-${createHash('sha256').update(JSON.stringify([agentId, historySessionId, key])).digest('hex')}`;
}

export function withContextHistory(store, { agentId, sessionId, historySessionId }) {
  return new Proxy(store, {
    get(target, property) {
      if (['append', 'appendIfAbsent'].includes(property)) return async (args) => {
        const result = await target[property](args);
        if (args.agentId === agentId && args.sessionId === sessionId) {
          await target.appendIfAbsent({ ...args, sessionId: historySessionId,
            entry: { ...result, sessionId: historySessionId, metadata: { ...result.metadata, contextSessionId: sessionId } },
            idempotencyKey: `context-history:${sessionId}:${result.id}` });
        }
        return result;
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// Internal execution projections are recovery addresses, not browse sources.
export function isInternalContextSession(record) {
  return Boolean((record?.metadata || record)?.contextIsolation?.historySessionId);
}

export async function canonicalHistorySessionId(store, { agentId, sessionId }) {
  const metadata = await store.getMetadata({ agentId, sessionId });
  return metadata?.contextIsolation?.historySessionId || sessionId;
}
