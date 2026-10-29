import { enabledAgents } from './agentCatalog';
import { minionOutcome } from './minionOutcome';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AgentStatus, type ContextStatus, type RuntimeAgent } from './api';
import type { Agent, ContextDetails, SavedProvider, Subagent } from './types';
import { usePolling, type IsPollingCancelled } from './usePolling';
import { childStreamId } from './useRuntimeSelection';

type RuntimeAgentHydrationOptions = {
  selectedAgentId: string;
  selectedStreamId: string;
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
  status: { agents: AgentStatus[]; minionScope?: 'agent' | 'session' };
  contexts: Record<string, ContextStatus>;
  error?: string;
};
export type RuntimeRegistryState = 'loading' | 'ready' | 'empty' | 'unavailable';

const avatarFor = (agent: RuntimeAgent) => agent.avatar || agent.name.slice(0, 1).toUpperCase() || 'A';
const workspacePathFor = (agentId: string) => `/workspace/${agentId}`;

const asAgent = (entry: AgentOverviewEntry): Agent => ({
  enabled: entry.agent.enabled,
  id: entry.agent.id,
  resourceId: entry.agent.id,
  targetId: 'local',
  targetName: 'Local',
  name: entry.identity?.name || entry.agent.name,
  avatar: entry.identity?.avatar || avatarFor(entry.agent),
  activity: entry.agent.enabled ? 'Idle' : 'Disabled',
  context: null, contextConfig: entry.agent.contextConfig, provider: '', model: '', effort: 'medium', temperature: 0.2,
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
    const [statusResult, contextResult, selection] = await Promise.all([
      api<{ agents: AgentStatus[] }>( `/api/agent-status?sessionId=${encodeURIComponent(sessionId)}&agentId=${encodeURIComponent(agent.id)}`, { signal }).then((status) => ({ status })).catch((error: Error) => ({ error })),
      api<{ status: ContextStatus }>( `/api/session/context-status?agentId=${encodeURIComponent(agent.id)}&sessionId=${encodeURIComponent(sessionId)}`, { signal }).then((context) => ({ context })).catch((error: Error) => ({ error })),
      api<{ selection: ModelSelection }>( `/api/agents/${encodeURIComponent(agent.id)}/model-selection`, { signal }).catch(() => ({ selection: null })),
    ]);
    const status = 'status' in statusResult ? statusResult.status : { agents: [] };
    const context = 'context' in contextResult ? contextResult.context : { status: {} };
    const childContexts = await Promise.all(status.agents.filter((item) => item.sessionId !== sessionId).map(async (child) => {
      const result = await api<{ status: ContextStatus }>( `/api/session/context-status?agentId=${encodeURIComponent(agent.id)}&sessionId=${encodeURIComponent(child.sessionId)}`, { signal }).catch(() => ({ status: {} }));
      return [child.sessionId, result.status] as const;
    }));
    const statusError = 'error' in statusResult ? statusResult.error : undefined;
    return { agent, identity: identitiesByAgentId.get(agent.id), sessionId, selection: selection.selection, status, contexts: { [sessionId]: context.status, ...Object.fromEntries(childContexts) }, error: statusError?.message };
  }));
}

export function useRuntimeAgents({ selectedAgentId, selectedStreamId, setSelectedAgentId, parentSessionIdForAgent, runtimeProviders, setSelectedStreamId, onNoAgents, reportError }: RuntimeAgentHydrationOptions) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [registryState, setRegistryState] = useState<RuntimeRegistryState>('loading');
  const [registryError, setRegistryError] = useState('');
  const [registryStale, setRegistryStale] = useState(false);
  const refreshSequence = useRef(0);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;
  const selectedStreamIdRef = useRef(selectedStreamId);
  selectedStreamIdRef.current = selectedStreamId;
  const targetKey = 'local';
  useEffect(() => {
    setAgents([]);
    setRegistryState('loading');
    setRegistryError('');
    setRegistryStale(false);
  }, [targetKey]);

  const refreshAgents = useCallback(async (isCancelled: IsPollingCancelled = () => false, signal?: AbortSignal) => {
    const sequence = ++refreshSequence.current;
    let hydrated: Agent[] = [];
    let loadError: Error | undefined;
    try {
      const knownAgents = agentsRef.current.map((agent) => agent.resourceId ? { id: agent.resourceId } : null).filter((agent): agent is { id: string } => Boolean(agent));
      const registeredAgents = knownAgents.length > 0 ? knownAgents : (await api<{ agents: RuntimeAgent[] }>('/api/agents', { signal })).agents.map(({ id }) => ({ id }));
      const sessions = Object.fromEntries(registeredAgents.map((agent) => [agent.id, parentSessionIdForAgent(agent.id)]));
      let entries: AgentOverviewEntry[];
      try {
        entries = (await api<{ agents: AgentOverviewEntry[] }>('/api/agents/overview', { signal, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions, minionScope: 'agent' }) })).agents;
      } catch (error) {
        if ((error as Error & { status?: number }).status !== 404) throw error;
        entries = await loadLegacyOverview(parentSessionIdForAgent, signal);
      }
      const currentAnchors = Object.fromEntries(registeredAgents.map((agent) => [agent.id, parentSessionIdForAgent(agent.id)]));
      hydrated = entries.map((entry) => {
        const oldAgent = agentsRef.current.find((candidate) => candidate.id === entry.agent.id);
        const anchorChangedInFlight = currentAnchors[entry.agent.id] !== sessions[entry.agent.id] || entry.sessionId !== sessions[entry.agent.id];
        if (anchorChangedInFlight) return {
          ...(oldAgent ?? asAgent(entry)),
          activity: entry.agent.enabled ? 'Unknown' : 'Disabled',
          context: null,
          contextDetails: undefined,
          minionScope: 'session',
          minionCoverage: oldAgent ? 'stale' : 'unavailable',
          subagents: oldAgent?.subagents.map((child) => ({ ...child, retained: true })) ?? [],
        };
        const agent = asAgent(entry);
        const parentStatus = entry.status.agents.find((item) => item.sessionId === entry.sessionId);
        // Keep all returned descendants, including retained orphans and the
        // requested anchor itself when the backend identifies it as a minion.
        // Keep it flat for stream selection; only the rail builds a hierarchy.
        const childStatuses = entry.status.agents.filter((item) => item.sessionId !== entry.sessionId || (item.depth ?? 0) > 0).filter((item, index, all) => all.findIndex((other) => other.sessionId === item.sessionId) === index);
        const subagents: Subagent[] = childStatuses.map((child) => {
          const childContext = entry.contexts[child.sessionId] ?? {};
          const outcome = minionOutcome(child.status, child.result);
          const streamId = childStreamId(entry.agent.id, child.sessionId);
          return {
            id: streamId, resourceId: child.sessionId, stream: streamId,
            agentId: entry.agent.id, targetId: 'local', subagentId: child.subagentId,
            runId: child.runId, parentSessionId: child.parentSessionId, parentRunId: child.parentRunId,
            depth: child.depth, maxDepth: child.maxDepth,
            rootSessionId: child.rootSessionId, rootRunId: child.rootRunId,
            name: child.label || child.subagentId || 'Minion', avatar: '↳',
            activity: outcome.label ?? formatAgentActivity(child.status), outcomeReason: outcome.reason,
            context: contextPercent(childContext), contextDetails: contextDetails(childContext),
          };
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
        // An agent-level failure is not an authoritative empty minion list or
        // proof of agent-wide coverage. Keep every known child until a good load.
        const knownChildren = entry.error ? oldAgent?.subagents.map((child) => ({ ...child, retained: true })) : undefined;
        const minionCoverage = entry.error ? (knownChildren ? 'stale' : 'unavailable') : 'current';
        return { ...configured, activity: entry.agent.enabled ? formatAgentActivity(parentStatus?.status?.toLowerCase()) : 'Disabled', context: contextPercent(parentContext), contextDetails: contextDetails(parentContext), minionScope: !entry.error && entry.status.minionScope === 'agent' ? 'agent' : 'session', minionCoverage, subagents: knownChildren ?? subagents };
      });
    } catch (error) { loadError = error as Error; }
    if (isCancelled() || sequence !== refreshSequence.current) return;
    if (loadError) {
      if (agentsRef.current.length > 0) { setRegistryStale(true); setRegistryError(loadError.message); return; }
      setRegistryState('unavailable'); setRegistryError(loadError.message); reportError(`Could not load agents: ${loadError.message}`); return;
    }
    const enabled = enabledAgents(hydrated);
    const fallbackAgentId = enabled[0]?.id ?? '';
    const latestSelectedAgentId = selectedAgentIdRef.current;
    const nextAgentId = enabled.some((agent) => agent.id === latestSelectedAgentId) ? latestSelectedAgentId : fallbackAgentId;
    // Keep an actively viewed child identifiable even if retention or a transient
    // scoped response removes it from the latest overview. Never switch its transcript.
    hydrated = hydrated.map((agent) => {
      if (agent.id !== latestSelectedAgentId || selectedStreamIdRef.current === agent.id) return agent;
      const retained = agentsRef.current.find((old) => old.id === agent.id)?.subagents.find((child) => child.id === selectedStreamIdRef.current);
      return retained && !agent.subagents.some((child) => child.id === retained.id) ? { ...agent, subagents: [...agent.subagents, { ...retained, retained: true }] } : agent;
    });
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
