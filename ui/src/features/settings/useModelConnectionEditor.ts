import { useEffect, useRef, useState } from 'react';
import { api, type RuntimeModel } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';
import type { SavedProvider } from '../../app/types';
import { isOpenAiOAuthConnection } from '../../app/useRuntimeDashboard';
import { modelConnectionsApi, type OpenAiOAuthConnection } from './modelConnectionsApi';
import { compatiblePoolMembers, isProviderPool } from './providerPools';
import { useClaudeCodeLoginFlow } from './useClaudeCodeLoginFlow';
import { useOpenAiOAuthConnectionFlow } from './useOpenAiOAuthConnectionFlow';

const selectedRuntimeModels = (models: Array<string | RuntimeModel> = []): RuntimeModel[] => models.map((model) => {
  if (typeof model === 'string') return { id: model, selected: true, acceptedInput: ['text'] };
  return { ...model, selected: model.selected ?? true, acceptedInput: model.acceptedInput ?? model.discoveredInput ?? ['text'] };
});

type Options = {
  savedProviders?: SavedProvider[];
  loadBalancing?: boolean;
  onModelConnectionsChanged: () => Promise<void>;
};

export function useModelConnectionEditor({ savedProviders = [], onModelConnectionsChanged, loadBalancing = false }: Options) {
  const confirm = useConfirm();
  const editorGeneration = useRef(0);
  const isEditorCurrent = (generation: number) => generation === editorGeneration.current;
  useEffect(() => () => { editorGeneration.current += 1; }, []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [provider, setProvider] = useState(loadBalancing ? 'OpenAI LB' : '');
  const [apiType, setApiType] = useState(loadBalancing ? 'openai-lb' : 'openai-chat-completions');
  const [poolEnabled, setPoolEnabled] = useState(true);
  const [memberConnectionIds, setMemberConnectionIds] = useState<string[]>([]);
  const poolConnection = isProviderPool(apiType);
  const poolMembers = compatiblePoolMembers(apiType, savedProviders);
  const missingPoolMembers = memberConnectionIds.filter(id => !poolMembers.some(member => member.id === id));
  const pool = { enabled: poolEnabled, memberConnectionIds, sticky: true as const, preferEarlierReset: false as const };
  const [url, setUrl] = useState('');
  const connectionReady = Boolean(provider.trim() && (poolConnection ? memberConnectionIds.length && !missingPoolMembers.length : url.trim()));
  const [apiKey, setApiKey] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [oauthConnection, setOauthConnection] = useState(false);
  const [oauthIdToken, setOauthIdToken] = useState('');
  const [oauthAccessToken, setOauthAccessToken] = useState('');
  const [oauthRefreshToken, setOauthRefreshToken] = useState('');
  const [availableModels, setAvailableModels] = useState<RuntimeModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState('');
  const [connected, setConnected] = useState(false);
  const [savedProvidersOpen, setSavedProvidersOpen] = useState(false);
  const [requestState, setRequestState] = useState<'idle' | 'connecting' | 'saving'>('idle');
  const [requestError, setRequestError] = useState('');
  const [oauthModal, setOauthModal] = useState<'openai' | 'anthropic' | null>(null);

  const resetProvider = () => {
    editorGeneration.current += 1;
    setEditingId(null);
    setPoolEnabled(true);
    setMemberConnectionIds([]);
    setProvider(loadBalancing ? 'OpenAI LB' : '');
    setApiType(loadBalancing ? 'openai-lb' : 'openai-chat-completions');
    setUrl('');
    setApiKey('');
    setApiKeyConfigured(false);
    setOauthConnection(false);
    setOauthIdToken('');
    setOauthAccessToken('');
    setOauthRefreshToken('');
    setAvailableModels([]);
    setSelectedModelId(null);
    setManualModel('');
    setConnected(false);
    setRequestState('idle');
    setRequestError('');
    resetClaudeLogin();
    resetOpenAiOAuth();
  };

  const connect = async (connection?: OpenAiOAuthConnection, isCurrent = () => true) => {
    const discoveryProvider = connection ? connection.provider ?? 'OpenAI' : provider;
    const discoveryUrl = connection ? connection.baseUrl ?? 'https://chatgpt.com/backend-api' : url;
    if (connection ? !discoveryProvider.trim() || !discoveryUrl.trim() : !connectionReady) return availableModels;
    const generation = ++editorGeneration.current;
    const current = () => isEditorCurrent(generation) && isCurrent();
    setRequestState('connecting');
    setRequestError('');
    try {
      const result = await modelConnectionsApi.discover({
        ...((connection?.id ?? editingId) ? { id: connection?.id ?? editingId! } : {}),
        provider: discoveryProvider.trim(),
        apiType: connection ? connection.apiType ?? 'openai-responses' : apiType,
        ...(!connection && poolConnection ? { pool } : { baseUrl: discoveryUrl.trim(), apiKey: connection ? '' : apiKey }),
        models: connection ? selectedRuntimeModels(connection.models) : availableModels,
      });
      if (!current()) return [];
      if (result.discovery?.status === 'error' || result.discovery?.error) throw new Error(result.discovery.error || 'Discovery failed');
      setAvailableModels(result.models);
      setSelectedModelId(result.models[0]?.id ?? null);
      setConnected(true);
      return result.models;
    } catch (error) {
      if (!current()) return [];
      setConnected(true);
      setRequestError(error instanceof Error
        ? `Could not discover models: ${error.message}. Add model IDs manually.`
        : 'Could not discover models. Add model IDs manually.');
      if (connection) throw error;
      return availableModels;
    } finally {
      if (current()) setRequestState('idle');
    }
  };

  const saveProvider = async (modelsOverride?: RuntimeModel[], onSaved?: () => void) => {
    const models = modelsOverride ?? availableModels;
    if (!connectionReady || !models.some((model) => model.selected !== false)) return;
    const generation = ++editorGeneration.current;
    setRequestState('saving');
    setRequestError('');
    try {
      await api('/api/settings/model-connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(editingId ? { id: editingId } : {}),
          provider: provider.trim(),
          apiType,
          ...(poolConnection ? { pool } : { baseUrl: url.trim() }),
          ...(!poolConnection && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...((!poolConnection && (oauthIdToken.trim() || oauthAccessToken.trim() || oauthRefreshToken.trim())) ? { oauthTokens: {
            ...(oauthIdToken.trim() ? { id_token: oauthIdToken.trim() } : {}),
            ...(oauthAccessToken.trim() ? { access_token: oauthAccessToken.trim() } : {}),
            ...(oauthRefreshToken.trim() ? { refresh_token: oauthRefreshToken.trim() } : {}),
          } } : {}),
          models,
        }),
      });
      if (isEditorCurrent(generation)) {
        // Clear secrets immediately after the successful write; refresh may be slow or fail.
        setApiKey('');
        setOauthIdToken('');
        setOauthAccessToken('');
        setOauthRefreshToken('');
      }
      await onModelConnectionsChanged();
      if (!isEditorCurrent(generation)) return;
      setSavedProvidersOpen(true);
      resetProvider();
      onSaved?.();
    } catch (error) {
      if (isEditorCurrent(generation)) setRequestError(error instanceof Error ? `Could not save provider: ${error.message}` : 'Could not save provider.');
    } finally {
      if (isEditorCurrent(generation)) setRequestState('idle');
    }
  };

  const applyOAuthConnection = (connection: OpenAiOAuthConnection) => {
    editorGeneration.current += 1;
    setEditingId(connection.id);
    setProvider(connection.provider ?? 'OpenAI');
    setApiType(connection.apiType ?? 'openai-responses');
    setUrl(connection.baseUrl ?? 'https://chatgpt.com/backend-api');
    setApiKey('');
    setApiKeyConfigured(Boolean(connection.apiKeyConfigured || connection.authConfigured));
    setOauthConnection(Boolean(connection.authConfigured));
    const models = selectedRuntimeModels(connection.models).map((model) => ({ ...model, selected: true }));
    setAvailableModels(models);
    setSelectedModelId(models[0]?.id ?? null);
    setConnected(Boolean(connection.authConfigured || connection.apiKeyConfigured));
  };

  const openAiFlow = useOpenAiOAuthConnectionFlow({
    onConnection: applyOAuthConnection,
    onAuthorized: async (connection, isCurrent) => {
      await connect(connection, isCurrent);
      if (!isCurrent()) return;
      const generation = editorGeneration.current;
      await onModelConnectionsChanged();
      if (isEditorCurrent(generation) && isCurrent()) setOauthModal(null);
    },
  });
  const claudeFlow = useClaudeCodeLoginFlow({
    onConnection: applyOAuthConnection,
    onImported: async (_login, isCurrent) => {
      const generation = editorGeneration.current;
      await onModelConnectionsChanged();
      if (!isCurrent() || !isEditorCurrent(generation)) return;
      // Discovery advances the editor generation; retain that owner across its await.
      const discovery = connect(undefined, isCurrent);
      const discoveryGeneration = editorGeneration.current;
      const discoveredModels = await discovery;
      if (!isCurrent() || !isEditorCurrent(discoveryGeneration)) return;
      const selectedModels = discoveredModels.map((model) => ({ ...model, selected: true }));
      setAvailableModels(selectedModels);
      await saveProvider(selectedModels, () => setOauthModal(null));
    },
  });
  const { reset: resetOpenAiOAuth } = openAiFlow;
  const { reset: resetClaudeLogin } = claudeFlow;

  const toggleModel = (id: string) => setAvailableModels((all) => all.map((model) => model.id === id
    ? { ...model, selected: model.selected === false }
    : model));

  const toggleModelInput = (id: string, input: 'text' | 'image') => setAvailableModels((all) => all.map((model) => {
    if (model.id !== id) return model;
    const acceptedInput = model.acceptedInput ?? model.discoveredInput ?? ['text'];
    const acceptedInputOverride = acceptedInput.includes(input)
      ? acceptedInput.filter((type) => type !== input)
      : [...acceptedInput, input];
    return { ...model, acceptedInput: acceptedInputOverride, acceptedInputOverride };
  }));

  const toggleModelOutput = (id: string, output: 'text' | 'audio' | 'image' | 'video' | 'file') => setAvailableModels((all) => all.map((model) => {
    if (model.id !== id) return model;
    const acceptedOutput = model.acceptedOutput ?? model.discoveredOutput ?? ['text'];
    const acceptedOutputOverride = acceptedOutput.includes(output) ? acceptedOutput.filter((type) => type !== output) : [...acceptedOutput, output];
    return { ...model, acceptedOutput: acceptedOutputOverride, acceptedOutputOverride };
  }));

  const setModelOutputAuto = (id: string, enabled: boolean) => setAvailableModels((all) => all.map((model) => {
    if (model.id !== id) return model;
    if (enabled) return { ...model, acceptedOutput: model.discoveredOutput ?? ['text'], acceptedOutputOverride: undefined };
    const acceptedOutput = model.acceptedOutput ?? model.discoveredOutput ?? ['text'];
    return { ...model, acceptedOutput, acceptedOutputOverride: acceptedOutput };
  }));

  const setModelContextAuto = (id: string, enabled: boolean) => setAvailableModels((all) => all.map((model) => {
    if (model.id !== id) return model;
    if (enabled) return { ...model, contextWindow: model.discoveredContextWindow, contextWindowOverride: undefined, contextWindowMode: 'auto' };
    const value = model.contextWindowOverride ?? model.contextWindow ?? model.discoveredContextWindow;
    return { ...model, contextWindow: value, contextWindowMode: 'manual', ...(value ? { contextWindowOverride: value } : { contextWindowOverride: undefined }) };
  }));

  const setModelContextOverride = (id: string, value: number | undefined) => setAvailableModels((all) => all.map((model) => model.id === id
    ? { ...model, contextWindow: value, contextWindowOverride: value, contextWindowMode: 'manual' }
    : model));

  const setModelInputAuto = (id: string, enabled: boolean) => setAvailableModels((all) => all.map((model) => {
    if (model.id !== id) return model;
    if (enabled) return { ...model, acceptedInput: model.discoveredInput ?? ['text'], acceptedInputOverride: undefined };
    const acceptedInput = model.acceptedInput ?? model.discoveredInput ?? ['text'];
    return { ...model, acceptedInput, acceptedInputOverride: acceptedInput };
  }));

  const addManualModel = () => {
    const id = manualModel.trim();
    if (!id) return;
    setAvailableModels((all) => all.some((model) => model.id === id)
      ? all
      : [...all, { id, selected: true, manual: true, acceptedInput: ['text'] }]);
    setManualModel('');
  };

  const deleteManualModel = (id: string) => setAvailableModels((all) => all.filter((model) => model.id !== id));

  const editProvider = (item: SavedProvider) => {
    editorGeneration.current += 1;
    setRequestState('idle');
    setEditingId(item.id);
    setProvider(item.provider);
    setApiType(item.apiType);
    setPoolEnabled(item.pool?.enabled ?? true);
    setMemberConnectionIds(item.pool?.memberConnectionIds ?? []);
    setUrl(item.url);
    setApiKey('');
    setOauthIdToken('');
    setOauthAccessToken('');
    setOauthRefreshToken('');
    setApiKeyConfigured(item.apiKeyConfigured === true);
    setOauthConnection(isOpenAiOAuthConnection(item));
    const models = item.connectionModels ?? item.models.map((id) => {
      const discoveredInput = item.modelDiscoveredInputs?.[id];
      const acceptedInputOverride = item.modelInputOverrides?.[id];
      return {
        id,
        selected: true,
        manual: item.manualModels?.[id] === true,
        displayName: item.modelLabels?.[id],
        reasoningEfforts: item.modelEfforts?.[id],
        defaultReasoningEffort: item.defaultEfforts?.[id],
        contextWindow: item.modelContextWindows?.[id],
        discoveredContextWindow: item.modelDiscoveredContextWindows?.[id],
        contextWindowOverride: item.modelContextWindowOverrides?.[id],
        discoveredInput,
        acceptedInputOverride,
        acceptedInput: acceptedInputOverride ?? discoveredInput ?? ['text'],
        discoveredOutput: item.modelDiscoveredOutputs?.[id],
        acceptedOutputOverride: item.modelOutputOverrides?.[id],
        acceptedOutput: item.modelOutputOverrides?.[id] ?? item.modelDiscoveredOutputs?.[id] ?? ['text'],
      };
    });
    setAvailableModels(models);
    setSelectedModelId(models[0]?.id ?? null);
    setConnected(true);
    setRequestError('');
    resetClaudeLogin();
    resetOpenAiOAuth();
  };

  const deleteProvider = async (item: SavedProvider) => {
    const generation = editorGeneration.current;
    if (!await confirm({
      title: 'Delete provider?',
      message: `Delete ${item.provider}? This removes its saved connection.`,
      confirmLabel: 'Delete provider',
      tone: 'danger',
    })) return;
    if (isEditorCurrent(generation)) setRequestError('');
    try {
      await api(`/api/settings/model-connections/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      await onModelConnectionsChanged();
      if (isEditorCurrent(generation) && editingId === item.id) resetProvider();
    } catch (error) {
      if (isEditorCurrent(generation)) setRequestError(error instanceof Error ? `Could not delete provider: ${error.message}` : 'Could not delete provider.');
    }
  };

  const openOpenAiOAuth = () => {
    if (editingId) resetOpenAiOAuth();
    else resetProvider();
    setOauthModal('openai');
  };
  const openAnthropicOAuth = () => {
    setApiType('anthropic-messages');
    setOauthModal('anthropic');
  };

  const changeApiType = (next: string) => {
    if (next === apiType) return;
    if (isProviderPool(next) || poolConnection) {
      resetProvider();
      setProvider(next === 'openai-lb' ? 'OpenAI LB' : next === 'anthropic-lb' ? 'Anthropic LB' : '');
    } else {
      editorGeneration.current += 1;
      setRequestState('idle');
    }
    setApiType(next);
  };
  const togglePoolMember = (id: string) => {
    editorGeneration.current += 1;
    setRequestState('idle');
    setRequestError('');
    setMemberConnectionIds(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]);
    setAvailableModels([]);
    setSelectedModelId(null);
    setConnected(false);
  };

  return {
    poolConnection, poolEnabled, setPoolEnabled, poolMembers, memberConnectionIds, missingPoolMembers, togglePoolMember, connectionReady,
    editingId,
    provider,
    setProvider,
    apiType,
    setApiType: changeApiType,
    url,
    setUrl,
    apiKey,
    setApiKey,
    apiKeyConfigured,
    oauthConnection,
    oauthIdToken,
    setOauthIdToken,
    oauthAccessToken,
    setOauthAccessToken,
    oauthRefreshToken,
    setOauthRefreshToken,
    availableModels,
    manualModel,
    setManualModel,
    connected,
    savedProvidersOpen,
    setSavedProvidersOpen,
    requestState,
    requestError,
    oauthModal,
    setOauthModal,
    openAiFlow,
    claudeFlow,
    resetProvider,
    connect,
    saveProvider,
    toggleModel,
    toggleModelInput,
    setModelInputAuto,
    setModelContextAuto,
    setModelContextOverride,
    toggleModelOutput,
    setModelOutputAuto,
    addManualModel,
    deleteManualModel,
    selectedModelId,
    setSelectedModelId,
    editProvider,
    deleteProvider,
    openOpenAiOAuth,
    openAnthropicOAuth,
  };
}
