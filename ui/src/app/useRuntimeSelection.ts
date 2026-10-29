import { useCallback, useState } from 'react';
import { usePersistedAgentSelection } from './usePersistedLayout';

// Child sessions are only unique within their owning agent. Keep this UI-only
// identity separate from the raw session resource used by runtime APIs.
export const childStreamId = (agentId: string, sessionId: string) => JSON.stringify(['child', agentId, sessionId]);

export function useRuntimeSelection() {
  const [selectedAgentId, setSelectedAgentId] = usePersistedAgentSelection();
  const [selectedStreamId, setSelectedStreamId] = useState('');
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(() => new Set());

  const selectParentStream = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
    setSelectedStreamId(agentId);
  }, [setSelectedAgentId]);

  const selectChildStream = useCallback((agentId: string, sessionId: string) => {
    setSelectedAgentId(agentId);
    setSelectedStreamId(childStreamId(agentId, sessionId));
  }, [setSelectedAgentId]);

  const showParentStream = useCallback(() => {
    setSelectedStreamId(selectedAgentId);
  }, [selectedAgentId]);

  const toggleAgentExpanded = useCallback((agentId: string) => {
    setExpandedAgents((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);

  return {
    expandedAgents,
    selectedAgentId,
    selectedStreamId,
    selectChildStream,
    selectParentStream,
    setSelectedAgentId,
    setSelectedStreamId,
    showParentStream,
    toggleAgentExpanded,
  };
}
