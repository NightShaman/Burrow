import { projectPendingActions, buildSessionEntry } from './session-entry.mjs';

function injectedStore(store) {
  if (store == null) throw new TypeError('conversation_store_required');
  if (typeof store !== 'object' || typeof store.read !== 'function' || typeof store.append !== 'function') {
    throw new TypeError('conversation_store_invalid');
  }
  if (typeof store.getMetadata !== 'function') throw new TypeError('conversation_store_metadata_invalid');
  return store;
}

function scope(agentId, sessionId) {
  return { agentId, sessionId };
}

// Do not let caller-controlled read options replace the authority scope.
function scopedReadOptions(agentId, sessionId, options = {}) {
  const { agentId: _agent, sessionId: _session, ...safeOptions } = options || {};
  return { ...safeOptions, agentId, sessionId };
}

function turnEntry(turn = {}) { return buildSessionEntry({ ...turn, type: 'message' }); }

async function readAllEntries(store, agentId, sessionId) {
  const found = [];
  let after = 0;
  for (;;) {
    const page = typeof store.page === 'function'
      ? await store.page({ agentId, sessionId, limit: 256, after })
      : { entries: await store.read({ agentId, sessionId, limit: 256, after }) };
    const entries = page?.entries || [];
    found.push(...entries);
    if (!page?.hasMore && (typeof store.page === 'function' || !entries.length)) break;
    if (!entries.length) break;
    const next = page?.next ?? entries.at(-1)?.sequence;
    if (next == null || String(next) === String(after)) throw new Error('conversation_store_paging_invalid');
    after = next;
  }
  return found;
}

async function readAllPending(store, agentId, sessionId) {
  const found = [];
  if (typeof store.page === 'function') {
    let after = 0;
    for (;;) {
      const page = await store.page({ agentId, sessionId, limit: 256, after });
      const entries = page?.entries || [];
      found.push(...entries);
      if (!page?.hasMore || !entries.length) break;
      const next = page.next ?? entries.at(-1)?.sequence;
      if (next == null || String(next) === String(after)) throw new Error('conversation_store_paging_invalid');
      after = next;
    }
  } else {
    // Legacy injected stores expose read(after), so walk until an empty page.
    let after = 0;
    for (;;) {
      const entries = await store.read({ agentId, sessionId, limit: 256, after });
      found.push(...entries);
      if (!entries.length) break;
      const next = entries.at(-1)?.sequence;
      if (next == null || String(next) === String(after)) throw new Error('conversation_store_paging_invalid');
      after = next;
    }
  }
  return projectPendingActions(found);
}

export function conversationAuthority({ store = null, agentId } = {}) {
  const pg = injectedStore(store);
  if (typeof agentId !== 'string' || !agentId.trim()) throw new Error('agent_id_required');
  const key = (sessionId) => scope(agentId, sessionId);
  return Object.freeze({
    async metadata(sessionId) { return pg.getMetadata(key(sessionId)); },
    async entries(sessionId, options = {}) { return pg.read(scopedReadOptions(agentId, sessionId, options)); },
    async entriesAll(sessionId) { return readAllEntries(pg, agentId, sessionId); },
    async pendingActions(sessionId) { return readAllPending(pg, agentId, sessionId); },
    async compact(sessionId, { summary, tailEntries = [] } = {}) {
      if (typeof pg.compact !== 'function') throw new Error('conversation_store_compaction_unsupported');
      return pg.compact({ ...key(sessionId), summary, tailEntries });
    },
    async append(entry, { idempotencyKey = null } = {}) {
      return pg.append({ ...key(entry.sessionId), entry: buildSessionEntry(entry), idempotencyKey });
    },
    async appendTurn(turn, { idempotencyKey = null } = {}) {
      return pg.append({ ...key(turn.sessionId), entry: turnEntry(turn), idempotencyKey });
    },
    async appendTurnIfAbsent(turn, { idempotencyKey = null } = {}) {
      return pg.appendIfAbsent({ ...key(turn.sessionId), entry: turnEntry(turn), idempotencyKey });
    },
  });
}

export function isConversationAuthority(value) {
  return Boolean(value && typeof value.entries === 'function' && typeof value.appendTurn === 'function');
}

export default conversationAuthority;
