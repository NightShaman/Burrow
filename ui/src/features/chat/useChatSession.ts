import { useConversationAuthority } from './useConversationAuthority';
import { useConversationSelection } from './useConversationSelection';
import { useConversationRevalidation } from './useConversationRevalidation';
import { shareChatRows } from './chatValueEquality';
import { useChatRecovery } from './useChatRecovery';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChatComposer } from './useChatComposer';
import {
  textFromChatValue,
  type SessionSummary,
  type SessionTurn,
  type ToolActivity,
} from '../../app/api';
import { conversationCacheGeneration, conversationCacheKey } from './chatConversationCache';
import { finalizeThoughtProgress } from './chatThoughtProgress';
import { chatTerminalMetadata } from './chatTerminal';
import { readSessionListCache } from './chatSessionRepository';

export { conversationCacheKey } from './chatConversationCache';

/** Owns conversation freshness, navigation, and runtime reconciliation. */
export function useChatSession(selectedAgentId: string) {
  const [sessionId, setSessionId] = useState('');
  const authority = useConversationAuthority(() => setTurns([]), selectedAgentId, sessionId);
  const {
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
    olderState,
    showOlderState,
    restoreOlderState,
  } = authority;
  const [isNewSession, setIsNewSession] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const attachmentKey = JSON.stringify([selectedAgentId, sessionId]);
  const attachmentScopeRef = useRef({ key: attachmentKey });
  if (attachmentScopeRef.current.key !== attachmentKey) {
    attachmentScopeRef.current = { key: attachmentKey };
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
      const recoveredTurns = reconcileSnapshot(cacheKey, session, cachedTurns ?? []).map((turn) => {
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
      const nextTurns = shareChatRows(cachedTurns ?? [], recoveredTurns);
      rememberLiveSnapshot(cacheKey, session.metadata?.updatedAt ?? '');
      if (nextTurns !== cachedTurns) commitSnapshot(cacheKey, nextTurns);
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
    if (live) restoreOlderState(cacheKey);
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
        commitSnapshot(cacheKey, nextTurns);
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
      commitSnapshot(cacheKey, nextTurns);
      showOlderState(agentId, targetSessionId, session);
      const current = selectedChatRef.current;
      if (current.agentId === agentId && current.sessionId === targetSessionId) setTurns(nextTurns);
    },
    [selectedAgentId, sessionId, sessionRepository],
  );

  useConversationRevalidation({
    authority,
    showOlderState,
    selectedChatRef,
    setTurns,
    setIsLoadingConversation,
  });

  const loadOlder = useCallback(
    () => authority.loadOlder(selectedAgentId, sessionId, setTurns, setChatError),
    [selectedAgentId, sessionId, authority.loadOlder],
  );

  const { selectSession, prepareAgentSelection, selectChildSession, parentSessionIdForAgent } =
    useConversationSelection({
      selectedAgentId,
      sessionId,
      clearActivity,
      childSessionsRef,
      sessionIdByAgentRef,
      parentSessionIdByAgentRef,
      setSessionId,
      setTurns,
      setIsLoadingConversation,
      setIsNewSession,
    });
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
    resetSnapshot(cacheKey);
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
    const nextTurns = appendLocalTurn(cacheKey, turn);
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
      commitSnapshot(cacheKey, nextTurns);
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
