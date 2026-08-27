import { useCallback, useEffect, useRef, useState } from 'react';
import { apiForTarget, type AgentStatus, type ContextStatus, type RuntimeAgent } from './api';
import { ownedResourceId, type ApiTarget } from './apiTargets';
import type { Agent, ContextDetails, SavedProvider, Subagent } from './types';
import { usePolling, type IsPollingCancelled } from './usePolling';

type RuntimeAgentHydrationOptions = {
  selectedAgentId: string;
  targets: ApiTarget[];
  setSelectedAgentId: (agentId: string) => void;
  parentSessionIdForAgent: (agentId: string) => string;
  runtimeProviders: React.MutableRefObject<SavedProvider[]>;
  setSelectedStreamId: React.Dispatch<React.SetStateAction<string>>;
  onNoAgents: () => void;
  reportError: (message: string) => void;
};

type OwnedRuntimeAgent = { agent: RuntimeAgent; target: ApiTarget; identity?: { id: string; name: string; avatar: string } };
export type RuntimeRegistryState = 'loading' | 'ready' | 'empty' | 'unavailable';
type TargetAgentResult = { target: ApiTarget; agents: OwnedRuntimeAgent[]; error?: Error };

const avatarFor = (agent: RuntimeAgent) => agent.avatar || agent.name.slice(0, 1).toUpperCase() || 'A';
const workspacePathFor = (agentId: string) => `/workspace/${agentId}`;

const asAgent = ({ agent, target, identity }: OwnedRuntimeAgent): Agent => ({
  id: ownedResourceId(target.id, agent.id),
  resourceId: agent.id,
  targetId: target.id,
  targetName: target.name,
  name: identity?.name || agent.name,
  avatar: identity?.avatar || avatarFor(agent),
  activity: agent.enabled ? 'Idle' : 'Disabled',
  context: null,
  provider: '',
  model: '',
  effort: 'medium',
  temperature: 0.2,
  workspace: workspacePathFor(agent.id),
  files: [],
  subagents: [],
});

export function formatAgentActivity(status?: string) {
  if (!status) return 'Idle';
  return status.replace(/[-_]+/g, ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function contextDetails(status: ContextStatus): ContextDetails {
  const context = status.context ?? {};
  const compaction = status.compaction ?? {};
  return {
    estimatedTokens: context.estimatedTokens ?? null,
    capacityTokens: context.capacityTokens ?? null,
    pressure: context.pressure ?? null,
    source: context.source ?? null,
    compactionActive: compaction.active === true,
    summarizedTurnCount: compaction.summarizedTurnCount ?? null,
    rawRecentTurnCount: compaction.rawRecentTurnCount ?? null,
    recallUsed: status.recall?.used === true,
    recallScope: status.recall?.scope ?? null,
    recallSourceCount: status.recall?.sourceCount ?? 0,
  };
}

function contextPercent(status: ContextStatus) {
  const { percent, usageRatio } = status.context ?? {};
  if (typeof percent === 'number') return Math.round(Math.max(0, Math.min(100, percent)));
  return typeof usageRatio === 'number' ? Math.round(Math.max(0, Math.min(1, usageRatio)) * 100) : null;
}

export function useRuntimeAgents({ selectedAgentId, targets, setSelectedAgentId, parentSessionIdForAgent, runtimeProviders, setSelectedStreamId, onNoAgents, reportError }: RuntimeAgentHydrationOptions) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [registryState, setRegistryState] = useState<RuntimeRegistryState>('loading');
  const [registryError, setRegistryError] = useState('');
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const targetKey = targets.map((target) => target.id).join('|');
  useEffect(() => {
    setAgents([]);
    setRegistryState('loading');
    setRegistryError('');
  }, [targetKey]);

  const refreshAgents = useCallback(async (isCancelled: IsPollingCancelled = () => false) => {
    const targetResults: TargetAgentResult[] = await Promise.all(targets.map(async (target) => {
      try {
        const [{ agents: runtimeAgents }, identities] = await Promise.all([
          apiForTarget<{ agents: RuntimeAgent[] }>(target, '/api/agents'),
          apiForTarget<{ agents: Array<{ id: string; name: string; avatar: string }> }>(target, '/api/settings/identities').catch(() => ({ agents: [] })),
        ]);
        const identitiesByAgentId = new Map(identities.agents.map((identity) => [identity.id, identity]));
        return { target, agents: runtimeAgents.map((agent): OwnedRuntimeAgent => ({ agent, target, identity: identitiesByAgentId.get(agent.id) })) };
      } catch (error) {
        // One unavailable remote node must not hide another healthy runtime.
        return { target, agents: [], error: error as Error };
      }
    }));
    const successfulTargets = targetResults.filter((result) => !result.error);
    const failedTargets = targetResults.filter((result) => result.error);
    const ownedAgents = successfulTargets.flatMap((result) => result.agents);
    const registered = ownedAgents.map(asAgent);
    const hydrated = await Promise.all(ownedAgents.map(async ({ agent: runtimeAgent, target }) => {
      const id = ownedResourceId(target.id, runtimeAgent.id);
      const agent = registered.find((item) => item.id === id)!;
      const parentSessionId = parentSessionIdForAgent(id);
      const [statusResult, contextResult, selectionResult] = await Promise.all([
        apiForTarget<{ agents: AgentStatus[] }>(target, `/api/agent-status?sessionId=${encodeURIComponent(parentSessionId)}&agentId=${encodeURIComponent(runtimeAgent.id)}`).catch(() => ({ agents: [] })),
        apiForTarget<{ status: ContextStatus }>(target, `/api/session/context-status?agentId=${encodeURIComponent(runtimeAgent.id)}&sessionId=${encodeURIComponent(parentSessionId)}`).catch(() => ({ status: {} })),
        apiForTarget<{ selection: { connectionId: string; model: string; reasoningEffort: string; temperature?: number } | null }>(target, `/api/agents/${encodeURIComponent(runtimeAgent.id)}/model-selection`).catch(() => ({ selection: null })),
      ]);
      const parentStatus = statusResult.agents.find((item) => item.sessionId === parentSessionId && !item.parentSessionId);
      const status = parentStatus?.status?.toLowerCase();
      const childStatuses = statusResult.agents.filter((item) => item.parentSessionId === parentStatus?.sessionId);
      const subagents: Subagent[] = await Promise.all(childStatuses.map(async (child) => {
        const childContext = await apiForTarget<{ status: ContextStatus }>(target, `/api/session/context-status?agentId=${encodeURIComponent(runtimeAgent.id)}&sessionId=${encodeURIComponent(child.sessionId)}`).catch(() => ({ status: {} }));
        return { id: ownedResourceId(target.id, child.sessionId), resourceId: child.sessionId, targetId: target.id, name: child.label || child.subagentId || 'Subagent', avatar: '↳', activity: formatAgentActivity(child.status), context: contextPercent(childContext.status), contextDetails: contextDetails(childContext.status), stream: ownedResourceId(target.id, child.sessionId), subagentId: child.subagentId };
      }));
      const selection = selectionResult.selection;
      // Provider configuration is runtime-owned. Use matching local metadata only
      // when available; chat requests otherwise omit the optional model override.
      const selectedProvider = runtimeProviders.current.find((item) => item.id === selection?.connectionId && item.models.includes(selection.model));
      const provider = selectedProvider ?? runtimeProviders.current.find((item) => item.provider === agent.provider) ?? (target.baseUrl ? undefined : runtimeProviders.current[0]);
      const configured = !provider ? agent : (() => {
        const model = selectedProvider && selection ? selection.model : provider.models.includes(agent.model) ? agent.model : provider.models[0];
        const efforts = ['off', ...(provider.modelEfforts?.[model] ?? []).filter((item) => item !== 'off')];
        const effort = selectedProvider && selection && efforts.includes(selection.reasoningEffort) ? selection.reasoningEffort : provider.defaultEfforts?.[model] ?? agent.effort;
        const temperature = typeof selection?.temperature === 'number' && Number.isFinite(selection.temperature) ? selection.temperature : agent.temperature;
        return { ...agent, provider: provider.provider, model, effort, temperature };
      })();
      return { ...configured, activity: runtimeAgent.enabled ? formatAgentActivity(status) : 'Disabled', context: contextPercent(contextResult.status), contextDetails: contextDetails(contextResult.status), subagents };
    }));
    if (isCancelled()) return;
    if (successfulTargets.length === 0) {
      const message = failedTargets.map(({ target, error }) => `${target.name}: ${error?.message || 'Unavailable'}`).join('; ');
      setRegistryState('unavailable');
      setRegistryError(message || 'The selected runtime is unavailable.');
      reportError(`Could not load agents: ${message || 'The selected runtime is unavailable.'}`);
      return;
    }
    const enabled = hydrated.filter((agent) => agent.activity !== 'Disabled');
    const fallbackAgentId = enabled[0]?.id ?? hydrated[0]?.id ?? '';
    const nextAgentId = hydrated.some((agent) => agent.id === selectedAgentId) ? selectedAgentId : fallbackAgentId;
    setAgents(hydrated);
    setRegistryState(hydrated.length === 0 ? 'empty' : 'ready');
    setRegistryError(failedTargets.map(({ target, error }) => `${target.name}: ${error?.message || 'Unavailable'}`).join('; '));
    if (hydrated.length === 0) onNoAgents();
    setSelectedAgentId(nextAgentId);
    setSelectedStreamId((streamId) => hydrated.find((agent) => agent.id === nextAgentId)?.subagents.some((subagent) => subagent.id === streamId) ? streamId : nextAgentId);
  }, [onNoAgents, parentSessionIdForAgent, reportError, runtimeProviders, selectedAgentId, setSelectedAgentId, setSelectedStreamId, targets]);

  usePolling(async (isCancelled) => {
    try {
      await refreshAgents(isCancelled);
    } catch (error) {
      if (!isCancelled()) {
        reportError(`Could not load agents: ${(error as Error).message}`);
        if (agentsRef.current.length === 0) onNoAgents();
      }
    }
  }, 15_000, true, targetKey);

  return { agents, setAgents, refreshAgents, registryState, registryError };
}
