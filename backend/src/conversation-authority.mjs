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

async function readAllEntries(store, agentId, sessionId, signal, deadline) {
  const found = [];
  let after = 0;
  for (;;) {
    signal?.throwIfAborted();
    const page = typeof store.page === 'function'
      ? await store.page({ agentId, sessionId, limit: 256, after, signal, deadline })
      : { entries: await store.read({ agentId, sessionId, limit: 256, after, signal, deadline }) };
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
    async metadata(sessionId, { signal, deadline } = {}) { return pg.getMetadata({ ...key(sessionId), signal, ...(deadline === undefined ? {} : { deadline }) }); },
    async entries(sessionId, options = {}) { return pg.read(scopedReadOptions(agentId, sessionId, options)); },
    async entriesAll(sessionId, { signal, deadline } = {}) { return readAllEntries(pg, agentId, sessionId, signal, deadline); },
    async originalEntries(sessionId, { entryIds, signal } = {}) {
      signal?.throwIfAborted();
      if (entryIds !== undefined) {
        if (typeof pg.listOriginalEntriesById !== 'function') throw new Error('conversation_store_targeted_originals_unsupported');
        return pg.listOriginalEntriesById({ ...key(sessionId), entryIds, signal });
      }
      const entries = await (typeof pg.listOriginalEntries === 'function'
        ? pg.listOriginalEntries({ ...key(sessionId), signal })
        : readAllEntries(pg, agentId, sessionId, signal));
      signal?.throwIfAborted();
      return entries;
    },
    async pendingActions(sessionId) { return readAllPending(pg, agentId, sessionId); },
    // One pre-admission snapshot can serve both context preparation and the
    // planner's pending-action projection. Callers must not reuse it after a
    // turn is appended or compression persists a successor transcript.
    async sessionSnapshot(sessionId, { signal } = {}) {
      signal?.throwIfAborted();
      if (typeof pg.sessionSnapshot === 'function') return pg.sessionSnapshot({ ...key(sessionId), signal });
      const [entries, metadata] = await Promise.all([
        readAllEntries(pg, agentId, sessionId, signal),
        pg.getMetadata({ ...key(sessionId), signal }),
      ]);
      signal?.throwIfAborted();
      return { entries, metadata, pendingActions: projectPendingActions(entries) };
    },
    async compact(sessionId, { summary, tailEntries = [], expectedEntries = null, expectedGeneration = null, signal } = {}) {
      if (typeof pg.compact !== 'function') throw new Error('conversation_store_compaction_unsupported');
      return pg.compact({ ...key(sessionId), summary, tailEntries, expectedEntries, expectedGeneration, signal });
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
