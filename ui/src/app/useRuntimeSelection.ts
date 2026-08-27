import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { apiForTarget, setActiveApiTarget, type RuntimeHealth } from './api';
import type { ApiTarget } from './apiTargets';
import { usePersistedAgentSelection, usePersistedTargetSelection } from './usePersistedLayout';

type RuntimeSelectionOptions = {
  targets: ApiTarget[];
  targetsLoaded: boolean;
};

export function useRuntimeSelection({ targets, targetsLoaded }: RuntimeSelectionOptions) {
  const [selectedTargetId, setSelectedTargetId] = usePersistedTargetSelection();
  const [selectedAgentId, setSelectedAgentId] = usePersistedAgentSelection();
  const [selectedStreamId, setSelectedStreamId] = useState('');
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(() => new Set());
  const [runtimeVersion, setRuntimeVersion] = useState<string | null>(null);
  const activeTarget = targets.find((target) => target.id === selectedTargetId) ?? targets[0];
  const activeTargets = useMemo(() => activeTarget ? [activeTarget] : [], [activeTarget]);

  useEffect(() => {
    if (targetsLoaded && !targets.some((target) => target.id === selectedTargetId)) {
      setSelectedTargetId(targets[0]?.id ?? 'local');
    }
  }, [selectedTargetId, setSelectedTargetId, targets, targetsLoaded]);

  useLayoutEffect(() => {
    setActiveApiTarget(activeTarget);
  }, [activeTarget]);

  useEffect(() => {
    let cancelled = false;
    setRuntimeVersion(null);
    void apiForTarget<RuntimeHealth>(activeTarget, '/api/health').then((health) => {
      if (!cancelled) setRuntimeVersion(health.version ?? null);
    }).catch(() => {
      if (!cancelled) setRuntimeVersion(null);
    });
    return () => { cancelled = true; };
  }, [activeTarget]);

  const selectTarget = useCallback((targetId: string) => {
    setSelectedTargetId(targetId);
    setSelectedAgentId('');
    setSelectedStreamId('');
    setExpandedAgents(new Set());
  }, [setSelectedAgentId, setSelectedTargetId]);

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
    activeTarget,
    activeTargets,
    expandedAgents,
    runtimeVersion,
    selectedAgentId,
    selectedStreamId,
    selectChildStream,
    selectParentStream,
    selectTarget,
    setSelectedAgentId,
    setSelectedStreamId,
    showParentStream,
    toggleAgentExpanded,
  };
}
