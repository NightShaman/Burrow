import { useEffect, useRef, useState } from 'react';
import { api, type RuntimeModel } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';
import { useUnsavedChanges, useUnsavedNavigation } from '../../app/UnsavedChanges';
import type { SavedProvider } from '../../app/types';
import { isOpenAiOAuthConnection } from '../../app/useRuntimeDashboard';
import { modelConnectionsApi, type OpenAiOAuthConnection } from './modelConnectionsApi';
import { compatiblePoolMembers, isProviderPool } from './providerPools';
import { useClaudeCodeLoginFlow } from './useClaudeCodeLoginFlow';
import { useOpenAiOAuthConnectionFlow } from './useOpenAiOAuthConnectionFlow';

const selectedRuntimeModels = (models: Array<string | RuntimeModel> = []): RuntimeModel[] =>
  models.map((model) => {
    if (typeof model === 'string') return { id: model, selected: true, acceptedInput: ['text'] };
    return {
      ...model,
      selected: model.selected ?? true,
      acceptedInput: model.acceptedInput ?? model.discoveredInput ?? ['text'],
    };
  });

type Options = {
  savedProviders?: SavedProvider[];
  loadBalancing?: boolean;
  onModelConnectionsChanged: () => Promise<void>;
};

export function useModelConnectionEditor({
  savedProviders = [],
  onModelConnectionsChanged,
  loadBalancing = false,
}: Options) {
  const confirm = useConfirm();
  const navigate = useUnsavedNavigation();
  const editorGeneration = useRef(0);
  const isEditorCurrent = (generation: number) => generation === editorGeneration.current;
  useEffect(
    () => () => {
      editorGeneration.current += 1;
    },
    [],
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [provider, setProvider] = useState(loadBalancing ? 'OpenAI LB' : '');
  const [apiType, setApiType] = useState(loadBalancing ? 'openai-lb' : 'openai-chat-completions');
  const [poolEnabled, setPoolEnabled] = useState(true);
  const [memberConnectionIds, setMemberConnectionIds] = useState<string[]>([]);
  const poolConnection = isProviderPool(apiType);
  const poolMembers = compatiblePoolMembers(apiType, savedProviders);
  const missingPoolMembers = memberConnectionIds.filter(
    (id) => !poolMembers.some((member) => member.id === id),
  );
  const pool = {
    enabled: poolEnabled,
    memberConnectionIds,
    sticky: true as const,
    preferEarlierReset: false as const,
  };
  const [url, setUrl] = useState('');
  const connectionReady = Boolean(
    provider.trim() &&
      (poolConnection ? memberConnectionIds.length && !missingPoolMembers.length : url.trim()),
  );
  const [apiKey, setApiKey] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [oauthConnection, setOauthConnection] = useState(false);
  const [autoUseExpiringResets, setAutoUseExpiringResets] = useState(false);
  const canAutoUseExpiringResets = Boolean(
    editingId &&
      !loadBalancing &&
      !poolConnection &&
      oauthConnection &&
      apiType === 'openai-responses',
  );
  const [oauthIdToken, setOauthIdToken] = useState('');
  const [oauthAccessToken, setOauthAccessToken] = useState('');
  const [oauthRefreshToken, setOauthRefreshToken] = useState('');
  // Count user edits independently of the saved value: clearing and retyping the
  // same secret during refresh is still a new draft, not the submitted secret.
  const secretEdits = useRef([0, 0, 0, 0]);
  const editSecret = (index: number, setter: (value: string) => void, value: string) => {
    secretEdits.current[index] += 1;
    setter(value);
  };
  const [availableModels, setAvailableModels] = useState<RuntimeModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState('');
  const [connected, setConnected] = useState(false);
  const [savedProvidersOpen, setSavedProvidersOpen] = useState(false);
  const [requestState, setRequestState] = useState<'idle' | 'connecting' | 'saving'>('idle');
  const [requestError, setRequestError] = useState('');
  // Disclosure state belongs to the current editor, not to generic save/delete errors.
  const [connectionRecoveryRequired, setConnectionRecoveryRequired] = useState(false);
  const [oauthModal, setOauthModal] = useState<'openai' | 'anthropic' | null>(null);
  const draft = JSON.stringify([
    editingId,
    provider,
    apiType,
    poolEnabled,
    memberConnectionIds,
    url,
    apiKey,
    oauthIdToken,
    oauthAccessToken,
    oauthRefreshToken,
    availableModels,
    autoUseExpiringResets,
  ]);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const writePending = useRef(false);
  const savedFingerprint = useRef<string | null>(null);
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify([
      null,
      loadBalancing ? 'OpenAI LB' : '',
      loadBalancing ? 'openai-lb' : 'openai-chat-completions',
      true,
      [],
      '',
      '',
      '',
      '',
      '',
      [],
      false,
    ]),
  );

  const resetProvider = () => {
    editorGeneration.current += 1;
    savedFingerprint.current = null;
    writePending.current = false;
    setEditingId(null);
    setConnectionRecoveryRequired(false);
    setPoolEnabled(true);
    setMemberConnectionIds([]);
    setProvider(loadBalancing ? 'OpenAI LB' : '');
    setApiType(loadBalancing ? 'openai-lb' : 'openai-chat-completions');
    setUrl('');
    setApiKey('');
    setApiKeyConfigured(false);
    setOauthConnection(false);
    setAutoUseExpiringResets(false);
    setOauthIdToken('');
    setOauthAccessToken('');
    setOauthRefreshToken('');
    setAvailableModels([]);
    setSelectedModelId(null);
    setManualModel('');
    setConnected(false);
    setRequestState('idle');
    setRequestError('');
    setBaseline(
      JSON.stringify([
        null,
        loadBalancing ? 'OpenAI LB' : '',
        loadBalancing ? 'openai-lb' : 'openai-chat-completions',
        true,
        [],
        '',
        '',
        '',
        '',
        '',
        [],
        false,
      ]),
    );
    resetClaudeLogin();
    resetOpenAiOAuth();
  };

  const connect = async (connection?: OpenAiOAuthConnection, isCurrent = () => true) => {
    if (writePending.current) return [];
    const discoveryProvider = connection ? (connection.provider ?? 'OpenAI') : provider;
    const discoveryUrl = connection
      ? (connection.baseUrl ?? 'https://chatgpt.com/backend-api')
      : url;
    if (connection ? !discoveryProvider.trim() || !discoveryUrl.trim() : !connectionReady)
      return availableModels;
    const generation = ++editorGeneration.current;
    const current = () => isEditorCurrent(generation) && isCurrent();
    setRequestState('connecting');
    setRequestError('');
    try {
      const result = await modelConnectionsApi.discover({
        ...((connection?.id ?? editingId) ? { id: connection?.id ?? editingId! } : {}),
        provider: discoveryProvider.trim(),
        apiType: connection ? (connection.apiType ?? 'openai-responses') : apiType,
        ...(!connection && poolConnection
          ? { pool }
          : { baseUrl: discoveryUrl.trim(), apiKey: connection ? '' : apiKey }),
        models: connection ? selectedRuntimeModels(connection.models) : availableModels,
      });
      if (!current()) return [];
      if (result.discovery?.status === 'error' || result.discovery?.error)
        throw new Error(result.discovery.error || 'Discovery failed');
      // Pools and their account/OAuth workflows retain their existing discovery semantics.
      // Ordinary API connections require an explicit opt-in for newly discovered IDs.
      const models =
        connection || poolConnection || loadBalancing || oauthConnection
          ? result.models
          : result.models.map((model) => ({
              ...model,
              selected:
                availableModels.find((existing) => existing.id === model.id)?.selected ??
                (availableModels.some((existing) => existing.id === model.id) ? true : false),
            }));
      setAvailableModels(models);
      setSelectedModelId(models[0]?.id ?? null);
      setConnected(true);
      setConnectionRecoveryRequired(false);
      return models;
    } catch (error) {
      if (!current()) return [];
      setConnected(true);
      // Network and discovery-envelope errors may also need URL/credential repair.
      // Keep recovery open through retries without guessing from error messages.
      setConnectionRecoveryRequired(true);
      setRequestError(
        error instanceof Error
          ? `Could not discover models: ${error.message}. Add model IDs manually.`
          : 'Could not discover models. Add model IDs manually.',
      );
      if (connection) throw error;
      return availableModels;
    } finally {
      if (current()) setRequestState('idle');
    }
  };

  const saveProvider = async (modelsOverride?: RuntimeModel[], onSaved?: () => void) => {
    const models = modelsOverride ?? availableModels;
    if (
      writePending.current ||
      requestState !== 'idle' ||
      !connectionReady ||
      (!poolConnection && !models.some((model) => model.selected !== false))
    )
      return false;
    if (savedFingerprint.current === draft) {
      setRequestError('Provider already saved. Refresh the connection list before editing again.');
      return false;
    }
    writePending.current = true;
    const snapshot = draft;
    const submittedSecretEdits = [...secretEdits.current];
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
          ...(canAutoUseExpiringResets ? { autoUseExpiringResets } : {}),
          ...(poolConnection ? { pool } : { baseUrl: url.trim() }),
          ...(!poolConnection && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(!poolConnection &&
          (oauthIdToken.trim() || oauthAccessToken.trim() || oauthRefreshToken.trim())
            ? {
                oauthTokens: {
                  ...(oauthIdToken.trim() ? { id_token: oauthIdToken.trim() } : {}),
                  ...(oauthAccessToken.trim() ? { access_token: oauthAccessToken.trim() } : {}),
                  ...(oauthRefreshToken.trim() ? { refresh_token: oauthRefreshToken.trim() } : {}),
                },
              }
            : {}),
          ...(!poolConnection ? { models } : {}),
        }),
      });
      // Only clear fields untouched since this POST began. An intervening edit
      // must survive even when the user retypes the exact submitted value.
      if (isEditorCurrent(generation)) {
        if (secretEdits.current[0] === submittedSecretEdits[0]) setApiKey('');
        if (secretEdits.current[1] === submittedSecretEdits[1]) setOauthIdToken('');
        if (secretEdits.current[2] === submittedSecretEdits[2]) setOauthAccessToken('');
        if (secretEdits.current[3] === submittedSecretEdits[3]) setOauthRefreshToken('');
      }
      // The write succeeded even if the subsequent inventory refresh fails. Do not
      // retry a POST with consumed credentials or discard edits made while saving.
      const accepted = JSON.stringify(
        JSON.parse(snapshot).map((value: unknown, index: number) =>
          index >= 6 && index <= 9 ? '' : value,
        ),
      );
      if (isEditorCurrent(generation)) {
        savedFingerprint.current = accepted;
        setBaseline(accepted);
      }
      try {
        await onModelConnectionsChanged();
      } catch (error) {
        if (isEditorCurrent(generation))
          setRequestError(
            error instanceof Error
              ? `Provider saved, but refresh failed: ${error.message}`
              : 'Provider saved, but refresh failed.',
          );
        return false;
      }
      if (!isEditorCurrent(generation)) return false;
      // The post-write clear may already have rendered. Compare edit sequence,
      // not current values, so cleared secrets do not look like fresh changes.
      if (secretEdits.current.some((count, index) => count !== submittedSecretEdits[index]))
        return false;
      if (
        JSON.stringify(
          JSON.parse(latestDraft.current).map((value: unknown, index: number) =>
            index >= 6 && index <= 9 ? '' : value,
          ),
        ) !==
        JSON.stringify(
          JSON.parse(snapshot).map((value: unknown, index: number) =>
            index >= 6 && index <= 9 ? '' : value,
          ),
        )
      )
        return false;
      setSavedProvidersOpen(true);
      resetProvider();
      onSaved?.();
      return true;
    } catch (error) {
      if (isEditorCurrent(generation))
        setRequestError(
          error instanceof Error
            ? `Could not save provider: ${error.message}`
            : 'Could not save provider.',
        );
      return false;
    } finally {
      if (isEditorCurrent(generation)) {
        writePending.current = false;
        setRequestState('idle');
      }
    }
  };

  const applyOAuthConnection = (connection: OpenAiOAuthConnection) => {
    editorGeneration.current += 1;
    savedFingerprint.current = null;
    writePending.current = false;
    setEditingId(connection.id);
    setConnectionRecoveryRequired(false);
    setProvider(connection.provider ?? 'OpenAI');
    setApiType(connection.apiType ?? 'openai-responses');
    setUrl(connection.baseUrl ?? 'https://chatgpt.com/backend-api');
    setApiKey('');
    setApiKeyConfigured(Boolean(connection.apiKeyConfigured || connection.authConfigured));
    setOauthConnection(Boolean(connection.authConfigured));
    setAutoUseExpiringResets(connection.autoUseExpiringResets === true);
    const models = selectedRuntimeModels(connection.models).map((model) => ({
      ...model,
      selected: true,
    }));
    setAvailableModels(models);
    setSelectedModelId(models[0]?.id ?? null);
    setConnected(Boolean(connection.authConfigured || connection.apiKeyConfigured));
    setBaseline(
      JSON.stringify([
        connection.id,
        connection.provider ?? 'OpenAI',
        connection.apiType ?? 'openai-responses',
        true,
        [],
        connection.baseUrl ?? 'https://chatgpt.com/backend-api',
        '',
        '',
        '',
        '',
        models,
        connection.autoUseExpiringResets === true,
      ]),
    );
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

  const toggleModel = (id: string) =>
    setAvailableModels((all) =>
      all.map((model) =>
        model.id === id ? { ...model, selected: model.selected === false } : model,
      ),
    );

  const toggleModelInput = (id: string, input: 'text' | 'image') =>
    setAvailableModels((all) =>
      all.map((model) => {
        if (model.id !== id) return model;
        const acceptedInput = model.acceptedInput ?? model.discoveredInput ?? ['text'];
        const acceptedInputOverride = acceptedInput.includes(input)
          ? acceptedInput.filter((type) => type !== input)
          : [...acceptedInput, input];
        return { ...model, acceptedInput: acceptedInputOverride, acceptedInputOverride };
      }),
    );

  const toggleModelOutput = (id: string, output: 'text' | 'audio' | 'image' | 'video' | 'file') =>
    setAvailableModels((all) =>
      all.map((model) => {
        if (model.id !== id) return model;
        const acceptedOutput = model.acceptedOutput ?? model.discoveredOutput ?? ['text'];
        const acceptedOutputOverride = acceptedOutput.includes(output)
          ? acceptedOutput.filter((type) => type !== output)
          : [...acceptedOutput, output];
        return { ...model, acceptedOutput: acceptedOutputOverride, acceptedOutputOverride };
      }),
    );

  const setModelOutputAuto = (id: string, enabled: boolean) =>
    setAvailableModels((all) =>
      all.map((model) => {
        if (model.id !== id) return model;
        if (enabled)
          return {
            ...model,
            acceptedOutput: model.discoveredOutput ?? ['text'],
            acceptedOutputOverride: undefined,
          };
        const acceptedOutput = model.acceptedOutput ?? model.discoveredOutput ?? ['text'];
        return { ...model, acceptedOutput, acceptedOutputOverride: acceptedOutput };
      }),
    );

  const setModelContextAuto = (id: string, enabled: boolean) =>
    setAvailableModels((all) =>
      all.map((model) => {
        if (model.id !== id) return model;
        if (enabled)
          return {
            ...model,
            contextWindow: model.discoveredContextWindow,
            contextWindowOverride: undefined,
            contextWindowMode: 'auto',
          };
        const value =
          model.contextWindowOverride ?? model.contextWindow ?? model.discoveredContextWindow;
        return {
          ...model,
          contextWindow: value,
          contextWindowMode: 'manual',
          ...(value ? { contextWindowOverride: value } : { contextWindowOverride: undefined }),
        };
      }),
    );

  const setModelContextOverride = (id: string, value: number | undefined) =>
    setAvailableModels((all) =>
      all.map((model) =>
        model.id === id
          ? {
              ...model,
              contextWindow: value,
              contextWindowOverride: value,
              contextWindowMode: 'manual',
            }
          : model,
      ),
    );

  const setModelInputAuto = (id: string, enabled: boolean) =>
    setAvailableModels((all) =>
      all.map((model) => {
        if (model.id !== id) return model;
        if (enabled)
          return {
            ...model,
            acceptedInput: model.discoveredInput ?? ['text'],
            acceptedInputOverride: undefined,
          };
        const acceptedInput = model.acceptedInput ?? model.discoveredInput ?? ['text'];
        return { ...model, acceptedInput, acceptedInputOverride: acceptedInput };
      }),
    );

  const addManualModel = () => {
    const id = manualModel.trim();
    if (!id) return;
    setAvailableModels((all) =>
      all.some((model) => model.id === id)
        ? all
        : [...all, { id, selected: true, manual: true, acceptedInput: ['text'] }],
    );
    setManualModel('');
  };

  const deleteManualModel = (id: string) =>
    setAvailableModels((all) => all.filter((model) => model.id !== id));

  const editProvider = (item: SavedProvider) => {
    editorGeneration.current += 1;
    savedFingerprint.current = null;
    writePending.current = false;
    setRequestState('idle');
    setEditingId(item.id);
    setConnectionRecoveryRequired(false);
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
    setAutoUseExpiringResets(item.autoUseExpiringResets === true);
    const models =
      item.connectionModels ??
      item.models.map((id) => {
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
          acceptedOutput: item.modelOutputOverrides?.[id] ??
            item.modelDiscoveredOutputs?.[id] ?? ['text'],
        };
      });
    setAvailableModels(models);
    setSelectedModelId(models[0]?.id ?? null);
    setConnected(true);
    setBaseline(
      JSON.stringify([
        item.id,
        item.provider,
        item.apiType,
        item.pool?.enabled ?? true,
        item.pool?.memberConnectionIds ?? [],
        item.url,
        '',
        '',
        '',
        '',
        models,
        item.autoUseExpiringResets === true,
      ]),
    );
    setRequestError('');
    resetClaudeLogin();
    resetOpenAiOAuth();
  };

  const deleteProvider = async (item: SavedProvider) => {
    const generation = editorGeneration.current;
    if (
      !(await confirm({
        title: 'Delete provider?',
        message: `Delete ${item.provider}? This removes its saved connection.`,
        confirmLabel: 'Delete provider',
        tone: 'danger',
      }))
    )
      return;
    if (isEditorCurrent(generation)) setRequestError('');
    try {
      await api(`/api/settings/model-connections/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
      });
      await onModelConnectionsChanged();
      if (isEditorCurrent(generation) && editingId === item.id) resetProvider();
    } catch (error) {
      if (isEditorCurrent(generation))
        setRequestError(
          error instanceof Error
            ? `Could not delete provider: ${error.message}`
            : 'Could not delete provider.',
        );
    }
  };

  useUnsavedChanges({
    dirty: draft !== baseline,
    busy: requestState !== 'idle',
    save: () => saveProvider(),
    discard: () => {
      const [id, name, type, enabled, members, baseUrl, , , , , models, autoResets] = JSON.parse(
        baseline,
      ) as [
        string | null,
        string,
        string,
        boolean,
        string[],
        string,
        string,
        string,
        string,
        string,
        RuntimeModel[],
        boolean,
      ];
      editorGeneration.current += 1;
      setEditingId(id);
      setConnectionRecoveryRequired(false);
      setProvider(name);
      setApiType(type);
      setPoolEnabled(enabled);
      setMemberConnectionIds(members);
      setUrl(baseUrl);
      setAutoUseExpiringResets(autoResets);
      setAvailableModels(models);
      setApiKey('');
      setOauthIdToken('');
      setOauthAccessToken('');
      setOauthRefreshToken('');
      setSelectedModelId(models[0]?.id ?? null);
      setConnected(Boolean(id));
      setManualModel('');
      setRequestError('');
    },
  });

  const openOpenAiOAuth = () =>
    navigate(() => {
      if (editingId) resetOpenAiOAuth();
      else resetProvider();
      setOauthModal('openai');
    });
  const openAnthropicOAuth = () => {
    setApiType('anthropic-messages');
    setOauthModal('anthropic');
  };

  const changeApiType = (next: string) => {
    if (next === apiType || writePending.current) return;
    if (isProviderPool(next) && poolConnection) {
      editorGeneration.current += 1;
      setMemberConnectionIds([]);
      setAvailableModels([]);
      setRequestError('');
      setRequestState('idle');
    } else if (isProviderPool(next) || poolConnection) {
      resetProvider();
      setProvider(
        next === 'openai-lb' ? 'OpenAI LB' : next === 'anthropic-lb' ? 'Anthropic LB' : '',
      );
    } else {
      editorGeneration.current += 1;
      setRequestState('idle');
    }
    setApiType(next);
  };
  const togglePoolMember = (id: string) => {
    if (writePending.current) return;
    editorGeneration.current += 1;
    setRequestState('idle');
    setRequestError('');
    setMemberConnectionIds((ids) =>
      ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id],
    );
    setAvailableModels([]);
    setSelectedModelId(null);
    setConnected(false);
  };

  return {
    poolConnection,
    poolEnabled,
    setPoolEnabled,
    poolMembers,
    memberConnectionIds,
    missingPoolMembers,
    togglePoolMember,
    connectionReady,
    editingId,
    provider,
    setProvider,
    apiType,
    setApiType: changeApiType,
    url,
    setUrl,
    apiKey,
    setApiKey: (value: string) => editSecret(0, setApiKey, value),
    apiKeyConfigured,
    oauthConnection,
    canAutoUseExpiringResets,
    autoUseExpiringResets,
    setAutoUseExpiringResets,
    oauthIdToken,
    setOauthIdToken: (value: string) => editSecret(1, setOauthIdToken, value),
    oauthAccessToken,
    setOauthAccessToken: (value: string) => editSecret(2, setOauthAccessToken, value),
    oauthRefreshToken,
    setOauthRefreshToken: (value: string) => editSecret(3, setOauthRefreshToken, value),
    availableModels,
    manualModel,
    setManualModel,
    connected,
    savedProvidersOpen,
    setSavedProvidersOpen,
    requestState,
    requestError,
    connectionRecoveryRequired,
    oauthModal,
    setOauthModal,
    openAiFlow,
    claudeFlow,
    resetProvider: () => navigate(resetProvider),
    connect,
    saveProvider: async (modelsOverride?: RuntimeModel[], onSaved?: () => void) => {
      await saveProvider(modelsOverride, onSaved);
    },
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
    editProvider: (item: SavedProvider) => {
      if (item.id !== editingId) navigate(() => editProvider(item));
    },
    deleteProvider,
    openOpenAiOAuth,
    openAnthropicOAuth,
  };
}
