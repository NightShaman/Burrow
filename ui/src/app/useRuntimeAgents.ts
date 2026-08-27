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

type AgentIdentity = { id: string; name: string; avatar: string };
type ModelSelection = { connectionId: string; model: string; reasoningEffort: string; temperature?: number } | null;
type AgentOverviewEntry = {
  agent: RuntimeAgent;
  identity?: AgentIdentity | null;
  sessionId: string;
  selection: ModelSelection;
  status: { agents: AgentStatus[] };
  contexts: Record<string, ContextStatus>;
  error?: string;
};
type TargetAgentResult = { target: ApiTarget; entries: AgentOverviewEntry[]; error?: Error };
export type RuntimeRegistryState = 'loading' | 'ready' | 'empty' | 'unavailable';

const avatarFor = (agent: RuntimeAgent) => agent.avatar || agent.name.slice(0, 1).toUpperCase() || 'A';
const workspacePathFor = (agentId: string) => `/workspace/${agentId}`;

const asAgent = (entry: AgentOverviewEntry, target: ApiTarget): Agent => ({
  id: ownedResourceId(target.id, entry.agent.id),
  resourceId: entry.agent.id,
  targetId: target.id,
  targetName: target.name,
  name: entry.identity?.name || entry.agent.name,
  avatar: entry.identity?.avatar || avatarFor(entry.agent),
  activity: entry.agent.enabled ? 'Idle' : 'Disabled',
  context: null,
  provider: '',
  model: '',
  effort: 'medium',
  temperature: 0.2,
  workspace: workspacePathFor(entry.agent.id),
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

async function loadLegacyOverview(target: ApiTarget, parentSessionIdForAgent: (agentId: string) => string): Promise<AgentOverviewEntry[]> {
  const [{ agents }, identities] = await Promise.all([
    apiForTarget<{ agents: RuntimeAgent[] }>(target, '/api/agents'),
    apiForTarget<{ agents: AgentIdentity[] }>(target, '/api/settings/identities').catch(() => ({ agents: [] })),
  ]);
  const identitiesByAgentId = new Map(identities.agents.map((identity) => [identity.id, identity]));
  return Promise.all(agents.map(async (agent) => {
    const sessionId = parentSessionIdForAgent(ownedResourceId(target.id, agent.id));
    if (!agent.enabled) return { agent, identity: identitiesByAgentId.get(agent.id), sessionId, selection: null, status: { agents: [] }, contexts: {} };
    const [status, context, selection] = await Promise.all([
      apiForTarget<{ agents: AgentStatus[] }>(target, `/api/agent-status?sessionId=${encodeURIComponent(sessionId)}&agentId=${encodeURIComponent(agent.id)}`).catch(() => ({ agents: [] })),
      apiForTarget<{ status: ContextStatus }>(target, `/api/session/context-status?agentId=${encodeURIComponent(agent.id)}&sessionId=${encodeURIComponent(sessionId)}`).catch(() => ({ status: {} })),
      apiForTarget<{ selection: ModelSelection }>(target, `/api/agents/${encodeURIComponent(agent.id)}/model-selection`).catch(() => ({ selection: null })),
    ]);
    const childContexts = await Promise.all(status.agents.filter((item) => item.parentSessionId === sessionId).map(async (child) => {
      const result = await apiForTarget<{ status: ContextStatus }>(target, `/api/session/context-status?agentId=${encodeURIComponent(agent.id)}&sessionId=${encodeURIComponent(child.sessionId)}`).catch(() => ({ status: {} }));
      return [child.sessionId, result.status] as const;
    }));
    return { agent, identity: identitiesByAgentId.get(agent.id), sessionId, selection: selection.selection, status, contexts: { [sessionId]: context.status, ...Object.fromEntries(childContexts) } };
  }));
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
        const knownAgents = agentsRef.current.filter((agent) => agent.targetId === target.id && agent.resourceId);
        const registeredAgents = knownAgents.length > 0
          ? knownAgents.map((agent) => ({ id: agent.resourceId! }))
          : (await apiForTarget<{ agents: RuntimeAgent[] }>(target, '/api/agents')).agents;
        const sessions = Object.fromEntries(registeredAgents.map((agent) => {
          const ownedId = ownedResourceId(target.id, agent.id);
          return [agent.id, parentSessionIdForAgent(ownedId)];
        }));
        const overview = await apiForTarget<{ agents: AgentOverviewEntry[] }>(target, '/api/agents/overview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessions }),
        });
        return { target, entries: overview.agents };
      } catch (error) {
        if ((error as Error & { status?: number }).status === 404) {
          try { return { target, entries: await loadLegacyOverview(target, parentSessionIdForAgent) }; }
          catch (legacyError) { return { target, entries: [], error: legacyError as Error }; }
        }
        return { target, entries: [], error: error as Error };
      }
    }));
    const successfulTargets = targetResults.filter((result) => !result.error);
    const failedTargets = targetResults.filter((result) => result.error);
    const hydrated = successfulTargets.flatMap(({ target, entries }) => entries.map((entry) => {
      const agent = asAgent(entry, target);
      const parentStatus = entry.status.agents.find((item) => item.sessionId === entry.sessionId && !item.parentSessionId);
      const childStatuses = entry.status.agents.filter((item) => item.parentSessionId === parentStatus?.sessionId);
      const subagents: Subagent[] = childStatuses.map((child) => {
        const childContext = entry.contexts[child.sessionId] ?? {};
        return { id: ownedResourceId(target.id, child.sessionId), resourceId: child.sessionId, targetId: target.id, name: child.label || child.subagentId || 'Subagent', avatar: '↳', activity: formatAgentActivity(child.status), context: contextPercent(childContext), contextDetails: contextDetails(childContext), stream: ownedResourceId(target.id, child.sessionId), subagentId: child.subagentId };
      });
      const selection = entry.selection;
      const selectedProvider = runtimeProviders.current.find((item) => item.id === selection?.connectionId && item.models.includes(selection.model));
      const provider = selectedProvider ?? runtimeProviders.current.find((item) => item.provider === agent.provider) ?? (target.baseUrl ? undefined : runtimeProviders.current[0]);
      const configured = !provider ? agent : (() => {
        const model = selectedProvider && selection ? selection.model : provider.models.includes(agent.model) ? agent.model : provider.models[0];
        const efforts = ['off', ...(provider.modelEfforts?.[model] ?? []).filter((item) => item !== 'off')];
        const effort = selectedProvider && selection && efforts.includes(selection.reasoningEffort) ? selection.reasoningEffort : provider.defaultEfforts?.[model] ?? agent.effort;
        const temperature = typeof selection?.temperature === 'number' && Number.isFinite(selection.temperature) ? selection.temperature : agent.temperature;
        return { ...agent, provider: provider.provider, model, effort, temperature };
      })();
      const parentContext = entry.contexts[entry.sessionId] ?? {};
      return { ...configured, activity: entry.agent.enabled ? formatAgentActivity(parentStatus?.status?.toLowerCase()) : 'Disabled', context: contextPercent(parentContext), contextDetails: contextDetails(parentContext), subagents };
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
