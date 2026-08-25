import { useCallback, useEffect, useRef, useState } from 'react';
import { apiForTarget, type AnthropicUsage, type ModelConnection, type OpenAiUsage } from './api';
import type { ApiTarget } from './apiTargets';
import type { Account, Agent, SavedProvider } from './types';
import { usePolling } from './usePolling';
import { writeStorage } from './usePersistedLayout';

export type OperatorProfile = { name: string; avatar: string };
export type ProviderConnectionStatus = 'checking' | 'connected' | 'disconnected';

type CodexLbAccount = {
  id?: string;
  name?: string;
  type?: string;
  status?: string;
  usagePercent?: number | null;
  resetAt?: string | null;
  availableResetCredits?: number | null;
  resetCreditNearestExpiresAt?: string | null;
};

type RuntimeDashboardOptions = {
  selectedProvider?: string;
  setAgents: React.Dispatch<React.SetStateAction<Agent[]>>;
  runtimeProviders: React.MutableRefObject<SavedProvider[]>;
  reportError: (message: string) => void;
  target?: ApiTarget;
};

const codexAccountOrderKey = 'hc.codexLbAccountOrder';

function readCodexAccountOrder(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(codexAccountOrderKey) ?? '[]');
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function formatReset(resetAt?: string | null) {
  if (!resetAt) return 'reset time unavailable';
  const timestamp = new Date(resetAt).getTime();
  if (!Number.isFinite(timestamp)) return `resets ${resetAt}`;
  const minutes = Math.max(0, Math.ceil((timestamp - Date.now()) / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  const duration = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`;
  return `resets in ${duration}`;
}

export function formatUsageReset(resetAt?: string | null) {
  if (!resetAt) return '—';
  const timestamp = new Date(resetAt).getTime();
  if (!Number.isFinite(timestamp)) return '—';
  const minutes = Math.max(0, Math.ceil((timestamp - Date.now()) / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`;
}

function formatResetCredit(count?: number | null, nearestEndAt?: string | null) {
  const available = Number(count);
  if (!Number.isFinite(available) || available <= 0) return undefined;
  const credits = Math.floor(available);
  const creditLabel = `${credits} reset${credits === 1 ? '' : 's'}`;
  if (!nearestEndAt) return creditLabel;
  const timestamp = new Date(nearestEndAt).getTime();
  if (!Number.isFinite(timestamp)) return creditLabel;
  const days = Math.max(0, Math.ceil((timestamp - Date.now()) / 86_400_000));
  return `${creditLabel} · ${days} day${days === 1 ? '' : 's'} left`;
}

function asCodexAccount(account: CodexLbAccount, index: number): Account {
  const usagePercent = Number(account.usagePercent);
  const remaining = Number.isFinite(usagePercent) ? Math.max(0, Math.min(100, Math.round(usagePercent))) : 0;
  return { id: account.id ?? `account-${index + 1}`, name: account.name ?? `Account ${index + 1}`, plan: account.type ?? 'Unknown plan', used: 100 - remaining, reset: formatReset(account.resetAt), status: account.status ?? 'Unknown', resetCredit: formatResetCredit(account.availableResetCredits, account.resetCreditNearestExpiresAt) };
}

const asSavedProvider = (connection: ModelConnection): SavedProvider => ({
  id: connection.id, provider: connection.provider, apiType: connection.apiType, url: connection.baseUrl, apiKey: '', apiKeyConfigured: connection.apiKeyConfigured,
  auth: connection.auth, oauthConfigured: connection.authConfigured, authSource: connection.auth?.source, expiresAt: connection.auth?.expiresAt,
  models: connection.models.filter((model) => model.selected !== false).map((model) => model.id),
  manualModels: Object.fromEntries(connection.models.map((model) => [model.id, model.manual === true])),
  modelLabels: Object.fromEntries(connection.models.map((model) => [model.id, model.displayName ?? model.id])),
  modelEfforts: Object.fromEntries(connection.models.map((model) => [model.id, model.reasoningEfforts ?? []])),
  defaultEfforts: Object.fromEntries(connection.models.flatMap((model) => model.defaultReasoningEffort ? [[model.id, model.defaultReasoningEffort]] : [])),
  modelContextWindows: Object.fromEntries(connection.models.flatMap((model) => Number.isFinite(model.contextWindow) && Number(model.contextWindow) > 0 ? [[model.id, Number(model.contextWindow)]] : [])),
  modelDiscoveredInputs: Object.fromEntries(connection.models.flatMap((model) => model.discoveredInput ? [[model.id, model.discoveredInput]] : [])),
  modelInputOverrides: Object.fromEntries(connection.models.flatMap((model) => model.acceptedInputOverride ? [[model.id, model.acceptedInputOverride]] : [])),
});

export function useRuntimeDashboard({ selectedProvider, setAgents, runtimeProviders, reportError, target }: RuntimeDashboardOptions) {
  const [savedProviders, setSavedProviders] = useState<SavedProvider[]>([]);
  const [modelConnectionsLoaded, setModelConnectionsLoaded] = useState(false);
  const [providerConnectionStatus, setProviderConnectionStatus] = useState<ProviderConnectionStatus>('checking');
  const [anthropicUsage, setAnthropicUsage] = useState<AnthropicUsage | null>(null);
  const [openAiUsage, setOpenAiUsage] = useState<OpenAiUsage | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [operatorProfile, setOperatorProfile] = useState<OperatorProfile>({ name: 'Operator', avatar: 'OP' });
  const codexAccountOrder = useRef(readCodexAccountOrder());

  const reorderAccounts = useCallback((draggedId: string, targetId: string) => {
    setAccounts((current) => {
      const sourceIndex = current.findIndex((account) => account.id === draggedId);
      const targetIndex = current.findIndex((account) => account.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return current;
      const next = [...current]; const [dragged] = next.splice(sourceIndex, 1); next.splice(targetIndex, 0, dragged);
      codexAccountOrder.current = next.map((account) => account.id);
      writeStorage(codexAccountOrderKey, JSON.stringify(codexAccountOrder.current));
      return next;
    });
  }, []);

  const refreshModelConnections = useCallback(async () => {
    const { connections } = await apiForTarget<{ connections: ModelConnection[] }>(target, '/api/settings/model-connections');
    const providers = connections.map(asSavedProvider).filter((provider) => provider.models.length);
    runtimeProviders.current = providers;
    setSavedProviders(providers); setModelConnectionsLoaded(true);
    if (!providers.length) return;
    const fallbackProvider = providers[0];
    setAgents((all) => all.map((agent) => {
      const provider = providers.find((item) => item.provider === agent.provider) ?? fallbackProvider;
      const model = provider.models.includes(agent.model) ? agent.model : provider.models[0];
      const efforts = ['off', ...(provider.modelEfforts?.[model] ?? []).filter((item) => item !== 'off')];
      return { ...agent, provider: provider.provider, model, effort: efforts.includes(agent.effort) ? agent.effort : provider.defaultEfforts?.[model] ?? 'off' };
    }));
  }, [setAgents, target]);

  useEffect(() => { apiForTarget<{ operator: OperatorProfile }>(target, '/api/settings/identities').then(({ operator }) => setOperatorProfile(operator)).catch((error: Error) => reportError(`Could not load operator profile: ${error.message}`)); }, [reportError, target]);
  useEffect(() => { let cancelled = false; setModelConnectionsLoaded(false); setSavedProviders([]); runtimeProviders.current = []; refreshModelConnections().catch((error: Error) => !cancelled && reportError(`Could not load model connections: ${error.message}`)); return () => { cancelled = true; }; }, [refreshModelConnections, reportError, target]);

  usePolling(async (isCancelled) => {
    try {
      const { accounts: nextAccounts } = await apiForTarget<{ accounts: CodexLbAccount[] }>(target, '/api/codex-lb/accounts');
      if (isCancelled()) return;
      setAccounts(() => {
        const next = (nextAccounts ?? []).map(asCodexAccount); const knownIds = new Set(next.map((account) => account.id));
        const orderedIds = codexAccountOrder.current.filter((id) => knownIds.has(id)); const orderedIdSet = new Set(orderedIds);
        codexAccountOrder.current = [...orderedIds, ...next.map((account) => account.id).filter((id) => !orderedIdSet.has(id))];
        return next.sort((a, b) => codexAccountOrder.current.indexOf(a.id) - codexAccountOrder.current.indexOf(b.id));
      });
    } catch { if (!isCancelled()) setAccounts([]); }
  }, 15_000, true, target?.id ?? 'local');

  const selectedConnection = savedProviders.find((provider) => provider.provider === selectedProvider) ?? savedProviders[0];
  usePolling(async (isCancelled) => {
    const provider = selectedConnection; const isAnthropicMessages = provider?.apiType === 'anthropic-messages';
    const isOpenAiOAuth = provider?.provider === 'openai' && (provider.auth?.type === 'oauth' || provider.auth?.source === 'oauth' || provider.auth?.source === 'openai-oauth' || provider.authSource === 'oauth' || provider.authSource === 'openai-oauth' || provider.oauthConfigured === true);
    if (!isAnthropicMessages && !isOpenAiOAuth) { setAnthropicUsage(null); setOpenAiUsage(null); return; }
    setAnthropicUsage(null); setOpenAiUsage(null);
    try {
      if (isAnthropicMessages) { const result = await apiForTarget<{ usage?: AnthropicUsage }>(target, `/api/anthropic/oauth/usage?connectionId=${encodeURIComponent(provider.id)}`); if (!isCancelled()) setAnthropicUsage(result.usage ?? null); }
      else { const result = await apiForTarget<{ usage?: OpenAiUsage }>(target, `/api/openai/oauth/usage?connectionId=${encodeURIComponent(provider.id)}`); if (!isCancelled()) setOpenAiUsage(result.usage ?? null); }
    } catch { if (!isCancelled()) { setAnthropicUsage(null); setOpenAiUsage(null); } }
  }, 300_000, true, `${target?.id ?? 'local'}:${selectedConnection?.id ?? ''}`);

  usePolling(async (isCancelled) => {
    const provider = selectedConnection;
    if (!provider?.apiKeyConfigured) { if (!isCancelled()) setProviderConnectionStatus('disconnected'); return; }
    try { await apiForTarget(target, '/api/settings/model-connections/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: provider.id, apiType: provider.apiType, baseUrl: provider.url }) }); if (!isCancelled()) setProviderConnectionStatus('connected'); }
    catch { if (!isCancelled()) setProviderConnectionStatus('disconnected'); }
  }, 30_000, modelConnectionsLoaded, `${target?.id ?? 'local'}:${selectedConnection?.id ?? ''}`);

  return { accounts, anthropicUsage, modelConnectionsLoaded, openAiUsage, operatorProfile, providerConnectionStatus, refreshModelConnections, reorderAccounts, runtimeProviders, savedProviders, setOperatorProfile };
}
