import path from 'node:path';
import {
  assertConnection,
  assertProviderPoolMembers,
  discoverModels,
  isProviderPool,
  normalizeModels,
  providerPoolModels,
} from '../../src/model-settings-store.mjs';
import { readMinionSettings, saveMinionSettings } from '../../src/minion-depth.mjs';
import {
  claudeCredentialAuthPayload,
  detectClaudeCliCredential,
} from '../../src/claude-cli-credentials.mjs';
import {
  cancelClaudeCodeLogin,
  getClaudeCodeLogin,
  importClaudeCodeLoginCredential,
  startClaudeCodeLogin,
  submitClaudeCodeLoginCode,
} from '../../src/claude-code-login.mjs';
import {
  cancelOpenAiOAuthLogin,
  getOpenAiOAuthLogin,
  startOpenAiOAuthLogin,
  submitOpenAiOAuthCode,
} from '../../src/openai-oauth-login.mjs';
export function mergeDiscoveredModels(discovered = [], existing = [], normalize = normalizeModels) {
  const prior = new Map((Array.isArray(existing) ? existing : []).map((model) => [String(model?.id || '').trim(), model]).filter(([id]) => id));
  const merged = [];
  for (const model of discovered) {
    const priorModel = prior.get(model.id);
    // Discovery refreshes provider/catalog metadata, but it must not erase
    // explicit operator overrides. Those overrides are the authority when a
    // provider's /models response omits output modalities (as Azure Foundry
    // currently does for image and speech deployments).
    const operatorOverrides = priorModel ? {
      ...(Array.isArray(priorModel.acceptedInputOverride) ? { acceptedInputOverride: priorModel.acceptedInputOverride } : {}),
      ...(Array.isArray(priorModel.acceptedOutputOverride) ? { acceptedOutputOverride: priorModel.acceptedOutputOverride } : {}),
      ...(priorModel.contextWindowOverride !== undefined ? { contextWindowOverride: priorModel.contextWindowOverride } : {}),
    } : {};
    merged.push(normalize([{ ...model, ...operatorOverrides, selected: priorModel?.selected !== false, manual: false }])[0]);
    prior.delete(model.id);
  }
  for (const model of prior.values()) merged.push({ ...model, selected: model.selected !== false, manual: Boolean(model.manual) });
  return merged;
}

/**
 * Model-connection HTTP workflows. Persistent stores, agent authority, and
 * logging are explicit dependencies; provider protocols remain in their named
 * model-settings and login adapters.
 */
export function createModelConnectionService({
  modelsStore,
  metadataStore,
  resolveAgentRuntime,
  logger,
  runtimeRoot = null,
  projectRoot = process.cwd(),
  environment = process.env,
  normalizeModelsImpl = normalizeModels,
  discoverModelsImpl = discoverModels,
  isProviderPoolImpl = isProviderPool,
  assertConnectionImpl = assertConnection,
  assertProviderPoolMembersImpl = assertProviderPoolMembers,
  providerPoolModelsImpl = providerPoolModels,
  readMinionSettingsImpl = readMinionSettings,
  saveMinionSettingsImpl = saveMinionSettings,
  startClaudeCodeLoginImpl = startClaudeCodeLogin,
  getClaudeCodeLoginImpl = getClaudeCodeLogin,
  submitClaudeCodeLoginCodeImpl = submitClaudeCodeLoginCode,
  cancelClaudeCodeLoginImpl = cancelClaudeCodeLogin,
  importClaudeCodeLoginCredentialImpl = importClaudeCodeLoginCredential,
  startOpenAiOAuthLoginImpl = startOpenAiOAuthLogin,
  getOpenAiOAuthLoginImpl = getOpenAiOAuthLogin,
  submitOpenAiOAuthCodeImpl = submitOpenAiOAuthCode,
  cancelOpenAiOAuthLoginImpl = cancelOpenAiOAuthLogin,
  detectClaudeCliCredentialImpl = detectClaudeCliCredential,
  claudeCredentialAuthPayloadImpl = claudeCredentialAuthPayload,
} = {}) {
  if (typeof modelsStore !== 'function') throw new TypeError('models_store_required');
  if (typeof resolveAgentRuntime !== 'function') throw new TypeError('resolve_agent_runtime_required');
  const claudeCodeLoginConnectionIds = new Map();

  async function modelConnections() {
    return { ok: true, connections: await modelsStore().list() };
  }

  async function ensureClaudeCodeConnection(body = {}) {
    const store = modelsStore();
    const explicitId = String(body.connectionId || body.modelConnectionId || '').trim();
    if (explicitId) {
      const connection = await store.get(explicitId);
      if (!connection) { const error = new Error('model_connection_not_found'); error.statusCode = 404; throw error; }
      return connection;
    }
    const defaults = {
      provider: 'Anthropic',
      apiType: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      acceptedInput: ['text', 'image'],
    };
    const provider = String(body.provider || defaults.provider).trim() || defaults.provider;
    const apiType = String(body.apiType || defaults.apiType).trim() || defaults.apiType;
    const baseUrl = String(body.baseUrl || defaults.baseUrl).trim() || defaults.baseUrl;
    // A login without an explicit connection ID starts a new account flow. Reusing
    // the first connection with the same Anthropic endpoint causes its eventual
    // Save to overwrite that account instead of preserving the new one.
    let selectedProvider = provider;
    for (let suffix = 0; suffix < 10; suffix += 1) {
      try {
        return await store.save({ provider: selectedProvider, apiType, baseUrl, acceptedInput: Array.isArray(body.acceptedInput) ? body.acceptedInput : defaults.acceptedInput, models: Array.isArray(body.models) ? body.models : [] });
      } catch (error) {
        if (!/provider_label_duplicate/.test(String(error?.message || error))) throw error;
        selectedProvider = suffix === 0 ? 'Anthropic OAuth' : `Anthropic OAuth ${suffix + 1}`;
      }
    }
    throw new Error('claude_code_connection_label_unavailable');
  }

  async function startClaudeCodeLoginApi(body = {}) {
    try {
      const connection = await ensureClaudeCodeConnection(body);
      const login = await startClaudeCodeLoginImpl({ runtimeRoot: runtimeRoot || environment.BURROW_RUNTIME_ROOT || path.dirname(projectRoot) });
      if (login?.id) claudeCodeLoginConnectionIds.set(login.id, connection.id);
      return { ok: true, connection, login };
    } catch (error) {
      return { ok: false, status: error?.statusCode || 400, error: String(error?.message || error) };
    }
  }

  function claudeCodeLoginStatus(id) {
    const login = getClaudeCodeLoginImpl({ id });
    return login ? { ok: true, login } : { ok: false, status: 404, error: 'claude_code_login_not_found' };
  }

  function submitClaudeCodeLoginApi(id, body = {}) {
    return submitClaudeCodeLoginCodeImpl({ id, code: body.code });
  }

  async function cancelClaudeCodeLoginApi(id) {
    try { return await cancelClaudeCodeLoginImpl({ id }); }
    finally { claudeCodeLoginConnectionIds.delete(String(id || '')); }
  }

  async function importClaudeCodeLoginApi(id, body = {}) {
    try {
      const store = modelsStore();
      const mappedConnectionId = claudeCodeLoginConnectionIds.get(String(id || ''));
      const connection = await ensureClaudeCodeConnection(mappedConnectionId && !body.connectionId && !body.modelConnectionId ? { ...body, connectionId: mappedConnectionId } : body);
      const result = await importClaudeCodeLoginCredentialImpl({ id, persistAuth: async (auth) => { await store.persistAuth(connection.id, auth); return await store.get(connection.id); } });
      if (result.ok) claudeCodeLoginConnectionIds.delete(String(id || ''));
      return result;
    } catch (error) {
      return { ok: false, status: error?.statusCode || 400, error: String(error?.message || error) };
    }
  }

  async function persistOpenAiOauthForConnection(connectionId) {
    const store = modelsStore();
    const connection = await store.get(connectionId);
    if (!connection) throw new Error('model_connection_not_found');
    return async (auth) => { await store.persistAuth(connection.id, auth); return await store.get(connection.id); };
  }

  async function ensureOpenAiOAuthConnection(body = {}) {
    const store = modelsStore();
    const explicitId = String(body.connectionId || body.modelConnectionId || '').trim();
    if (explicitId) {
      const connection = await store.get(explicitId);
      if (!connection) { const error = new Error('model_connection_not_found'); error.statusCode = 404; throw error; }
      return connection;
    }

    const defaults = {
      provider: 'OpenAI',
      apiType: 'openai-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      acceptedInput: ['text', 'image'],
    };
    const provider = String(body.provider || defaults.provider).trim() || defaults.provider;
    const apiType = String(body.apiType || defaults.apiType).trim() || defaults.apiType;
    const baseUrl = String(body.baseUrl || defaults.baseUrl).trim() || defaults.baseUrl;
    // A login without an explicit connection ID starts a new account flow. Reusing
    // the first matching OpenAI endpoint overwrites that account's OAuth token.
    let selectedProvider = provider;
    for (let suffix = 0; suffix < 10; suffix += 1) {
      try {
        return await store.save({
          provider: selectedProvider,
          apiType,
          baseUrl,
          acceptedInput: Array.isArray(body.acceptedInput) ? body.acceptedInput : defaults.acceptedInput,
          models: Array.isArray(body.models) ? body.models : [],
        });
      } catch (error) {
        if (!/provider_label_duplicate/.test(String(error?.message || error))) throw error;
        selectedProvider = suffix === 0 ? 'OpenAI OAuth' : `OpenAI OAuth ${suffix + 1}`;
      }
    }
    throw new Error('openai_oauth_connection_label_unavailable');
  }

  async function startOpenAiOAuthLoginApi(body = {}) {
    try {
      const connection = await ensureOpenAiOAuthConnection(body);
      return { ok: true, connection, login: await startOpenAiOAuthLoginImpl({ connectionId: connection.id, persistAuth: await persistOpenAiOauthForConnection(connection.id) }) };
    } catch (error) {
      return { ok: false, status: error?.statusCode || 400, error: String(error?.message || error) };
    }
  }

  function openAiOAuthLoginStatus(id) {
    const login = getOpenAiOAuthLoginImpl({ id });
    return login ? { ok: true, login } : { ok: false, status: 404, error: 'openai_oauth_login_not_found' };
  }

  async function submitOpenAiOAuthLoginApi(id, body = {}) {
    const existing = getOpenAiOAuthLoginImpl({ id });
    const connectionId = existing?.connectionId || String(body.connectionId || body.modelConnectionId || '').trim();
    return submitOpenAiOAuthCodeImpl({ id, input: body.code || body.redirectUrl || body.input, persistAuth: connectionId ? await persistOpenAiOauthForConnection(connectionId) : undefined });
  }

  async function cancelOpenAiOAuthLoginApi(id) {
    return cancelOpenAiOAuthLoginImpl({ id });
  }

  async function claudeCliCredentialStatus() {
    return { ok: true, credential: detectClaudeCliCredentialImpl({ allowKeychainPrompt: false }) };
  }

  async function importClaudeCliCredential(body = {}) {
    try {
      const store = modelsStore();
      const connection = await ensureClaudeCodeConnection(body);
      const auth = claudeCredentialAuthPayloadImpl({ allowKeychainPrompt: false });
      const saved = await store.persistAuth(connection.id, { ...auth, source: 'claude-code-import' });
      return { ok: true, connection: await store.get(connection.id), auth: { configured: true, type: saved.type, provider: saved.provider, source: saved.source, expiresAt: saved.expiresAt } };
    } catch (error) {
      return { ok: false, status: 400, error: String(error?.message || error) };
    }
  }

  async function agentModelSelection(agentId) {
    const runtime = await resolveAgentRuntime(agentId);
    return { ok: true, selection: await modelsStore().modelSelection(runtime.agentId) };
  }

  async function saveAgentModelSelection(agentId, body = {}) {
    try {
      const runtime = await resolveAgentRuntime(agentId);
      return { ok: true, selection: await modelsStore().saveModelSelection({ agentId: runtime.agentId, connectionId: body.connectionId || body.modelConnectionId, model: body.model || body.modelId, reasoningEffort: body.reasoningEffort, thinkingMode: body.thinkingMode, temperature: body.temperature }) };
    } catch (error) {
      return { ok: false, status: error?.statusCode || 400, error: String(error?.message || error) };
    }
  }

  async function agentMinionModelSelection(agentId) {
    const runtime = await resolveAgentRuntime(agentId);
    return { ok: true, selection: await modelsStore().modelSelection(runtime.agentId, { minion: true }) };
  }

  async function saveAgentMinionModelSelection(agentId, body = {}) {
    try {
      const runtime = await resolveAgentRuntime(agentId);
      return { ok: true, selection: await modelsStore().saveModelSelection({ agentId: runtime.agentId, connectionId: body.connectionId || body.modelConnectionId, model: body.model || body.modelId, reasoningEffort: body.reasoningEffort, thinkingMode: body.thinkingMode, temperature: body.temperature, minion: true }) };
    } catch (error) {
      return { ok: false, status: error?.statusCode || 400, error: String(error?.message || error) };
    }
  }

  async function agentMinionSettings(agentId) {
    const runtime = await resolveAgentRuntime(agentId);
    return { ok: true, ...await readMinionSettingsImpl(metadataStore(), runtime.agentId) };
  }

  async function saveAgentMinionSettings(agentId, body = {}) {
    const runtime = await resolveAgentRuntime(agentId);
    return { ok: true, ...await saveMinionSettingsImpl(metadataStore(), runtime.agentId, body) };
  }

  async function chatIdentities() { return { ok: true, ...await modelsStore().identities() }; }
  async function saveChatIdentity(body = {}) {
    try { return { ok: true, ...await modelsStore().saveIdentity(body) }; }
    catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; }
  }

  async function discoverModelConnection(body = {}) {
    const store = modelsStore();
    const existing = body.id ? await store.get(String(body.id)) : null;
    let auth = body.auth || (existing ? await store.auth(existing.id) : null) || {};
    const baseUrl = body.baseUrl || existing?.baseUrl;
    const apiType = body.apiType || existing?.apiType;
    const priorModels = body.models || existing?.models || [];
    try {
      if (isProviderPoolImpl({ apiType })) {
        const connection = { ...assertConnectionImpl({ ...existing, ...body, apiType }), id: existing?.id };
        const members = await Promise.all(connection.pool.memberConnectionIds.map(id => store.get(id)));
        assertProviderPoolMembersImpl(connection, members.filter(Boolean));
        const catalogs = await Promise.all(members.map(async member => {
          const models = await store.discoverModels({ id: member.id, useModelsDev: true, signal: AbortSignal.timeout(15_000) });

          return { ...member, models };
        }));
        const discovered = providerPoolModelsImpl(catalogs);
        return { ok: true, models: discovered, discovery: { status: discovered.length ? 'discovered' : 'manual_only', count: discovered.length } };
      }
      if (existing && auth?.type === 'oauth' && /openai/i.test(String(auth.provider || existing.provider || '')) && /chatgpt\.com\/backend-api/i.test(String(baseUrl || ''))) auth = { ...auth, ...(await store.resolveAuth(existing.id)) };
      const apiKey = String(body.apiKey || '').trim() || (auth?.token ? String(auth.token).trim() : '') || (auth?.apiKey ? String(auth.apiKey).trim() : '') || (auth?.accessToken ? String(auth.accessToken).trim() : '') || (existing ? await store.apiKey(existing.id) : null);
      const hasCredential = Boolean(apiKey || auth?.token || auth?.apiKey || auth?.accessToken);
      if (!hasCredential) return { ok: false, status: 400, error: 'api_key_required' };
      const discovered = existing && auth.type === 'oauth' && !body.auth && !body.apiKey && baseUrl === existing.baseUrl && apiType === existing.apiType
        ? await store.discoverModels({ id: existing.id, useModelsDev: true, signal: AbortSignal.timeout(15_000) })
        : await discoverModelsImpl({ baseUrl, provider: body.provider || existing?.provider || auth?.provider, useModelsDev: true, apiType, apiKey, auth, store, signal: AbortSignal.timeout(15_000) });
      return { ok: true, models: mergeDiscoveredModels(discovered, priorModels, normalizeModelsImpl), discovery: { status: discovered.length ? 'discovered' : 'manual_only', count: discovered.length } };
    } catch (error) {
      return { ok: true, models: mergeDiscoveredModels([], priorModels, normalizeModelsImpl), discovery: { status: 'manual_only', count: 0, error: String(error?.message || error) } };
    }
  }

  async function saveModelConnection(body = {}) {
    try {
      return { ok: true, connection: await modelsStore().save(body) };
    } catch (error) {
      return { ok: false, status: 400, error: String(error?.message || error) };
    }
  }

  async function resolveModelConnectionChatBody(body = {}) {
    const connectionId = String(body.modelConnectionId || body.modelProviderId || '').trim();
    const model = String(body.model || body.modelId || '').trim();
    if (!connectionId || !model || model === 'off') return body;
    const store = modelsStore();
    const connection = await store.get(connectionId);
    if (!connection) {
      const error = new Error('model_connection_not_found');
      error.statusCode = 400;
      throw error;
    }
    const selected = (connection.models || []).some((item) => item.id === model && item.selected !== false);
    if (!selected) {
      const error = new Error('model_not_enabled_for_connection');
      error.statusCode = 400;
      throw error;
    }
    if (!await store.hasAuth(connection.id)) {
      const error = new Error('model_connection_auth_required');
      error.statusCode = 400;
      throw error;
    }
    return {
      ...body,
      // Only the connection record ID and exact enabled model cross the API boundary.
      // Runtime resolution retrieves connection metadata and its encrypted secret
      // directly from the settings database.
      modelConnectionId: connection.id,
      model,
      modelConnection: undefined,
      modelBaseUrl: undefined,
      modelApi: undefined,
      modelApiKey: undefined,
    };
  }

  return {
    modelConnections,
    ensureClaudeCodeConnection,
    startClaudeCodeLoginApi,
    claudeCodeLoginStatus,
    submitClaudeCodeLoginApi,
    cancelClaudeCodeLoginApi,
    importClaudeCodeLoginApi,
    ensureOpenAiOAuthConnection,
    startOpenAiOAuthLoginApi,
    openAiOAuthLoginStatus,
    submitOpenAiOAuthLoginApi,
    cancelOpenAiOAuthLoginApi,
    claudeCliCredentialStatus,
    importClaudeCliCredential,
    agentModelSelection,
    saveAgentModelSelection,
    agentMinionModelSelection,
    saveAgentMinionModelSelection,
    agentMinionSettings,
    saveAgentMinionSettings,
    chatIdentities,
    saveChatIdentity,
    discoverModelConnection,
    saveModelConnection,
    resolveModelConnectionChatBody,
  };
}
