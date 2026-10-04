import { api, type ChatSession, type SessionSummary } from '../../app/api';
import { readStoredValue, writeStoredValue } from '../../app/browserStorage';

export const sessionListCacheStorageKey = 'hc.chatSessions.v1';
const sessionListCacheVersion = 1;
const sessionListCacheLimit = 16;

type SessionListCacheEntry = { savedAt: number; sessions: SessionSummary[] };
type SessionListCache = Record<string, SessionListCacheEntry>;

function isSessionListCacheEntry(value: unknown): value is SessionListCacheEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.savedAt === 'number' && Number.isFinite(entry.savedAt) && Array.isArray(entry.sessions);
}

function isSessionListCache(value: unknown): value is SessionListCache {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(isSessionListCacheEntry);
}

function readSessionListEntries(storage?: Storage | null): SessionListCache {
  return readStoredValue({
    key: sessionListCacheStorageKey,
    version: sessionListCacheVersion,
    fallback: {},
    validate: isSessionListCache,
    decodeLegacy: (_raw, parsed) => isSessionListCache(parsed) ? parsed : undefined,
    storage,
  });
}

export function readSessionListCache(agentId: string, storage?: Storage | null): SessionSummary[] | null {
  return readSessionListEntries(storage)[agentId]?.sessions ?? null;
}

export function writeSessionListCache(agentId: string, sessions: SessionSummary[], storage?: Storage | null) {
  const stored = readSessionListEntries(storage);
  const newestSavedAt = Object.values(stored).reduce((latest, entry) => Math.max(latest, entry.savedAt), 0);
  const savedAt = Math.max(Date.now(), newestSavedAt + 1);
  const entries = Object.entries({ ...stored, [agentId]: { savedAt, sessions } })
    .sort(([aKey, a], [bKey, b]) => b.savedAt - a.savedAt || aKey.localeCompare(bKey))
    .slice(0, sessionListCacheLimit);
  writeStoredValue(sessionListCacheStorageKey, sessionListCacheVersion, Object.fromEntries(entries), storage);
}

export type ChatSessionRepository = {
  listSessions: (agentId: string) => Promise<SessionSummary[]>;
  loadSession: (agentId: string, sessionId: string) => Promise<ChatSession>;
  resetSession: (agentId: string, sessionId: string) => Promise<void>;
};

/** Provides local-runtime chat session requests. */
export function createChatSessionRepository(): ChatSessionRepository {
  return {
    async listSessions(agentId) {
      const response = await api<{ sessions: SessionSummary[] }>(`/api/sessions?agentId=${encodeURIComponent(agentId)}`);
      writeSessionListCache(agentId, response.sessions);
      return response.sessions;
    },
    async loadSession(agentId, sessionId) {
      const response = await api<{ session: ChatSession }>(`/api/sessions/${encodeURIComponent(sessionId)}?agentId=${encodeURIComponent(agentId)}`);
      return response.session;
    },
    async resetSession(agentId, sessionId) {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/reset?agentId=${encodeURIComponent(agentId)}`, { method: 'POST' });
    },
  };
}
