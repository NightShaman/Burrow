import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, apiForTarget, textFromChatValue, type ChatAttachment, type ChatSession, type ProgressEntry, type SessionSummary, type SessionToolActivity, type SessionTurn, type ToolActivity } from '../../app/api';
import { localApiTarget, targetForResource, type ApiTarget } from '../../app/apiTargets';

type ConversationCache = Record<string, SessionTurn[]>;
type ConversationCacheEntry = { savedAt: number; turns: SessionTurn[] };
type DraftRecord = { value: string; updatedAt: number };
type DraftCache = Record<string, DraftRecord>;

const conversationCacheStorageKey = 'hc.chatConversations.v1';
const conversationCacheLimit = 24;
const sessionListCacheStorageKey = 'hc.chatSessions.v1';
const sessionListCacheLimit = 16;
const draftCacheStorageKey = 'hc.chatDrafts';
const draftRetentionMs = 24 * 60 * 60 * 1_000;
const defaultApiTargets = [localApiTarget];

function mergeSessionActivities(turns: SessionTurn[], activities: SessionToolActivity[]): SessionTurn[] {
  const activityByRun = new Map(activities.filter((activity) => activity.runId).map((activity) => [activity.runId, activity]));
  return turns.map((turn) => {
    if (turn.role !== 'assistant' || !turn.runId) return { ...turn, content: textFromChatValue(turn.content) };
    const activity = activityByRun.get(turn.runId);
    if (!activity) return { ...turn, content: textFromChatValue(turn.content) };
    const toolActivity: ToolActivity = {
      runId: activity.runId,
      summary: activity.summary,
      status: activity.items.some((item) => item.status === 'error') ? 'warn' : 'ok',
      items: activity.items.map((item, index) => ({ id: `${activity.runId}:${index}`, label: item.label, detail: item.detail, status: item.status })),
    };
    return { ...turn, content: textFromChatValue(turn.content), metadata: { ...turn.metadata, toolActivity } };
  });
}

function reconcileConversationTurns(serverTurns: SessionTurn[], localTurns: SessionTurn[]): SessionTurn[] {
  // A run writes its user and assistant turns independently. A terminal
  // refresh can therefore see only one of them while persistence catches up;
  // treating the run id as one indivisible record would erase its missing mate.
  const serverTurnKeys = new Set(serverTurns.map((turn) => turn.runId ? `${turn.runId}:${turn.role}` : ''));
  const missingLocalTurns = localTurns.filter((turn) => turn.runId && !serverTurnKeys.has(`${turn.runId}:${turn.role}`));
  const localTurnsByRunAndRole = new Map(localTurns.filter((turn) => turn.runId && turn.role).map((turn) => [`${turn.runId}:${turn.role}`, turn]));
  const mergedServerTurns = serverTurns.map((turn) => {
    const local = turn.runId && turn.role ? localTurnsByRunAndRole.get(`${turn.runId}:${turn.role}`) : undefined;
    const streamedAnswer = turn.role === 'assistant' && !turn.metadata?.streamedAnswer ? local?.metadata?.streamedAnswer : undefined;
    // The optimistic user turn has the attachment manifest immediately. Keep
    // it when the server's first refreshed snapshot has not caught up with its
    // separately persisted metadata, rather than making the chip disappear.
    const attachments = !turn.metadata?.attachments?.length ? local?.metadata?.attachments : undefined;
    return streamedAnswer || attachments
      ? { ...turn, metadata: { ...turn.metadata, ...(streamedAnswer ? { streamedAnswer } : {}), ...(attachments ? { attachments } : {}) } }
      : turn;
  });
  if (!missingLocalTurns.length) return mergedServerTurns;
  return [...mergedServerTurns, ...missingLocalTurns].sort((a, b) => {
    const aTime = a.ts ? Date.parse(a.ts) : 0;
    const bTime = b.ts ? Date.parse(b.ts) : 0;
    return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
  });
}

function readConversationCache(): ConversationCache {
  if (typeof window === 'undefined') return {};
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(conversationCacheStorageKey) ?? '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored)
      .filter(([, entry]) => entry && typeof entry === 'object' && Array.isArray((entry as ConversationCacheEntry).turns))
      .sort(([, a], [, b]) => (b as ConversationCacheEntry).savedAt - (a as ConversationCacheEntry).savedAt)
      .slice(0, conversationCacheLimit)
      .map(([key, entry]) => [key, (entry as ConversationCacheEntry).turns]));
  } catch {
    return {};
  }
}

function readSessionListCache(agentId: string): SessionSummary[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = JSON.parse(window.localStorage.getItem(sessionListCacheStorageKey) ?? '{}') as Record<string, { savedAt: number; sessions: SessionSummary[] }>;
    const entry = stored[agentId];
    return entry && Array.isArray(entry.sessions) ? entry.sessions : null;
  } catch {
    return null;
  }
}

function writeSessionListCache(agentId: string, sessions: SessionSummary[]) {
  if (typeof window === 'undefined') return;
  try {
    const stored = JSON.parse(window.localStorage.getItem(sessionListCacheStorageKey) ?? '{}') as Record<string, { savedAt: number; sessions: SessionSummary[] }>;
    const next = { ...stored, [agentId]: { savedAt: Date.now(), sessions } };
    const entries = Object.entries(next).sort(([, a], [, b]) => b.savedAt - a.savedAt).slice(0, sessionListCacheLimit);
    window.localStorage.setItem(sessionListCacheStorageKey, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Session-list caching is best-effort.
  }
}

function writeConversationCache(cache: ConversationCache, touchedKey?: string) {
  if (typeof window === 'undefined') return;
  try {
    const stored: Record<string, ConversationCacheEntry> = JSON.parse(window.localStorage.getItem(conversationCacheStorageKey) ?? '{}');
    const next = { ...stored };
    Object.entries(cache).forEach(([key, turns]) => {
      next[key] = { savedAt: key === touchedKey ? Date.now() : next[key]?.savedAt ?? Date.now(), turns };
    });
    const entries = Object.entries(next).sort(([, a], [, b]) => b.savedAt - a.savedAt).slice(0, conversationCacheLimit);
    window.localStorage.setItem(conversationCacheStorageKey, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Caching is an enhancement; storage failures must not affect chat loading.
  }
}

export function conversationCacheKey(agentId: string, sessionId: string) {
  return `${agentId}:${sessionId}`;
}

function readDraftCache(): DraftCache {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(draftCacheStorageKey) ?? '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    const oldestAllowed = Date.now() - draftRetentionMs;
    return Object.fromEntries(Object.entries(stored).flatMap(([key, record]) => {
      if (!record || typeof record !== 'object') return [];
      const { value, updatedAt } = record as Record<string, unknown>;
      return typeof value === 'string' && value && typeof updatedAt === 'number' && updatedAt >= oldestAllowed
        ? [[key, { value, updatedAt }]]
        : [];
    }));
  } catch {
    return {};
  }
}

/** Owns durable chat-session state, draft retention, and runtime reconciliation. */
export function useChatSession(selectedAgentId: string, targets: ApiTarget[] = defaultApiTargets) {
  const ownerFor = useCallback((agentId: string) => targetForResource(targets, agentId), [targets]);
  const requestFor = useCallback(<T,>(target: ApiTarget, path: string, init?: RequestInit) => target.baseUrl
    ? apiForTarget<T>(target, path, init)
    : init === undefined ? api<T>(path) : api<T>(path, init), []);
  const [draftCache, setDraftCache] = useState<DraftCache>(readDraftCache);
  const [attached, setAttached] = useState<ChatAttachment[]>([]);
  const [isNewSession, setIsNewSession] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [chatError, setChatError] = useState('');
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const [toolActivityByRun, setToolActivityByRun] = useState<Record<string, ToolActivity>>({});
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

  useEffect(() => {
    try { localStorage.setItem(draftCacheStorageKey, JSON.stringify(draftCache)); } catch { /* Draft retention is best-effort. */ }
  }, [draftCache]);
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
    const owner = ownerFor(selectedAgentId);
    requestFor<{ sessions: SessionSummary[] }>(owner.target, `/api/sessions?agentId=${encodeURIComponent(owner.resourceId)}`).then(({ sessions: nextSessions }) => {
      if (cancelled) return;
      writeSessionListCache(selectedAgentId, nextSessions);
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
  }, [selectedAgentId]);

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
    const owner = ownerFor(selectedAgentId);
    const sessionPath = `/api/sessions/${encodeURIComponent(sessionId)}?agentId=${encodeURIComponent(owner.resourceId)}`;
    requestFor<{ session: ChatSession }>(owner.target, sessionPath).then(({ session }) => {
      if (cancelled || conversationCacheRef.current[cacheKey] !== cachedTurns) return;
      const nextTurns = reconcileConversationTurns(mergeSessionActivities(session.turns ?? [], session.activities ?? []), conversationCacheRef.current[cacheKey] ?? []);
      conversationCacheRef.current[cacheKey] = nextTurns;
      writeConversationCache(conversationCacheRef.current, cacheKey);
      setTurns(nextTurns);
    }).catch((error: Error) => !cancelled && setChatError(`Could not load conversation: ${error.message}`)).finally(() => !cancelled && setIsLoadingConversation(false));
    return () => { cancelled = true; };
  }, [isNewSession, ownerFor, selectedAgentId, sessionId]);

  const refreshSessions = useCallback(async (agentId = selectedAgentId) => {
    if (!agentId) return;
    const owner = ownerFor(agentId);
    const { sessions: nextSessions } = await requestFor<{ sessions: SessionSummary[] }>(owner.target, `/api/sessions?agentId=${encodeURIComponent(owner.resourceId)}`);
    writeSessionListCache(agentId, nextSessions);
    if (selectedChatRef.current.agentId === agentId) setSessions(nextSessions);
  }, [ownerFor, selectedAgentId]);
  const refreshConversation = useCallback(async (agentId = selectedAgentId, targetSessionId = sessionId) => {
    if (!agentId || !targetSessionId) return;
    const cacheKey = conversationCacheKey(agentId, targetSessionId);
    const turnsAtRequestStart = conversationCacheRef.current[cacheKey];
    const owner = ownerFor(agentId);
    const sessionPath = `/api/sessions/${encodeURIComponent(targetSessionId)}?agentId=${encodeURIComponent(owner.resourceId)}`;
    const { session } = await requestFor<{ session: ChatSession }>(owner.target, sessionPath);
    // A refresh started before a direct send may resolve after appendTurn has
    // added the optimistic user message. That older server snapshot must not
    // erase newer local turns; the run's terminal refresh will reconcile once
    // persistence is complete.
    if (conversationCacheRef.current[cacheKey] !== turnsAtRequestStart) return;
    const nextTurns = reconcileConversationTurns(
      mergeSessionActivities(session.turns ?? [], session.activities ?? []),
      conversationCacheRef.current[cacheKey] ?? [],
    ).map((turn) => {
      const activity = turn.runId ? toolActivityByRunRef.current[turn.runId] : undefined;
      const normalizedTurn = { ...turn, content: textFromChatValue(turn.content) };
      return normalizedTurn.role === 'assistant' && activity?.items?.length ? { ...normalizedTurn, metadata: { ...normalizedTurn.metadata, toolActivity: activity } } : normalizedTurn;
    });
    conversationCacheRef.current[cacheKey] = nextTurns;
    writeConversationCache(conversationCacheRef.current, cacheKey);
    const current = selectedChatRef.current;
    if (current.agentId === agentId && current.sessionId === targetSessionId) setTurns(nextTurns);
  }, [ownerFor, selectedAgentId, sessionId]);
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
    const owner = ownerFor(selectedAgentId);
    await requestFor(owner.target, `/api/sessions/${encodeURIComponent(sessionId || 'default')}/reset?agentId=${encodeURIComponent(owner.resourceId)}`, { method: 'POST' });
    setSessionId('default');
    sessionIdByAgentRef.current[selectedAgentId] = 'default';
    const cacheKey = conversationCacheKey(selectedAgentId, 'default');
    conversationCacheRef.current[cacheKey] = [];
    writeConversationCache(conversationCacheRef.current, cacheKey);
    setTurns([]);
    setIsNewSession(true);
    setChatError('');
  }, [ownerFor, selectedAgentId, sessionId]);
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
    setToolActivityByRun(toolActivityByRunRef.current);
  }, []);
  const toolActivityForRun = useCallback((runId: string) => toolActivityByRunRef.current[runId], []);
  const setAttachment = useCallback((attachments: ChatAttachment[]) => setAttached((current) => [...current, ...attachments]), []);
  const clearAttachment = useCallback(() => setAttached([]), []);
  const removeAttachment = useCallback((index: number) => setAttached((current) => current.filter((_, attachmentIndex) => attachmentIndex !== index)), []);
  const reportError = useCallback((message: string) => setChatError(message), []);
  const clearError = useCallback(() => setChatError(''), []);

  return { attached, setAttachment, clearAttachment, removeAttachment, isNewSession, leaveNewSessionForMessage, sessions, sessionId, turns, chatError, reportError, clearError, isLoadingConversation: isLoadingConversation || isSwitchingAgent, draft, setDraft, refreshSessions, refreshConversation, selectSession, prepareAgentSelection, selectChildSession, parentSessionIdForAgent, resetSession, appendTurn, storeToolActivity, toolActivityForRun };
}
