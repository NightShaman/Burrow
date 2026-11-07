import { useEffect, type MutableRefObject, type Dispatch, type SetStateAction } from 'react';
import { api, type ChatSession, type SessionSummary, type SessionTurn } from '../../app/api';
import { conversationCacheGeneration, conversationCacheKey } from './chatConversationCache';

/** Keeps visited live snapshots fresh without granting stale reads authority over local writes. */
export function useConversationRevalidation({
  authority,
  showOlderState,
  selectedChatRef,
  setTurns,
  setIsLoadingConversation,
}: {
  authority: ReturnType<typeof import('./useConversationAuthority').useConversationAuthority>;
  showOlderState: (agentId: string, id: string, session: ChatSession) => void;
  selectedChatRef: MutableRefObject<{ agentId: string; sessionId: string }>;
  setTurns: Dispatch<SetStateAction<SessionTurn[]>>;
  setIsLoadingConversation: Dispatch<SetStateAction<boolean>>;
}) {
  const {
    liveSnapshots,
    staleSnapshots,
    conversationCacheRef,
    loadNavigationSession,
    reconcileSnapshot,
    rememberLiveSnapshot,
    commitSnapshot,
  } = authority;
  // Keep visited transcripts warm even while another agent is selected. The
  // incremental session listing is a coarse invalidation signal, never a
  // transcript revision. Re-read changed conversations through the same owner
  // used by navigation/recovery, with generation and local-write guards.
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    // Use server timestamps, not the browser clock. Scope the lightweight
    // invalidation reads to visited agents rather than enumerate every agent.
    const poll = async () => {
      const generation = conversationCacheGeneration;
      try {
        if (!liveSnapshots.current.size) return;
        const agents = [
          ...new Set(
            Object.keys(conversationCacheRef.current)
              .filter((key) => liveSnapshots.current.has(key))
              .map((key) => key.slice(0, key.indexOf(':'))),
          ),
        ];
        await Promise.all(
          agents.map(async (agentId) => {
            try {
              if (stopped || generation !== conversationCacheGeneration) return;
              const versions = [...liveSnapshots.current.entries()]
                .filter(([key, version]) => key.startsWith(`${agentId}:`) && version)
                .map(([, version]) => version)
                .sort();
              const oldest = Date.parse(versions[0] ?? '');
              const since = Number.isFinite(oldest)
                ? new Date(oldest - 1).toISOString()
                : '1970-01-01T00:00:00.000Z';
              const { sessions: changed } = await api<{ sessions: SessionSummary[] }>(
                `/api/sessions?agentId=${encodeURIComponent(agentId)}&updatedSince=${encodeURIComponent(since)}`,
              );
              if (stopped || generation !== conversationCacheGeneration) return;
              for (const summary of changed) {
                const key = conversationCacheKey(agentId, summary.id);
                const version = liveSnapshots.current.get(key);
                if (version === undefined || (summary.updatedAt && summary.updatedAt === version))
                  continue;
                const cached = conversationCacheRef.current[key];
                // Mark known-stale memory before awaiting the fresh page. Selecting
                // it in this interval must not display the obsolete snapshot.
                staleSnapshots.current.add(key);
                try {
                  const session = await loadNavigationSession(agentId, summary.id);
                  if (stopped || generation !== conversationCacheGeneration) return;
                  if (conversationCacheRef.current[key] !== cached) continue;
                  const next = reconcileSnapshot(key, session, cached ?? []);
                  commitSnapshot(key, next);
                  rememberLiveSnapshot(key, session.metadata?.updatedAt ?? summary.updatedAt ?? '');
                  showOlderState(agentId, summary.id, session);
                  const current = selectedChatRef.current;
                  if (current.agentId === agentId && current.sessionId === summary.id) {
                    setTurns(next);
                    setIsLoadingConversation(false);
                  }
                } catch {
                  // Keep invalidated entries retryable without presenting them as fresh.
                  throw new Error('Background transcript refresh failed');
                }
              }
            } catch {
              // A failed agent read must not stall other visited conversations.
            }
          }),
        );
      } catch {
        // Navigation owns visible errors. Versions remain unchanged for retry.
      } finally {
        if (!stopped) timer = window.setTimeout(poll, 2000);
      }
    };
    timer = window.setTimeout(poll, 2000);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadNavigationSession, reconcileSnapshot, showOlderState, rememberLiveSnapshot]);
}
