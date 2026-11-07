import { useCallback, type MutableRefObject, type Dispatch, type SetStateAction } from 'react';
import type { SessionTurn } from '../../app/api';
import { conversationCacheKey } from './chatConversationCache';

/** Coordinates explicit selections and the per-agent parent return anchor. */
export function useConversationSelection({
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
}: {
  selectedAgentId: string;
  sessionId: string;
  clearActivity: () => void;
  childSessionsRef: MutableRefObject<Set<string>>;
  sessionIdByAgentRef: MutableRefObject<Record<string, string>>;
  parentSessionIdByAgentRef: MutableRefObject<Record<string, string>>;
  setSessionId: Dispatch<SetStateAction<string>>;
  setTurns: Dispatch<SetStateAction<SessionTurn[]>>;
  setIsLoadingConversation: Dispatch<SetStateAction<boolean>>;
  setIsNewSession: Dispatch<SetStateAction<boolean>>;
}) {
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
  return { selectSession, prepareAgentSelection, selectChildSession, parentSessionIdForAgent };
}
