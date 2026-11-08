import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientBudgets } from '../../app/clientBudgets';
import { type ChatSession, type SessionTurn } from '../../app/api';
import {
  conversationCacheGeneration,
  conversationCacheKey,
  conversationCacheInvalidated,
  readConversationCache,
  writeConversationCache,
  type ConversationCache,
} from './chatConversationCache';
import { cachedTurnsForSession, reconcileSessionTurns } from './chatTurnReconciliation';
import { createChatSessionRepository } from './chatSessionRepository';

/** Mounted-workspace read authority. Owns repository lifetime, navigation read
 * deduplication, persisted reconciliation input, pending acknowledgements and
 * bounded live freshness. Selection/UI state never grants disk snapshots freshness.
 */
export function useConversationAuthority(onInvalidate: () => void, agentId = '', sessionId = '') {
  const [olderState, setOlderState] = useState({ key: '', hasMore: false, loading: false });
  const olderRequest = useRef<object | null>(null);
  const olderBySession = useRef(new Map<string, boolean>());
  // Conversation ownership is independent of composer/attachment lifetime.
  const selectionKey = conversationCacheKey(agentId, sessionId);
  const selection = useRef({ key: selectionKey });
  if (selection.current.key !== selectionKey) {
    selection.current = { key: selectionKey };
    olderRequest.current = null;
  }
  const showOlderState = useCallback((agentId: string, id: string, session: ChatSession) => {
    const key = conversationCacheKey(agentId, id);
    olderBySession.current.set(key, Boolean(session.hasMore));
    if (selection.current.key !== key) return;
    setOlderState({
      key,
      hasMore: Boolean(session.hasMore),
      loading: olderRequest.current !== null,
    });
  }, []);
  const restoreOlderState = useCallback((key: string) => {
    setOlderState({ key, hasMore: olderBySession.current.get(key) ?? false, loading: false });
  }, []);
  const invalidateRef = useRef(onInvalidate);
  invalidateRef.current = onInvalidate;
  const sessionRepository = useMemo(() => createChatSessionRepository(), []);
  // A read may finish after navigation. Only its caller, after validating its
  // scope, may change the pagination state of the displayed conversation.
  const loadSession = useCallback(
    (agentId: string, id: string) => sessionRepository.loadSession(agentId, id),
    [sessionRepository],
  );
  const navigationReads = useRef(new Map<string, Promise<ChatSession>>());
  const loadNavigationSession = useCallback(
    (agentId: string, id: string) => {
      const key = JSON.stringify([conversationCacheGeneration, agentId, id]);
      const existing = navigationReads.current.get(key);
      if (existing) return existing;
      const pending = loadSession(agentId, id);
      navigationReads.current.set(key, pending);
      void pending
        .finally(() => {
          if (navigationReads.current.get(key) === pending) navigationReads.current.delete(key);
        })
        .catch(() => undefined);
      return pending;
    },
    [loadSession],
  );
  const pendingTurnsRef = useRef(new Map<string, SessionTurn[]>());
  const conversationCacheRef = useRef<ConversationCache>({});
  // Local turns bridge persistence lag only until the server acknowledges each
  // run/role. Completing a stream is not a transcript acknowledgement.
  const reconcileSnapshot = useCallback(
    (cacheKey: string, session: ChatSession, cachedTurns: SessionTurn[]) => {
      const pending = cachedTurnsForSession(session, pendingTurnsRef.current.get(cacheKey) ?? []);
      const next = reconcileSessionTurns(session, cachedTurns, pending);
      const acknowledged = new Set(
        (session.turns ?? []).map((turn) => `${turn.runId}:${turn.role}`),
      );
      const remaining = pending.filter((turn) => !acknowledged.has(`${turn.runId}:${turn.role}`));
      if (remaining.length) pendingTurnsRef.current.set(cacheKey, remaining);
      else pendingTurnsRef.current.delete(cacheKey);
      return next;
    },
    [],
  );
  // Disk snapshots are restoration/reconciliation input only. Only snapshots
  // confirmed during this mounted workspace can paint an instant return.
  const liveSnapshots = useRef(new Map<string, string>());
  const staleSnapshots = useRef(new Set<string>());
  const rememberLiveSnapshot = useCallback((key: string, version: string) => {
    liveSnapshots.current.delete(key);
    liveSnapshots.current.set(key, version);
    staleSnapshots.current.delete(key);
    while (liveSnapshots.current.size > clientBudgets.conversationCacheEntries) {
      const oldest = liveSnapshots.current.keys().next().value!;
      liveSnapshots.current.delete(oldest);
      staleSnapshots.current.delete(oldest);
    }
  }, []);
  const cacheInitialized = useRef(false);
  if (!cacheInitialized.current) {
    conversationCacheRef.current = readConversationCache();
    cacheInitialized.current = true;
  }
  useEffect(() => {
    const invalidate = () => {
      conversationCacheRef.current = {};
      olderBySession.current.clear();
      pendingTurnsRef.current.clear();
      liveSnapshots.current.clear();
      staleSnapshots.current.clear();
      invalidateRef.current();
    };
    window.addEventListener(conversationCacheInvalidated, invalidate);
    return () => window.removeEventListener(conversationCacheInvalidated, invalidate);
  }, []);
  const commitSnapshot = useCallback((key: string, turns: SessionTurn[]) => {
    conversationCacheRef.current[key] = turns;
    writeConversationCache(conversationCacheRef.current, key);
  }, []);
  const appendLocalTurn = useCallback(
    (key: string, turn: SessionTurn) => {
      if (turn.runId && (turn.role === 'user' || turn.role === 'assistant'))
        pendingTurnsRef.current.set(key, [
          ...(pendingTurnsRef.current.get(key) ?? []).filter(
            (pending) => pending.runId !== turn.runId || pending.role !== turn.role,
          ),
          turn,
        ]);
      const next = [...(conversationCacheRef.current[key] ?? []), turn];
      commitSnapshot(key, next);
      return next;
    },
    [commitSnapshot],
  );
  const resetSnapshot = useCallback(
    (key: string) => {
      // A successful same-session reset invalidates paging ownership, not just
      // the snapshot. Old completions (including errors) cannot repaint it.
      if (selection.current.key === key) {
        olderRequest.current = null;
        setOlderState({ key, hasMore: false, loading: false });
      }
      olderBySession.current.delete(key);
      pendingTurnsRef.current.delete(key);
      liveSnapshots.current.delete(key);
      commitSnapshot(key, []);
    },
    [commitSnapshot],
  );
  const loadOlder = useCallback(
    async (
      agentId: string,
      id: string,
      display: (turns: SessionTurn[]) => void,
      reportError: (message: string) => void,
    ) => {
      if (olderRequest.current || !agentId || !id) return;
      const scope = selection.current;
      const key = conversationCacheKey(agentId, id);
      const generation = conversationCacheGeneration;
      const request = {};
      olderRequest.current = request;
      setOlderState((current) => ({ ...current, loading: true }));
      try {
        const session = await sessionRepository.loadOlder(agentId, id);
        if (
          selection.current !== scope ||
          olderRequest.current !== request ||
          generation !== conversationCacheGeneration
        )
          return;
        const next = reconcileSnapshot(key, session, conversationCacheRef.current[key] ?? []);
        commitSnapshot(key, next);
        display(next);
        showOlderState(agentId, id, session);
      } catch (error) {
        if (
          selection.current === scope &&
          olderRequest.current === request &&
          generation === conversationCacheGeneration
        )
          reportError(`Could not load older messages: ${(error as Error).message}`);
      } finally {
        if (selection.current === scope && olderRequest.current === request) {
          olderRequest.current = null;
          setOlderState((current) => ({ ...current, loading: false }));
        }
      }
    },
    [sessionRepository, reconcileSnapshot, commitSnapshot, showOlderState],
  );
  return {
    olderState,
    showOlderState,
    restoreOlderState,
    loadOlder,
    commitSnapshot,
    appendLocalTurn,
    resetSnapshot,
    sessionRepository,
    loadSession,
    navigationReads,
    loadNavigationSession,
    pendingTurnsRef,
    conversationCacheRef,
    reconcileSnapshot,
    liveSnapshots,
    staleSnapshots,
    rememberLiveSnapshot,
  };
}
