import path from 'node:path';
import { ModelSettingsStore, settingsKeyFromEnvironment } from './model-settings-store.mjs';
import { getSettingsMeta, openSettingsDatabase } from './settings-database.mjs';
import { getUiAuthSecret } from './ui-auth-secrets.mjs';
import { normalizeContextCompressionConfig } from './context-compression.mjs';
import { anthropicSupportsTemperature, isAnthropicMessagesConnection } from './anthropic-model-capabilities.mjs';

export const MODEL_REASONING_EFFORT_VALUES = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const MODEL_REASONING_EFFORTS = new Set(MODEL_REASONING_EFFORT_VALUES);
export const DEFAULT_RUNTIME_ROOT = '/mnt/local/burrow';
export const DEFAULT_WORKSPACE_ID = 'workspace';
export const DEFAULT_AGENT_ID = 'hatchet';

const text = (value) => String(value ?? '').trim();
const absolute = (value, fallback) => path.resolve(text(value) || fallback);
const env = (name, fallback = undefined) => process.env[name] === undefined ? fallback : process.env[name];

export const PROVIDER_DEFAULT_CONTEXT_TOKENS = Object.freeze({ openai: 292_000, anthropic: 1_000_000 });

export function resolveEffectiveModelContextTokens({ contextTokens = null, contextWindow = null, provider = '', api = '' } = {}) {
  for (const value of [contextTokens, contextWindow]) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const family = `${text(provider)} ${text(api)}`.toLowerCase();
  if (family.includes('anthropic')) return PROVIDER_DEFAULT_CONTEXT_TOKENS.anthropic;
  if (family.includes('openai') || family.includes('responses') || family.includes('chat-completions')) return PROVIDER_DEFAULT_CONTEXT_TOKENS.openai;
  return null;
}

export function normalizeModelReasoningEffort(value) {
  if (value === undefined || value === null) return null;
  const normalized = text(value).toLowerCase();
  if (!MODEL_REASONING_EFFORTS.has(normalized)) throw new Error(`invalid reasoning effort: ${value}`);
  return normalized;
}

/**
 * Configuration ownership is SQLite plus service environment. This retained
 * loader is intentionally an inert compatibility seam: it never reads or
 * writes burrow.json (or any other application JSON configuration).
 */
export async function loadBurrowConfig() {
  return { path: null, exists: false, config: {}, validation: { ok: true, errors: [], warnings: [] } };
}
export function validateConfig() { return { ok: true, errors: [], warnings: [] }; }
export function configDefaults() { return {}; }

function selectedModels(connection) {
  return (Array.isArray(connection?.models) ? connection.models : []).filter((model) => model && model.selected !== false && text(model.id));
}

function modelSupportsTemperature({ provider = '', api = '', model = '', declared = undefined } = {}) {
  if (declared === false) return false;
  if (isAnthropicMessagesConnection({ provider, apiType: api })) return anthropicSupportsTemperature(model);
  return true;
}
function explicitSettingsKey(args = {}) {
  const supplied = args.settings_key ?? args.settingsKey;
  if (supplied === undefined || supplied === null || supplied === '') return undefined;
  if (Buffer.isBuffer(supplied)) return supplied;
  return settingsKeyFromEnvironment({ BURROW_SETTINGS_KEY: supplied });
}
async function resolveSqliteModel(connectionId, modelId, args = {}) {
  const store = new ModelSettingsStore({ databasePath: args.settings_db ?? args.settingsDb, key: explicitSettingsKey(args) });
  try {
    const connection = store.get(connectionId);
    if (!connection) throw new Error('model_connection_not_found');
    const model = selectedModels(connection).find((item) => item.id === modelId);
    if (!model) throw new Error('model_not_enabled_for_connection');
    const auth = await store.resolveAuth(connection.id, { fetchImpl: args.fetchImpl ?? fetch });
    return { connection, model, auth };
  } finally { store.close(); }
}

/** Models are selected only by an enabled SQLite connection/model pair. */
export async function resolveModelConfig(args = {}) {
  let connectionId = text(args.model_connection_id ?? args.modelConnectionId);
  let modelId = text(args.model ?? args.model_id ?? args.modelId);
  let agentSelection = null;
  if (text(args.agent_id ?? args.agentId) && (process.env.BURROW_SETTINGS_KEY || explicitSettingsKey(args))) {
    const store = new ModelSettingsStore({ databasePath: args.settings_db ?? args.settingsDb, key: explicitSettingsKey(args) });
    try { agentSelection = store.modelSelection(text(args.agent_id ?? args.agentId)); } finally { store.close(); }
    connectionId = connectionId || agentSelection?.connectionId || '';
    modelId = modelId || agentSelection?.model || '';
  }
  if (!connectionId || !modelId) return null;
  const { connection, model, auth } = await resolveSqliteModel(connectionId, modelId, args);
  const reasoningEffort = normalizeModelReasoningEffort(args.model_reasoning_effort ?? args.reasoning_effort ?? agentSelection?.reasoningEffort ?? 'off');
  const suppliedTemperature = args.temperature ?? args.model_temperature;
  const temperature = suppliedTemperature === undefined || suppliedTemperature === null || suppliedTemperature === '' ? (agentSelection?.temperature ?? 0.2) : Number(suppliedTemperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error(`invalid model temperature: ${suppliedTemperature}`);
  const extra = reasoningEffort === 'off' ? undefined : { reasoning: { effort: reasoningEffort } };
  const result = {
    provider: connection.provider,
    providerName: connection.provider,
    api: connection.apiType,
    baseUrl: connection.baseUrl,
    apiKey: auth.token,
    auth,
    model: model.id,
    temperature,
    contextWindow: model.contextWindow ?? undefined,
    contextTokens: resolveEffectiveModelContextTokens({ contextTokens: model.contextTokens, contextWindow: model.contextWindow, provider: connection.provider, api: connection.apiType }) ?? undefined,
    reasoningEfforts: model.reasoningEfforts ?? undefined,
    defaultReasoningEffort: model.defaultReasoningEffort ?? undefined,
    supportsTemperature: modelSupportsTemperature({ provider: connection.provider, api: connection.apiType, model: model.id, declared: model.supportsTemperature }),
    // Per-model capabilities take precedence. The connection-level value remains
    // a backward-compatible fallback for models saved before this setting.
    supportsVision: (model.acceptedInput ?? connection.acceptedInput ?? []).includes('image'),
    vision: (model.acceptedInput ?? connection.acceptedInput ?? []).includes('image'),
    multimodal: (model.acceptedInput ?? connection.acceptedInput ?? []).includes('image'),
    capabilities: { images: (model.acceptedInput ?? connection.acceptedInput ?? []).includes('image'), vision: (model.acceptedInput ?? connection.acceptedInput ?? []).includes('image') },
    extra,
    connectionId: connection.id,
    availableModels: selectedModels(connection),
    selectedModel: model.id,
    // runtime_id remains only in older SQLite rows; all model connections use the direct API runtime.
    runtimeId: 'direct-api',
    selectionSource: agentSelection ? 'agent-default' : 'turn-override',
  };
  Object.defineProperty(result, 'resolveChildModel', { enumerable: false, value: async (childId) => resolveModelConfig({ modelConnectionId: connection.id, model: childId }) });
  return result;
}
export function redactModelConfig(modelConfig) {
  if (!modelConfig) return null;
  return { provider: modelConfig.provider, providerName: modelConfig.providerName, api: modelConfig.api, baseUrl: modelConfig.baseUrl, model: modelConfig.model, temperature: modelConfig.temperature ?? 0.2, hasApiKey: Boolean(modelConfig.apiKey), contextWindow: modelConfig.contextWindow || null, contextTokens: modelConfig.contextTokens || null, connectionId: modelConfig.connectionId || null, selectedModel: modelConfig.selectedModel || null };
}


export function resolveExecutionConfig(args = {}) { return { profile: text(args.autonomy_profile) || 'local-dev', executeProposals: args.execute_proposals === true, allowReviewRequiredProposals: args.allow_review_required_proposals === true, allowMutationProposals: args.allow_mutation_proposals === true, commitChanges: args.commit_changes === true, commitMessage: args.commit_message || null }; }
function splitCsv(value) {
  return text(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function readUiAuthSettings(databasePath) {
  if (!databasePath) return {};
  let db = null;
  try {
    db = openSettingsDatabase({ databasePath });
    const value = getSettingsMeta(db, 'ui_auth');
    const settings = value && typeof value === 'object' ? value : {};
    if (settings.oidc && typeof settings.oidc === 'object' && !settings.oidc.clientSecret) {
      try { settings.oidc = { ...settings.oidc, clientSecret: getUiAuthSecret(db) }; } catch {}
    }
    return settings;
  } catch {
    return {};
  } finally {
    try { db?.close(); } catch {}
  }
}

export async function resolveUiConfig(args = {}) {
  const settings = readUiAuthSettings(args.settings_database_path ?? args.settingsDatabasePath ?? env('BURROW_SETTINGS_DB'));
  const envMode = env('BURROW_UI_AUTH_MODE');
  const mode = text(args.ui_auth_mode ?? envMode ?? settings.mode ?? 'none').toLowerCase();
  const allowedModes = new Set(['none', 'trusted-proxy', 'basic', 'oidc']);
  if (!allowedModes.has(mode)) throw new Error(`invalid ui auth mode: ${mode}`);
  return {
    host: args.ui_host ?? env('BURROW_UI_HOST', '127.0.0.1'),
    port: args.ui_port ?? env('BURROW_UI_PORT', '42817'),
    authMode: mode,
    authEnabled: mode !== 'none',
    authSource: args.ui_auth_mode || envMode ? 'environment' : (settings.mode ? 'sqlite' : 'default'),
    trustedProxy: {
      allowedProxies: splitCsv(args.ui_auth_allowed_proxies ?? env('BURROW_UI_AUTH_ALLOWED_PROXIES') ?? settings.trustedProxy?.allowedProxies?.join?.(',') ?? settings.trustedProxy?.allowedProxy ?? '127.0.0.1,::1'),
      userHeader: text(args.ui_auth_user_header ?? env('BURROW_UI_AUTH_USER_HEADER') ?? settings.trustedProxy?.userHeader ?? 'x-forwarded-user').toLowerCase() || 'x-forwarded-user',
    },
    basic: {
      username: text(args.ui_auth_basic_username ?? env('BURROW_UI_AUTH_BASIC_USERNAME') ?? settings.basic?.username) || null,
      passwordHash: text(args.ui_auth_basic_password_hash ?? env('BURROW_UI_AUTH_BASIC_PASSWORD_HASH') ?? settings.basic?.passwordHash) || null,
      sessionTtlSeconds: Math.max(60, Number(args.ui_auth_basic_session_ttl_seconds ?? env('BURROW_UI_AUTH_BASIC_SESSION_TTL_SECONDS') ?? settings.basic?.sessionTtlSeconds ?? 12 * 60 * 60) || 12 * 60 * 60),
    },
    oidc: {
      issuer: text(args.ui_auth_oidc_issuer ?? env('BURROW_UI_AUTH_OIDC_ISSUER') ?? settings.oidc?.issuer) || null,
      clientId: text(args.ui_auth_oidc_client_id ?? env('BURROW_UI_AUTH_OIDC_CLIENT_ID') ?? settings.oidc?.clientId) || null,
      clientSecret: text(args.ui_auth_oidc_client_secret ?? env('BURROW_UI_AUTH_OIDC_CLIENT_SECRET') ?? settings.oidc?.clientSecret) || null,
      redirectUri: text(args.ui_auth_oidc_redirect_uri ?? env('BURROW_UI_AUTH_OIDC_REDIRECT_URI') ?? settings.oidc?.redirectUri) || null,
      scopes: splitCsv(args.ui_auth_oidc_scopes ?? env('BURROW_UI_AUTH_OIDC_SCOPES') ?? settings.oidc?.scopes?.join?.(',') ?? 'openid,email,profile'),
      allowedEmails: splitCsv(args.ui_auth_oidc_allowed_emails ?? env('BURROW_UI_AUTH_OIDC_ALLOWED_EMAILS') ?? settings.oidc?.allowedEmails?.join?.(',') ?? ''),
      allowedDomains: splitCsv(args.ui_auth_oidc_allowed_domains ?? env('BURROW_UI_AUTH_OIDC_ALLOWED_DOMAINS') ?? settings.oidc?.allowedDomains?.join?.(',') ?? ''),
      insecureCookies: String(args.ui_auth_oidc_insecure_cookies ?? env('BURROW_UI_AUTH_OIDC_INSECURE_COOKIES') ?? settings.oidc?.insecureCookies ?? '').toLowerCase() === 'true',
    },
  };
}

export function defaultRuntimeRoot() { return env('BURROW_RUNTIME_ROOT', DEFAULT_RUNTIME_ROOT); }
export function defaultRuntimeWorkspaceRoot() { return path.join(defaultRuntimeRoot(), DEFAULT_WORKSPACE_ID); }
export function defaultRuntimeAgentWorkspaceRoot() { return path.join(defaultRuntimeWorkspaceRoot(), DEFAULT_AGENT_ID); }
export function defaultRuntimeAgentDataRoot() { return path.join(defaultRuntimeRoot(), 'agentdata', DEFAULT_AGENT_ID); }
export function defaultRuntimeDataRoot() { return defaultRuntimeAgentDataRoot(); }
export function defaultRuntimeCacheRoot() { return path.join(defaultRuntimeRoot(), 'cache'); }
export function defaultRuntimeArchiveRoot() { return path.join(defaultRuntimeRoot(), 'archive'); }
export function defaultRuntimeSourceRoot() { return env('BURROW_SOURCE_ROOT', process.cwd()); }

/** Deployment paths are service-environment owned; CLI flags are explicit one-shot overrides. */
export function resolveRuntimeStateConfig({ rootDir, args = {} } = {}) {
  const agentId = text(args.agent_id ?? env('BURROW_AGENT_ID', DEFAULT_AGENT_ID)) || DEFAULT_AGENT_ID;
  const sourceRoot = absolute(args.source_root ?? env('BURROW_SOURCE_ROOT'), rootDir || process.cwd());
  const workspaceRoot = absolute(args.workspace_root ?? env('BURROW_WORKSPACE_ROOT'), defaultRuntimeWorkspaceRoot());
  const agentWorkspaceRoot = absolute(args.agent_workspace_root ?? env('BURROW_AGENT_WORKSPACE_ROOT'), path.join(workspaceRoot, agentId));
  const agentDataRoot = absolute(args.agent_data_root ?? env('BURROW_AGENT_DATA_ROOT'), path.join(defaultRuntimeRoot(), 'agentdata', agentId));
  const dataRoot = absolute(args.data_root ?? env('BURROW_DATA_ROOT'), agentDataRoot);
  const cacheRoot = absolute(args.cache_root ?? env('BURROW_CACHE_ROOT'), path.join(defaultRuntimeRoot(), 'cache'));
  const archiveRoot = absolute(args.archive_root ?? env('BURROW_ARCHIVE_ROOT'), path.join(defaultRuntimeRoot(), 'archive'));
  const settingsDatabasePath = absolute(args.settings_database_path ?? env('BURROW_SETTINGS_DB'), path.join(defaultRuntimeRoot(), 'config', 'settings.sqlite'));
  return { sourceRoot, workspaceRoot, workspaceRootSource: 'environment', agentId, agentWorkspaceRoot, agentWorkspaceRootSource: 'environment', agentDataRoot, agentDataRootSource: 'environment', filesystemBoundaries: [], sourceCopyRoot: sourceRoot, skillsRoot: absolute(args.skills_root ?? env('BURROW_SKILLS_ROOT'), path.join(agentWorkspaceRoot, 'skills')), skillsRootSource: 'environment', dataRoot, dataRootSource: 'environment', cacheRoot, cacheRootSource: 'environment', archiveRoot, archiveRootSource: 'environment', settingsDatabasePath };
}
function safe(value, fallback) { return text(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || fallback; }
export function resolveRuntimeTracePath({ cacheRoot, workspaceRoot, agentId = DEFAULT_AGENT_ID, sessionId = 'default', runId = null, testIsolation = null } = {}) { const resolvedCacheRoot = path.resolve(cacheRoot); const tracedWorkspace = safe(path.basename(path.resolve(workspaceRoot || DEFAULT_WORKSPACE_ID)), DEFAULT_WORKSPACE_ID); const parts = [resolvedCacheRoot, testIsolation ? 'test-traces' : 'traces', tracedWorkspace, safe(agentId, DEFAULT_AGENT_ID), safe(sessionId, 'default')]; if (runId) parts.push(safe(runId, 'run')); return path.join(...parts); }
function runtimeTestIsolation(args = {}) { const explicit = args.test_isolation ?? args.testIsolation ?? env('BURROW_TRACE_ISOLATION'); return explicit === undefined || explicit === null ? Boolean(process.env.NODE_V8_COVERAGE || process.env.TEST || process.env.NODE_TEST_CONTEXT || process.env.npm_lifecycle_event === 'test' || process.execArgv.includes('--test')) : /^(?:1|true|yes)$/i.test(String(explicit)); }
export async function resolveRuntimeTraceRoot(rootDir, args = {}) { return resolveRuntimeTracePath({ ...resolveRuntimeStateConfig({ rootDir, args }), sessionId: 'default', testIsolation: runtimeTestIsolation(args) }); }
export function resolveSubjectScopes() { return []; }
export function resolveDreamSchedulerConfig() { return { enabled: false }; }
export function resolveRetentionConfig() {
  const positive = (value, fallback = null) => {
    const resolved = value === undefined ? fallback : value;
    return Number.isFinite(Number(resolved)) && Number(resolved) > 0 ? Number(resolved) : null;
  };
  return {
    sessionsMax: null,
    tracesMax: null,
    maxAgeDays: null,
    mainMaxAgeDays: positive(env('BURROW_MAIN_SESSION_MAX_AGE_DAYS'), 60),
    taskMaxAgeDays: positive(env('BURROW_TASK_SESSION_MAX_AGE_DAYS'), 30),
    subagentMaxAgeDays: positive(env('BURROW_SUBAGENT_SESSION_MAX_AGE_DAYS'), 7),
    traceMaxAgeDays: positive(env('BURROW_TRACE_MAX_AGE_DAYS')),
    traceMaxBytes: positive(env('BURROW_TRACE_MAX_BYTES')),
  };
}
const DEFAULT_SUBAGENT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SUBAGENT_MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_SUBAGENT_TIMEOUT_MS = 30 * 1000;

function boundedTimeout(value, fallback, { min = MIN_SUBAGENT_TIMEOUT_MS, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/** Runtime-owned limits for isolated child processes; no unlimited mode exists. */
export function resolveSubagentTimeoutConfig(args = {}) {
  const maxTimeoutMs = boundedTimeout(args.subagent_max_timeout_ms ?? args.subagentMaxTimeoutMs ?? env('BURROW_SUBAGENT_MAX_TIMEOUT_MS'), DEFAULT_SUBAGENT_MAX_TIMEOUT_MS);
  const defaultTimeoutMs = boundedTimeout(args.subagent_timeout_ms ?? args.subagentTimeoutMs ?? env('BURROW_SUBAGENT_TIMEOUT_MS'), DEFAULT_SUBAGENT_TIMEOUT_MS, { max: maxTimeoutMs });
  return Object.freeze({ defaultTimeoutMs, maxTimeoutMs, minTimeoutMs: MIN_SUBAGENT_TIMEOUT_MS });
}

export function resolveChatToolLoopConfig() { return { stopOnNoProgress: false, loopWarningThreshold: 2, loopBlockThreshold: 3 }; }
export function resolveContextConfig(args = {}) {
  return normalizeContextCompressionConfig({
    // Chat HTTP requests intentionally do not accept runtime compression policy.
    // The service environment owns that default; explicit CLI args remain a
    // one-shot override for non-server commands.
    contextThreshold: args.context_threshold ?? env('BURROW_CONTEXT_THRESHOLD'),
    freshTailCount: args.fresh_tail_count ?? env('BURROW_CONTEXT_FRESH_TAIL_COUNT'),
    freshTailMaxTokens: args.fresh_tail_max_tokens ?? env('BURROW_CONTEXT_FRESH_TAIL_MAX_TOKENS'),
    leafChunkTokens: args.leaf_chunk_tokens ?? env('BURROW_CONTEXT_LEAF_CHUNK_TOKENS'),
    summaryTargetTokens: args.summary_target_tokens ?? env('BURROW_CONTEXT_SUMMARY_TARGET_TOKENS'),
    summaryModel: args.summary_model ?? env('BURROW_CONTEXT_SUMMARY_MODEL'),
    maxSweepIterations: args.max_sweep_iterations ?? env('BURROW_CONTEXT_MAX_SWEEP_ITERATIONS'),
    sweepDeadlineMs: args.sweep_deadline_ms ?? env('BURROW_CONTEXT_SWEEP_DEADLINE_MS'),
  });
}
export function resolveSkillsConfig() { return { disabledSkillIds: [], experimentalSkillIds: [], deprecatedSkillIds: [], memoryIndex: { enabled: false, namespace: 'skills', storesBody: false } }; }
export const __test__ = {};
