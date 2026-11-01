import { isNativeThinkingProvider } from './modelSelectionOptions';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ModelConnection } from './api';
import type { Agent, SavedProvider } from './types';

export type OperatorProfile = { name: string; avatar: string };
export type ProviderConnectionStatus = 'unknown' | 'checking' | 'connected' | 'disconnected';

type RuntimeDashboardOptions = {
  setAgents: React.Dispatch<React.SetStateAction<Agent[]>>;
  runtimeProviders: React.MutableRefObject<SavedProvider[]>;
  reportError: (message: string) => void;
};

export const isOpenAiOAuthConnection = (provider?: Pick<SavedProvider, 'auth' | 'authSource' | 'oauthConfigured'>) =>
  provider?.auth?.provider?.toLowerCase() === 'openai' ||
  provider?.auth?.type === 'oauth' ||
  provider?.auth?.source === 'oauth' ||
  provider?.auth?.source === 'openai-oauth' ||
  provider?.authSource === 'oauth' ||
  provider?.authSource === 'openai-oauth' ||
  provider?.oauthConfigured === true;

const asSavedProvider = (connection: ModelConnection): SavedProvider => ({
  id: connection.id, provider: connection.provider, apiType: connection.apiType, url: connection.baseUrl, apiKey: '', apiKeyConfigured: connection.apiKeyConfigured,
  auth: connection.auth, oauthConfigured: connection.auth?.type === 'oauth' || connection.auth?.source === 'oauth' || connection.auth?.source === 'openai-oauth', authSource: connection.auth?.source, expiresAt: connection.auth?.expiresAt,
  pool: connection.pool,
  connectionModels: connection.models,
  models: connection.models.filter((model) => model.selected !== false).map((model) => model.id),
  manualModels: Object.fromEntries(connection.models.map((model) => [model.id, model.manual === true])),
  modelLabels: Object.fromEntries(connection.models.map((model) => [model.id, model.displayName ?? model.id])),
  modelEfforts: Object.fromEntries(connection.models.map((model) => [model.id, model.reasoningEfforts ?? []])),
  defaultEfforts: Object.fromEntries(connection.models.flatMap((model) => model.defaultReasoningEffort ? [[model.id, model.defaultReasoningEffort]] : [])),
  modelContextWindows: Object.fromEntries(connection.models.flatMap((model) => Number.isFinite(model.contextWindow) && Number(model.contextWindow) > 0 ? [[model.id, Number(model.contextWindow)]] : [])),
  modelDiscoveredInputs: Object.fromEntries(connection.models.flatMap((model) => model.discoveredInput ? [[model.id, model.discoveredInput]] : [])),
  modelInputOverrides: Object.fromEntries(connection.models.flatMap((model) => model.acceptedInputOverride ? [[model.id, model.acceptedInputOverride]] : [])),
  modelDiscoveredOutputs: Object.fromEntries(connection.models.flatMap((model) => model.discoveredOutput ? [[model.id, model.discoveredOutput]] : [])),
  modelOutputOverrides: Object.fromEntries(connection.models.flatMap((model) => model.acceptedOutputOverride ? [[model.id, model.acceptedOutputOverride]] : [])),
});

/** Catalog arrival must not erase an overview selection that arrived first. */
export function reconcileModelCatalog(agents: Agent[], providers: SavedProvider[]): Agent[] {
  if (!providers.length) return agents;
  return agents.map(agent => {
    const provider = providers.find(item => item.id === agent.modelConnectionId)
      ?? providers.find(item => item.provider === agent.provider) ?? providers[0];
    const model = provider.models.includes(agent.model) ? agent.model : provider.models[0];
    const efforts = ['off', ...(provider.modelEfforts?.[model] ?? []).filter(item => item !== 'off')];
    return { ...agent, provider: provider.provider, modelConnectionId: provider.id, model,
      effort: isNativeThinkingProvider(provider) || efforts.includes(agent.effort) ? agent.effort : provider.defaultEfforts?.[model] ?? 'off' };
  });
}

export function useRuntimeDashboard({ setAgents, runtimeProviders, reportError }: RuntimeDashboardOptions) {
  const [savedProviders, setSavedProviders] = useState<SavedProvider[]>([]);
  const [modelConnectionsLoaded, setModelConnectionsLoaded] = useState(false);
  // Catalog discovery writes models; it is not a connection-health probe.
  const providerConnectionStatus: ProviderConnectionStatus = 'unknown';
  const [operatorProfile, setOperatorProfile] = useState<OperatorProfile>({ name: 'Operator', avatar: 'OP' });
  const scope = useRef({ generation: 0 });
  const generation = scope.current.generation;

  const refreshModelConnections = useCallback(async () => {
    if (scope.current.generation !== generation) return;
    const { connections } = await api<{ connections: ModelConnection[] }>( '/api/settings/model-connections');
    if (scope.current.generation !== generation) return;
    const saved = connections.map(asSavedProvider);
    const providers = saved.filter((provider) => provider.models.length);
    runtimeProviders.current = providers;
    setSavedProviders(saved); setModelConnectionsLoaded(true);
    if (!providers.length) return;
    setAgents(all => reconcileModelCatalog(all, providers));
  }, [setAgents, generation]);

  useEffect(() => {
    let cancelled = false;
    setOperatorProfile({ name: 'Operator', avatar: 'OP' });
    api<{ operator: OperatorProfile }>( '/api/settings/identities')
      .then(({ operator }) => { if (!cancelled && scope.current.generation === generation) setOperatorProfile(operator); })
      .catch((error: Error) => { if (!cancelled && scope.current.generation === generation) reportError(`Could not load operator profile: ${error.message}`); });
    return () => { cancelled = true; };
  }, [reportError, generation]);
  useEffect(() => { let cancelled = false; setModelConnectionsLoaded(false); setSavedProviders([]); runtimeProviders.current = []; refreshModelConnections().catch((error: Error) => !cancelled && reportError(`Could not load model connections: ${error.message}`)); return () => { cancelled = true; }; }, [refreshModelConnections, reportError]);

  return { modelConnectionsLoaded, operatorProfile, providerConnectionStatus, refreshModelConnections, runtimeProviders, savedProviders, setOperatorProfile };
}
