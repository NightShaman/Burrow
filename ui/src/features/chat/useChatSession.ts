import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { textFromChatValue, type ChatAttachment, type SessionSummary, type SessionTurn, type ToolActivity } from '../../app/api';
import { localApiTarget, type ApiTarget } from '../../app/apiTargets';
import { conversationCacheKey, readConversationCache, writeConversationCache, type ConversationCache } from './chatConversationCache';
import { readDraftCache, writeDraftCache, type DraftCache } from './chatDraftCache';
import { reconcileSessionTurns } from './chatTurnReconciliation';
import { createChatSessionRepository, readSessionListCache } from './chatSessionRepository';

export { conversationCacheKey } from './chatConversationCache';

const defaultApiTargets = [localApiTarget];

/** Owns durable chat-session state, draft retention, and runtime reconciliation. */
export function useChatSession(selectedAgentId: string, targets: ApiTarget[] = defaultApiTargets) {
  const sessionRepository = useMemo(() => createChatSessionRepository(targets), [targets]);
  const [draftCache, setDraftCache] = useState<DraftCache>(readDraftCache);
  const [attached, setAttached] = useState<ChatAttachment[]>([]);
  const [isNewSession, setIsNewSession] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [chatError, setChatError] = useState('');
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const [, setToolActivityVersion] = useState(0);
  const conversationCacheRef = useRef<ConversationCache>(readConversationCache());
  // The displayed chat session may be a child session. Agent-status is scoped
  // separately to the parent session and must never follow that selection.
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
  const draftKey = selectedAgentId && sessionId ? conversationCacheKey(selectedAgentId, sessionId) : '';
  const draft = draftKey ? draftCache[draftKey]?.value ?? '' : '';

  const setDraft = useCallback((value: string) => {
    if (!draftKey) return;
    setDraftCache((current) => {
      if (!value) {
        if (!current[draftKey]) return current;
        const { [draftKey]: _, ...remaining } = current;
        return remaining;
      }
      return { ...current, [draftKey]: { value, updatedAt: Date.now() } };
    });
  }, [draftKey]);

  useEffect(() => { writeDraftCache(draftCache); }, [draftCache]);
  useEffect(() => { selectedChatRef.current = { agentId: selectedAgentId, sessionId }; }, [selectedAgentId, sessionId]);

  // This must run before paint. A regular effect runs after React commits the
  // new rail selection, leaving one frame where Chat sees no turns and no
  // loading flag and therefore renders the new-session logo.
  useLayoutEffect(() => {
    committedAgentIdRef.current = selectedAgentId;
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
    // Keep the currently rendered conversation in place until the incoming
    // agent's session resolves. Clearing it here creates a blank frame between
    // two real conversations; loading state prevents it from being mistaken
    // for a settled empty session.
    // The session list must resolve before the new agent's conversation can
    // load. Mark that whole handoff as loading so an empty-state logo only
    // represents a deliberate new/reset session, never an agent switch.
    const cachedSessions = readSessionListCache(selectedAgentId);
    if (cachedSessions) {
      setSessions(cachedSessions);
      setIsLoadingConversation(false);
      setSessionId((current) => {
        const remembered = sessionIdByAgentRef.current[selectedAgentId];
        const availableSessionIds = new Set(cachedSessions.map((session) => session.id));
        const rememberedSelection = remembered && remembered !== 'default' ? remembered : '';
        const nextSessionId = rememberedSelection || ([current, 'default', cachedSessions[0]?.id].find((id): id is string => Boolean(id && availableSessionIds.has(id))) ?? '');
        if (nextSessionId) sessionIdByAgentRef.current[selectedAgentId] = nextSessionId;
        if (!parentSessionIdByAgentRef.current[selectedAgentId]) parentSessionIdByAgentRef.current[selectedAgentId] = availableSessionIds.has('default') ? 'default' : cachedSessions[0]?.id ?? 'default';
        return nextSessionId;
      });
    } else {
      setIsLoadingConversation(true);
    }
    let cancelled = false;
    sessionRepository.listSessions(selectedAgentId).then((nextSessions) => {
      if (cancelled) return;
      setSessions(nextSessions);
      if (!nextSessions.length && !sessionIdByAgentRef.current[selectedAgentId]) setIsLoadingConversation(false);
      setSessionId((current) => {
        const remembered = sessionIdByAgentRef.current[selectedAgentId];
        const availableSessionIds = new Set(nextSessions.map((session) => session.id));
        // Child sessions are surfaced by /api/agent-status, not necessarily by
        // the parent's /api/sessions list. Preserve an explicitly selected
        // non-default session while that list refreshes.
        // `remembered` is the authoritative selection for this agent. A child
        // session intentionally is not required to appear in the parent's
        // `/api/sessions` collection, so do not discard it during the list
        // refresh that follows a rail click.
        const rememberedSelection = remembered && remembered !== 'default' ? remembered : '';
        const nextSessionId = rememberedSelection || ([current, 'default', nextSessions[0]?.id].find((id): id is string => Boolean(id && availableSessionIds.has(id))) ?? '');
        if (nextSessionId) sessionIdByAgentRef.current[selectedAgentId] = nextSessionId;
        if (!parentSessionIdByAgentRef.current[selectedAgentId]) {
          // Parent status/context must follow the canonical default session,
          // not whichever named session the API happens to return first.
          parentSessionIdByAgentRef.current[selectedAgentId] = availableSessionIds.has('default') ? 'default' : nextSessions[0]?.id ?? 'default';
        }
        return nextSessionId;
      });
    }).catch((error: Error) => {
      if (cancelled) return;
      setChatError(`Could not load sessions: ${error.message}`);
      setIsLoadingConversation(false);
    });
    return () => { cancelled = true; };
  }, [selectedAgentId, sessionRepository]);

  useEffect(() => {
    // A blank composer belongs to the agent that requested it, not whichever
    // agent is selected next.
    setIsNewSession(false);
  }, [selectedAgentId]);

  useEffect(() => {
    // An agent switch deliberately clears the target session id while its
    // session list loads. Do not clear `turns` for that intermediate state:
    // doing so creates the visible chat → blank → chat flash. The old rendered
    // conversation stays in place under the loading state until the new one is
    // available. Only an explicit new/reset session or no selected agent gets
    // a blank transcript here.
    if (!selectedAgentId || isNewSession) { setTurns([]); return; }
    if (!sessionId) return;
    if (skipNextConversationLoadRef.current) {
      skipNextConversationLoadRef.current = false;
      setIsLoadingConversation(false);
      return;
    }
    let cancelled = false;
    const cacheKey = conversationCacheKey(selectedAgentId, sessionId);
    const cachedTurns = conversationCacheRef.current[cacheKey];
    if (cachedTurns) {
      setTurns(cachedTurns);
      setIsLoadingConversation(false);
    } else {
      // Retain the previous rendered surface until this conversation arrives.
      // Replacing it with an empty array produces a visible blank flash on
      // every uncached agent/session switch.
      setIsLoadingConversation(true);
    }
    setChatError('');
    sessionRepository.loadSession(selectedAgentId, sessionId).then((session) => {
      if (cancelled || conversationCacheRef.current[cacheKey] !== cachedTurns) return;
      const nextTurns = reconcileSessionTurns(session, conversationCacheRef.current[cacheKey] ?? []);
      conversationCacheRef.current[cacheKey] = nextTurns;
      writeConversationCache(conversationCacheRef.current, cacheKey);
      setTurns(nextTurns);
    }).catch((error: Error) => !cancelled && setChatError(`Could not load conversation: ${error.message}`)).finally(() => !cancelled && setIsLoadingConversation(false));
    return () => { cancelled = true; };
  }, [isNewSession, selectedAgentId, sessionId, sessionRepository]);

  const refreshSessions = useCallback(async (agentId = selectedAgentId) => {
    if (!agentId) return;
    const nextSessions = await sessionRepository.listSessions(agentId);
    if (selectedChatRef.current.agentId === agentId) setSessions(nextSessions);
  }, [selectedAgentId, sessionRepository]);
  const refreshConversation = useCallback(async (agentId = selectedAgentId, targetSessionId = sessionId) => {
    if (!agentId || !targetSessionId) return;
    const cacheKey = conversationCacheKey(agentId, targetSessionId);
    const turnsAtRequestStart = conversationCacheRef.current[cacheKey];
    const session = await sessionRepository.loadSession(agentId, targetSessionId);
    // A refresh started before a direct send may resolve after appendTurn has
    // added the optimistic user message. That older server snapshot must not
    // erase newer local turns; the run's terminal refresh will reconcile once
    // persistence is complete.
    if (conversationCacheRef.current[cacheKey] !== turnsAtRequestStart) return;
    const nextTurns = reconcileSessionTurns(session, conversationCacheRef.current[cacheKey] ?? []).map((turn) => {
      const activity = turn.runId ? toolActivityByRunRef.current[turn.runId] : undefined;
      const normalizedTurn = { ...turn, content: textFromChatValue(turn.content) };
      return normalizedTurn.role === 'assistant' && activity?.items?.length ? { ...normalizedTurn, metadata: { ...normalizedTurn.metadata, toolActivity: activity } } : normalizedTurn;
    });
    conversationCacheRef.current[cacheKey] = nextTurns;
    writeConversationCache(conversationCacheRef.current, cacheKey);
    const current = selectedChatRef.current;
    if (current.agentId === agentId && current.sessionId === targetSessionId) setTurns(nextTurns);
  }, [selectedAgentId, sessionId, sessionRepository]);
  const selectSession = useCallback((targetSessionId: string) => {
    if (!selectedAgentId || !targetSessionId || targetSessionId === sessionId) return;
    // Remember explicit choices before React state changes so concurrent list
    // refreshes cannot restore the previous session.
    sessionIdByAgentRef.current[selectedAgentId] = targetSessionId;
    setSessionId(targetSessionId);
    setTurns(conversationCacheRef.current[conversationCacheKey(selectedAgentId, targetSessionId)] ?? []);
    setIsNewSession(false);
    setChatError('');
  }, [selectedAgentId, sessionId]);
  const prepareAgentSelection = useCallback((agentId: string) => {
    // Rail selections always reopen the parent's canonical session rather than
    // inheriting a displayed child session.
    const targetSessionId = parentSessionIdByAgentRef.current[agentId] ?? '';
    if (targetSessionId) sessionIdByAgentRef.current[agentId] = targetSessionId;
    else delete sessionIdByAgentRef.current[agentId];
    setSessionId(targetSessionId);
    const cachedTurns = targetSessionId ? conversationCacheRef.current[conversationCacheKey(agentId, targetSessionId)] : undefined;
    if (cachedTurns) setTurns(cachedTurns);
    setIsNewSession(false);
    setChatError('');
  }, []);
  const selectChildSession = useCallback((agentId: string, childSessionId: string) => {
    sessionIdByAgentRef.current[agentId] = childSessionId;
    setSessionId(childSessionId);
    setTurns(conversationCacheRef.current[conversationCacheKey(agentId, childSessionId)] ?? []);
    setIsNewSession(false);
    setChatError('');
  }, []);
  const parentSessionIdForAgent = useCallback((agentId: string) => parentSessionIdByAgentRef.current[agentId] || 'default', []);
  const resetSession = useCallback(async () => {
    if (!selectedAgentId) return;
    await sessionRepository.resetSession(selectedAgentId, sessionId || 'default');
    setSessionId('default');
    sessionIdByAgentRef.current[selectedAgentId] = 'default';
    const cacheKey = conversationCacheKey(selectedAgentId, 'default');
    conversationCacheRef.current[cacheKey] = [];
    writeConversationCache(conversationCacheRef.current, cacheKey);
    setTurns([]);
    setIsNewSession(true);
    setChatError('');
  }, [selectedAgentId, sessionId, sessionRepository]);
  const leaveNewSessionForMessage = useCallback(() => {
    if (isNewSession) skipNextConversationLoadRef.current = true;
    setIsNewSession(false);
  }, [isNewSession]);
  const appendTurn = useCallback((agentId: string, targetSessionId: string, turn: SessionTurn) => {
    const cacheKey = conversationCacheKey(agentId, targetSessionId);
    const nextTurns = [...(conversationCacheRef.current[cacheKey] ?? []), turn];
    conversationCacheRef.current[cacheKey] = nextTurns;
    writeConversationCache(conversationCacheRef.current, cacheKey);
    if (selectedChatRef.current.agentId === agentId && selectedChatRef.current.sessionId === targetSessionId) setTurns(nextTurns);
  }, []);
  const storeToolActivity = useCallback((activity: ToolActivity) => {
    if (!activity.runId) return;
    toolActivityByRunRef.current = { ...toolActivityByRunRef.current, [activity.runId]: activity };
    setToolActivityVersion((version) => version + 1);
  }, []);
  const toolActivityForRun = useCallback((runId: string) => toolActivityByRunRef.current[runId], []);
  const setAttachment = useCallback((attachments: ChatAttachment[]) => setAttached((current) => [...current, ...attachments]), []);
  const clearAttachment = useCallback(() => setAttached([]), []);
  const removeAttachment = useCallback((index: number) => setAttached((current) => current.filter((_, attachmentIndex) => attachmentIndex !== index)), []);
  const reportError = useCallback((message: string) => setChatError(message), []);
  const clearError = useCallback(() => setChatError(''), []);

  return { attached, setAttachment, clearAttachment, removeAttachment, isNewSession, leaveNewSessionForMessage, sessions, sessionId, turns, chatError, reportError, clearError, isLoadingConversation: isLoadingConversation || isSwitchingAgent, draft, setDraft, refreshSessions, refreshConversation, selectSession, prepareAgentSelection, selectChildSession, parentSessionIdForAgent, resetSession, appendTurn, storeToolActivity, toolActivityForRun };
}
