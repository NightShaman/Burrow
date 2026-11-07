import { useChatRecovery } from './useChatRecovery';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clientBudgets } from '../../app/clientBudgets';
import { useChatComposer } from './useChatComposer';
import {
  api,
  textFromChatValue,
  type ChatSession,
  type SessionSummary,
  type SessionTurn,
  type ToolActivity,
} from '../../app/api';
import {
  conversationCacheGeneration,
  conversationCacheInvalidated,
  conversationCacheKey,
  readConversationCache,
  writeConversationCache,
  type ConversationCache,
} from './chatConversationCache';
import { cachedTurnsForSession, reconcileSessionTurns } from './chatTurnReconciliation';
import { finalizeThoughtProgress } from './chatThoughtProgress';
import { chatTerminalMetadata } from './chatTerminal';
import { createChatSessionRepository, readSessionListCache } from './chatSessionRepository';

export { conversationCacheKey } from './chatConversationCache';

/** Owns conversation freshness, navigation, and runtime reconciliation. */
export function useChatSession(selectedAgentId: string) {
  const sessionRepository = useMemo(() => createChatSessionRepository(), []);
  const [olderState, setOlderState] = useState<{ key: string; hasMore: boolean; loading: boolean }>(
    { key: '', hasMore: false, loading: false },
  );
  const olderRequest = useRef<object | null>(null);
  const olderBySession = useRef(new Map<string, boolean>());
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
  const showOlderState = useCallback((agentId: string, id: string, session: ChatSession) => {
    olderBySession.current.set(conversationCacheKey(agentId, id), Boolean(session.hasMore));
    if (selectedChatRef.current.agentId !== agentId || selectedChatRef.current.sessionId !== id)
      return;
    setOlderState({
      key: conversationCacheKey(agentId, id),
      hasMore: Boolean(session.hasMore),
      loading: olderRequest.current !== null,
    });
  }, []);
  const [isNewSession, setIsNewSession] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const attachmentKey = JSON.stringify([selectedAgentId, sessionId]);
  const attachmentScopeRef = useRef({ key: attachmentKey });
  if (attachmentScopeRef.current.key !== attachmentKey) {
    attachmentScopeRef.current = { key: attachmentKey };
    olderRequest.current = null;
  }
  const attachmentScope = attachmentScopeRef.current;
  const isAttachmentScopeCurrent = useCallback(
    () => attachmentScopeRef.current === attachmentScope,
    [attachmentScope],
  );
  const {
    draft,
    setDraft,
    attached,
    setAttachment,
    clearAttachment,
    removeAttachment,
    composerResetGeneration,
    noteComposerReset,
  } = useChatComposer(selectedAgentId, sessionId, attachmentScope, isAttachmentScopeCurrent);

  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const childSessionsRef = useRef(new Set<string>());
  const [, setToolActivityVersion] = useState(0);
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
      pendingTurnsRef.current.clear();
      liveSnapshots.current.clear();
      staleSnapshots.current.clear();
      olderBySession.current.clear();
      setTurns([]);
    };
    window.addEventListener(conversationCacheInvalidated, invalidate);
    return () => window.removeEventListener(conversationCacheInvalidated, invalidate);
  }, []);
  // Track the displayed session separately from each agent’s return anchor.
  // A child selection must not replace the root used when returning to its agent.
  const sessionIdByAgentRef = useRef<Record<string, string>>({});
  const parentSessionIdByAgentRef = useRef<Record<string, string>>({});
  const toolActivityByRunRef = useRef<Record<string, ToolActivity>>({});
  // Sending the first message of a reset session already supplies the local
  // transcript. Do not let the loader replace that optimistic turn with the
  // reset session's still-empty server snapshot.
  const skipNextConversationLoadRef = useRef(false);
  const selectedChatRef = useRef({ agentId: selectedAgentId, sessionId });
  // State updates from an effect cannot protect the render that follows an
  // agent selection. Keep the last committed agent so consumers can treat that
  // handoff as loading synchronously, before the empty-session view is eligible.
  const committedAgentIdRef = useRef(selectedAgentId);
  const isSwitchingAgent = committedAgentIdRef.current !== selectedAgentId;
  const [errorsByConversation, setErrorsByConversation] = useState<Record<string, string>>({});
  const errorKey = conversationCacheKey(selectedAgentId, sessionId);
  const chatError = isSwitchingAgent
    ? ''
    : (errorsByConversation[errorKey] ??
      errorsByConversation[conversationCacheKey(selectedAgentId, '')] ??
      '');
  // An async run reports against its captured origin, not the currently selected chat.
  const reportError = useCallback((message: string, agentId?: string, targetSessionId?: string) => {
    const current = selectedChatRef.current;
    const key = conversationCacheKey(
      agentId ?? current.agentId,
      targetSessionId ?? current.sessionId,
    );
    setErrorsByConversation((errors) => ({ ...errors, [key]: message }));
  }, []);
  const setChatError = reportError;
  const clearError = useCallback(() => {
    const { agentId, sessionId: selectedSessionId } = selectedChatRef.current;
    setErrorsByConversation((errors) => ({
      ...errors,
      [conversationCacheKey(agentId, selectedSessionId)]: '',
      [conversationCacheKey(agentId, '')]: '',
    }));
  }, []);
  useEffect(() => {
    selectedChatRef.current = { agentId: selectedAgentId, sessionId };
  }, [selectedAgentId, sessionId]);

  const {
    a2aActivities,
    runtimeRun,
    runtimeChildActivities,
    clearActivity,
    cancelRuntimeRun,
    retireRuntimeRun,
  } = useChatRecovery({
    agentId: selectedAgentId,
    sessionId,
    enabled: !isNewSession,
    isChildSession: childSessionsRef.current.has(conversationCacheKey(selectedAgentId, sessionId)),
    onError: setChatError,
    onRefresh: async ({ current, generation, recoveredProgress }) => {
      const cacheKey = conversationCacheKey(selectedAgentId, sessionId);
      const cachedTurns = conversationCacheRef.current[cacheKey];
      const session = await loadSession(selectedAgentId, sessionId);
      if (
        !current() ||
        conversationCacheGeneration !== generation ||
        conversationCacheRef.current[cacheKey] !== cachedTurns
      )
        return false;
      const nextTurns = reconcileSnapshot(cacheKey, session, cachedTurns ?? []).map((turn) => {
        if (turn.role !== 'assistant' || !turn.runId || turn.metadata?.progress) return turn;
        const recovered = recoveredProgress[turn.runId];
        if (!recovered?.length) return turn;
        const content = textFromChatValue(turn.content);
        const status = chatTerminalMetadata(turn.metadata)?.terminalStatus;
        // Unversioned successful rows predate terminal metadata. Never decode text.
        const terminalStatus = status === 'completed' ? 'complete' : (status ?? 'complete');
        const progress = finalizeThoughtProgress(recovered, terminalStatus, content);
        delete recoveredProgress[turn.runId];
        return progress ? { ...turn, metadata: { ...turn.metadata, progress } } : turn;
      });
      rememberLiveSnapshot(cacheKey, session.metadata?.updatedAt ?? '');
      conversationCacheRef.current[cacheKey] = nextTurns;
      writeConversationCache(conversationCacheRef.current, cacheKey);
      if (current()) showOlderState(selectedAgentId, sessionId, session);
      if (
        current() &&
        selectedChatRef.current.agentId === selectedAgentId &&
        selectedChatRef.current.sessionId === sessionId
      )
        setTurns(nextTurns);
      return true;
    },
  });

  // This must run before paint. A regular effect runs after React commits the
  // new rail selection, leaving one frame where Chat sees no turns and no
  // loading flag and therefore renders the new-session logo.
  useLayoutEffect(() => {
    committedAgentIdRef.current = selectedAgentId;
    clearActivity();
    if (!selectedAgentId) {
      setIsNewSession(false);
      setSessionId('');
      setTurns([]);
      return;
    }
    // Agent changes invalidate the previous agent's session immediately. This
    // prevents the chat frame from showing the old transcript while the new
    // agent's session list is hydrating.
    setSessionId('');
    // The session effect restores only a live, validated snapshot for this
    // destination. Persisted snapshots must not masquerade as current history.
    setTurns([]);
    // The session list must resolve before the new agent's conversation can
    // load. Mark that whole handoff as loading so an empty-state logo only
    // represents a deliberate new/reset session, never an agent switch.
    const rememberedSession = sessionIdByAgentRef.current[selectedAgentId];
    const cachedSessions =
      readSessionListCache(selectedAgentId) ??
      (rememberedSession ? [{ id: rememberedSession }] : null);
    if (cachedSessions) {
      setSessions(cachedSessions);
      setIsLoadingConversation(
        Boolean(cachedSessions.length || sessionIdByAgentRef.current[selectedAgentId]),
      );
      setSessionId((current) => {
        const remembered = sessionIdByAgentRef.current[selectedAgentId];
        const availableSessionIds = new Set(cachedSessions.map((session) => session.id));
        const rememberedSelection = remembered || '';
        const nextSessionId =
          rememberedSelection ||
          ([current, 'default', cachedSessions[0]?.id].find((id): id is string =>
            Boolean(id && availableSessionIds.has(id)),
          ) ??
            '');
        if (nextSessionId) sessionIdByAgentRef.current[selectedAgentId] = nextSessionId;
        if (!parentSessionIdByAgentRef.current[selectedAgentId])
          parentSessionIdByAgentRef.current[selectedAgentId] = availableSessionIds.has('default')
            ? 'default'
            : (cachedSessions[0]?.id ?? 'default');
        return nextSessionId;
      });
    } else {
      setIsLoadingConversation(true);
    }
    let cancelled = false;
    sessionRepository
      .listSessions(selectedAgentId)
      .then((nextSessions) => {
        if (cancelled) return;
        setSessions(nextSessions);
        if (!nextSessions.length && !sessionIdByAgentRef.current[selectedAgentId])
          setIsLoadingConversation(false);
        setSessionId((current) => {
          const remembered = sessionIdByAgentRef.current[selectedAgentId];
          const availableSessionIds = new Set(nextSessions.map((session) => session.id));
          // `remembered` is the authoritative selection for this agent. A child
          // session intentionally is not required to appear in the parent's
          // `/api/sessions` collection, so do not discard it during the list
          // refresh that follows a rail click.
          const rememberedSelection = remembered || '';
          const nextSessionId =
            rememberedSelection ||
            ([current, 'default', nextSessions[0]?.id].find((id): id is string =>
              Boolean(id && availableSessionIds.has(id)),
            ) ??
              '');
          if (nextSessionId) sessionIdByAgentRef.current[selectedAgentId] = nextSessionId;
          if (!parentSessionIdByAgentRef.current[selectedAgentId]) {
            // Initialize the return anchor when no explicit parent or root is known.
            parentSessionIdByAgentRef.current[selectedAgentId] = availableSessionIds.has('default')
              ? 'default'
              : (nextSessions[0]?.id ?? 'default');
          }
          return nextSessionId;
        });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setChatError(`Could not load sessions: ${error.message}`);
        setIsLoadingConversation(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAgentId, sessionRepository, clearActivity]);

  useEffect(() => {
    // A blank composer belongs to the agent that requested it, not whichever
    // agent is selected next.
    setIsNewSession(false);
  }, [selectedAgentId]);

  useLayoutEffect(() => {
    // Fetch the newest page before exposing a navigated conversation. A cached
    // transcript may predate work completed while another agent was selected.
    if (!selectedAgentId || isNewSession) {
      setTurns([]);
      setIsLoadingConversation(false);
      return;
    }
    if (!sessionId) return;
    if (skipNextConversationLoadRef.current) {
      skipNextConversationLoadRef.current = false;
      setIsLoadingConversation(false);
      return;
    }
    let cancelled = false;
    const generationAtRequestStart = conversationCacheGeneration;
    const cacheKey = conversationCacheKey(selectedAgentId, sessionId);
    const cachedTurns = conversationCacheRef.current[cacheKey];
    const live =
      liveSnapshots.current.has(cacheKey) &&
      !staleSnapshots.current.has(cacheKey) &&
      cachedTurns !== undefined;
    setTurns(live ? cachedTurns : []);
    setIsLoadingConversation(!live);
    if (live)
      setOlderState({
        key: cacheKey,
        hasMore: olderBySession.current.get(cacheKey) ?? false,
        loading: false,
      });
    // Background/session hydration must not erase a reported failure.
    loadNavigationSession(selectedAgentId, sessionId)
      .then((session) => {
        if (
          cancelled ||
          conversationCacheGeneration !== generationAtRequestStart ||
          conversationCacheRef.current[cacheKey] !== cachedTurns
        )
          return;
        const nextTurns = reconcileSnapshot(
          cacheKey,
          session,
          conversationCacheRef.current[cacheKey] ?? [],
        );
        rememberLiveSnapshot(cacheKey, session.metadata?.updatedAt ?? '');
        conversationCacheRef.current[cacheKey] = nextTurns;
        writeConversationCache(conversationCacheRef.current, cacheKey);
        showOlderState(selectedAgentId, sessionId, session);
        setTurns(nextTurns);
      })
      .catch(
        (error: Error) =>
          !cancelled && setChatError(`Could not load conversation: ${error.message}`),
      )
      .finally(() => !cancelled && setIsLoadingConversation(false));
    return () => {
      cancelled = true;
    };
  }, [isNewSession, selectedAgentId, sessionId, sessionRepository]);

  const refreshSessions = useCallback(
    async (agentId = selectedAgentId) => {
      if (!agentId) return;
      const nextSessions = await sessionRepository.listSessions(agentId);
      if (selectedChatRef.current.agentId === agentId) setSessions(nextSessions);
    },
    [selectedAgentId, sessionRepository, clearActivity],
  );
  const refreshConversation = useCallback(
    async (agentId = selectedAgentId, targetSessionId = sessionId) => {
      if (!agentId || !targetSessionId) return;
      const cacheKey = conversationCacheKey(agentId, targetSessionId);
      const generationAtRequestStart = conversationCacheGeneration;
      const turnsAtRequestStart = conversationCacheRef.current[cacheKey];
      const session = await loadSession(agentId, targetSessionId);
      // A refresh started before a direct send may resolve after appendTurn has
      // added the optimistic user message. That older server snapshot must not
      // erase newer local turns; the run's terminal refresh will reconcile once
      // persistence is complete.
      if (
        conversationCacheGeneration !== generationAtRequestStart ||
        conversationCacheRef.current[cacheKey] !== turnsAtRequestStart
      )
        return;
      const nextTurns = reconcileSnapshot(
        cacheKey,
        session,
        conversationCacheRef.current[cacheKey] ?? [],
      ).map((turn) => {
        const activity = turn.runId ? toolActivityByRunRef.current[turn.runId] : undefined;
        const normalizedTurn = { ...turn, content: textFromChatValue(turn.content) };
        return normalizedTurn.role === 'assistant' && activity?.items?.length
          ? { ...normalizedTurn, metadata: { ...normalizedTurn.metadata, toolActivity: activity } }
          : normalizedTurn;
      });
      rememberLiveSnapshot(cacheKey, session.metadata?.updatedAt ?? '');
      conversationCacheRef.current[cacheKey] = nextTurns;
      writeConversationCache(conversationCacheRef.current, cacheKey);
      showOlderState(agentId, targetSessionId, session);
      const current = selectedChatRef.current;
      if (current.agentId === agentId && current.sessionId === targetSessionId) setTurns(nextTurns);
    },
    [selectedAgentId, sessionId, sessionRepository],
  );

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
                  conversationCacheRef.current[key] = next;
                  rememberLiveSnapshot(key, session.metadata?.updatedAt ?? summary.updatedAt ?? '');
                  writeConversationCache(conversationCacheRef.current, key);
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

  const loadOlder = useCallback(async () => {
    if (olderRequest.current || !selectedAgentId || !sessionId) return;
    const scope = attachmentScopeRef.current;
    const cacheKey = conversationCacheKey(selectedAgentId, sessionId);
    const generation = conversationCacheGeneration;
    const request = {};
    olderRequest.current = request;
    setOlderState((current) => ({ ...current, loading: true }));
    try {
      const session = await sessionRepository.loadOlder(selectedAgentId, sessionId);
      if (
        attachmentScopeRef.current !== scope ||
        olderRequest.current !== request ||
        generation !== conversationCacheGeneration
      )
        return;
      const next = reconcileSnapshot(
        cacheKey,
        session,
        conversationCacheRef.current[cacheKey] ?? [],
      );
      conversationCacheRef.current[cacheKey] = next;
      writeConversationCache(conversationCacheRef.current, cacheKey);
      setTurns(next);
      showOlderState(selectedAgentId, sessionId, session);
    } catch (error) {
      if (attachmentScopeRef.current === scope)
        setChatError(`Could not load older messages: ${(error as Error).message}`);
    } finally {
      if (attachmentScopeRef.current === scope && olderRequest.current === request) {
        olderRequest.current = null;
        setOlderState((current) => ({ ...current, loading: false }));
      }
    }
  }, [selectedAgentId, sessionId, sessionRepository]);

  const selectSession = useCallback(
    (targetSessionId: string, targetAgentId = selectedAgentId) => {
      clearActivity();
      if (
        !targetAgentId ||
        !targetSessionId ||
        (targetAgentId === selectedAgentId && targetSessionId === sessionId)
      )
        return;
      // Remember explicit choices before React state changes so concurrent list
      // refreshes cannot restore the previous session.
      sessionIdByAgentRef.current[targetAgentId] = targetSessionId;
      parentSessionIdByAgentRef.current[targetAgentId] = targetSessionId;
      setSessionId(targetSessionId);
      setTurns([]);
      setIsLoadingConversation(true);
      setIsNewSession(false);
    },
    [selectedAgentId, sessionId, clearActivity],
  );
  const prepareAgentSelection = useCallback(
    (agentId: string) => {
      clearActivity();
      // Return to this agent’s remembered parent/root anchor, not the child.
      const targetSessionId = parentSessionIdByAgentRef.current[agentId] ?? '';
      // Clicking the already displayed parent is not navigation. Clearing it
      // would leave an unchanged effect dependency waiting for a new request.
      if (agentId === selectedAgentId && targetSessionId === sessionId) return;
      if (targetSessionId) sessionIdByAgentRef.current[agentId] = targetSessionId;
      else delete sessionIdByAgentRef.current[agentId];
      setSessionId(targetSessionId);
      setTurns([]);
      setIsLoadingConversation(true);
      setIsNewSession(false);
    },
    [clearActivity, selectedAgentId, sessionId],
  );
  const selectChildSession = useCallback(
    (agentId: string, childSessionId: string, rootSessionId?: string | null) => {
      if (agentId === selectedAgentId && childSessionId === sessionId) return;
      clearActivity();
      childSessionsRef.current.add(conversationCacheKey(agentId, childSessionId));
      if (rootSessionId) parentSessionIdByAgentRef.current[agentId] = rootSessionId;
      sessionIdByAgentRef.current[agentId] = childSessionId;
      setSessionId(childSessionId);
      setTurns([]);
      setIsLoadingConversation(true);
      setIsNewSession(false);
    },
    [clearActivity, selectedAgentId, sessionId],
  );
  const parentSessionIdForAgent = useCallback(
    (agentId: string) => parentSessionIdByAgentRef.current[agentId] || 'default',
    [],
  );
  const resetSession = useCallback(async () => {
    if (!selectedAgentId) return false;
    const resetSessionId = sessionId || 'default';
    navigationReads.current.delete(
      JSON.stringify([conversationCacheGeneration, selectedAgentId, resetSessionId]),
    );
    await sessionRepository.resetSession(selectedAgentId, resetSessionId);
    if (!isAttachmentScopeCurrent()) return false;
    noteComposerReset();
    setSessionId(resetSessionId);
    sessionIdByAgentRef.current[selectedAgentId] = resetSessionId;
    const cacheKey = conversationCacheKey(selectedAgentId, resetSessionId);
    pendingTurnsRef.current.delete(cacheKey);
    liveSnapshots.current.delete(cacheKey);
    conversationCacheRef.current[cacheKey] = [];
    writeConversationCache(conversationCacheRef.current, cacheKey);
    setTurns([]);
    setIsNewSession(true);
    setChatError('');
    return true;
  }, [selectedAgentId, sessionId, sessionRepository, isAttachmentScopeCurrent, noteComposerReset]);
  const leaveNewSessionForMessage = useCallback(() => {
    if (isNewSession) skipNextConversationLoadRef.current = true;
    setIsNewSession(false);
  }, [isNewSession]);
  const appendTurn = useCallback((agentId: string, targetSessionId: string, turn: SessionTurn) => {
    const cacheKey = conversationCacheKey(agentId, targetSessionId);
    if (turn.runId && (turn.role === 'user' || turn.role === 'assistant'))
      pendingTurnsRef.current.set(cacheKey, [
        ...(pendingTurnsRef.current.get(cacheKey) ?? []).filter(
          (pending) => pending.runId !== turn.runId || pending.role !== turn.role,
        ),
        turn,
      ]);
    const nextTurns = [...(conversationCacheRef.current[cacheKey] ?? []), turn];
    conversationCacheRef.current[cacheKey] = nextTurns;
    writeConversationCache(conversationCacheRef.current, cacheKey);
    if (
      selectedChatRef.current.agentId === agentId &&
      selectedChatRef.current.sessionId === targetSessionId
    )
      setTurns(nextTurns);
  }, []);
  const appendTransientTurn = useCallback(
    (agentId: string, targetSessionId: string, turn: SessionTurn) => {
      if (
        selectedChatRef.current.agentId === agentId &&
        selectedChatRef.current.sessionId === targetSessionId
      )
        setTurns((current) => [...current, turn]);
    },
    [],
  );
  const storeToolActivity = useCallback((activity: ToolActivity) => {
    if (!activity.runId) return;
    toolActivityByRunRef.current = { ...toolActivityByRunRef.current, [activity.runId]: activity };
    setToolActivityVersion((version) => version + 1);
  }, []);
  const toolActivityForRun = useCallback(
    (runId: string) => toolActivityByRunRef.current[runId],
    [],
  );
  const clearRunState = useCallback((agentId: string, targetSessionId: string, runId: string) => {
    const cacheKey = conversationCacheKey(agentId, targetSessionId);
    pendingTurnsRef.current.set(
      cacheKey,
      (pendingTurnsRef.current.get(cacheKey) ?? []).filter((turn) => turn.runId !== runId),
    );
    const cachedTurns = conversationCacheRef.current[cacheKey] ?? [];
    // Preserve the operator's submitted message until the authoritative refresh
    // reconciles it. Only terminal assistant artifacts from this superseded run
    // are invalid; removing the user turn here can make the request blink away.
    const nextTurns = cachedTurns.filter((turn) => turn.runId !== runId || turn.role === 'user');
    if (nextTurns.length !== cachedTurns.length) {
      conversationCacheRef.current[cacheKey] = nextTurns;
      writeConversationCache(conversationCacheRef.current, cacheKey);
      if (
        selectedChatRef.current.agentId === agentId &&
        selectedChatRef.current.sessionId === targetSessionId
      )
        setTurns(nextTurns);
    }
    if (toolActivityByRunRef.current[runId]) {
      const { [runId]: _, ...remaining } = toolActivityByRunRef.current;
      toolActivityByRunRef.current = remaining;
      setToolActivityVersion((version) => version + 1);
    }
  }, []);

  return {
    loadOlder,
    hasOlder:
      !isNewSession &&
      !isLoadingConversation &&
      !isSwitchingAgent &&
      olderState.key === conversationCacheKey(selectedAgentId, sessionId) &&
      olderState.hasMore,
    isLoadingOlder:
      olderState.key === conversationCacheKey(selectedAgentId, sessionId) && olderState.loading,
    composerResetGeneration,
    isAttachmentScopeCurrent,
    attached,
    setAttachment,
    clearAttachment,
    removeAttachment,
    isNewSession,
    leaveNewSessionForMessage,
    sessions,
    sessionId,
    turns,
    chatError,
    reportError,
    clearError,
    isLoadingConversation: isLoadingConversation || isSwitchingAgent,
    draft,
    setDraft,
    refreshSessions,
    refreshConversation,
    selectSession,
    prepareAgentSelection,
    selectChildSession,
    parentSessionIdForAgent,
    resetSession,
    appendTurn,
    appendTransientTurn,
    storeToolActivity,
    toolActivityForRun,
    clearRunState,
    a2aActivities,
    runtimeRun,
    runtimeChildActivities,
    cancelRuntimeRun,
    retireRuntimeRun,
  };
}
