import { minionOutcome } from './minionOutcome';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AgentStatus, type ContextStatus, type RuntimeAgent } from './api';
import type { Agent, ContextDetails, SavedProvider, Subagent } from './types';
import { usePolling, type IsPollingCancelled } from './usePolling';

type RuntimeAgentHydrationOptions = {
  selectedAgentId: string;
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
export type RuntimeRegistryState = 'loading' | 'ready' | 'empty' | 'unavailable';

const avatarFor = (agent: RuntimeAgent) => agent.avatar || agent.name.slice(0, 1).toUpperCase() || 'A';
const workspacePathFor = (agentId: string) => `/workspace/${agentId}`;

const asAgent = (entry: AgentOverviewEntry): Agent => ({
  id: entry.agent.id,
  resourceId: entry.agent.id,
  targetId: 'local',
  targetName: 'Local',
  name: entry.identity?.name || entry.agent.name,
  avatar: entry.identity?.avatar || avatarFor(entry.agent),
  activity: entry.agent.enabled ? 'Idle' : 'Disabled',
  context: null, provider: '', model: '', effort: 'medium', temperature: 0.2,
  workspace: workspacePathFor(entry.agent.id), files: [], subagents: [],
  executionEnvironment: entry.agent.executionEnvironment ?? null,
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

async function loadLegacyOverview(parentSessionIdForAgent: (agentId: string) => string, signal?: AbortSignal): Promise<AgentOverviewEntry[]> {
  const [{ agents }, identities] = await Promise.all([
    api<{ agents: RuntimeAgent[] }>( '/api/agents', { signal }),
    api<{ agents: AgentIdentity[] }>( '/api/settings/identities', { signal }).catch(() => ({ agents: [] })),
  ]);
  const identitiesByAgentId = new Map(identities.agents.map((identity) => [identity.id, identity]));
  return Promise.all(agents.map(async (agent) => {
    const sessionId = parentSessionIdForAgent(agent.id);
    if (!agent.enabled) return { agent, identity: identitiesByAgentId.get(agent.id), sessionId, selection: null, status: { agents: [] }, contexts: {} };
    const [status, context, selection] = await Promise.all([
      api<{ agents: AgentStatus[] }>( `/api/agent-status?sessionId=${encodeURIComponent(sessionId)}&agentId=${encodeURIComponent(agent.id)}`, { signal }).catch(() => ({ agents: [] })),
      api<{ status: ContextStatus }>( `/api/session/context-status?agentId=${encodeURIComponent(agent.id)}&sessionId=${encodeURIComponent(sessionId)}`, { signal }).catch(() => ({ status: {} })),
      api<{ selection: ModelSelection }>( `/api/agents/${encodeURIComponent(agent.id)}/model-selection`, { signal }).catch(() => ({ selection: null })),
    ]);
    const childContexts = await Promise.all(status.agents.filter((item) => item.parentSessionId === sessionId).map(async (child) => {
      const result = await api<{ status: ContextStatus }>( `/api/session/context-status?agentId=${encodeURIComponent(agent.id)}&sessionId=${encodeURIComponent(child.sessionId)}`).catch(() => ({ status: {} }));
      return [child.sessionId, result.status] as const;
    }));
    return { agent, identity: identitiesByAgentId.get(agent.id), sessionId, selection: selection.selection, status, contexts: { [sessionId]: context.status, ...Object.fromEntries(childContexts) } };
  }));
}

export function useRuntimeAgents({ selectedAgentId, setSelectedAgentId, parentSessionIdForAgent, runtimeProviders, setSelectedStreamId, onNoAgents, reportError }: RuntimeAgentHydrationOptions) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [registryState, setRegistryState] = useState<RuntimeRegistryState>('loading');
  const [registryError, setRegistryError] = useState('');
  const [registryStale, setRegistryStale] = useState(false);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;
  const targetKey = 'local';
  useEffect(() => {
    setAgents([]);
    setRegistryState('loading');
    setRegistryError('');
    setRegistryStale(false);
  }, [targetKey]);

  const refreshAgents = useCallback(async (isCancelled: IsPollingCancelled = () => false, signal?: AbortSignal) => {
    let hydrated: Agent[] = [];
    let loadError: Error | undefined;
    try {
      const knownAgents = agentsRef.current.map((agent) => agent.resourceId ? { id: agent.resourceId } : null).filter((agent): agent is { id: string } => Boolean(agent));
      const registeredAgents = knownAgents.length > 0 ? knownAgents : (await api<{ agents: RuntimeAgent[] }>('/api/agents', { signal })).agents.map(({ id }) => ({ id }));
      const sessions = Object.fromEntries(registeredAgents.map((agent) => [agent.id, parentSessionIdForAgent(agent.id)]));
      let entries: AgentOverviewEntry[];
      try {
        entries = (await api<{ agents: AgentOverviewEntry[] }>('/api/agents/overview', { signal, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions }) })).agents;
      } catch (error) {
        if ((error as Error & { status?: number }).status !== 404) throw error;
        entries = await loadLegacyOverview(parentSessionIdForAgent, signal);
      }
      hydrated = entries.map((entry) => {
        const agent = asAgent(entry);
        const parentStatus = entry.status.agents.find((item) => item.sessionId === entry.sessionId && !item.parentSessionId);
        const childStatuses = entry.status.agents.filter((item) => item.parentSessionId === parentStatus?.sessionId);
        const subagents: Subagent[] = childStatuses.map((child) => {
          const childContext = entry.contexts[child.sessionId] ?? {};
          return { id: child.sessionId, resourceId: child.sessionId, targetId: 'local', name: child.label || child.subagentId || 'Minion', avatar: '↳', activity: minionOutcome(child.status, child.result).label ?? formatAgentActivity(child.status), outcomeReason: minionOutcome(child.status, child.result).reason, context: contextPercent(childContext), contextDetails: contextDetails(childContext), stream: child.sessionId, subagentId: child.subagentId };
        });
        const selection = entry.selection;
        const selectedProvider = runtimeProviders.current.find((item) => item.id === selection?.connectionId && item.models.includes(selection.model));
        const provider = selectedProvider ?? runtimeProviders.current.find((item) => item.provider === agent.provider) ?? runtimeProviders.current[0];
        const configured = !provider ? agent : (() => {
          const model = selectedProvider && selection ? selection.model : provider.models.includes(agent.model) ? agent.model : provider.models[0];
          const efforts = ['off', ...(provider.modelEfforts?.[model] ?? []).filter((item) => item !== 'off')];
          const effort = selectedProvider && selection && efforts.includes(selection.reasoningEffort) ? selection.reasoningEffort : provider.defaultEfforts?.[model] ?? agent.effort;
          const temperature = typeof selection?.temperature === 'number' && Number.isFinite(selection.temperature) ? selection.temperature : agent.temperature;
          return { ...agent, provider: provider.provider, model, effort, temperature };
        })();
        const parentContext = entry.contexts[entry.sessionId] ?? {};
        return { ...configured, activity: entry.agent.enabled ? formatAgentActivity(parentStatus?.status?.toLowerCase()) : 'Disabled', context: contextPercent(parentContext), contextDetails: contextDetails(parentContext), subagents };
      });
    } catch (error) { loadError = error as Error; }
    if (isCancelled()) return;
    if (loadError) {
      if (agentsRef.current.length > 0) { setRegistryStale(true); setRegistryError(loadError.message); return; }
      setRegistryState('unavailable'); setRegistryError(loadError.message); reportError(`Could not load agents: ${loadError.message}`); return;
    }
    const enabled = hydrated.filter((agent) => agent.activity !== 'Disabled');
    const fallbackAgentId = enabled[0]?.id ?? hydrated[0]?.id ?? '';
    const latestSelectedAgentId = selectedAgentIdRef.current;
    const nextAgentId = hydrated.some((agent) => agent.id === latestSelectedAgentId) ? latestSelectedAgentId : fallbackAgentId;
    setAgents(hydrated);
    setRegistryState(hydrated.length === 0 ? 'empty' : 'ready');
    setRegistryStale(false);
    setRegistryError('');
    if (hydrated.length === 0) onNoAgents();
    setSelectedAgentId(nextAgentId);
    setSelectedStreamId((streamId) => hydrated.find((agent) => agent.id === nextAgentId)?.subagents.some((subagent) => subagent.id === streamId) ? streamId : nextAgentId);
  }, [onNoAgents, parentSessionIdForAgent, reportError, runtimeProviders, selectedAgentId, setSelectedAgentId, setSelectedStreamId]);

  usePolling(async (isCancelled, signal) => {
    try {
      await refreshAgents(isCancelled, signal);
    } catch (error) {
      if (!isCancelled()) {
        if (agentsRef.current.length > 0) {
          setRegistryStale(true);
          setRegistryError((error as Error).message);
        } else {
          reportError(`Could not load agents: ${(error as Error).message}`);
          onNoAgents();
        }
      }
    }
  }, 15_000, true, targetKey);

  return { agents, setAgents, refreshAgents, registryState, registryError, registryStale };
}
