import { useState } from 'react';
import { api, type RuntimeModel } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';
import type { SavedProvider } from '../../app/types';
import { modelConnectionsApi, type OpenAiOAuthConnection } from './modelConnectionsApi';
import { useClaudeCodeLoginFlow } from './useClaudeCodeLoginFlow';
import { useOpenAiOAuthConnectionFlow } from './useOpenAiOAuthConnectionFlow';

const selectedRuntimeModels = (models: Array<string | RuntimeModel> = []): RuntimeModel[] => models.map((model) => {
  if (typeof model === 'string') return { id: model, selected: true, acceptedInput: ['text'] };
  return { ...model, selected: model.selected ?? true, acceptedInput: model.acceptedInput ?? model.discoveredInput ?? ['text'] };
});

type Options = {
  onModelConnectionsChanged: () => Promise<void>;
};

export function useModelConnectionEditor({ onModelConnectionsChanged }: Options) {
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [provider, setProvider] = useState('');
  const [apiType, setApiType] = useState('openai-chat-completions');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [availableModels, setAvailableModels] = useState<RuntimeModel[]>([]);
  const [manualModel, setManualModel] = useState('');
  const [connected, setConnected] = useState(false);
  const [savedProvidersOpen, setSavedProvidersOpen] = useState(false);
  const [requestState, setRequestState] = useState<'idle' | 'connecting' | 'saving'>('idle');
  const [requestError, setRequestError] = useState('');
  const [oauthModal, setOauthModal] = useState<'openai' | 'anthropic' | null>(null);

  const resetProvider = () => {
    setEditingId(null);
    setProvider('');
    setApiType('openai-chat-completions');
    setUrl('');
    setApiKey('');
    setApiKeyConfigured(false);
    setAvailableModels([]);
    setManualModel('');
    setConnected(false);
    setRequestError('');
    resetClaudeLogin();
    resetOpenAiOAuth();
  };

  const connect = async () => {
    if (!provider.trim() || !url.trim()) return availableModels;
    setRequestState('connecting');
    setRequestError('');
    try {
      const result = await modelConnectionsApi.discover({
        ...(editingId ? { id: editingId } : {}),
        provider: provider.trim(),
        apiType,
        baseUrl: url.trim(),
        apiKey,
        models: availableModels,
      });
      setAvailableModels(result.models);
      setConnected(true);
      return result.models;
    } catch (error) {
      setConnected(true);
      setRequestError(error instanceof Error
        ? `Could not discover models: ${error.message}. Add model IDs manually.`
        : 'Could not discover models. Add model IDs manually.');
      return availableModels;
    } finally {
      setRequestState('idle');
    }
  };

  const saveProvider = async (modelsOverride?: RuntimeModel[]) => {
    const models = modelsOverride ?? availableModels;
    if (!provider.trim() || !url.trim() || !models.some((model) => model.selected !== false)) return;
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
          baseUrl: url.trim(),
          ...(apiKey ? { apiKey } : {}),
          models,
        }),
      });
      await onModelConnectionsChanged();
      setSavedProvidersOpen(true);
      resetProvider();
    } catch (error) {
      setRequestError(error instanceof Error ? `Could not save provider: ${error.message}` : 'Could not save provider.');
    } finally {
      setRequestState('idle');
    }
  };

  const applyOAuthConnection = (connection: OpenAiOAuthConnection) => {
    setEditingId(connection.id);
    setProvider(connection.provider ?? 'OpenAI');
    setApiType(connection.apiType ?? 'openai-responses');
    setUrl(connection.baseUrl ?? 'https://chatgpt.com/backend-api');
    setApiKey('');
    setApiKeyConfigured(Boolean(connection.apiKeyConfigured || connection.authConfigured));
    setAvailableModels(selectedRuntimeModels(connection.models).map((model) => ({ ...model, selected: true })));
    setConnected(Boolean(connection.authConfigured || connection.apiKeyConfigured));
  };

  const openAiFlow = useOpenAiOAuthConnectionFlow({
    onConnection: applyOAuthConnection,
    onAuthorized: async () => {
      await saveProvider();
      setOauthModal(null);
    },
  });
  const claudeFlow = useClaudeCodeLoginFlow({
    onConnection: applyOAuthConnection,
    onImported: async () => {
      await onModelConnectionsChanged();
      const discoveredModels = await connect();
      const selectedModels = (discoveredModels ?? availableModels).map((model) => ({ ...model, selected: true }));
      setAvailableModels(selectedModels);
      await saveProvider(selectedModels);
      setOauthModal(null);
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
    setEditingId(item.id);
    setProvider(item.provider);
    setApiType(item.apiType);
    setUrl(item.url);
    setApiKey('');
    setApiKeyConfigured(item.apiKeyConfigured === true);
    setAvailableModels(item.models.map((id) => {
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
        discoveredInput,
        acceptedInputOverride,
        acceptedInput: acceptedInputOverride ?? discoveredInput ?? ['text'],
      };
    }));
    setConnected(true);
    setRequestError('');
    resetClaudeLogin();
    resetOpenAiOAuth();
  };

  const deleteProvider = async (item: SavedProvider) => {
    if (!await confirm({
      title: 'Delete provider?',
      message: `Delete ${item.provider}? This removes its saved connection.`,
      confirmLabel: 'Delete provider',
      tone: 'danger',
    })) return;
    setRequestError('');
    try {
      await api(`/api/settings/model-connections/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      await onModelConnectionsChanged();
      if (editingId === item.id) resetProvider();
    } catch (error) {
      setRequestError(error instanceof Error ? `Could not delete provider: ${error.message}` : 'Could not delete provider.');
    }
  };

  const openOpenAiOAuth = () => setOauthModal('openai');
  const openAnthropicOAuth = () => {
    setApiType('anthropic-messages');
    setOauthModal('anthropic');
  };

  return {
    editingId,
    provider,
    setProvider,
    apiType,
    setApiType,
    url,
    setUrl,
    apiKey,
    setApiKey,
    apiKeyConfigured,
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
    addManualModel,
    deleteManualModel,
    editProvider,
    deleteProvider,
    openOpenAiOAuth,
    openAnthropicOAuth,
  };
}
