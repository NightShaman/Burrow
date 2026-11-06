import { api, type ChatSession, type SessionSummary } from '../../app/api';
import { secureUuid } from '../../app/secureUuid';
import { clientBudgets } from '../../app/clientBudgets';
import { readStoredValue, writeStoredValue } from '../../app/browserStorage';
import { conversationCacheGeneration } from './chatConversationCache';

export const sessionListCacheStorageKey = 'hc.chatSessions.v1';
const sessionListCacheVersion = 1;
const sessionListCacheLimit = 16;

type SessionListCacheEntry = { savedAt: number; sessions: SessionSummary[] };
type SessionListCache = Record<string, SessionListCacheEntry>;

function isSessionListCacheEntry(value: unknown): value is SessionListCacheEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.savedAt === 'number' &&
    Number.isFinite(entry.savedAt) &&
    Array.isArray(entry.sessions)
  );
}

function isSessionListCache(value: unknown): value is SessionListCache {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(isSessionListCacheEntry)
  );
}

function readSessionListEntries(storage?: Storage | null): SessionListCache {
  return readStoredValue({
    key: sessionListCacheStorageKey,
    version: sessionListCacheVersion,
    fallback: {},
    validate: isSessionListCache,
    decodeLegacy: (_raw, parsed) => (isSessionListCache(parsed) ? parsed : undefined),
    storage,
  });
}

export function readSessionListCache(
  agentId: string,
  storage?: Storage | null,
): SessionSummary[] | null {
  return readSessionListEntries(storage)[agentId]?.sessions ?? null;
}

export function writeSessionListCache(
  agentId: string,
  sessions: SessionSummary[],
  storage?: Storage | null,
) {
  const stored = readSessionListEntries(storage);
  const newestSavedAt = Object.values(stored).reduce(
    (latest, entry) => Math.max(latest, entry.savedAt),
    0,
  );
  const savedAt = Math.max(Date.now(), newestSavedAt + 1);
  const entries = Object.entries({ ...stored, [agentId]: { savedAt, sessions } })
    .sort(([aKey, a], [bKey, b]) => b.savedAt - a.savedAt || aKey.localeCompare(bKey))
    .slice(0, sessionListCacheLimit);
  writeStoredValue(
    sessionListCacheStorageKey,
    sessionListCacheVersion,
    Object.fromEntries(entries),
    storage,
  );
}

export type ChatSessionRepository = {
  listSessions: (agentId: string) => Promise<SessionSummary[]>;
  loadSession: (agentId: string, sessionId: string) => Promise<ChatSession>;
  loadOlder: (agentId: string, sessionId: string) => Promise<ChatSession>;
  resetSession: (agentId: string, sessionId: string) => Promise<void>;
};

/** Provides local-runtime chat session requests. */
export function createChatSessionRepository(): ChatSessionRepository {
  const loaded = new Map<string, ChatSession>();
  // Only rows actually returned by an explicit older-page request may survive
  // a newest-page refresh. Missing rows from a previous newest page are not a
  // known older prefix and may have been removed on the server.
  const olderPrefixIds = new Map<string, Set<string>>();
  let cacheGeneration = conversationCacheGeneration;
  const syncCacheGeneration = () => {
    if (cacheGeneration === conversationCacheGeneration) return;
    cacheGeneration = conversationCacheGeneration;
    loaded.clear();
    olderPrefixIds.clear();
    // In-flight reads from before a purge must not win against a new read.
    for (const key of revisions.keys()) revisions.set(key, revisions.get(key)! + 1);
  };
  const epochs = new Map<string, number>();
  const revisions = new Map<string, number>();
  const olderRequests = new Map<string, object>();
  const resets = new Map<string, Promise<void>>();
  const key = (agentId: string, sessionId: string) => JSON.stringify([agentId, sessionId]);
  const read = async (agentId: string, sessionId: string, before?: string | null) => {
    const response = await api<{ session: ChatSession }>(
      `/api/sessions/${encodeURIComponent(sessionId)}?agentId=${encodeURIComponent(agentId)}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
    );
    return response.session;
  };
  const sameGeneration = (a: ChatSession, b: ChatSession) =>
    (a.metadata?.resetGeneration ?? 0) === (b.metadata?.resetGeneration ?? 0) &&
    a.metadata?.resetAt === b.metadata?.resetAt;
  const merge = (older: ChatSession, newer: ChatSession): ChatSession => {
    const ids = new Set(newer.turns?.map((turn) => turn.id).filter(Boolean));
    return {
      ...newer,
      turns: [
        ...(older.turns ?? []).filter((turn) => turn.id && !ids.has(turn.id)),
        ...(newer.turns ?? []),
      ],
    };
  };
  const repository: ChatSessionRepository = {
    async listSessions(agentId) {
      const response = await api<{ sessions: SessionSummary[] }>(
        `/api/sessions?agentId=${encodeURIComponent(agentId)}`,
      );
      writeSessionListCache(agentId, response.sessions);
      return response.sessions;
    },
    async loadSession(agentId, sessionId) {
      syncCacheGeneration();
      const cacheGenerationAtStart = cacheGeneration;
      const cacheKey = key(agentId, sessionId);
      if (resets.has(cacheKey)) await resets.get(cacheKey);
      const epoch = epochs.get(cacheKey) ?? 0;
      const revision = (revisions.get(cacheKey) ?? 0) + 1;
      revisions.set(cacheKey, revision);
      const page = await read(agentId, sessionId);
      syncCacheGeneration();
      if (
        cacheGenerationAtStart !== cacheGeneration ||
        epoch !== (epochs.get(cacheKey) ?? 0) ||
        revision !== revisions.get(cacheKey)
      )
        return loaded.get(cacheKey) ?? page;
      const previous = loaded.get(key(agentId, sessionId));
      if (
        previous &&
        (previous.metadata?.resetGeneration ?? 0) > (page.metadata?.resetGeneration ?? 0)
      )
        return previous;
      // Preserve only explicitly paginated older rows, not every missing row
      // previously returned by a newest-page read. Adopt the fresh cursor.
      if (previous && !sameGeneration(previous, page)) olderPrefixIds.delete(cacheKey);
      const prefix = olderPrefixIds.get(cacheKey);
      const session =
        previous && sameGeneration(previous, page) && prefix?.size
          ? merge(
              {
                ...previous,
                turns: previous.turns?.filter((turn) => turn.id && prefix.has(turn.id)),
              },
              page,
            )
          : page;
      loaded.set(cacheKey, session);
      return session;
    },
    async loadOlder(agentId, sessionId) {
      syncCacheGeneration();
      const cacheGenerationAtStart = cacheGeneration;
      const cacheKey = key(agentId, sessionId);
      if (resets.has(cacheKey)) await resets.get(cacheKey);
      const epoch = epochs.get(cacheKey) ?? 0;
      const previous = loaded.get(cacheKey);
      if (!previous?.hasMore || !previous.nextCursor)
        return previous ?? this.loadSession(agentId, sessionId);
      const request = {};
      olderRequests.set(cacheKey, request);
      try {
        let page = await read(agentId, sessionId, previous.nextCursor);
        // Refresh may have moved the cursor back to the newest page. Walk only
        // on explicit demand until the already loaded prefix is crossed.
        const oldestId = previous.turns?.find((turn) => turn.id)?.id;
        while (
          oldestId &&
          !page.turns?.some((turn) => turn.id === oldestId) &&
          page.hasMore &&
          page.nextCursor &&
          page.turns?.every((turn) => previous.turns?.some((old) => old.id === turn.id))
        ) {
          page = await read(agentId, sessionId, page.nextCursor);
        }
        syncCacheGeneration();
        const current = loaded.get(cacheKey) ?? previous;
        if (
          cacheGenerationAtStart !== cacheGeneration ||
          olderRequests.get(cacheKey) !== request ||
          epoch !== (epochs.get(cacheKey) ?? 0) ||
          !sameGeneration(current, page)
        )
          return loaded.get(cacheKey) ?? page;
        const prefix = olderPrefixIds.get(cacheKey) ?? new Set<string>();
        // A concurrent newest refresh may already have replaced the boundary
        // we paginated from. Keep that boundary only after this page succeeds.
        const boundary = merge(previous, current);
        // Once an older page is fetched, the current newest boundary belongs
        // to the loaded scrollback as well; the next newest page can shift.
        for (const turn of [...(page.turns ?? []), ...(previous.turns ?? [])])
          if (turn.id) prefix.add(turn.id);
        olderPrefixIds.set(cacheKey, prefix);
        const session = {
          ...merge(page, boundary),
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        };
        loaded.set(cacheKey, session);
        return session;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('archive_cursor_invalid'))
          throw error;
        if (olderRequests.get(cacheKey) !== request) return loaded.get(cacheKey) ?? previous;
        // Append/compaction invalidates cursors; a reset instead replaces the
        // generation. Never clear a conversation just because a cursor expired.
        return this.loadSession(agentId, sessionId);
      } finally {
        if (olderRequests.get(cacheKey) === request) olderRequests.delete(cacheKey);
      }
    },
    async resetSession(agentId, sessionId) {
      loaded.delete(key(agentId, sessionId));
      olderPrefixIds.delete(key(agentId, sessionId));
      const sessionPath = `/api/sessions/${encodeURIComponent(sessionId)}?agentId=${encodeURIComponent(agentId)}`;
      const operationId = secureUuid();
      try {
        await api(
          `/api/sessions/${encodeURIComponent(sessionId)}/reset?agentId=${encodeURIComponent(agentId)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ operationId }),
          },
          { deadlineMs: clientBudgets.sessionResetDeadlineMs },
        );
      } catch (error) {
        // A lost response is not proof the destructive operation failed. Never retry
        // the POST: only accept an authoritative read of this exact operation.
        const status = (error as { status?: number } | null)?.status;
        if (status && status >= 400 && status < 500 && status !== 408) throw error;
        try {
          const { session } = await api<{ session: ChatSession }>(sessionPath, {
            cache: 'no-store',
          });
          if (
            session.id === sessionId &&
            session.metadata?.resetOperationId === operationId &&
            typeof session.metadata.resetGeneration === 'number' &&
            Number.isSafeInteger(session.metadata.resetGeneration) &&
            session.metadata.resetGeneration > 0 &&
            Array.isArray(session.turns) &&
            session.turns.length === 0
          )
            return;
        } catch {
          // Preserve the current conversation/composer when verification is unavailable.
        }
        throw new Error(
          'Reset outcome could not be confirmed. Refresh the session before trying again.',
        );
      }
    },
  };
  return {
    ...repository,
    resetSession(agentId, sessionId) {
      syncCacheGeneration();
      const cacheKey = key(agentId, sessionId);
      epochs.set(cacheKey, (epochs.get(cacheKey) ?? 0) + 1);
      const reset = (resets.get(cacheKey) ?? Promise.resolve()).then(() =>
        repository.resetSession(agentId, sessionId),
      );
      resets.set(cacheKey, reset);
      void reset
        .finally(() => {
          if (resets.get(cacheKey) === reset) resets.delete(cacheKey);
        })
        .catch(() => undefined);
      return reset;
    },
  };
}
