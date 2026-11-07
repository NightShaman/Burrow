import { useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { SavedProvider } from '../../app/types';
import { api, type RuntimeModel } from '../../app/api';
import type { OpenAiOAuthConnection } from './modelConnectionsApi';
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

export const savedProviderFromConnection = (connection: OpenAiOAuthConnection): SavedProvider => {
  const models = selectedRuntimeModels(connection.models);
  return {
    id: connection.id,
    provider: connection.provider ?? 'OpenAI',
    apiType: connection.apiType ?? 'openai-responses',
    url: connection.baseUrl ?? 'https://chatgpt.com/backend-api',
    apiKey: '',
    models: models.filter((model) => model.selected !== false).map((model) => model.id),
    manualModels: Object.fromEntries(
      models.filter((model) => model.manual).map((model) => [model.id, true]),
    ),
    modelLabels: Object.fromEntries(
      models.filter((model) => model.displayName).map((model) => [model.id, model.displayName!]),
    ),
    modelEfforts: Object.fromEntries(
      models
        .filter((model) => model.reasoningEfforts?.length)
        .map((model) => [model.id, model.reasoningEfforts!]),
    ),
    defaultEfforts: Object.fromEntries(
      models
        .filter((model) => model.defaultReasoningEffort)
        .map((model) => [model.id, model.defaultReasoningEffort!]),
    ),
    modelContextWindows: Object.fromEntries(
      models
        .filter((model) => model.contextWindow)
        .map((model) => [model.id, model.contextWindow!]),
    ),
    modelDiscoveredInputs: Object.fromEntries(
      models
        .filter((model) => model.discoveredInput?.length)
        .map((model) => [model.id, model.discoveredInput!]),
    ),
    modelInputOverrides: Object.fromEntries(
      models
        .filter((model) => model.acceptedInputOverride?.length)
        .map((model) => [model.id, model.acceptedInputOverride!]),
    ),
    modelDiscoveredOutputs: Object.fromEntries(
      models
        .filter((model) => model.discoveredOutput?.length)
        .map((model) => [model.id, model.discoveredOutput!]),
    ),
    modelOutputOverrides: Object.fromEntries(
      models
        .filter((model) => model.acceptedOutputOverride?.length)
        .map((model) => [model.id, model.acceptedOutputOverride!]),
    ),
  };
};

export function useWizardOAuthProvisioning({
  setProviders,
  setConnectionId,
  setModel,
}: {
  setProviders: Dispatch<SetStateAction<SavedProvider[]>>;
  setConnectionId: Dispatch<SetStateAction<string>>;
  setModel: Dispatch<SetStateAction<string>>;
}) {
  const [oauthProvider, setOauthProvider] = useState<'openai' | 'anthropic' | null>(null);
  const wizardOAuthConnection = useRef<OpenAiOAuthConnection | null>(null);
  const saveWizardConnection = async (connection: OpenAiOAuthConnection) => {
    if (!connection.id || !connection.provider || !connection.apiType || !connection.baseUrl)
      throw new Error('OAuth completed, but the connection details were incomplete.');

    // The OAuth callback can report authorized before the saved connection has a model list.
    // Discover only after that authorization state, using its freshly stored OAuth credentials.
    const discovered = await api<{ models: RuntimeModel[] }>(
      '/api/settings/model-connections/discover',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: connection.id,
          provider: connection.provider,
          apiType: connection.apiType,
          baseUrl: connection.baseUrl,
        }),
      },
    );
    const models = selectedRuntimeModels(discovered.models).map((item) => ({
      ...item,
      selected: true,
    }));
    if (!models.length)
      throw new Error('OAuth completed, but did not return any available models.');
    await api('/api/settings/model-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: connection.id,
        provider: connection.provider,
        apiType: connection.apiType,
        baseUrl: connection.baseUrl,
        models,
      }),
    });
    const result = await api<{ connections: OpenAiOAuthConnection[] }>(
      '/api/settings/model-connections',
    );
    setProviders((result.connections ?? []).map(savedProviderFromConnection));
    setConnectionId(connection.id);
    setModel(models[0]?.id ?? '');
  };
  const receiveWizardOAuthConnection = (connection: OpenAiOAuthConnection) => {
    wizardOAuthConnection.current = connection;
  };
  const completeWizardOAuth = async () => {
    if (!wizardOAuthConnection.current)
      throw new Error('OAuth completed, but the connection details were unavailable.');
    await saveWizardConnection(wizardOAuthConnection.current);
    setOauthProvider(null);
  };
  const {
    login: openAiLogin,
    code: openAiOAuthCode,
    setCode: setOpenAiOAuthCode,
    requestState: openAiOAuthState,
    error: openAiOAuthError,
    start: startOpenAiOAuth,
    submit: submitOpenAiOAuth,
    reset: resetOpenAiOAuth,
  } = useOpenAiOAuthConnectionFlow({
    onConnection: receiveWizardOAuthConnection,
    onAuthorized: completeWizardOAuth,
  });
  const {
    login: claudeLogin,
    code: claudeOAuthCode,
    setCode: setClaudeOAuthCode,
    requestState: claudeOAuthState,
    error: claudeOAuthError,
    start: startClaudeOAuth,
    submit: submitClaudeOAuth,
    reset: resetClaudeOAuth,
  } = useClaudeCodeLoginFlow({
    onConnection: receiveWizardOAuthConnection,
    onImported: completeWizardOAuth,
    autoImport: true,
  });
  const oauthBusy =
    oauthProvider === 'openai'
      ? openAiOAuthState
      : oauthProvider === 'anthropic'
        ? claudeOAuthState
        : 'idle';
  const oauthError =
    oauthProvider === 'openai'
      ? openAiOAuthError
      : oauthProvider === 'anthropic'
        ? claudeOAuthError
        : '';
  const oauthCode = oauthProvider === 'openai' ? openAiOAuthCode : claudeOAuthCode;
  const setOauthCode = (code: string) => {
    if (oauthProvider === 'openai') setOpenAiOAuthCode(code);
    else setClaudeOAuthCode(code);
  };
  const startWizardOAuth = async (kind: 'openai' | 'anthropic') => {
    setOauthProvider(kind);
    wizardOAuthConnection.current = null;
    resetOpenAiOAuth();
    resetClaudeOAuth();
    if (kind === 'openai') await startOpenAiOAuth();
    else await startClaudeOAuth();
  };
  const submitWizardOAuth = async () => {
    if (oauthProvider === 'openai') await submitOpenAiOAuth();
    else if (oauthProvider === 'anthropic') await submitClaudeOAuth();
  };
  const resetWizardOAuth = () => {
    wizardOAuthConnection.current = null;
    setOauthProvider(null);
    resetOpenAiOAuth();
    resetClaudeOAuth();
  };
  return {
    oauthProvider,
    setOauthProvider,
    openAiLogin,
    claudeLogin,
    oauthBusy,
    oauthError,
    oauthCode,
    setOauthCode,
    startWizardOAuth,
    submitWizardOAuth,
    resetWizardOAuth,
  };
}
