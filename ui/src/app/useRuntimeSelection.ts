import { useCallback, useState } from 'react';
import { usePersistedAgentSelection } from './usePersistedLayout';

export function useRuntimeSelection() {
  const [selectedAgentId, setSelectedAgentId] = usePersistedAgentSelection();
  const [selectedStreamId, setSelectedStreamId] = useState('');
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(() => new Set());

  const selectParentStream = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
    setSelectedStreamId(agentId);
  }, [setSelectedAgentId]);

  const selectChildStream = useCallback((agentId: string, streamId: string) => {
    setSelectedAgentId(agentId);
    setSelectedStreamId(streamId);
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
