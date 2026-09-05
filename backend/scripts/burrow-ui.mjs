#!/usr/bin/env node
import { releaseVersion } from '../src/release-version.mjs';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSessionContext, inspectSessionContextStatus } from '../src/context-engine.mjs';
import { activeConversationLimits } from '../src/context-preparation.mjs';
import { createChatTurnRunId, runChatTurnFromBody, runChatTurnFromWorkbenchContinuation, chatTurnResponse, chatTurnProgressResponse, chatTurnErrorResponse, loadRuntimeConfig } from '../src/chat-turn-controller.mjs';
import { resolveModelConfig, resolveRuntimeTracePath } from '../src/config.mjs';
import { getSettingsMeta, setSettingsMeta, settingsOwnershipInventory } from '../src/settings-database.mjs';
import { completeSetup, readSetupStatus } from '../src/setup-state-store.mjs';
import { getUiAuthSecret, hasUiAuthSecret, setUiAuthSecret } from '../src/ui-auth-secrets.mjs';
import { collectTraceObservability } from '../src/trace-observability.mjs';
import { listSubagentRecords, subagentVisibilitySummary } from '../src/subagent-store.mjs';
import { ContinuityHandoffStore, buildContinuityHandoff, listContinuityHandoffs } from '../src/continuity-handoff-store.mjs';
import { appendSessionEntry, archiveSession, forkSession, listResetSessionArchives, listSessionRecords, readActivityEvents, readChatMessages, readResetSessionArchive, readSessionMetadata, readSessionTurns, exportSessionTranscript, renameSession, resetSession, summarizeSessionTurns, writeResetSessionArchiveMetadata, writeSessionMetadata } from '../src/session-store.mjs';
import { runPendingRecoveryContinuations } from '../src/recovery-continuation-runner.mjs';
import { recordActiveRunInterruptions } from '../src/interrupted-run-recovery.mjs';
import { generateArchiveSummary } from '../src/archive-summary.mjs';
import { listArchiveRuns, readArchiveRun } from '../src/archive-proof.mjs';
import { loadWorkingContinuity, normalizeContinuityScope, projectHandoffsIntoWorkingContinuity } from '../src/working-memory-continuity.mjs';
import { persistSessionWorkingContext, workingContextFromSession } from '../src/working-context.mjs';
import { appendGroupChannelTurn, createGroupChannel, listGroupChannels, readGroupChannel, readGroupChannelTurns } from '../src/group-channel-store.mjs';
import { resolveGroupMentionTargets } from '../src/group-channel-routing.mjs';
import { planRetentionCleanup, runRetentionCleanup } from '../src/retention.mjs';
import { normalizeRetentionPolicy, readRetentionPolicy, readRetentionPolicyState, retentionPolicyFailureState, retentionPolicySuccessState, saveRetentionPolicy, writeRetentionPolicyState } from '../src/retention-settings.mjs';
import { createRetentionScheduler } from '../src/retention-scheduler.mjs';
import { createInstallStagingCleanupScheduler } from '../src/install-staging-cleanup.mjs';
import { authorityExplanationFromTraceSummary, latestAuthorityExplanationForSession, listAuthorityExplanationsForSession, summarizeTrace } from '../src/trace-summary.mjs';
import { routeRequest } from '../src/request-router.mjs';
import { planTurn } from '../src/turn-planner.mjs';
import { workbenchWorkflow } from '../src/workbench-workflow.mjs';
import { runWorkbenchStep } from '../src/workbench-runner.mjs';
import { resolveExecutionTarget } from '../src/execution-context.mjs';
import { createExecutionProviderRegistry } from '../src/process-execution-router.mjs';
import { buildChatSupportStatus, buildWorkbenchStatus } from '../src/workbench-status.mjs';
import { allowedNextSteps, appendWorkItemStep, archiveWorkItem, createWorkItem, listWorkItems, readWorkItem, workItemEligibility } from '../src/work-item-store.mjs';
import { searchBurrowSessionEvidence, searchSessionEvidence } from '../src/session-search.mjs';
import { ModelSettingsStore, CODEX_CLIENT_VERSION_CACHE_TTL_MS, discoverModels, refreshCodexClientVersionCache, settingsDatabasePath } from '../src/model-settings-store.mjs';
import { claudeCredentialAuthPayload, detectClaudeCliCredential } from '../src/claude-cli-credentials.mjs';
import { cancelClaudeCodeLogin, getClaudeCodeLogin, importClaudeCodeLoginCredential, startClaudeCodeLogin, submitClaudeCodeLoginCode } from '../src/claude-code-login.mjs';
import { cancelOpenAiOAuthLogin, getOpenAiOAuthLogin, startOpenAiOAuthLogin, submitOpenAiOAuthCode } from '../src/openai-oauth-login.mjs';
import { WorkingMemoryStore } from '../src/working-memory-store.mjs';
import { curatorRoot, curatorRuntimeStatus, readCuratorSelection, saveCuratorSelection } from '../src/curator-runtime.mjs';
import { AgentRegistryStore, agentRuntimeContext, ensureAgentRoots } from '../src/agent-registry.mjs';
import { AGENT_PROFILE_KINDS, AgentProfileStore } from '../src/agent-profile-store.mjs';
import { DreamDiaryStore } from '../src/dream-diary-store.mjs';
import { DreamSettingsStore } from '../src/dream-settings-store.mjs';
import { consolidateDreamMemory } from '../src/dream-memory-consolidator.mjs';
import { createDreamCycleScheduler, latestDreamCycleReceipts, runDreamCycle } from '../src/dream-cycle-runner.mjs';
import { createTiddleScheduler, listTiddleCards, tiddleHistory, tiddleStatus } from '../src/tiddle-continuity.mjs';
import { cleanupAgentAttachments, createAttachmentCleanupScheduler, deleteAttachmentArtifact, listSessionAttachments, resolveAttachmentArtifact } from '../src/attachment-store.mjs';
import { TaskBoardStore, TASK_PRIORITIES, TASK_STATUSES } from '../src/task-board-store.mjs';
import { ScheduledJobStore } from '../src/scheduled-job-store.mjs';
import { createScheduledJobScheduler } from '../src/scheduled-job-scheduler.mjs';
import { backgroundSchedulersEnabled } from '../src/background-scheduler-policy.mjs';
import { McpSettingsStore } from '../src/mcp-settings-store.mjs';
import { diagnoseMcpConnection as diagnoseMcpConnectionRuntime, discoverMcpTools, hydrateMcpProviderStates, reconcilePersistentMcpConnection } from '../src/mcporter-adapter.mjs';
import { createRuntimeMetricsCollector } from '../src/runtime-metrics.mjs';
import { createRuntimeServerLogger } from '../src/runtime-server-log.mjs';
import { latestProviderRequest } from '../src/provider-request-inspection.mjs';
import { chatCommandHelpText, chatCommandResponse, parseChatCommand } from '../src/chat-commands.mjs';
import { activeChatRunKey, activeChatRunSummaries, activeChatRunSummary, cancelActiveChatRun, registerActiveAgentRun } from '../src/active-chat-runs.mjs';
import { toolActivityPresentation, toolActivityStatus } from '../src/tool-activity-labels.mjs';
import { executionBoundaryStatus, readExecutionBoundaries, saveExecutionBoundaries } from '../src/execution-boundaries.mjs';
import { clearOidcCookies, completeOidcCallback, oidcCookieClearHeader, oidcLoginUrl, oidcSessionFromRequest, sendOidcSessionCookie, setOidcStateCookie } from '../src/ui-oidc-auth.mjs';
import { buildExport, decodeExport, exportCatalog, normalizeImportRequest } from '../src/export-service.mjs';
import { createExportRoutes } from './ui/export-routes.mjs';
import { createTaskBoardRoutes } from './ui/task-board-routes.mjs';
import { createWorkbenchRoutes } from './ui/workbench-routes.mjs';
import { createDreamRoutes } from './ui/dream-routes.mjs';
import { createSettingsRoutes } from './ui/settings-routes.mjs';
import { createAgentRoutes } from './ui/agent-routes.mjs';
import { createSessionRoutes } from './ui/session-routes.mjs';
import { createGeneralSettingsRoutes } from './ui/general-settings-routes.mjs';
import { createObservabilityRoutes } from './ui/observability-routes.mjs';
import { createScheduledChannelRoutes } from './ui/scheduled-channel-routes.mjs';
import { createAuthRoutes } from './ui/auth-routes.mjs';
import { createChatRoutes } from './ui/chat-routes.mjs';
import { cleanupMods, createModRoute, loadMods } from '../src/mod-runtime.mjs';
import { MAX_OVERVIEW_CHILD_CONTEXTS, normalizeOverviewBody, overviewSessionIds } from '../src/agent-overview.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(process.env.BURROW_SOURCE_ROOT || sourceRoot);
const uiDistRoot = path.join(projectRoot, 'public', 'ui');
const apiDocsRoot = path.join(sourceRoot, 'public', 'api-docs');
const port = Number(process.env.BURROW_UI_PORT || process.argv.find((arg) => arg.startsWith('--port='))?.split('=')[1] || 42817);
const host = process.env.BURROW_UI_HOST || '0.0.0.0';
const activeChatRuns = new Map();
const executionProviders = createExecutionProviderRegistry();
const sessionContinuityHeads = new Map();
// The continuity head rejects stale writes, but browser requests sharing a
// session must not make each other stale in the first place. Serialize the
// complete HTTP turn per agent/session; nested A2A runs are serialized by the
// runtime queue in app-runtime.
const sessionChatQueues = new Map();
function sessionChatQueueKey(agentId, sessionId) { return `${String(agentId)}:${String(sessionId || 'default')}`; }
async function serializeSessionChat({ agentId, sessionId, operation }) {
  const key = sessionChatQueueKey(agentId, sessionId);
  const previous = sessionChatQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  sessionChatQueues.set(key, current);
  try { return await current; }
  finally { if (sessionChatQueues.get(key) === current) sessionChatQueues.delete(key); }
}
const claudeCodeLoginConnectionIds = new Map();
const groupChannelRuns = new Map();
let modelSettingsStore = null;
let agentRegistryStore = null;
let mcpSettingsStore = null;
let scheduledJobScheduler = null;
let dreamCycleScheduler = null;
let tiddleScheduler = null;
let attachmentCleanupScheduler = null;
let retentionScheduler = null;
let installStagingCleanupScheduler = null;
const traceStatusCache = new Map();
const TRACE_STATUS_CACHE_MS = 30_000;
const ANTHROPIC_USAGE_CACHE_MS = 60_000;
const OPENAI_OAUTH_USAGE_CACHE_MS = 60_000;
const BASIC_SESSION_COOKIE = 'hc_basic_session';
const OPENAI_OAUTH_USAGE_URL = process.env.BURROW_OPENAI_OAUTH_USAGE_URL || 'https://chatgpt.com/backend-api/wham/usage';
const anthropicUsageCache = new Map();
const openaiOauthUsageCache = new Map();
const runtimeRoot = process.env.BURROW_RUNTIME_ROOT || process.env.BURROW_DATA_ROOT || '/mnt/local/burrow';
const serverLogger = createRuntimeServerLogger({ runtimeRoot });
await hydrateMcpProviderStates({ runtimeRoot: process.env.BURROW_MCPORTER_ROOT || path.join(runtimeRoot, 'integrations', 'mcporter') }).catch((error) => serverLogger.event('mcp_provider_state_hydration_failed', { error: String(error?.message || error) }));
const runtimeMetrics = createRuntimeMetricsCollector({
  runtimeRoot: process.env.BURROW_DATA_ROOT || '/mnt/local/burrow',
  settingsDatabasePath: settingsDatabasePath(),
});

function profilesStore() { return new AgentProfileStore({ databasePath: settingsDatabasePath() }); }
function dreamDiaryStore() { return new DreamDiaryStore({ databasePath: settingsDatabasePath() }); }
function dreamSettingsStore() { return new DreamSettingsStore({ databasePath: settingsDatabasePath() }); }

function agentsStore() {
  if (!agentRegistryStore) agentRegistryStore = new AgentRegistryStore({ databasePath: settingsDatabasePath() });
  return agentRegistryStore;
}

async function withTaskBoard(operation) {
  const store = new TaskBoardStore({ databasePath: settingsDatabasePath() });
  try { return await operation(store); } finally { store.close(); }
}

async function withScheduledJobs(operation) {
  const store = new ScheduledJobStore({ databasePath: settingsDatabasePath() });
  try { return await operation(store); } finally { store.close(); }
}

function scheduler() {
  if (!scheduledJobScheduler) scheduledJobScheduler = createScheduledJobScheduler({
    storeFactory: () => new ScheduledJobStore({ databasePath: settingsDatabasePath() }),
    resolveAgentRuntime, rootDir: projectRoot,
  });
  return scheduledJobScheduler;
}

function dreamScheduler() {
  if (!dreamCycleScheduler) dreamCycleScheduler = createDreamCycleScheduler({
    databasePath: settingsDatabasePath(),
    resolveAgentRoot: async (agentId) => (await resolveAgentRuntime(agentId))?.agentWorkspaceRoot || null,
  });
  return dreamCycleScheduler;
}

function rollingContinuityScheduler() {
  if (!tiddleScheduler) tiddleScheduler = createTiddleScheduler({
    databasePath: settingsDatabasePath(),
    runtimeRoot: process.env.BURROW_RUNTIME_ROOT || '/mnt/local/burrow',
  });
  return tiddleScheduler;
}

function attachmentScheduler() {
  if (!attachmentCleanupScheduler) attachmentCleanupScheduler = createAttachmentCleanupScheduler({
    databasePath: settingsDatabasePath(),
    resolveAgentWorkspaceRoot: async (agentId) => (await resolveAgentRuntime(agentId))?.agentWorkspaceRoot || null,
  });
  return attachmentCleanupScheduler;
}

function retentionPolicyScheduler() {
  if (!retentionScheduler) retentionScheduler = createRetentionScheduler({
    databasePath: settingsDatabasePath(),
    runCleanup: async (policy) => retentionCleanup({ policy, confirm: true, includeAttachments: true }),
  });
  return retentionScheduler;
}

function installerStagingScheduler() {
  if (!installStagingCleanupScheduler) installStagingCleanupScheduler = createInstallStagingCleanupScheduler({ runtimeRoot });
  return installStagingCleanupScheduler;
}

function taskExecutionMessage(task, project) {
  return [
    'Task-board execution request. Work this task now and report concise evidence, blockers, and any changed files. Before changing this board task’s status, fields, assignment, or metadata, confirm the intended board update with Rob; do not infer it from work completion alone.',
    `Task ID: ${task.id}`,
    `Project: ${project.name} (${project.id})`,
    `Title: ${task.title}`,
    `Priority: ${task.priority}`,
    task.description ? `Description:\n${task.description}` : null,
    Object.keys(task.metadata || {}).length ? `Metadata:\n${JSON.stringify(task.metadata, null, 2)}` : null,
  ].filter(Boolean).join('\n\n');
}

async function executeBoardTask(taskId) {
  const dispatch = await withTaskBoard(async (store) => {
    const task = store.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (!task.assignedAgentId) return { ok: false, error: 'task_assigned_agent_required', task };
    if (['done', 'cancelled'].includes(task.status)) return { ok: false, error: 'task_not_executable', task };
    const project = store.getProject(task.projectId);
    const agentRuntime = await resolveAgentRuntime(task.assignedAgentId);
    // Board tasks deliberately execute where Rob works: the assigned agent's
    // main/default conversation. The task record, not a task-specific session,
    // is the durable execution owner.
    const sessionId = 'default';
    const runId = createChatTurnRunId({ sessionId, prefix: 'task' });
    const updated = store.startExecution(task.id, { agentId: agentRuntime.agentId, sessionId, runId });
    return { ok: true, task, project, agentRuntime, sessionId, runId, updated };
  });
  if (!dispatch.ok) return dispatch;
  const { task, project, agentRuntime, sessionId, runId, updated } = dispatch;
  const controller = new AbortController();
  const record = { agentId: agentRuntime.agentId, runId, sessionId, controller, startedAt: new Date().toISOString(), phase: 'thinking', latestUserMessage: taskExecutionMessage(task, project).slice(0, 16_000), progress: [], contextUsage: null, cancelled: false, reason: null, detached: true, taskId: task.id };
  const headKey = sessionContinuityHeadKey(agentRuntime.agentId, sessionId);
  sessionContinuityHeads.set(headKey, record);
  activeChatRuns.set(activeChatRunKey(agentRuntime.agentId, runId), record);
  void runChatTurnFromBody({
    body: { message: record.latestUserMessage, sessionId, runId, abortSignal: controller.signal },
    rootDir: projectRoot,
    agentRuntime,
    resolveAgentRuntime,
    onTraceRecord: (traceRecord) => {
      const progress = publicChatProgress(traceRecord);
      if (!progress) return;
      record.progress = [...record.progress, { ...progress, runId, sessionId, ts: traceRecord.ts || new Date().toISOString() }].slice(-50);
      if (progress.type === 'model.started') record.phase = 'thinking';
      if (progress.type === 'model.completed') record.phase = 'streaming';
    },
    onModelContextUsage: async (usage) => {
      if (!usage || typeof usage !== 'object') return;
      record.contextUsage = updateContextUsageHighWater(record.contextUsage, usage);
    },
  }).then(async (result) => {
    const taskResult = {
      answerText: String(result.answerText || '').slice(0, 12_000) || null,
      blockers: Array.isArray(result.blockers) ? result.blockers.slice(0, 20) : [],
      verification: result.verification ? { required: Boolean(result.verification.required), ok: result.verification.ok ?? null, reason: result.verification.reason || null } : null,
      completionEvidence: result.completionEvidence || null,
    };
    await withTaskBoard((store) => store.recordExecution(task.id, { agentId: agentRuntime.agentId, sessionId, runId: result.runId || runId, decision: result.decision || null, ok: Boolean(result.ok), executedAt: new Date().toISOString(), traceDir: result.traceDir || null, error: result.ok ? null : (result.error || null), result: taskResult }));
  }).catch(async (error) => {
    await withTaskBoard((store) => store.recordExecution(task.id, { agentId: agentRuntime.agentId, sessionId, runId, ok: false, error: String(error?.message || error), result: { answerText: null, blockers: [String(error?.message || error)], verification: null, completionEvidence: null } }));
  }).finally(() => {
    if (activeChatRuns.get(activeChatRunKey(agentRuntime.agentId, runId)) === record) activeChatRuns.delete(activeChatRunKey(agentRuntime.agentId, runId));
  });
  return { ok: true, task: updated, execution: updated.execution };
}

function updateContextUsageHighWater(previous, usage) {
  const previousEstimated = Number.isFinite(Number(previous?.estimatedTokens)) ? Number(previous.estimatedTokens) : null;
  const currentEstimated = Number.isFinite(Number(usage?.estimatedTokens)) ? Number(usage.estimatedTokens) : null;
  const previousProvider = Number.isFinite(Number(previous?.providerInputTokens)) ? Number(previous.providerInputTokens) : null;
  const currentProvider = Number.isFinite(Number(usage?.providerInputTokens)) ? Number(usage.providerInputTokens) : null;
  const candidates = [previousEstimated, currentEstimated, previousProvider, currentProvider].filter((value) => value !== null);
  if (!candidates.length) return { ...usage };
  const highWater = Math.max(...candidates);
  return { ...usage, estimatedTokens: highWater, highWaterEstimatedTokens: highWater, highWaterProviderInputTokens: Math.max(...[previousProvider, currentProvider].filter((value) => value !== null), 0) || null, provenance: usage.continuation ? 'run-high-water-continuation' : 'run-high-water-initial' };
}

function sessionContinuityHeadKey(agentId, sessionId) {
  return `${String(agentId)}:${String(sessionId || 'default')}`;
}
function groupChannelRunKey(channelId, agentId, runId) {
  return `${String(channelId)}:${String(agentId)}:${String(runId)}`;
}

async function selectedAgentRuntime(agentId = null) {
  return agentId ? resolveAgentRuntime(agentId) : null;
}

async function dataRootForAgent(agentRuntime = null) {
  return agentRuntime?.agentDataRoot || runtimeDataRoot();
}

function agentRuntimeArgs(agentRuntime, dataRoot) {
  // Agent authority is passed out-of-band as agentRuntime, never serialized
  // into mutable request arguments.
  return agentRuntime ? {} : { data_root: dataRoot };
}


let codexClientVersionRefreshInterval = null;
function refreshCodexClientVersionNow() {
  void refreshCodexClientVersionCache({ store: modelsStore(), signal: AbortSignal.timeout(15_000) }).catch((error) => {
    console.warn(`Codex client version refresh failed: ${String(error?.message || error)}`);
  });
}
function startCodexClientVersionRefresh() {
  refreshCodexClientVersionNow();
  if (!codexClientVersionRefreshInterval) codexClientVersionRefreshInterval = setInterval(refreshCodexClientVersionNow, CODEX_CLIENT_VERSION_CACHE_TTL_MS);
  codexClientVersionRefreshInterval.unref?.();
}

function modelsStore() {
  if (!modelSettingsStore) modelSettingsStore = new ModelSettingsStore({ databasePath: settingsDatabasePath() });
  return modelSettingsStore;
}
function mcpStore() {
  if (!mcpSettingsStore) mcpSettingsStore = new McpSettingsStore({ databasePath: settingsDatabasePath() });
  return mcpSettingsStore;
}
async function mcpConnections() { return { ok: true, connections: mcpStore().list() }; }
async function saveMcpConnection(body = {}) { try {
  const store = mcpStore();
  const { existing, next } = store.prepareSave(body);
  const previousApiKey = existing ? store.apiKey(existing.id) : null;
  const nextApiKey = body.apiKey === undefined || !String(body.apiKey || '').trim() ? previousApiKey : String(body.apiKey).trim();
  const previousEnvironmentVariables = existing ? store.secretEnvironment(existing.id) : {};
  const nextEnvironmentVariables = Array.isArray(body.environmentVariables) ? Object.fromEntries(body.environmentVariables.map((entry) => [String(entry?.name || '').trim(), entry?.value === undefined || !String(entry.value).trim() ? previousEnvironmentVariables[String(entry?.name || '').trim()] : String(entry.value).trim()]).filter(([name, value]) => name && value)) : previousEnvironmentVariables;
  // Persist configuration and scoped secrets before touching a running daemon.
  // A stale/broken keep-alive process must not turn a valid settings update into
  // a failed save (and lose the operator's replacement secret).
  const connection = store.save(body);
  try {
    await reconcilePersistentMcpConnection(existing, next, { previousApiKey, nextApiKey, previousEnvironmentVariables, nextEnvironmentVariables });
  } catch (error) {
    console.warn(`MCP connection ${connection.id} was saved but its prior keep-alive daemon could not be stopped: ${String(error?.message || error)}`);
  }
  return { ok: true, connection };
} catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; } }
async function removeMcpConnection(id) {
  try {
    const store = mcpStore();
    const connection = store.get(id);
    if (!connection) return false;
    await reconcilePersistentMcpConnection(connection, null, { previousApiKey: store.apiKey(connection.id), previousEnvironmentVariables: store.secretEnvironment(connection.id) });
    return store.remove(id);
  } catch (error) { throw error; }
}
async function discoverMcpConnection(body = {}) { try { const connection = mcpStore().get(body.connectionId); if (!connection) return { ok: false, status: 404, error: 'mcp_connection_not_found' }; const tools = await discoverMcpTools(connection, { apiKey: mcpStore().apiKey(connection.id), environmentVariables: mcpStore().secretEnvironment(connection.id) }); return { ok: true, connection: mcpStore().refreshTools(connection.id, tools), tools }; } catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; } }
async function diagnoseMcpConnection(body = {}) {
  const connection = mcpStore().get(body.connectionId);
  if (!connection) return { ok: false, status: 404, error: 'mcp_connection_not_found' };
  const result = await diagnoseMcpConnectionRuntime(connection, { apiKey: mcpStore().apiKey(connection.id), environmentVariables: mcpStore().secretEnvironment(connection.id), toolName: typeof body.toolName === 'string' && body.toolName.trim() ? body.toolName.trim() : null, arguments: body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments : {} });
  return { ...result, ...(result.ok ? {} : { status: 400 }) };
}
async function agentMcpTools(agentId) { try { await resolveAgentRuntime(agentId); return { ok: true, agentId, tools: mcpStore().agentTools(agentId) }; } catch (error) { return { ok: false, status: error?.statusCode || 400, error: String(error?.message || error) }; } }
async function saveAgentMcpTools(agentId, body = {}) { try { return { ok: true, agentId, tools: mcpStore().setAgentTools(agentId, body.tools) }; } catch (error) { return { ok: false, status: String(error?.message || error) === 'agent_not_found' ? 404 : 400, error: String(error?.message || error) }; } }

function mergeDiscoveredModels(discovered = [], existing = []) {
  const prior = new Map((Array.isArray(existing) ? existing : []).map((model) => [String(model?.id || '').trim(), model]).filter(([id]) => id));
  const merged = [];
  for (const model of discovered) {
    const priorModel = prior.get(model.id);
    merged.push({ ...model, selected: priorModel?.selected === true, manual: false });
    prior.delete(model.id);
  }
  for (const model of prior.values()) merged.push({ ...model, selected: model.selected !== false, manual: Boolean(model.manual) });
  return merged;
}

async function modelConnections() {
  return { ok: true, connections: modelsStore().list() };
}


const CLAUDE_CODE_DEFAULT_CONNECTION = Object.freeze({
  provider: 'Anthropic',
  apiType: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  acceptedInput: ['text', 'image'],
});

function ensureClaudeCodeConnection(body = {}) {
  const store = modelsStore();
  const explicitId = String(body.connectionId || body.modelConnectionId || '').trim();
  if (explicitId) {
    const connection = store.get(explicitId);
    if (!connection) { const error = new Error('model_connection_not_found'); error.statusCode = 404; throw error; }
    return connection;
  }
  const provider = String(body.provider || CLAUDE_CODE_DEFAULT_CONNECTION.provider).trim() || CLAUDE_CODE_DEFAULT_CONNECTION.provider;
  const apiType = String(body.apiType || CLAUDE_CODE_DEFAULT_CONNECTION.apiType).trim() || CLAUDE_CODE_DEFAULT_CONNECTION.apiType;
  const baseUrl = String(body.baseUrl || CLAUDE_CODE_DEFAULT_CONNECTION.baseUrl).trim() || CLAUDE_CODE_DEFAULT_CONNECTION.baseUrl;
  // A login without an explicit connection ID starts a new account flow. Reusing
  // the first connection with the same Anthropic endpoint causes its eventual
  // Save to overwrite that account instead of preserving the new one.
  let selectedProvider = provider;
  for (let suffix = 0; suffix < 10; suffix += 1) {
    try {
      return store.save({ provider: selectedProvider, apiType, baseUrl, acceptedInput: Array.isArray(body.acceptedInput) ? body.acceptedInput : CLAUDE_CODE_DEFAULT_CONNECTION.acceptedInput, models: Array.isArray(body.models) ? body.models : [] });
    } catch (error) {
      if (!/provider_label_duplicate/.test(String(error?.message || error))) throw error;
      selectedProvider = suffix === 0 ? 'Anthropic OAuth' : `Anthropic OAuth ${suffix + 1}`;
    }
  }
  throw new Error('claude_code_connection_label_unavailable');
}

async function startClaudeCodeLoginApi(body = {}) {
  try {
    const connection = ensureClaudeCodeConnection(body);
    const login = await startClaudeCodeLogin({ runtimeRoot: process.env.BURROW_RUNTIME_ROOT || path.dirname(projectRoot) });
    if (login?.id) claudeCodeLoginConnectionIds.set(login.id, connection.id);
    return { ok: true, connection, login };
  } catch (error) {
    return { ok: false, status: error?.statusCode || 400, error: String(error?.message || error) };
  }
}

function claudeCodeLoginStatus(id) {
  const login = getClaudeCodeLogin({ id });
  return login ? { ok: true, login } : { ok: false, status: 404, error: 'claude_code_login_not_found' };
}

function submitClaudeCodeLoginApi(id, body = {}) {
  return submitClaudeCodeLoginCode({ id, code: body.code });
}

async function cancelClaudeCodeLoginApi(id) {
  try { return await cancelClaudeCodeLogin({ id }); }
  finally { claudeCodeLoginConnectionIds.delete(String(id || '')); }
}

async function importClaudeCodeLoginApi(id, body = {}) {
  try {
    const store = modelsStore();
    const mappedConnectionId = claudeCodeLoginConnectionIds.get(String(id || ''));
    const connection = ensureClaudeCodeConnection(mappedConnectionId && !body.connectionId && !body.modelConnectionId ? { ...body, connectionId: mappedConnectionId } : body);
    const result = await importClaudeCodeLoginCredential({ id, persistAuth: (auth) => { store.persistAuth(connection.id, auth); return store.get(connection.id); } });
    if (result.ok) claudeCodeLoginConnectionIds.delete(String(id || ''));
    return result;
  } catch (error) {
    return { ok: false, status: error?.statusCode || 400, error: String(error?.message || error) };
  }
}

const OPENAI_OAUTH_DEFAULT_CONNECTION = Object.freeze({
  provider: 'OpenAI',
  apiType: 'openai-responses',
  baseUrl: 'https://chatgpt.com/backend-api',
  acceptedInput: ['text', 'image'],
});

function persistOpenAiOauthForConnection(connectionId) {
  const store = modelsStore();
  const connection = store.get(connectionId);
  if (!connection) throw new Error('model_connection_not_found');
  return (auth) => { store.persistAuth(connection.id, auth); return store.get(connection.id); };
}

function ensureOpenAiOAuthConnection(body = {}) {
  const store = modelsStore();
  const explicitId = String(body.connectionId || body.modelConnectionId || '').trim();
  if (explicitId) {
    const connection = store.get(explicitId);
    if (!connection) { const error = new Error('model_connection_not_found'); error.statusCode = 404; throw error; }
    return connection;
  }

  const provider = String(body.provider || OPENAI_OAUTH_DEFAULT_CONNECTION.provider).trim() || OPENAI_OAUTH_DEFAULT_CONNECTION.provider;
  const apiType = String(body.apiType || OPENAI_OAUTH_DEFAULT_CONNECTION.apiType).trim() || OPENAI_OAUTH_DEFAULT_CONNECTION.apiType;
  const baseUrl = String(body.baseUrl || OPENAI_OAUTH_DEFAULT_CONNECTION.baseUrl).trim() || OPENAI_OAUTH_DEFAULT_CONNECTION.baseUrl;
  // A login without an explicit connection ID starts a new account flow. Reusing
  // the first matching OpenAI endpoint overwrites that account's OAuth token.
  let selectedProvider = provider;
  for (let suffix = 0; suffix < 10; suffix += 1) {
    try {
      return store.save({
        provider: selectedProvider,
        apiType,
        baseUrl,
        acceptedInput: Array.isArray(body.acceptedInput) ? body.acceptedInput : OPENAI_OAUTH_DEFAULT_CONNECTION.acceptedInput,
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
    const connection = ensureOpenAiOAuthConnection(body);
    return { ok: true, connection, login: await startOpenAiOAuthLogin({ connectionId: connection.id, persistAuth: persistOpenAiOauthForConnection(connection.id) }) };
  } catch (error) {
    return { ok: false, status: error?.statusCode || 400, error: String(error?.message || error) };
  }
}

function openAiOAuthLoginStatus(id) {
  const login = getOpenAiOAuthLogin({ id });
  return login ? { ok: true, login } : { ok: false, status: 404, error: 'openai_oauth_login_not_found' };
}

async function submitOpenAiOAuthLoginApi(id, body = {}) {
  const existing = getOpenAiOAuthLogin({ id });
  const connectionId = existing?.connectionId || String(body.connectionId || body.modelConnectionId || '').trim();
  return submitOpenAiOAuthCode({ id, input: body.code || body.redirectUrl || body.input, persistAuth: connectionId ? persistOpenAiOauthForConnection(connectionId) : undefined });
}

async function cancelOpenAiOAuthLoginApi(id) {
  return cancelOpenAiOAuthLogin({ id });
}

async function claudeCliCredentialStatus() {
  return { ok: true, credential: detectClaudeCliCredential({ allowKeychainPrompt: false }) };
}

async function importClaudeCliCredential(body = {}) {
  try {
    const store = modelsStore();
    const connection = ensureClaudeCodeConnection(body);
    const auth = claudeCredentialAuthPayload({ allowKeychainPrompt: false });
    const saved = store.persistAuth(connection.id, { ...auth, source: 'claude-code-import' });
    return { ok: true, connection: store.get(connection.id), auth: { configured: true, type: saved.type, provider: saved.provider, source: saved.source, expiresAt: saved.expiresAt } };
  } catch (error) {
    return { ok: false, status: 400, error: String(error?.message || error) };
  }
}

async function agentModelSelection(agentId) {
  const runtime = await resolveAgentRuntime(agentId);
  return { ok: true, selection: modelsStore().modelSelection(runtime.agentId) };
}

async function saveAgentModelSelection(agentId, body = {}) {
  try {
    const runtime = await resolveAgentRuntime(agentId);
    return { ok: true, selection: modelsStore().saveModelSelection({ agentId: runtime.agentId, connectionId: body.connectionId || body.modelConnectionId, model: body.model || body.modelId, reasoningEffort: body.reasoningEffort, temperature: body.temperature }) };
  } catch (error) {
    return { ok: false, status: error?.statusCode || 400, error: String(error?.message || error) };
  }
}

function archiveSummarySelection(agentId) {
  return getSettingsMeta(modelsStore().db, `archive_summary_model:${agentId}`);
}
async function saveArchiveSummaryModelSelection(agentId, body = {}) {
  try {
    const runtime = await resolveAgentRuntime(agentId);
    const connectionId = body.connectionId || body.modelConnectionId;
    const model = body.model || body.modelId;
    if (!connectionId || !model) { setSettingsMeta(modelsStore().db, `archive_summary_model:${runtime.agentId}`, null); return { ok: true, selection: null }; }
    const connection = modelsStore().get(connectionId);
    if (!connection || !connection.models.some((item) => item.id === model && item.selected !== false) || !modelsStore().hasAuth(connectionId)) throw new Error('archive_summary_model_invalid');
    const selection = { connectionId, model, reasoningEffort: body.reasoningEffort || 'off', temperature: body.temperature ?? 0 };
    setSettingsMeta(modelsStore().db, `archive_summary_model:${runtime.agentId}`, selection);
    return { ok: true, selection };
  } catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; }
}

async function archiveSummaryModelConfig(agentId) {
  const selection = archiveSummarySelection(agentId);
  if (!selection?.connectionId || !selection?.model) return null;
  return resolveModelConfig({ settingsDb: settingsDatabasePath(), agentId: null, modelConnectionId: selection.connectionId, model: selection.model, reasoningEffort: selection.reasoningEffort || 'off', temperature: selection.temperature ?? 0 });
}
async function archiveSummaryForSession({ agentId, rootDir, sessionId } = {}) {
  const modelConfig = await archiveSummaryModelConfig(agentId);
  if (!modelConfig) return null;
  const turns = await readChatMessages({ rootDir, sessionId, limit: 0 });
  const metadata = await readSessionMetadata({ rootDir, sessionId });
  const summary = await generateArchiveSummary({ modelConfig, title: metadata?.archiveTitle || sessionId, turns });
  if (!summary) return null;
  return writeSessionMetadata({ rootDir, sessionId, extra: { archiveSummary: summary, archiveSummaryStatus: 'ready', archiveSummarizedAt: new Date().toISOString() } });
}

async function archiveSummaryForReset({ agentId, rootDir, archiveId = null, archivedPath = null } = {}) {
  const archive = archiveId ? { id: archiveId } : (archivedPath ? (await listResetSessionArchives({ rootDir, limit: 20 })).find((item) => item.fileName === path.basename(archivedPath)) : null);
  if (!archive) return null;
  const snapshot = await readResetSessionArchive({ rootDir, archiveId: archive.id });
  if (!snapshot) return null;
  const modelConfig = await archiveSummaryModelConfig(agentId);
  if (!modelConfig) return null;
  const summary = await generateArchiveSummary({ modelConfig, title: snapshot.archiveTitle, turns: snapshot.turns.filter((turn) => turn.visibility === 'chat') });
  if (!summary) return null;
  return writeResetSessionArchiveMetadata({ rootDir, archiveId: archive.id, metadata: { summary, summaryStatus: 'ready', summarizedAt: new Date().toISOString() } });
}

async function curatorSettings() {
  const root = curatorRoot();
  return { ok: true, ...(await curatorRuntimeStatus({ databasePath: settingsDatabasePath(), root })) };
}
async function saveCuratorSettings(body = {}) {
  try {
    const root = curatorRoot();
    const selection = saveCuratorSelection(body, { databasePath: settingsDatabasePath(), root });
    return { ok: true, selection, ...(await curatorRuntimeStatus({ databasePath: settingsDatabasePath(), root })) };
  } catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; }
}

function normalizeUiAuthRecord(record = {}) {
  const mode = String(record.mode || 'none').trim().toLowerCase();
  const allowedModes = new Set(['none', 'trusted-proxy', 'basic', 'oidc']);
  if (!allowedModes.has(mode)) throw new Error('ui_auth_mode_invalid');
  const trustedProxy = record.trustedProxy && typeof record.trustedProxy === 'object' ? record.trustedProxy : {};
  const basic = record.basic && typeof record.basic === 'object' ? record.basic : {};
  const sessionTtlSeconds = Math.max(60, Math.floor(Number(basic.sessionTtlSeconds ?? 12 * 60 * 60) || 12 * 60 * 60));
  return {
    mode,
    trustedProxy: {
      allowedProxies: (Array.isArray(trustedProxy.allowedProxies) ? trustedProxy.allowedProxies : [])
        .map((value) => String(value || '').trim()).filter(Boolean),
      userHeader: String(trustedProxy.userHeader || 'x-forwarded-user').trim().toLowerCase() || 'x-forwarded-user',
    },
    basic: {
      username: String(basic.username || '').trim(),
      passwordHash: String(basic.passwordHash || '').trim(),
      sessionTtlSeconds,
    },
    oidc: {
      issuer: String(record.oidc?.issuer || '').trim().replace(/\/+$/, ''),
      clientId: String(record.oidc?.clientId || '').trim(),
      clientSecret: String(record.oidc?.clientSecret || '').trim(),
      clientSecretConfigured: Boolean(record.oidc?.clientSecretConfigured),
      redirectUri: String(record.oidc?.redirectUri || '').trim(),
      scopes: (Array.isArray(record.oidc?.scopes) ? record.oidc.scopes : ['openid', 'email', 'profile']).map((value) => String(value || '').trim()).filter(Boolean),
      allowedEmails: (Array.isArray(record.oidc?.allowedEmails) ? record.oidc.allowedEmails : []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean),
      allowedDomains: (Array.isArray(record.oidc?.allowedDomains) ? record.oidc.allowedDomains : []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean),
    },
  };
}

function safeUiAuthSettings(record = {}) {
  const normalized = normalizeUiAuthRecord(record);
  return {
    mode: normalized.mode,
    trustedProxy: normalized.trustedProxy,
    basic: {
      username: normalized.basic.username,
      passwordConfigured: Boolean(normalized.basic.passwordHash),
      sessionTtlSeconds: normalized.basic.sessionTtlSeconds,
    },
    oidc: {
      issuer: normalized.oidc.issuer,
      clientId: normalized.oidc.clientId,
      clientSecretConfigured: Boolean(normalized.oidc.clientSecret || normalized.oidc.clientSecretConfigured),
      redirectUri: normalized.oidc.redirectUri,
      scopes: normalized.oidc.scopes,
      allowedEmails: normalized.oidc.allowedEmails,
      allowedDomains: normalized.oidc.allowedDomains,
    },
  };
}

function readUiAuthRecord() {
  const db = modelsStore().db;
  const record = normalizeUiAuthRecord(getSettingsMeta(db, 'ui_auth') || {});
  record.oidc.clientSecretConfigured = Boolean(record.oidc.clientSecretConfigured || hasUiAuthSecret(db));
  return record;
}

async function uiAuthSettings() {
  const runtime = await runtimeConfig();
  return { ok: true, auth: safeUiAuthSettings(readUiAuthRecord()), effective: { mode: runtime.ui.authMode, enabled: runtime.ui.authEnabled, source: runtime.ui.authSource } };
}

function hashBasicPassword(password) {
  const salt = randomBytes(16);
  return `scrypt:16384:${salt.toString('base64url')}:${scryptSync(String(password || ''), salt, 32, { N: 16384 }).toString('base64url')}`;
}

async function saveUiAuthSettings(body = {}) {
  try {
    const existing = readUiAuthRecord();
    const mode = String(body.mode || existing.mode || 'none').trim().toLowerCase();
    if (!['none', 'trusted-proxy', 'basic', 'oidc'].includes(mode)) return { ok: false, status: 400, error: 'ui_auth_mode_invalid' };
    const trustedProxyInput = body.trustedProxy && typeof body.trustedProxy === 'object' ? body.trustedProxy : {};
    const basicInput = body.basic && typeof body.basic === 'object' ? body.basic : {};
    const oidcInput = body.oidc && typeof body.oidc === 'object' ? body.oidc : {};
    const next = normalizeUiAuthRecord({
      mode,
      trustedProxy: {
        allowedProxies: Array.isArray(trustedProxyInput.allowedProxies) ? trustedProxyInput.allowedProxies : existing.trustedProxy.allowedProxies,
        userHeader: trustedProxyInput.userHeader ?? existing.trustedProxy.userHeader,
      },
      basic: {
        username: basicInput.username ?? existing.basic.username,
        passwordHash: basicInput.password !== undefined ? hashBasicPassword(basicInput.password) : existing.basic.passwordHash,
        sessionTtlSeconds: basicInput.sessionTtlSeconds ?? existing.basic.sessionTtlSeconds,
      },
      oidc: {
        issuer: oidcInput.issuer ?? existing.oidc.issuer,
        clientId: oidcInput.clientId ?? existing.oidc.clientId,
        clientSecret: oidcInput.clientSecret !== undefined ? oidcInput.clientSecret : '',
        clientSecretConfigured: existing.oidc.clientSecretConfigured,
        redirectUri: oidcInput.redirectUri ?? existing.oidc.redirectUri,
        scopes: Array.isArray(oidcInput.scopes) ? oidcInput.scopes : existing.oidc.scopes,
        allowedEmails: Array.isArray(oidcInput.allowedEmails) ? oidcInput.allowedEmails : existing.oidc.allowedEmails,
        allowedDomains: Array.isArray(oidcInput.allowedDomains) ? oidcInput.allowedDomains : existing.oidc.allowedDomains,
      },
    });
    if (next.mode === 'trusted-proxy' && !next.trustedProxy.allowedProxies.length) return { ok: false, status: 400, error: 'trusted_proxy_allowed_proxies_required' };
    if (next.mode === 'basic' && (!next.basic.username || !next.basic.passwordHash)) return { ok: false, status: 400, error: 'basic_username_password_required' };
    const db = modelsStore().db;
    if (oidcInput.clientSecret !== undefined && String(oidcInput.clientSecret || '').trim()) setUiAuthSecret(db, String(oidcInput.clientSecret));
    next.oidc.clientSecretConfigured = Boolean(next.oidc.clientSecretConfigured || hasUiAuthSecret(db));
    if (next.mode === 'oidc' && (!next.oidc.issuer || !next.oidc.clientId || !next.oidc.clientSecretConfigured)) return { ok: false, status: 400, error: 'oidc_issuer_client_secret_required' };
    const stored = normalizeUiAuthRecord(next);
    stored.oidc.clientSecret = '';
    stored.oidc.clientSecretConfigured = next.oidc.clientSecretConfigured;
    setSettingsMeta(db, 'ui_auth', stored);
    const runtime = await runtimeConfig();
    return { ok: true, auth: safeUiAuthSettings(next), effective: { mode: runtime.ui.authMode, enabled: runtime.ui.authEnabled, source: runtime.ui.authSource } };
  } catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; }
}

async function chatIdentities() { return { ok: true, ...modelsStore().identities() }; }
async function saveChatIdentity(body = {}) {
  try { return { ok: true, ...modelsStore().saveIdentity(body) }; }
  catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; }
}

async function discoverModelConnection(body = {}) {
  const store = modelsStore();
  const existing = body.id ? store.get(String(body.id)) : null;
  let auth = body.auth || (existing ? store.auth(existing.id) : null) || {};
  const baseUrl = body.baseUrl || existing?.baseUrl;
  const apiType = body.apiType || existing?.apiType;
  const priorModels = body.models || existing?.models || [];
  try {
    if (existing && auth?.type === 'oauth' && /openai/i.test(String(auth.provider || existing.provider || '')) && /chatgpt\.com\/backend-api/i.test(String(baseUrl || ''))) auth = { ...auth, ...(await store.resolveAuth(existing.id)) };
    const apiKey = String(body.apiKey || '').trim() || (auth?.token ? String(auth.token).trim() : '') || (auth?.apiKey ? String(auth.apiKey).trim() : '') || (auth?.accessToken ? String(auth.accessToken).trim() : '') || (existing ? store.apiKey(existing.id) : null);
    const hasCredential = Boolean(apiKey || auth?.token || auth?.apiKey || auth?.accessToken);
    if (!hasCredential) return { ok: false, status: 400, error: 'api_key_required' };
    const discovered = await discoverModels({ baseUrl, apiType, apiKey, auth, store, signal: AbortSignal.timeout(15_000) });
    return { ok: true, models: mergeDiscoveredModels(discovered, priorModels), discovery: { status: discovered.length ? 'discovered' : 'manual_only', count: discovered.length } };
  } catch (error) {
    return { ok: true, models: mergeDiscoveredModels([], priorModels), discovery: { status: 'manual_only', count: 0, error: String(error?.message || error) } };
  }
}

async function saveModelConnection(body = {}) {
  try {
    return { ok: true, connection: modelsStore().save(body) };
  } catch (error) {
    return { ok: false, status: 400, error: String(error?.message || error) };
  }
}


async function resolveModelConnectionChatBody(body = {}) {
  const connectionId = String(body.modelConnectionId || body.modelProviderId || '').trim();
  const model = String(body.model || body.modelId || '').trim();
  if (!connectionId || !model || model === 'off') return body;
  const store = modelsStore();
  const connection = store.get(connectionId);
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
  if (!store.hasAuth(connection.id)) {
    const error = new Error('model_connection_auth_required');
    error.statusCode = 400;
    throw error;
  }
  return {
    ...body,
    // Only the SQLite record ID and exact enabled model cross the API boundary.
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

async function runtimeConfig(agentId = 'hatchet') {
  return loadRuntimeConfig({ rootDir: projectRoot, args: { agent_id: String(agentId || 'hatchet') } });
}

async function resolveAgentRuntime(agentId = null) {
  const runtime = await runtimeConfig();
  const id = String(agentId || runtime.runtimeState.agentId || 'hatchet').trim();
  const agent = agentsStore().resolve(id) || (id === 'hatchet' ? agentsStore().bootstrap() : null);
  if (!agent) {
    const error = new Error('agent_not_found');
    error.statusCode = 404;
    throw error;
  }
  if (!agent.enabled) {
    const error = new Error('agent_disabled');
    error.statusCode = 409;
    throw error;
  }
  const resolved = agentRuntimeContext({ runtimeState: runtime.runtimeState, agent });
  const executionEnvironment = Object.freeze(agent.executionEnvironment
    ? { ...agent.executionEnvironment }
    : { kind: 'local', workspaceRoot: resolved.agentWorkspaceRoot });
  return Object.freeze({
    ...resolved,
    executionEnvironment,
    processExecutionController: executionEnvironment.kind === 'remote' ? executionProviders.get(executionEnvironment.providerId) : null,
  });
}

async function createAgent(body = {}) {
  try {
    const agent = agentsStore().create(body);
    const runtime = await runtimeConfig();
    const context = await ensureAgentRoots({ runtimeState: runtime.runtimeState, agent });
    const dreamStore = dreamSettingsStore();
    try { dreamStore.save(agent.id, { enabled: true }); } finally { dreamStore.close(); }
    // Every agent starts with a real default conversation scope. Without this
    // metadata record, the first /api/sessions request returns an empty list
    // until some later action happens to materialize the session.
    await writeSessionMetadata({ rootDir: context.agentWorkspaceRoot, sessionId: 'default' });
    return { ok: true, agent, context: { agentWorkspaceRoot: context.agentWorkspaceRoot, agentDataRoot: context.agentDataRoot, skillsRoot: context.skillsRoot } };
  } catch (error) {
    return { ok: false, status: String(error?.message || error) === 'agent_id_exists' ? 409 : 400, error: String(error?.message || error) };
  }
}

async function updateAgent(id, body = {}) {
  try { return { ok: true, agent: agentsStore().update(id, body) }; }
  catch (error) { return { ok: false, status: String(error?.message || error) === 'agent_not_found' ? 404 : 400, error: String(error?.message || error) }; }
}

async function deleteAgent(id) {
  try { return { ok: true, agent: agentsStore().delete(id) }; }
  catch (error) { return { ok: false, status: String(error?.message || error) === 'agent_not_found' ? 404 : 400, error: String(error?.message || error) }; }
}

async function agentProfileDocuments(agentId, body = null) {
  const store = profilesStore();
  try {
    if (body === null) return { ok: true, documents: store.list(agentId) };
    return { ok: true, documents: store.replace(agentId, body.documents) };
  } catch (error) {
    const message = String(error?.message || error);
    return { ok: false, status: message === 'agent_not_found' ? 404 : 400, error: message };
  } finally { store.close(); }
}

async function agentDreamSettings(agentId, body = null) {
  const store = dreamSettingsStore();
  try {
    if (body === null) return { ok: true, settings: store.get(agentId) };
    return { ok: true, settings: store.save(agentId, body) };
  } catch (error) {
    const message = String(error?.message || error);
    return { ok: false, status: message === 'agent_not_found' ? 404 : 400, error: message };
  } finally { store.close(); }
}

async function agentDreamDiary(agentId, body = null, query = {}) {
  const store = dreamDiaryStore();
  try {
    const markdownMode = query.format || query.markdown;
    if (body === null) return { ok: true, entries: store.list(agentId, { date: query.date || null, phase: query.phase || null, limit: query.limit || 30 }), markdown: markdownMode ? store.renderMarkdown(agentId, { date: query.date || null, phase: query.phase || null, limit: query.limit || 30, format: markdownMode }) : null };
    return { ok: true, entry: store.append(agentId, body) };
  } catch (error) {
    const message = String(error?.message || error);
    return { ok: false, status: message === 'agent_not_found' ? 404 : 400, error: message };
  } finally { store.close(); }
}

async function agentDreamMemoryConsolidate(agentId, body = {}) {
  try {
    return consolidateDreamMemory({ agentId, databasePath: settingsDatabasePath(), limit: body.limit, generatedAt: body.generatedAt });
  } catch (error) {
    const message = String(error?.message || error);
    return { ok: false, status: message === 'agent_not_found' ? 404 : 400, error: message };
  }
}

async function agentDreamCycle(agentId, body = null, query = {}) {
  try {
    if (body === null) return { ok: true, receipts: latestDreamCycleReceipts({ agentId, databasePath: settingsDatabasePath(), limit: query.limit || 20 }) };
    const context = await resolveAgentRuntime(agentId);
    return { ok: true, result: await runDreamCycle({ agentId, databasePath: settingsDatabasePath(), rootDir: context?.agentWorkspaceRoot || null, limit: body.limit, generatedAt: body.generatedAt }) };
  } catch (error) {
    const message = String(error?.message || error);
    return { ok: false, status: message === 'agent_not_found' ? 404 : 400, error: message };
  }
}

function codexLbOriginFromModelConfig(modelConfig = {}) {
  if (!modelConfig?.baseUrl) return null;
  try {
    return new URL(modelConfig.baseUrl).origin;
  } catch {
    return null;
  }
}

function authSecretToken(auth = {}) {
  if (auth.type === 'oauth') return auth.accessToken || auth.token || '';
  if (auth.type === 'token' || auth.type === 'bearer_token') return auth.token || '';
  if (auth.type === 'api_key') return auth.apiKey || auth.token || '';
  return '';
}

function codexLbConnectionCandidate(connection = {}) {
  const provider = String(connection.provider || '').toLowerCase();
  const baseUrl = String(connection.baseUrl || '').toLowerCase();
  return provider.includes('codex-lb') || provider.includes('codex lb') || baseUrl.includes('codex-lb') || baseUrl.includes(':2455/');
}

async function resolveCodexLbAccountSource() {
  const store = modelsStore();
  const connection = store.list().find(codexLbConnectionCandidate);
  if (connection) {
    const origin = codexLbOriginFromModelConfig(connection);
    const token = authSecretToken(await store.resolveAuth(connection.id));
    if (origin && token) return { origin, token, source: 'model-connection', connectionId: connection.id };
  }
  // Legacy fallback only: older deployments used the active runtime model config.
  // The Codex-LB account panel must not disappear just because chat is currently
  // routed through a different model adapter.
  const runtime = await runtimeConfig();
  const model = runtime.modelConfig || {};
  if (codexLbConnectionCandidate({ provider: model.provider || model.providerName, baseUrl: model.baseUrl })) {
    const origin = codexLbOriginFromModelConfig(model);
    if (origin && model.apiKey) return { origin, token: model.apiKey, source: 'active-model-config', connectionId: model.connectionId || null };
  }
  return null;
}

function finitePercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function accountPlanLabel(planType = '') {
  const normalized = String(planType || '').trim().toLowerCase();
  if (normalized === 'prolite') return 'Prolite';
  if (normalized === 'team') return 'Team';
  if (normalized === 'plus') return 'Plus';
  if (normalized === 'pro') return 'Pro';
  return normalized ? normalized.replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Unknown';
}

function statusLabel(status = '') {
  const normalized = String(status || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!normalized) return 'Unknown';
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function finiteQuotaNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function quotaWindow(account = {}, usage = {}, kind = 'secondary') {
  const suffix = kind === 'monthly' ? 'Monthly' : kind === 'primary' ? 'Primary' : 'Secondary';
  const windowMinutes = finiteQuotaNumber(account[`windowMinutes${suffix}`]);
  return {
    kind,
    label: kind === 'monthly' || (windowMinutes !== null && windowMinutes >= 40000) ? 'Monthly' : windowMinutes === 10080 ? 'Weekly' : windowMinutes === 300 ? '5-hour' : suffix,
    percent: finitePercent(usage[`${kind}RemainingPercent`]),
    resetAt: account[`resetAt${suffix}`] || null,
    windowMinutes,
    capacityCredits: finiteQuotaNumber(account[`capacityCredits${suffix}`]),
    remainingCredits: finiteQuotaNumber(account[`remainingCredits${suffix}`]),
  };
}

function usableQuotaWindow(window = {}) {
  return window.percent !== null || window.resetAt || window.windowMinutes !== null || window.remainingCredits !== null;
}

function selectedAccountWindow(account = {}) {
  const usage = account.usage || {};
  const windows = ['monthly', 'primary', 'secondary'].map((kind) => quotaWindow(account, usage, kind));
  return windows.find(usableQuotaWindow) || windows[2];
}

function sanitizeCodexLbAccount(account = {}, index = 0) {
  const selectedWindow = selectedAccountWindow(account);
  const quotaWindows = {
    primary: quotaWindow(account, account.usage || {}, 'primary'),
    secondary: quotaWindow(account, account.usage || {}, 'secondary'),
  };
  return {
    id: `account-${index + 1}`,
    name: account.alias || account.displayName || `Account ${index + 1}`,
    type: accountPlanLabel(account.planType || account.accountType || account.type),
    status: statusLabel(account.status),
    usagePercent: selectedWindow.percent,
    resetAt: selectedWindow.resetAt,
    window: selectedWindow,
    quotaWindows,
    availableResetCredits: Number.isFinite(Number(account.availableResetCredits)) ? Number(account.availableResetCredits) : null,
    resetCreditNearestExpiresAt: account.resetCreditNearestExpiresAt || null,
  };
}

async function codexLbAccounts() {
  const source = await resolveCodexLbAccountSource();
  if (!source?.origin || !source?.token) return { ok: false, status: 503, error: 'codex_lb_model_config_missing', accounts: [] };
  try {
    const response = await fetch(`${source.origin}/api/accounts`, {
      headers: { accept: 'application/json', authorization: `Bearer ${source.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, status: response.status, error: `codex_lb_accounts_failed:${response.status}`, accounts: [] };
    const data = await response.json();
    const rawAccounts = Array.isArray(data) ? data : data?.accounts;
    if (!Array.isArray(rawAccounts)) return { ok: false, status: 502, error: 'codex_lb_accounts_invalid_response', accounts: [] };
    return {
      ok: true,
      source: 'codex-lb',
      connectionSource: source.source,
      connectionId: source.connectionId || null,
      accounts: rawAccounts.map(sanitizeCodexLbAccount),
    };
  } catch (error) {
    return { ok: false, status: 502, error: 'codex_lb_accounts_unavailable', detail: String(error?.message || error), accounts: [] };
  }
}

function anthropicConnectionCandidate(connection = {}) {
  const provider = String(connection.provider || '').toLowerCase();
  const apiType = String(connection.apiType || connection.api_type || '').toLowerCase();
  const baseUrl = String(connection.baseUrl || connection.base_url || '').toLowerCase();
  return provider.includes('anthropic') || provider.includes('claude') || apiType === 'anthropic-messages' || baseUrl.includes('anthropic.com');
}

function openaiOauthConnectionCandidate(connection = {}) {
  const provider = String(connection.provider || '').toLowerCase();
  const apiType = String(connection.apiType || connection.api_type || '').toLowerCase();
  const baseUrl = String(connection.baseUrl || connection.base_url || '').toLowerCase();
  return provider.includes('openai') || apiType.startsWith('openai-') || baseUrl.includes('chatgpt.com');
}

function originFromUrl(value = '') {
  try { return new URL(value).origin; } catch { return null; }
}

async function resolveAnthropicUsageSource(connectionId = '') {
  const store = modelsStore();
  const requestedId = String(connectionId || '').trim();
  const connections = store.list();
  const candidates = requestedId ? connections.filter((connection) => connection.id === requestedId) : connections.filter(anthropicConnectionCandidate);
  for (const connection of candidates) {
    if (!anthropicConnectionCandidate(connection)) continue;
    const auth = await store.resolveAuth(connection.id);
    if (String(auth?.type || '').toLowerCase() !== 'oauth') continue;
    const token = authSecretToken(auth);
    const origin = originFromUrl(connection.baseUrl || 'https://api.anthropic.com') || 'https://api.anthropic.com';
    if (token) return { origin, token, connectionId: connection.id, provider: connection.provider || 'Anthropic', expiresAt: auth.expiresAt || null };
  }
  return null;
}

async function resolveOpenAiOauthUsageSource(connectionId = '') {
  const store = modelsStore();
  const requestedId = String(connectionId || '').trim();
  const connections = store.list();
  const candidates = requestedId ? connections.filter((connection) => connection.id === requestedId) : connections.filter(openaiOauthConnectionCandidate);
  for (const connection of candidates) {
    if (!openaiOauthConnectionCandidate(connection)) continue;
    const auth = await store.resolveAuth(connection.id);
    if (String(auth?.type || '').toLowerCase() !== 'oauth') continue;
    const authProvider = String(auth.provider || '').toLowerCase();
    if (authProvider && authProvider !== 'openai') continue;
    const token = authSecretToken(auth);
    if (token) return { token, accountId: auth.accountId || null, connectionId: connection.id, provider: connection.provider || 'OpenAI', expiresAt: auth.expiresAt || null };
  }
  return null;
}

function isoOrNull(value) {
  if (!value) return null;
  const text = String(value);
  const ms = Number(text);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms < 10_000_000_000 ? ms * 1000 : ms).toISOString();
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function sanitizeAnthropicUsageWindow(key, raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const utilization = Number(raw.utilization ?? raw.used_percentage ?? raw.usedPercent);
  return {
    key,
    label: key.split('_').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(' '),
    usedPercent: Number.isFinite(utilization) ? Math.max(0, Math.min(100, Math.round(utilization))) : null,
    resetAt: isoOrNull(raw.resets_at ?? raw.resetAt ?? raw.resetsAt),
  };
}

function sanitizeAnthropicUsage(data = {}) {
  const windows = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus']
    .map((key) => sanitizeAnthropicUsageWindow(key, data?.[key]))
    .filter(Boolean);
  const extra = data?.extra_usage && typeof data.extra_usage === 'object' ? data.extra_usage : null;
  return {
    windows,
    extraUsage: extra ? {
      isEnabled: Boolean(extra.is_enabled ?? extra.isEnabled),
      monthlyLimit: Number.isFinite(Number(extra.monthly_limit ?? extra.monthlyLimit)) ? Number(extra.monthly_limit ?? extra.monthlyLimit) : null,
      usedCredits: Number.isFinite(Number(extra.used_credits ?? extra.usedCredits)) ? Number(extra.used_credits ?? extra.usedCredits) : null,
      usedPercent: Number.isFinite(Number(extra.utilization ?? extra.used_percentage)) ? Math.max(0, Math.min(100, Math.round(Number(extra.utilization ?? extra.used_percentage)))) : null,
    } : null,
  };
}


function clampUsagePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
}

function labelForWindowSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 'Window';
  const days = value / 86_400;
  if (days >= 28) return `${Math.round(days)}d`;
  if (Math.abs(days - Math.round(days)) < 0.05 && days >= 1) return `${Math.round(days)}d`;
  const hours = value / 3_600;
  if (Math.abs(hours - Math.round(hours)) < 0.05 && hours >= 1) return `${Math.round(hours)}h`;
  return `${Math.round(value / 60)}m`;
}

function sanitizeOpenAiUsageWindow(key, raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const windowSeconds = Number(raw.limit_window_seconds ?? raw.limitWindowSeconds ?? raw.window_seconds ?? raw.windowSeconds);
  const usedPercent = clampUsagePercent(raw.used_percent ?? raw.usedPercent ?? raw.utilization);
  const resetAt = isoOrNull(raw.reset_at ?? raw.resetAt ?? raw.resets_at ?? raw.resetsAt);
  if (usedPercent === null && !resetAt && !Number.isFinite(windowSeconds)) return null;
  return {
    key,
    label: labelForWindowSeconds(windowSeconds),
    usedPercent,
    resetAt,
    windowSeconds: Number.isFinite(windowSeconds) ? windowSeconds : null,
  };
}

function sanitizeAdditionalOpenAiRateLimits(additional) {
  if (!additional || typeof additional !== 'object') return [];
  const entries = Array.isArray(additional) ? additional.map((value, index) => [`additional_${index + 1}`, value]) : Object.entries(additional);
  const windows = [];
  for (const [name, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    const direct = sanitizeOpenAiUsageWindow(String(name), value);
    if (direct) windows.push(direct);
    for (const [childName, childValue] of Object.entries(value)) {
      const child = sanitizeOpenAiUsageWindow(`${name}_${childName}`, childValue);
      if (child) windows.push(child);
    }
  }
  return windows;
}

function sanitizeOpenAiOauthUsage(data = {}) {
  const rateLimit = data?.rate_limit && typeof data.rate_limit === 'object' ? data.rate_limit : data?.rateLimit;
  const windows = [
    sanitizeOpenAiUsageWindow('primary', rateLimit?.primary_window ?? rateLimit?.primaryWindow),
    sanitizeOpenAiUsageWindow('secondary', rateLimit?.secondary_window ?? rateLimit?.secondaryWindow),
    ...sanitizeAdditionalOpenAiRateLimits(data?.additional_rate_limits ?? data?.additionalRateLimits),
  ].filter(Boolean);
  return {
    planType: typeof data.plan_type === 'string' ? data.plan_type : (typeof data.planType === 'string' ? data.planType : null),
    blocked: Boolean(rateLimit?.limit_reached ?? rateLimit?.limitReached ?? data.rate_limit_reached_type ?? data.rateLimitReachedType),
    reachedType: typeof data.rate_limit_reached_type === 'string' ? data.rate_limit_reached_type : (typeof data.rateLimitReachedType === 'string' ? data.rateLimitReachedType : null),
    windows,
    credits: data?.credits && typeof data.credits === 'object' ? {
      hasCredits: typeof data.credits.has_credits === 'boolean' ? data.credits.has_credits : (typeof data.credits.hasCredits === 'boolean' ? data.credits.hasCredits : null),
      unlimited: typeof data.credits.unlimited === 'boolean' ? data.credits.unlimited : null,
      balance: Number.isFinite(Number(data.credits.balance)) ? Number(data.credits.balance) : null,
      overageLimitReached: Boolean(data.credits.overage_limit_reached ?? data.credits.overageLimitReached),
    } : null,
  };
}

async function anthropicOauthUsage({ connectionId = '', force = false } = {}) {
  const source = await resolveAnthropicUsageSource(connectionId);
  if (!source?.origin || !source?.token) return { ok: false, status: 503, error: 'anthropic_oauth_usage_config_missing', usage: null };
  const cacheKey = source.connectionId;
  const cached = anthropicUsageCache.get(cacheKey);
  const nowMs = Date.now();
  if (!force && cached && nowMs - cached.fetchedAtMs < ANTHROPIC_USAGE_CACHE_MS) return { ...cached.result, cached: true, cacheTtlMs: Math.max(0, ANTHROPIC_USAGE_CACHE_MS - (nowMs - cached.fetchedAtMs)) };
  try {
    const response = await fetch(`${source.origin}/api/oauth/usage`, {
      headers: { accept: 'application/json', authorization: `Bearer ${source.token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, status: response.status, error: `anthropic_oauth_usage_failed:${response.status}`, usage: null };
    const result = {
      ok: true,
      source: 'anthropic-oauth',
      endpoint: '/api/oauth/usage',
      connectionId: source.connectionId,
      provider: source.provider,
      cached: false,
      cacheTtlMs: ANTHROPIC_USAGE_CACHE_MS,
      fetchedAt: new Date(nowMs).toISOString(),
      usage: sanitizeAnthropicUsage(data),
    };
    anthropicUsageCache.set(cacheKey, { fetchedAtMs: nowMs, result });
    return result;
  } catch (error) {
    return { ok: false, status: 502, error: 'anthropic_oauth_usage_unavailable', detail: String(error?.message || error), usage: null };
  }
}


async function openaiOauthUsage({ connectionId = '', force = false } = {}) {
  const source = await resolveOpenAiOauthUsageSource(connectionId);
  if (!source?.token) return { ok: false, status: 503, error: 'openai_oauth_usage_config_missing', usage: null };
  const cacheKey = source.connectionId;
  const cached = openaiOauthUsageCache.get(cacheKey);
  const nowMs = Date.now();
  if (!force && cached && nowMs - cached.fetchedAtMs < OPENAI_OAUTH_USAGE_CACHE_MS) return { ...cached.result, cached: true, cacheTtlMs: Math.max(0, OPENAI_OAUTH_USAGE_CACHE_MS - (nowMs - cached.fetchedAtMs)) };
  try {
    const headers = { accept: 'application/json', authorization: `Bearer ${source.token}`, originator: 'burrow', 'user-agent': 'burrow/dev' };
    if (source.accountId) headers['ChatGPT-Account-Id'] = source.accountId;
    const response = await fetch(OPENAI_OAUTH_USAGE_URL, { headers, signal: AbortSignal.timeout(10_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, status: response.status, error: `openai_oauth_usage_failed:${response.status}`, usage: null };
    const result = {
      ok: true,
      source: 'openai-oauth-wham',
      endpoint: '/backend-api/wham/usage',
      connectionId: source.connectionId,
      provider: source.provider,
      cached: false,
      cacheTtlMs: OPENAI_OAUTH_USAGE_CACHE_MS,
      fetchedAt: new Date(nowMs).toISOString(),
      usage: sanitizeOpenAiOauthUsage(data),
    };
    openaiOauthUsageCache.set(cacheKey, { fetchedAtMs: nowMs, result });
    return result;
  } catch (error) {
    return { ok: false, status: 502, error: 'openai_oauth_usage_unavailable', detail: String(error?.message || error), usage: null };
  }
}

async function runtimeDataRoot() {
  const runtime = await runtimeConfig();
  return runtime.runtimeState.agentDataRoot;
}

async function runtimeAgentWorkspaceRoot() {
  const runtime = await runtimeConfig();
  return runtime.runtimeState.agentWorkspaceRoot || path.join(runtime.runtimeState.workspaceRoot, runtime.runtimeState.agentId || 'hatchet');
}

async function runtimeAgentDataRoot() {
  const runtime = await runtimeConfig();
  return runtime.runtimeState.agentDataRoot;
}

async function runtimeSessionRoot(sessionId, agentId = null) {
  // An agent's ordinary chats live in its workspace, but spawned child
  // transcripts live in its agent-data session store. Resolve the requested
  // id across both roots before falling back to the normal workspace root.
  const agentRuntime = agentId ? await resolveAgentRuntime(agentId) : await resolveAgentRuntime();
  const roots = [agentRuntime.agentWorkspaceRoot, agentRuntime.agentDataRoot, await runtimeAgentWorkspaceRoot(), await runtimeDataRoot()]
    .filter(Boolean)
    .filter((root, index, all) => all.indexOf(root) === index);
  for (const rootDir of roots) {
    if (await readSessionMetadata({ rootDir, sessionId })) return rootDir;
  }
  return roots[0] || null;
}

function remoteAddress(req) {
  const raw = req.socket?.remoteAddress || '';
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

function headerValue(req, name) {
  const value = req.headers[String(name || '').toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function basicCredentials(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.toLowerCase().startsWith('basic ')) return null;
  const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function parseCookieHeader(header = '') {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return cookies;
}

function basicSessionSignature(payload, passwordHash) {
  return createHmac('sha256', `burrow-basic-session:${String(passwordHash || '')}`).update(payload).digest('base64url');
}

function signBasicSession({ username, passwordHash, ttlSeconds }) {
  const expiresAt = Date.now() + Math.max(60, Number(ttlSeconds) || 0) * 1000;
  const payload = Buffer.from(JSON.stringify({ username, expiresAt }), 'utf8').toString('base64url');
  return `${payload}.${basicSessionSignature(payload, passwordHash)}`;
}

function verifyBasicSessionCookie(value, auth, nowMs = Date.now()) {
  const [payload, signature] = String(value || '').split('.');
  if (!payload || !signature || !auth?.basic?.passwordHash || !auth.basic.username) return null;
  const expected = basicSessionSignature(payload, auth.basic.passwordHash);
  const actual = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length || !timingSafeEqual(actual, expectedBuffer)) return null;
  let decoded = null;
  try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (decoded?.username !== auth.basic.username) return null;
  if (!Number.isFinite(Number(decoded.expiresAt)) || Number(decoded.expiresAt) <= nowMs) return null;
  return { username: decoded.username, expiresAt: new Date(Number(decoded.expiresAt)).toISOString() };
}

function setBasicSessionCookie(res, auth) {
  const ttlSeconds = Math.max(60, Number(auth.basic?.sessionTtlSeconds) || 12 * 60 * 60);
  const cookie = signBasicSession({ username: auth.basic.username, passwordHash: auth.basic.passwordHash, ttlSeconds });
  res.setHeader('set-cookie', `${BASIC_SESSION_COOKIE}=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttlSeconds}`);
}

function verifyScryptPassword(password, encoded) {
  const parts = String(encoded || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost < 2 ** 12 || cost > 2 ** 20) return false;
  const salt = Buffer.from(parts[2], 'base64url');
  const expected = Buffer.from(parts[3], 'base64url');
  if (!salt.length || !expected.length) return false;
  const actual = scryptSync(String(password || ''), salt, expected.length, { N: cost });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function denyBasic(res, reason) {
  res.setHeader('www-authenticate', 'Basic realm="Burrow", charset="UTF-8"');
  sendJson(res, 401, { ok: false, error: 'unauthorized', auth: { required: true, mode: 'basic', reason } });
}

async function authorizeRequest(req, res, url) {
  const runtime = await runtimeConfig();
  const auth = runtime.ui || {};
  const mode = auth.authMode || 'none';
  if (mode === 'none') return true;
  if (mode === 'trusted-proxy') {
    const address = remoteAddress(req);
    const allowed = auth.trustedProxy?.allowedProxies || [];
    if (!allowed.includes(address)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized', auth: { required: true, mode, reason: 'proxy_not_allowed' } });
      return false;
    }
    const user = String(headerValue(req, auth.trustedProxy?.userHeader || 'x-forwarded-user') || '').trim();
    if (!user) {
      sendJson(res, 401, { ok: false, error: 'unauthorized', auth: { required: true, mode, reason: 'missing_proxy_user' } });
      return false;
    }
    return true;
  }
  if (mode === 'basic') {
    if (!auth.basic?.username || !auth.basic?.passwordHash) {
      sendJson(res, 503, { ok: false, error: 'auth_not_configured', auth: { required: true, mode } });
      return false;
    }
    const session = verifyBasicSessionCookie(parseCookieHeader(req.headers.cookie || '')[BASIC_SESSION_COOKIE], auth);
    if (session) {
      setBasicSessionCookie(res, auth);
      return true;
    }
    const credentials = basicCredentials(req);
    if (!credentials) {
      denyBasic(res, 'missing_basic_credentials');
      return false;
    }
    if (credentials.username !== auth.basic.username || !verifyScryptPassword(credentials.password, auth.basic.passwordHash)) {
      denyBasic(res, 'invalid_basic_credentials');
      return false;
    }
    setBasicSessionCookie(res, auth);
    return true;
  }
  if (mode === 'oidc') {
    if (!auth.oidc?.issuer || !auth.oidc?.clientId || !auth.oidc?.clientSecret) {
      sendJson(res, 503, { ok: false, error: 'auth_not_configured', auth: { required: true, mode } });
      return false;
    }
    const session = oidcSessionFromRequest(req, runtime);
    if (session) return true;
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      res.writeHead(302, { location: `/auth/oidc/login?returnTo=${encodeURIComponent(url.pathname + url.search)}` });
      res.end();
      return false;
    }
    sendJson(res, 401, { ok: false, error: 'unauthorized', auth: { required: true, mode, loginUrl: '/auth/oidc/login' } });
    return false;
  }
  sendJson(res, 501, { ok: false, error: 'auth_mode_not_implemented', auth: { required: true, mode } });
  return false;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function applyApiCors(req, res, url) {
  if (!url.pathname.startsWith('/api/')) return false;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-max-age', '600');
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204);
  res.end();
  return true;
}


const IMPORT_SUPPORTED_CATEGORIES = new Set(['agents', 'settings', 'task-board', 'model-connections', 'mcp-connections', 'ui-auth']);
function importPreview(decoded, conflictPolicy) {
  const supported = decoded.categories.filter((id) => IMPORT_SUPPORTED_CATEGORIES.has(id));
  const unsupported = decoded.categories.filter((id) => !IMPORT_SUPPORTED_CATEGORIES.has(id));
  return { ok: true, format: decoded.payload.manifest.format, encrypted: decoded.encrypted, categories: decoded.categories, supported, unsupported, conflictPolicy, requiresConfirmation: true, redacted: Boolean(decoded.payload.manifest.redacted) };
}
async function applyImport(decoded, { conflictPolicy = 'error' } = {}) {
  const categories = decoded.payload.categories || {};
  const unsupported = decoded.categories.filter((id) => !IMPORT_SUPPORTED_CATEGORIES.has(id));
  if (unsupported.length) return { ok: false, status: 400, error: 'import_category_unsupported', details: { categories: unsupported } };
  if (Object.hasOwn(categories, 'agents') && (!categories.agents || typeof categories.agents !== 'object' || Array.isArray(categories.agents) || categories.agents.schema !== 'burrow.agents-and-profiles/v2' || !Array.isArray(categories.agents.records) || !categories.agents.profiles || typeof categories.agents.profiles !== 'object' || Array.isArray(categories.agents.profiles))) {
    return { ok: false, status: 400, error: 'import_agents_format_invalid', details: { expected: 'burrow.agents-and-profiles/v2' } };
  }
  const conflicts = [];
  if (categories['task-board']?.projects && Array.isArray(categories['task-board'].projects)) for (const project of categories['task-board'].projects) if (await withTaskBoard((store) => store.getProject(project.id))) conflicts.push({ category: 'task-board.projects', id: project.id });
  if (Array.isArray(categories['model-connections'])) {
    const store = modelsStore();
    for (const connection of categories['model-connections']) {
      if (!connection?.id) continue;
      const existingById = store.get(connection.id);
      const existingByProvider = store.list().find((item) => String(item.provider || '').toLowerCase() === String(connection.provider || '').toLowerCase() && item.id !== connection.id);
      // A supplied ID is the portable identity of a model connection. Saving
      // it again is an update, not a conflict; the store already handles that
      // transactionally. Only a different connection with the same provider
      // label needs an explicit conflict policy.
      if (!existingById && existingByProvider) conflicts.push({ category: 'model-connections', id: connection.id, existingId: existingByProvider.id, reason: 'provider' });
    }
  }
  if (conflicts.length && conflictPolicy === 'error') return { ok: false, status: 409, error: 'import_conflicts', details: { conflicts } };
  const imported = [];
  let importRuntime = null;
  const materializeAgentRuntime = async (agent) => {
    if (!agent?.id) return;
    importRuntime ||= await runtimeConfig();
    const context = await ensureAgentRoots({ runtimeState: importRuntime.runtimeState, agent });
    await writeSessionMetadata({ rootDir: context.agentWorkspaceRoot, sessionId: 'default' });
  };
  if (categories.settings && typeof categories.settings === 'object') {
    if (categories.settings.executionBoundaries) {
      const result = saveExecutionBoundaries(categories.settings.executionBoundaries, { databasePath: settingsDatabasePath() });
      if (!result.ok) return result;
      imported.push('settings:execution-boundaries');
    }
    if (categories.settings.curatorSelection) {
      try {
        saveCuratorSelection(categories.settings.curatorSelection, { databasePath: settingsDatabasePath(), root: curatorRoot() });
        imported.push('settings:curator-selection');
      } catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; }
    }
  }
  // Model connections must exist before agent dream settings are restored.
  if (Array.isArray(categories['model-connections'])) {
    const store = modelsStore();
    for (const connection of categories['model-connections']) {
      if (connection.auth?.apiKey === '[redacted]' || connection.auth?.token === '[redacted]') continue;
      const connectionConflicts = conflicts.filter((conflict) => conflict.category === 'model-connections' && conflict.id === connection.id);
      if (conflictPolicy === 'skip' && connectionConflicts.length) continue;
      for (const conflict of connectionConflicts) {
        if (conflict.reason === 'provider' && conflict.existingId && conflict.existingId !== connection.id) store.remove(conflict.existingId);
      }
      store.save(connection);
      imported.push(`model-connections:${connection.id}`);
    }
  }
  if (categories.agents && typeof categories.agents === 'object' && !Array.isArray(categories.agents)) {
    const agentRecords = Array.isArray(categories.agents.records) ? categories.agents.records : [];
    const profiles = categories.agents.profiles && typeof categories.agents.profiles === 'object' ? categories.agents.profiles : {};
    for (const agent of agentRecords) {
      if (conflictPolicy === 'skip' && conflicts.some((c) => c.category === 'agents' && c.id === agent.id)) continue;
      const importedAgent = agentsStore().get(agent.id) ? agentsStore().update(agent.id, agent) : agentsStore().create(agent);
      await materializeAgentRuntime(importedAgent);
      if (agent.avatar !== undefined || agent.identityName !== undefined) modelsStore().saveIdentity({ kind: 'agent', id: agent.id, name: agent.identityName ?? agent.name, avatar: agent.avatar ?? '' });
      const profileDocuments = Array.isArray(profiles[agent.id]) ? profiles[agent.id] : [];
      if (profileDocuments.length) {
        const profileStore = profilesStore();
        try { profileStore.replace(agent.id, profileDocuments.filter((item) => AGENT_PROFILE_KINDS.includes(String(item?.kind || '').toUpperCase())).map((item) => ({ ...item, kind: String(item.kind).toUpperCase() }))); } finally { profileStore.close(); }
      }
      if (agent.dreamSettings && typeof agent.dreamSettings === 'object') {
        const dreamStore = dreamSettingsStore();
        try {
          try {
            dreamStore.save(agent.id, agent.dreamSettings);
          } catch (error) {
            // Dream model selection is optional. An export may refer to a provider
            // model that was not included, was redacted, or is unavailable here.
            // Preserve the rest of the dream configuration rather than aborting
            // the entire import; the model can be selected later in Settings.
            if (!['dream_settings_model_selection_invalid', 'dream_settings_model_selection_incomplete'].includes(error?.message)) throw error;
            dreamStore.save(agent.id, { ...agent.dreamSettings, modelConnectionId: null, model: null });
          }
        } finally { dreamStore.close(); }
      }
      imported.push(`agents:${agent.id}`);
    }
    if (categories.agents.operator && typeof categories.agents.operator === 'object') {
      const operator = categories.agents.operator;
      modelsStore().saveIdentity({ kind: 'operator', id: 'default', name: operator.name ?? '', avatar: operator.avatar ?? '' });
      imported.push('agents:operator');
    }
  }
  if (categories['task-board']) for (const project of (categories['task-board'].projects || [])) { if (conflictPolicy === 'skip' && conflicts.some((c) => c.category === 'task-board.projects' && c.id === project.id)) continue; if (!(await withTaskBoard((store) => store.getProject(project.id)))) await withTaskBoard((store) => store.createProject(project)); imported.push(`task-board.projects:${project.id}`); }
  if (categories['task-board']) for (const task of (categories['task-board'].tasks || [])) { const exists = await withTaskBoard((store) => store.getTask(task.id)); if (exists && conflictPolicy !== 'replace') continue; if (!exists) await withTaskBoard((store) => store.createTask(task)); else await withTaskBoard((store) => store.updateTask(task.id, task)); imported.push(`task-board.tasks:${task.id}`); }
  if (categories['mcp-connections'] && typeof categories['mcp-connections'] === 'object' && !Array.isArray(categories['mcp-connections'])) {
    const connections = Array.isArray(categories['mcp-connections'].connections) ? categories['mcp-connections'].connections : [];
    for (const connection of connections) { if (connection.apiKey === '[redacted]') continue; const { environmentVariables, ...portableConnection } = connection; mcpStore().save(portableConnection); imported.push(`mcp-connections:${connection.id}`); }
    for (const grant of (Array.isArray(categories['mcp-connections'].grants) ? categories['mcp-connections'].grants : [])) {
      if (!agentsStore().get(grant?.agentId) || !Array.isArray(grant?.tools) || !grant.tools.length) continue;
      // v2 stores connection IDs inside each per-agent tool grant. The old
      // importer incorrectly looked for grant.connectionId on the wrapper,
      // which is undefined and caused every valid MCP export to fail with
      // mcp_connection_id_invalid before setAgentTools could validate it.
      const connectionIds = [...new Set(grant.tools.map((tool) => String(tool?.connectionId || '').trim()).filter(Boolean))];
      if (connectionIds.length && connectionIds.every((connectionId) => mcpStore().get(connectionId))) {
        mcpStore().setAgentTools(grant.agentId, grant.tools);
        imported.push(`mcp-grants:${grant.agentId}`);
      }
    }
  } else if (Array.isArray(categories['mcp-connections'])) for (const connection of categories['mcp-connections']) { if (connection.apiKey === '[redacted]') continue; const { environmentVariables, ...portableConnection } = connection; mcpStore().save(portableConnection); imported.push(`mcp-connections:${connection.id}`); }
  if (categories['ui-auth'] && typeof categories['ui-auth'] === 'object') {
    const auth = categories['ui-auth'].auth;
    const secret = categories['ui-auth'].oidcClientSecret;
    if (auth && typeof auth === 'object' && secret !== '[redacted]' && secret) {
      const result = await saveUiAuthSettings({ ...auth, oidc: { ...(auth.oidc || {}), clientSecret: secret } });
      if (!result.ok) return result;
      imported.push('ui-auth:oidc-secret');
    } else if (auth && typeof auth === 'object') {
      const result = await saveUiAuthSettings(auth);
      if (!result.ok) return result;
      imported.push('ui-auth:settings');
    }
  }
  return { ok: true, imported, skipped: conflicts.filter((c) => conflictPolicy === 'skip'), unsupported: [] };
}

async function exportSnapshot(categories = []) {
  const data = {};
  if (categories.includes('api-contract')) {
    data['api-contract'] = {
      openapi: JSON.parse(await fs.readFile(path.join(sourceRoot, 'docs', 'openapi.json'), 'utf8')),
      streamContract: await fs.readFile(path.join(sourceRoot, 'docs', 'chat-stream-contract.md'), 'utf8'),
      policy: await fs.readFile(path.join(sourceRoot, 'docs', 'api-contract-policy.md'), 'utf8'),
    };
  }
  if (categories.includes('agents')) {
    const identities = modelsStore().identities();
    const identitiesById = new Map(identities.agents.map((identity) => [identity.id, identity]));
    const agentRecords = agentsStore().list({ includeDisabled: true });
    const profileStore = profilesStore();
    const dreamStore = dreamSettingsStore();
    let profiles;
    let dreamSettings;
    try {
      profiles = Object.fromEntries(agentRecords.map((agent) => [agent.id, profileStore.list(agent.id)]));
      dreamSettings = Object.fromEntries(agentRecords.map((agent) => [agent.id, dreamStore.get(agent.id)]));
    } finally { profileStore.close(); dreamStore.close(); }
    data.agents = {
      schema: 'burrow.agents-and-profiles/v2',
      operator: identities.operator,
      records: agentsStore().list({ includeDisabled: true }).map((agent) => {
        const identity = identitiesById.get(agent.id);
        return { ...agent, ...(identity ? { identityName: identity.name, avatar: identity.avatar || '' } : {}), dreamSettings: dreamSettings[agent.id] };
      }),
      profiles,
    };
  }
  if (categories.includes('settings')) {
    const db = modelsStore().db;
    data.settings = {
      schema: 'burrow.portable-settings/v1',
      executionBoundaries: readExecutionBoundaries({ databasePath: settingsDatabasePath() }),
      curatorSelection: readCuratorSelection({ databasePath: settingsDatabasePath(), root: curatorRoot() }),
      ownership: settingsOwnershipInventory(db).ownership,
    };
  }
  if (categories.includes('model-connections')) {
    const store = modelsStore();
    data['model-connections'] = store.list().map((connection) => ({ ...connection, auth: store.auth(connection.id) }));
  }
  if (categories.includes('mcp-connections')) {
    const store = mcpStore();
    const agents = agentsStore().list({ includeDisabled: true });
    data['mcp-connections'] = {
      schema: 'burrow.mcp-connections-and-grants/v2',
      connections: store.list().map((connection) => ({ ...connection, apiKey: store.apiKey(connection.id), environmentVariables: (connection.environmentVariables || []).map(({ name }) => ({ name, configured: true })) })),
      grants: agents.map((agent) => ({ agentId: agent.id, tools: store.agentTools(agent.id).map((grant) => ({ connectionId: grant.connectionId, toolName: grant.toolName, enabled: grant.enabled })) })).filter((entry) => entry.tools.length > 0),
    };
  }
  if (categories.includes('ui-auth')) {
    const db = modelsStore().db;
    data['ui-auth'] = { auth: safeUiAuthSettings(readUiAuthRecord()), oidcClientSecret: getUiAuthSecret(db) };
  }
  if (categories.includes('sessions')) data.sessions = { note: 'Session content export is intentionally bounded to metadata in v1.', agents: agentsStore().list({ includeDisabled: true }).map((agent) => ({ id: agent.id, name: agent.name })) };
  if (categories.includes('task-board')) data['task-board'] = { projects: await withTaskBoard((store) => store.listProjects()), tasks: await withTaskBoard((store) => store.listTasks()) };
  if (categories.includes('traces')) data.traces = await runtimeMetrics();
  return data;
}


function acceptsNdjson(req) {
  return String(req.headers.accept || '').toLowerCase().split(',').some((value) => value.trim().split(';')[0] === 'application/x-ndjson');
}

function beginNdjson(res) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  });
}

function writeNdjson(res, event) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`${JSON.stringify(event)}\n`);
}

// This is deliberately a narrow public projection of persisted trace records.
// Prompts, headers, tool arguments/results, and model/provider internals stay
// in trace evidence; the progress stream exposes only operational state.
function publicChatProgress(record = {}) {
  const payload = record.payload || {};
  if (record.type === 'router' && payload.stage === 'ask-chat-turn') {
    return { type: 'route.decided', data: { routeKind: payload.route?.kind || null, sessionKind: payload.runtimeTurn?.envelope?.route?.kind || null } };
  }
  if (record.type === 'model' && payload.stage === 'model-request') {
    return { type: 'model.started', data: { provider: payload.provider || null, api: payload.api || null, model: payload.model || null, toolCount: Number(payload.toolCount || 0) } };
  }
  if (record.type === 'model' && payload.stage === 'model-response') {
    return { type: 'model.completed', data: { status: payload.status ?? null, ok: payload.ok === true, finishReason: payload.finishReason || null, responseChars: Number(payload.responseChars || 0) } };
  }
  if (record.type === 'tool') {
    const presentation = toolActivityPresentation(payload) || {};
    return {
      type: payload.phase === 'start' ? 'tool.started' : 'tool.completed',
      data: {
        tool: payload.tool || null,
        rawTool: payload.tool || null,
        activityId: payload.activityId || null,
        ok: payload.ok ?? null,
        status: payload.status || null,
        childSessionId: payload.childSessionId || null,
        ...presentation,
        command: payload.command || null,
        cwd: payload.cwd || null,
        filePath: payload.filePath || payload.path || null,
        dirPath: payload.dirPath || null,
        query: payload.query || payload.pattern || null,
        reason: payload.reason || null,
        error: payload.error || null,
      },
    };
  }
  if (record.type === 'verifier') return { type: 'verification.completed', data: { ok: payload.ok ?? null, required: payload.required ?? null, status: payload.status || null } };
  if (record.type === 'chat-tool-loop-warning' || record.type === 'chat-tool-loop-blocked') return { type: 'runtime.notice', data: { notice: record.type } };
  return null;
}

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
]);

async function sendStaticFile(res, filePath, { downloadName = null } = {}) {
  const data = await fs.readFile(filePath);
  res.writeHead(200, {
    'content-type': MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
    'content-length': data.byteLength,
    'cache-control': path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    ...(downloadName ? { 'content-disposition': `inline; filename="${String(downloadName).replace(/["\\]/g, '_')}"` } : {}),
  });
  res.end(data);
}

async function serveV18Asset(url, res) {
  const requestPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const normalized = path.normalize(requestPath).replace(/^[/\\]+/, '');
  const filePath = path.join(uiDistRoot, normalized);
  const relative = path.relative(uiDistRoot, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    await sendStaticFile(res, filePath);
    return true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return false;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch {
    const error = new Error('invalid_json');
    error.statusCode = 400;
    throw error;
  }
}

function requireObjectBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('request_body_object_required'), { statusCode: 400 });
  return body;
}

function requireStringField(body, field, { allowEmpty = false } = {}) {
  if (typeof body[field] !== 'string' || (!allowEmpty && !body[field].trim())) throw Object.assign(new Error(`${field}_required`), { statusCode: 400 });
}

function validateBoundaryBody(kind, input = {}) {
  const body = requireObjectBody(input);
  if (kind === 'agent-create') { requireStringField(body, 'name'); if (body.id !== undefined && typeof body.id !== 'string') throw Object.assign(new Error('agent_id_invalid'), { statusCode: 400 }); }
  if (kind === 'agent-overview') {
    normalizeOverviewBody(body);
  }
  if (kind === 'agent-patch') { for (const field of ['name', 'enabled', 'availableCapabilities', 'contextConfig']) if (body[field] !== undefined && !['string', 'boolean', 'object'].includes(typeof body[field])) throw Object.assign(new Error(`${field}_invalid`), { statusCode: 400 }); }
  if (kind === 'chat') { const hasMessage = typeof body.message === 'string' && body.message.trim(); const hasImage = Array.isArray(body.attachments) && body.attachments.some((item) => String(item?.type || item?.mimeType || '').toLowerCase().startsWith('image/')); if (!hasMessage && !hasImage) throw Object.assign(new Error('message_required'), { statusCode: 400 }); }
  if (kind === 'workspace-write') { requireStringField(body, 'path'); if (typeof body.content !== 'string') throw Object.assign(new Error('content_required'), { statusCode: 400 }); }
  if (kind === 'project-create') requireStringField(body, 'name');
  if (kind === 'task-create') { requireStringField(body, 'projectId'); requireStringField(body, 'title'); }
  if (kind === 'scheduled-job-create') for (const field of ['agentId', 'name', 'prompt', 'cron', 'timezone']) requireStringField(body, field);
  if (kind === 'group-create') { requireStringField(body, 'name'); if (!Array.isArray(body.participantAgentIds) || !body.participantAgentIds.length || body.participantAgentIds.some((id) => typeof id !== 'string' || !id.trim())) throw Object.assign(new Error('group_participants_required'), { statusCode: 400 }); }
  if (kind === 'group-message') requireStringField(body, 'message');
  return body;
}

async function listDirs(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function sessionPreview(id) {
  try {
    const rootDir = await runtimeAgentWorkspaceRoot();
    const meta = await readSessionMetadata({ rootDir, sessionId: id });
    const turns = await readSessionTurns({ rootDir, sessionId: id, limit: 20 });
    const last = turns.at(-1) || null;
    return { id, turnCount: meta?.turnCount ?? turns.length, createdAt: meta?.createdAt || null, updatedAt: meta?.updatedAt || last?.ts || null, lastRole: meta?.lastRole || last?.role || null, lastContent: last?.content || '', summary: meta?.summary || '' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { id, turnCount: 0, updatedAt: null, lastRole: null, lastContent: '' };
    throw error;
  }
}

function boundedInteger(value, { fallback = 100, min = 1, max = 500 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

async function listSessions({ rootDir, rootDirs = null, agentId = null, includeArchived = false, query = '', updatedSince = null, limit = 100 } = {}) {
  const resolvedLimit = boundedInteger(limit, { fallback: 100, min: 1, max: 500 });
  const since = updatedSince && !Number.isNaN(Date.parse(updatedSince)) ? String(updatedSince) : null;
  const roots = (rootDirs || [rootDir]).filter(Boolean).filter((item, index, all) => all.indexOf(item) === index);
  const records = await Promise.all(roots.map((item) => listSessionRecords({ rootDir: item, includeArchived, query, limit: resolvedLimit })));
  return records.flat()
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .filter((item) => !since || (item.updatedAt && item.updatedAt > since))
    .map((item) => ({ ...item, sessionId: item.id, agentId }))
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, resolvedLimit);
}

function archiveSessionListItem(record = {}, agentRuntime = {}, agent = {}) {
  const metadata = record.metadata || {};
  const sessionId = record.id || metadata.sessionId || metadata.sessionKey || 'default';
  return {
    agentId: agentRuntime.agentId || agent.id || null,
    agentName: agent.name || agentRuntime.agentName || agentRuntime.agentId || agent.id || null,
    sessionId,
    id: sessionId,
    title: record.archiveTitle || metadata.archiveTitle || metadata.title || metadata.name || sessionId,
    titleSource: record.archiveTitle || metadata.archiveTitle ? 'derived' : 'legacy',
    summary: record.archiveSummary || metadata.archiveSummary || null,
    summaryStatus: record.summaryStatus || metadata.archiveSummaryStatus || 'not_configured',
    summarizedAt: record.summarizedAt || metadata.archiveSummarizedAt || null,
    turnCount: record.turnCount ?? metadata.turnCount ?? 0,
    chatTurnCount: metadata.chatTurnCount ?? null,
    createdAt: metadata.createdAt || null,
    updatedAt: record.updatedAt || metadata.updatedAt || metadata.lastInteractionAt || null,
    archived: Boolean(record.archiveSnapshot || record.archived || metadata.archived),
    archivedAt: metadata.archivedAt || null,
    kind: metadata.kind || null,
    lastRole: metadata.lastRole || null,
    lastRunId: metadata.lastRunId || null,
    ...(record.archiveSnapshot ? { archiveSnapshot: record.archiveSnapshot, sourceSessionId: record.sourceSessionId } : {}),
  };
}

async function archiveDreams({ agentId = null, date = null, phase = null, limit = 200 } = {}) {
  const agents = agentsStore().list({ includeDisabled: true }).filter((agent) => !agentId || agent.id === String(agentId));
  const store = dreamDiaryStore();
  try {
    const entries = agents.flatMap((agent) => store.list(agent.id, { date, phase, limit }).map((entry) => ({ id: entry.id, kind: 'dream', agentId: agent.id, agentName: agent.name, entryDate: entry.entryDate, phase: entry.phase, title: `${entry.phase.toUpperCase()} dream · ${entry.entryDate}`, excerpt: String(entry.narrative || '').slice(0, 320).trim(), createdAt: entry.createdAt })));
    return { ok: true, entries: entries.sort((a, b) => String(b.entryDate || b.createdAt).localeCompare(String(a.entryDate || a.createdAt))).slice(0, Math.max(1, Math.min(500, Number(limit) || 200))) };
  } finally { store.close(); }
}

async function archiveDreamDetail(agentId, entryId) {
  const store = dreamDiaryStore();
  try {
    const entry = store.get(agentId, entryId);
    const agent = agentsStore().get(agentId);
    return { ok: true, document: { id: entry.id, kind: 'dream', agentId, agentName: agent?.name || agentId, title: `${entry.phase.toUpperCase()} dream · ${entry.entryDate}`, subtitle: entry.entryDate, phase: entry.phase, markdown: entry.narrative, createdAt: entry.createdAt } };
  } catch (error) { return { ok: false, status: String(error?.message || error) === 'dream_diary_entry_not_found' ? 404 : 400, error: String(error?.message || error) }; } finally { store.close(); }
}

async function archiveContinuityCards({ agentId = null, scope = null, limit = 200 } = {}) {
  const resolvedLimit = boundedInteger(limit, { fallback: 200, min: 1, max: 500 });
  const agents = agentsStore().list({ includeDisabled: true }).filter((agent) => !agentId || agent.id === String(agentId));
  const cards = agents.flatMap((agent) => listTiddleCards({ agentId: agent.id, scope, limit: resolvedLimit, databasePath: settingsDatabasePath() }).cards.map((card) => ({ ...card, kind: 'continuity', agentId: agent.id, agentName: agent.name })));
  return { ok: true, scope: scope || null, cards: cards.sort((left, right) => String(right.lastSeen || '').localeCompare(String(left.lastSeen || ''))).slice(0, resolvedLimit) };
}

async function archiveContinuityCardDetail({ agentId, cardId, limit = 200 } = {}) {
  const agent = agentsStore().get(agentId);
  if (!agent) return { ok: false, status: 404, error: 'agent_not_found' };
  const cards = listTiddleCards({ agentId, limit: 500, databasePath: settingsDatabasePath() }).cards;
  const card = cards.find((candidate) => candidate.id === cardId);
  if (!card) return { ok: false, status: 404, error: 'archive_continuity_card_not_found' };
  const history = tiddleHistory({ agentId, cardId, limit: boundedInteger(limit, { fallback: 200, min: 1, max: 500 }), databasePath: settingsDatabasePath() }).entries;
  return { ok: true, card: { ...card, kind: 'continuity', agentId, agentName: agent.name }, history };
}

async function archiveRuns({ agentRuntime, sessionId = null, limit = 100 } = {}) {
  const agent = agentsStore().resolve(agentRuntime.agentId) || { id: agentRuntime.agentId, name: agentRuntime.agentId };
  const runtime = await runtimeConfig(agentRuntime.agentId);
  return listArchiveRuns({ rootDir: agentRuntime.agentWorkspaceRoot, dataRoot: agentRuntime.agentDataRoot, traceRoot: runtimeTraceRoot(runtime, sessionId || 'default', agentRuntime.agentId), agentId: agentRuntime.agentId, agentName: agent.name, sessionId, limit });
}

async function archiveRunDetail({ agentRuntime, runId } = {}) {
  const agent = agentsStore().resolve(agentRuntime.agentId) || { id: agentRuntime.agentId, name: agentRuntime.agentId };
  const runtime = await runtimeConfig(agentRuntime.agentId);
  return readArchiveRun({ rootDir: agentRuntime.agentWorkspaceRoot, dataRoot: agentRuntime.agentDataRoot, traceRoot: runtimeTraceRoot(runtime, 'default', agentRuntime.agentId), agentId: agentRuntime.agentId, agentName: agent.name, runId });
}

async function archiveSessions({ includeArchived = true, query = '', limit = 200, includeDisabled = false } = {}) {
  const resolvedLimit = boundedInteger(limit, { fallback: 200, min: 1, max: 1000 });
  const agents = agentsStore().list({ includeDisabled: Boolean(includeDisabled) });
  const lists = await Promise.all(agents.map(async (agent) => {
    if (!agent.enabled && !includeDisabled) return [];
    const agentRuntime = await resolveAgentRuntime(agent.id);
    const records = await listSessionRecords({ rootDir: agentRuntime.agentWorkspaceRoot, includeArchived, query, limit: resolvedLimit });
    const resets = includeArchived ? await listResetSessionArchives({ rootDir: agentRuntime.agentWorkspaceRoot, query, limit: resolvedLimit }) : [];
    return [...records, ...resets].map((record) => archiveSessionListItem(record, agentRuntime, agent));
  }));
  return lists.flat()
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, resolvedLimit);
}

function activityItemFromTraceCard(card = {}) {
  const payload = card.payload || card;
  const presentation = toolActivityPresentation(payload);
  if (!presentation) return null;
  return { ...presentation, status: toolActivityStatus({ card, payload }) };
}

function runtimeTraceRoot(runtime, sessionId = 'default', agentId = runtime.runtimeState.agentId) {
  return resolveRuntimeTracePath({
    cacheRoot: runtime.runtimeState.cacheRoot,
    workspaceRoot: runtime.runtimeState.workspaceRoot,
    agentId,
    sessionId,
  });
}

async function sessionActivities({ sessionId, turns } = {}) {
  const runtime = await runtimeConfig();
  const receiptRuns = [...new Set((turns || []).filter((turn) => turn.type === 'receipt' && turn.runId).map((turn) => turn.runId))];
  const activities = [];
  for (const runId of receiptRuns.slice(-20)) {
    const trace = await summarizeTrace({ rootDir: runtimeTraceRoot(runtime, sessionId), runId, includeToolOutput: false, includeRelatedWorkTrace: false });
    const items = (trace.cards || []).filter((card) => card.stream === 'tool').map(activityItemFromTraceCard).filter(Boolean);
    const uniqueItems = items.filter((item, index, all) => all.findIndex((candidate) => candidate.label === item.label && candidate.status === item.status && candidate.detail === item.detail) === index);
    if (!uniqueItems.length) continue;
    const failures = uniqueItems.some((item) => item.status === 'error');
    const complete = uniqueItems.every((item) => item.status === 'ok' || item.status === 'error');
    activities.push({
      runId,
      status: failures ? 'warn' : complete ? 'ok' : 'running',
      title: failures ? 'Finished with an issue' : complete ? 'Done' : 'Working…',
      summary: complete ? `Used ${uniqueItems.length} tool${uniqueItems.length === 1 ? '' : 's'}.` : uniqueItems.at(-1)?.label || 'Working…',
      items: uniqueItems,
    });
  }
  return activities;
}

function compactChatTurn(turn = {}) {
  const metadata = {};
  if (turn.metadata?.toolActivity) metadata.toolActivity = turn.metadata.toolActivity;
  for (const key of ['fromAgentName', 'fromAgentId', 'messageMode', 'direction']) {
    if (turn.metadata?.[key] !== undefined) metadata[key] = turn.metadata[key];
  }
  return {
    id: turn.id,
    parentId: turn.parentId ?? null,
    ts: turn.ts,
    type: turn.type,
    role: turn.role,
    content: turn.content,
    contentTruncated: Boolean(turn.contentTruncated),
    runId: turn.runId ?? null,
    visibility: turn.visibility,
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}

async function sessionDetail(id, { rootDir } = {}) {
  const metadata = rootDir ? await readSessionMetadata({ rootDir, sessionId: id }) : null;
  if (!metadata) return null;
  // The cockpit needs rendered chat plus compact activity cards, never raw
  // model/tool/debug envelopes. Those remain available through trace routes.
  // Fetch the two bounded projections separately so a verbose work turn cannot
  // make ordinary chat hydration transfer or parse its invisible debug payload.
  const [chatTurns, activityTurns] = await Promise.all([
    readChatMessages({ rootDir, sessionId: id, limit: 200 }),
    readActivityEvents({ rootDir, sessionId: id, limit: 20 }),
  ]);
  const turns = [...chatTurns, ...activityTurns]
    .sort((left, right) => String(left.ts || '').localeCompare(String(right.ts || '')))
    .map(compactChatTurn);
  const activities = activityTurns
    .filter((turn) => turn.metadata?.toolActivity)
    .map((turn) => ({ ...turn.metadata.toolActivity, runId: turn.runId || turn.metadata.toolActivity.runId || null }));
  return { id, turnCount: metadata.turnCount ?? turns.length, metadata, summary: metadata.summary || summarizeSessionTurns(chatTurns, { maxChars: 2000 }), turns, activities };
}

async function archiveSessionDetail(agentId, sessionId) {
  const agentRuntime = await resolveAgentRuntime(agentId);
  const agent = agentsStore().resolve(agentRuntime.agentId) || { id: agentRuntime.agentId, name: agentRuntime.agentId };
  const resetSnapshot = await readResetSessionArchive({ rootDir: agentRuntime.agentWorkspaceRoot, archiveId: sessionId });
  if (resetSnapshot) {
    const chatTurns = resetSnapshot.turns.filter((turn) => turn.visibility === 'chat').map(compactChatTurn);
    return {
      agentId: agentRuntime.agentId,
      agentName: agent.name || agentRuntime.agentId,
      sessionId: resetSnapshot.id,
      session: {
        id: resetSnapshot.id,
        sessionId: resetSnapshot.id,
        agentId: agentRuntime.agentId,
        agentName: agent.name || agentRuntime.agentId,
        archiveSnapshot: 'reset',
        sourceSessionId: resetSnapshot.sourceSessionId,
        turnCount: resetSnapshot.turnCount,
        metadata: { archived: true, archiveSnapshot: 'reset', sourceSessionId: resetSnapshot.sourceSessionId, createdAt: resetSnapshot.createdAt, updatedAt: resetSnapshot.updatedAt },
        summary: resetSnapshot.archiveSummary || null,
        summaryStatus: resetSnapshot.summaryStatus || 'not_configured',
        title: resetSnapshot.archiveTitle || `Conversation from ${resetSnapshot.sourceSessionId}`,
        turns: chatTurns,
        activities: [],
      },
    };
  }
  const session = await sessionDetail(sessionId, { rootDir: agentRuntime.agentWorkspaceRoot });
  if (!session) return null;
  return {
    agentId: agentRuntime.agentId,
    agentName: agent.name || agentRuntime.agentId,
    sessionId: session.id,
    session: {
      ...session,
      agentId: agentRuntime.agentId,
      agentName: agent.name || agentRuntime.agentId,
      sessionId: session.id,
    },
  };
}

async function listTraces(sessionId = 'default', agentId = null) {
  const runtime = await runtimeConfig();
  const ids = await listDirs(runtimeTraceRoot(runtime, sessionId, agentId || runtime.runtimeState.agentId));
  return ids.slice(0, 100).map((id) => ({ id, url: `/api/traces/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId)}` }));
}

async function traceRootForRun({ rootDir, sessionId, runId, runtime, agentId } = {}) {
  const findTraceDir = async (id) => {
    const turns = await readSessionTurns({ rootDir, sessionId: id, limit: 500, includeHistory: true });
    return turns.findLast((turn) => turn.runId === runId && turn.traceDir)?.traceDir || null;
  };
  let traceDir = rootDir ? await findTraceDir(sessionId) : null;
  // Legacy trace URLs do not carry sessionId. Resolve through the selected
  // agent's session lineage rather than mixing unrelated session histories.
  if (!traceDir && rootDir) {
    const records = await listSessionRecords({ rootDir, includeArchived: true, limit: 500 });
    for (const record of records) {
      if (record.id === sessionId) continue;
      traceDir = await findTraceDir(record.id);
      if (traceDir) break;
    }
  }
  return traceDir ? path.dirname(traceDir) : runtimeTraceRoot(runtime, sessionId, agentId);
}

function runtimePolicyStatus(runtime) {
  const boundaries = readExecutionBoundaries({ databasePath: runtime?.runtimeState?.settingsDatabasePath });
  const status = executionBoundaryStatus(boundaries);
  return { retired: false, packs: 0, hardBlockCount: status.hardBlockCount, enabledHardBlockCount: status.enabledHardBlockCount, hardBlocks: status.hardBlocks.map((rule) => ({ id: rule.id, enabled: rule.enabled, type: rule.type, match: rule.match, operations: rule.operations, reason: rule.reason || null })) };
}

async function executionBoundarySettings() {
  const boundaries = readExecutionBoundaries({ databasePath: settingsDatabasePath() });
  return { ok: true, boundaries, status: executionBoundaryStatus(boundaries) };
}

async function saveExecutionBoundarySettings(body = {}) {
  const result = saveExecutionBoundaries(body, { databasePath: settingsDatabasePath() });
  return result.ok ? { ...result, status: executionBoundaryStatus(result.boundaries) } : result;
}

async function cachedTraceObservability(traceRoot) {
  const key = path.resolve(traceRoot);
  const cached = traceStatusCache.get(key);
  if (cached && Date.now() - cached.at < TRACE_STATUS_CACHE_MS) return cached.value;
  const value = await collectTraceObservability({ traceRoot: key });
  traceStatusCache.set(key, { at: Date.now(), value });
  return value;
}

async function runtimeStatus(agentId = null) {
  try {
    const runtime = await runtimeConfig();
    const agentRuntime = await selectedAgentRuntime(agentId);
    const selected = agentRuntime ? modelsStore().modelSelection(agentRuntime.agentId) : null;
    const selectedRuntime = selected ? await loadRuntimeConfig({ rootDir: projectRoot, args: { agent_id: agentRuntime.agentId } }) : runtime;
    const traceRoot = path.join(runtime.runtimeState.cacheRoot, 'traces');
    const traces = await cachedTraceObservability(traceRoot);
    return {
      ok: true,
      root: projectRoot,
      runtime: 'burrow',
      version: releaseVersion,
      config: { ownership: 'retired', path: null, exists: false, warnings: [] },
      state: { sourceRoot: runtime.runtimeState.sourceRoot, workspaceRoot: runtime.runtimeState.workspaceRoot, agentWorkspaceRoot: runtime.runtimeState.agentWorkspaceRoot, agentDataRoot: runtime.runtimeState.agentDataRoot, dataRoot: runtime.runtimeState.dataRoot },
      ui: { host, port, authEnabled: runtime.ui.authEnabled, authMode: runtime.ui.authMode, authSource: runtime.ui.authSource },
      memory: { configured: false, owner: 'local_session_and_mcp' },
      model: selectedRuntime.modelConfig ? { configured: Boolean(selectedRuntime.modelConfig.model), selectionRequired: !selectedRuntime.modelConfig.model, provider: selectedRuntime.modelConfig.provider, providerName: selectedRuntime.modelConfig.providerName || selectedRuntime.modelConfig.provider, api: selectedRuntime.modelConfig.api, baseUrl: selectedRuntime.modelConfig.baseUrl, model: selectedRuntime.modelConfig.model, selectedProfile: selectedRuntime.modelConfig.selectedProfile || null, profiles: selectedRuntime.modelConfig.availableProfiles || [], hasApiKey: Boolean(selectedRuntime.modelConfig.apiKey), reasoningEffort: selectedRuntime.modelConfig.extra?.reasoning?.effort || 'off', temperature: selectedRuntime.modelConfig.temperature ?? 0.2, reasoningEfforts: selectedRuntime.modelConfig.reasoningEfforts || ['off', 'minimal', 'low', 'medium', 'high'], contextWindow: selectedRuntime.modelConfig.contextWindow || null, contextTokens: selectedRuntime.modelConfig.contextTokens || null, selectionSource: selectedRuntime.modelConfig.selectionSource || null, agentId: agentRuntime?.agentId || null } : { configured: false, selectionRequired: true, selectedProfile: null, profiles: [], reasoningEfforts: ['off', 'minimal', 'low', 'medium', 'high'], contextWindow: null, contextTokens: null },
      policy: runtimePolicyStatus(runtime),
      retention: runtime.retention,
      traces,
    };
  } catch (error) {
    return { ok: false, root: projectRoot, runtime: 'burrow', version: releaseVersion, error: String(error?.message || error) };
  }
}


function selectedWorkspaceRoot(runtime, scope = 'workspaces', agentRuntime = null) {
  const workspaceContainer = path.resolve(runtime.runtimeState.workspaceRoot || runtime.runtimeState.sourceCopyRoot || runtime.runtimeState.sourceRoot || projectRoot);
  const agentRoot = path.resolve(agentRuntime?.agentWorkspaceRoot || runtime.runtimeState.agentWorkspaceRoot || path.join(workspaceContainer, runtime.runtimeState.agentId || 'hatchet'));
  const normalizedScope = String(scope || 'workspaces').toLowerCase();
  if (normalizedScope === 'agent') return { workspaceRoot: agentRoot, workspaceScope: 'agent' };
  // The workspace container is ordinary local context. Selecting an agent
  // changes automatic prompt/session state, not what files may be inspected.
  return { workspaceRoot: workspaceContainer, workspaceScope: 'workspaces' };
}

async function listWorkspaceFiles({ limit = 1000, scope = 'workspaces', agentRuntime = null } = {}) {
  const runtime = await runtimeConfig();
  const { workspaceRoot, workspaceScope } = selectedWorkspaceRoot(runtime, scope, agentRuntime);
  const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'public/ui', '.tmp', '.cache', 'coverage']);
  const files = [];
  async function walk(dir, prefix = '') {
    if (files.length >= limit) return;
    const entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith('.') || entry.name === '.env.example')
      .sort((a, b) => a.name.localeCompare(b.name));
    const directories = [];
    for (const entry of entries) {
      if (files.length >= limit) break;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirs.has(relative) || ignoredDirs.has(entry.name)) continue;
        files.push({ path: `${relative}/`, type: 'directory' });
        directories.push({ fullPath, relative });
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        files.push({ path: relative, type: 'file', size: stat.size });
      }
    }
    for (const directory of directories) {
      if (files.length >= limit) break;
      await walk(directory.fullPath, directory.relative);
    }
  }
  try {
    await walk(workspaceRoot);
  } catch (error) {
    return { ok: false, workspaceRoot, workspaceScope, files: [], error: String(error?.message || error) };
  }
  return { ok: true, workspaceRoot, workspaceScope, files };
}

async function resolveWorkspaceFile(filePath, scope = 'workspaces', agentRuntime = null) {
  const runtime = await runtimeConfig();
  const { workspaceRoot, workspaceScope } = selectedWorkspaceRoot(runtime, scope, agentRuntime);
  const relativePath = String(filePath || '').replace(/^[/\\]+/, '').trim();
  if (!relativePath) return { ok: false, status: 400, error: 'workspace_file_path_required' };
  const resolvedPath = path.resolve(workspaceRoot, relativePath);
  const relative = path.relative(workspaceRoot, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, status: 403, error: 'workspace_file_outside_root' };
  return { ok: true, workspaceRoot, workspaceScope, relativePath: relative, resolvedPath };
}

async function readWorkspaceFile(filePath, scope = 'workspaces', agentRuntime = null) {
  const resolved = await resolveWorkspaceFile(filePath, scope, agentRuntime);
  if (!resolved.ok) return resolved;
  try {
    const stat = await fs.stat(resolved.resolvedPath);
    if (!stat.isFile()) return { ok: false, status: 400, error: 'workspace_path_not_file', path: resolved.relativePath };
    if (stat.size > 1024 * 1024) return { ok: false, status: 413, error: 'workspace_file_too_large', path: resolved.relativePath, size: stat.size };
    const content = await fs.readFile(resolved.resolvedPath, 'utf8');
    return { ok: true, path: resolved.relativePath, workspaceRoot: resolved.workspaceRoot, workspaceScope: resolved.workspaceScope, content, size: stat.size };
  } catch (error) {
    return { ok: false, status: error?.code === 'ENOENT' ? 404 : 500, error: String(error?.message || error), path: resolved.relativePath };
  }
}

async function writeWorkspaceFile(body = {}, agentRuntime = null) {
  const resolved = await resolveWorkspaceFile(body.path, body.scope || body.workspaceScope || 'workspaces', agentRuntime);
  if (!resolved.ok) return resolved;
  const content = String(body.content ?? '');
  if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) return { ok: false, status: 413, error: 'workspace_file_too_large', path: resolved.relativePath };
  try {
    const stat = await fs.stat(resolved.resolvedPath);
    if (!stat.isFile()) return { ok: false, status: 400, error: 'workspace_path_not_file', path: resolved.relativePath };
    await fs.writeFile(resolved.resolvedPath, content, 'utf8');
    return { ok: true, path: resolved.relativePath, workspaceRoot: resolved.workspaceRoot, workspaceScope: resolved.workspaceScope, content, size: Buffer.byteLength(content, 'utf8') };
  } catch (error) {
    return { ok: false, status: error?.code === 'ENOENT' ? 404 : 500, error: String(error?.message || error), path: resolved.relativePath };
  }
}

async function localContinuityContext(body = {}) {
  const agentRuntime = await resolveAgentRuntime(body.agentId);
  const sessionId = String(body.sessionId || 'default').trim() || 'default';
  return { agentRuntime, sessionId, dataRoot: agentRuntime.agentDataRoot };
}

async function sessionContinuityScope(body = {}) {
  const agentRuntime = await resolveAgentRuntime(body.agentId);
  const sessionId = String(body.sessionId || 'default').trim() || 'default';
  const metadata = await readSessionMetadata({ rootDir: agentRuntime.agentWorkspaceRoot, sessionId });
  return { ok: true, agentId: agentRuntime.agentId, sessionId, continuityScope: workingContextFromSession({ metadata }).continuityScope || null };
}

async function setSessionContinuityScope(body = {}) {
  const agentRuntime = await resolveAgentRuntime(body.agentId);
  const sessionId = String(body.sessionId || 'default').trim() || 'default';
  const continuityScope = normalizeContinuityScope(body.continuityScope ?? body.scope);
  if (!continuityScope) return { ok: false, error: 'continuity_scope_required' };
  const metadata = await readSessionMetadata({ rootDir: agentRuntime.agentWorkspaceRoot, sessionId });
  const workingContext = workingContextFromSession({ metadata });
  await persistSessionWorkingContext({ rootDir: agentRuntime.agentWorkspaceRoot, sessionId, workingContext: { ...workingContext, continuityScope } });
  return { ok: true, agentId: agentRuntime.agentId, sessionId, continuityScope };
}

async function clearSessionContinuityScope(body = {}) {
  const agentRuntime = await resolveAgentRuntime(body.agentId);
  const sessionId = String(body.sessionId || 'default').trim() || 'default';
  const metadata = await readSessionMetadata({ rootDir: agentRuntime.agentWorkspaceRoot, sessionId });
  const { continuityScope: _removed, ...workingContext } = workingContextFromSession({ metadata });
  await persistSessionWorkingContext({ rootDir: agentRuntime.agentWorkspaceRoot, sessionId, workingContext });
  return { ok: true, agentId: agentRuntime.agentId, sessionId, continuityScope: null };
}

async function sessionReadHandoff(body = {}) {
  try {
    const { agentRuntime, sessionId, dataRoot } = await localContinuityContext(body);
    const session = await sessionDetail(sessionId, { rootDir: agentRuntime.agentWorkspaceRoot });
    const metadata = await readSessionMetadata({ rootDir: agentRuntime.agentWorkspaceRoot, sessionId });
    const workingContext = workingContextFromSession({ metadata });
    const continuityScope = normalizeContinuityScope(workingContext.continuityScope) || `conversation:${metadata?.conversationId || sessionId}`;
    const handoffs = listContinuityHandoffs({ dataRoot, agentId: agentRuntime.agentId, limit: 1 });
    const workingContinuity = projectHandoffsIntoWorkingContinuity({
      continuity: loadWorkingContinuity({ agentId: agentRuntime.agentId, continuityScope }),
      handoffs,
      agentId: agentRuntime.agentId,
      continuityScope,
    });
    return { ok: true, owner: 'sqlite', handoffModel: 'rolling_continuity_metadata', agentId: agentRuntime.agentId, sessionId, continuityScope, sessionSummary: session?.summary || null, handoffs, workingContinuity };
  } catch (error) { return { ok: false, error: String(error?.message || error) }; }
}

async function sessionWriteHandoff(body = {}) {
  try {
    const { agentRuntime, sessionId, dataRoot } = await localContinuityContext(body);
    const session = await sessionDetail(sessionId, { rootDir: agentRuntime.agentWorkspaceRoot });
    const content = String(body.content || session?.summary || '').trim();
    if (!content) return { ok: false, error: 'handoff_content_empty' };
    const runId = String(body.runId || `ui-handoff-${Date.now()}`);
    const handoff = buildContinuityHandoff({ agentId: agentRuntime.agentId, sessionId, runId, message: body.message || `Session ${sessionId} continuity handoff`, answerText: content, toolResults: [], curated: { title: body.title || `Burrow session handoff: ${sessionId}`, content } });
    if (!handoff) return { ok: false, error: 'handoff_content_insufficient' };
    const store = new ContinuityHandoffStore({ dataRoot });
    try { return { ok: true, owner: 'sqlite', handoff: store.upsert(handoff) }; } finally { store.close(); }
  } catch (error) { return { ok: false, error: String(error?.message || error) }; }
}

async function sessionWriteHandoffCandidate(body = {}) {
  const candidate = body.candidate || body.handoffCandidate || body;
  if (!candidate?.proposed) return { ok: false, error: 'handoff_candidate_not_proposed' };
  if (!candidate.content) return { ok: false, error: 'handoff_candidate_content_empty' };
  return sessionWriteHandoff({ ...body, content: String(candidate.content), title: candidate.title || 'Burrow handoff candidate', runId: candidate.runId || body.runId });
}

async function brainPromotionCandidates(body = {}) {
  const agentRuntime = await resolveAgentRuntime(body.agentId);
  const store = new WorkingMemoryStore({ databasePath: settingsDatabasePath() });
  try {
    return { ok: true, owner: 'local_review_queue', entersPrompt: false, writesBrain: false, agentId: agentRuntime.agentId, candidates: store.listBrainPromotionCandidates({ agentId: agentRuntime.agentId, status: body.status || 'pending', limit: body.limit || 20 }) };
  } catch (error) { return { ok: false, error: String(error?.message || error) }; }
  finally { store.close(); }
}

async function updateBrainPromotionCandidate(body = {}) {
  const agentRuntime = await resolveAgentRuntime(body.agentId);
  const store = new WorkingMemoryStore({ databasePath: settingsDatabasePath() });
  try {
    return { ok: true, owner: 'local_review_queue', entersPrompt: false, writesBrain: false, candidate: store.updateBrainPromotionCandidate({ agentId: agentRuntime.agentId, candidateId: body.candidateId || body.id, status: body.status, reason: body.reason }) };
  } catch (error) { return { ok: false, error: String(error?.message || error) }; }
  finally { store.close(); }
}

async function retentionPolicySettings() {
  const runtime = await runtimeConfig();
  const policy = readRetentionPolicy({ databasePath: runtime.runtimeState.settingsDatabasePath });
  const state = readRetentionPolicyState({ databasePath: runtime.runtimeState.settingsDatabasePath });
  const plan = await planRetentionCleanup({ dataRoot: runtime.runtimeState.agentDataRoot, traceRoot: path.join(runtime.runtimeState.cacheRoot, 'traces'), settingsDatabasePath: runtime.runtimeState.settingsDatabasePath, retention: policy });
  return { ok: true, policy, state, plan };
}

async function saveRetentionPolicySettings(body = {}) {
  try {
    const runtime = await runtimeConfig();
    const policy = saveRetentionPolicy(body.policy || body, { databasePath: runtime.runtimeState.settingsDatabasePath });
    const state = readRetentionPolicyState({ databasePath: runtime.runtimeState.settingsDatabasePath });
    return { ok: true, policy, state };
  } catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; }
}

async function retentionCleanup(body = {}) {
  const runtime = await runtimeConfig();
  const savedPolicy = readRetentionPolicy({ databasePath: runtime.runtimeState.settingsDatabasePath });
  const policy = body.policy ? normalizeRetentionPolicy(body.policy, savedPolicy) : savedPolicy;
  if (body.confirm === true && !policy.enabled && body.requireEnabled !== false) return { ok: false, status: 409, error: 'retention_policy_disabled', policy };
  try {
    const result = await runRetentionCleanup({ dataRoot: runtime.runtimeState.agentDataRoot, traceRoot: path.join(runtime.runtimeState.cacheRoot, 'traces'), settingsDatabasePath: runtime.runtimeState.settingsDatabasePath, retention: policy, confirm: body.confirm === true });
    const attachments = body.confirm === true && body.includeAttachments === true ? await cleanupAgentAttachments({ databasePath: settingsDatabasePath(), resolveAgentWorkspaceRoot: async (agentId) => (await resolveAgentRuntime(agentId))?.agentWorkspaceRoot || null }) : null;
    const state = body.confirm === true ? writeRetentionPolicyState(retentionPolicySuccessState({ policy, result, previous: readRetentionPolicyState({ databasePath: runtime.runtimeState.settingsDatabasePath }) }), { databasePath: runtime.runtimeState.settingsDatabasePath }) : readRetentionPolicyState({ databasePath: runtime.runtimeState.settingsDatabasePath });
    return { ok: true, policy, state, ...result, attachments };
  } catch (error) {
    if (body.confirm === true) writeRetentionPolicyState(retentionPolicyFailureState({ policy, error, previous: readRetentionPolicyState({ databasePath: runtime.runtimeState.settingsDatabasePath }) }), { databasePath: runtime.runtimeState.settingsDatabasePath });
    return { ok: false, status: 500, error: String(error?.message || error), policy, state: readRetentionPolicyState({ databasePath: runtime.runtimeState.settingsDatabasePath }) };
  }
}

async function workbenchPlan(body = {}, agentRuntime = null) {
  const message = String(body.message || '').trim();
  if (!message) return { ok: false, error: 'message_required' };
  const workspaceRoot = body.workspaceRoot ? String(body.workspaceRoot) : null;
  const action = body.action ? String(body.action) : null;
  const turnPlan = planTurn({ message, action, workspaceContext: { workspaceRoot } });
  const route = await routeRequest({ rootDir: projectRoot, message, workspaceContext: { workspaceRoot }, turnPlan });
  const session = turnPlan.intentFacts?.authoritative
    ? {
        kind: turnPlan.intentFacts.kind,
        actionRoute: {
          kind: turnPlan.intentFacts.kind,
          route: turnPlan.intentFacts.kind,
          reason: 'explicit-action',
        },
        reason: 'explicit-action',
        warnings: [],
      }
    : {
        kind: 'chat',
        actionRoute: { kind: 'chat', route: 'chat', reason: 'model-owned' },
        reason: 'model-owned',
        warnings: [],
      };
  const actionRoute = session.actionRoute ?? { kind: session.kind, route: session.kind, reason: session.reason ?? null };
  const workflow = workbenchWorkflow({ session, actionRoute, workspaceRoot });
  return {
    ok: true,
    workbenchStatus: buildWorkbenchStatus({ decision: 'planned', session, actionRoute, workflow, blockers: workflow.blockers || [], warnings: session.warnings || [] }),
    debug: { session, actionRoute, workflow },
  };
}

async function workbenchRun(body = {}, agentRuntime = null) {
  const message = String(body.message || '').trim();
  if (!message) return { ok: false, error: 'message_required' };
  const workspaceRoot = body.workspaceRoot ? String(body.workspaceRoot) : null;
  const target = body.target && typeof body.target === 'object' ? body.target : null;
  const action = body.action ? String(body.action) : null;
  const turnPlan = planTurn({ message, action, workspaceContext: { workspaceRoot } });
  const route = await routeRequest({ rootDir: projectRoot, message, workspaceContext: { workspaceRoot }, turnPlan });
  const session = turnPlan.intentFacts?.authoritative
    ? {
        kind: turnPlan.intentFacts.kind,
        actionRoute: {
          kind: turnPlan.intentFacts.kind,
          route: turnPlan.intentFacts.kind,
          reason: 'explicit-action',
        },
        reason: 'explicit-action',
        warnings: [],
      }
    : {
        kind: 'chat',
        actionRoute: { kind: 'chat', route: 'chat', reason: 'model-owned' },
        reason: 'model-owned',
        warnings: [],
      };
  const actionRoute = session.actionRoute ?? { kind: session.kind, route: session.kind, reason: session.reason ?? null };
  const workflow = workbenchWorkflow({ session, actionRoute, workspaceRoot });
  const result = await runWorkbenchStep({
    rootDir: projectRoot,
    step: body.step || 'inspect',
    message,
    workspaceRoot,
    target,
    verifyCommand: body.verifyCommand ? String(body.verifyCommand) : null,
    args: agentRuntimeArgs(agentRuntime, await dataRootForAgent(agentRuntime)),
    agentRuntime,
  });
  return {
    ok: result.ok,
    step: result.step,
    decision: result.decision,
    workbenchStatus: buildWorkbenchStatus({ decision: result.decision, session, actionRoute, workflow, blockers: result.blockers || [], warnings: result.warnings || [], runId: result.runId, traceDir: result.traceDir }),
    result,
  };
}

async function listWorkItemSummaries(agentRuntime = null) {
  return listWorkItems({ dataRoot: await dataRootForAgent(agentRuntime), limit: 100 });
}

async function createWorkbenchItem(body = {}, agentRuntime = null) {
  const message = String(body.message || '').trim();
  if (!message) return { ok: false, error: 'message_required' };
  const workspaceRoot = body.workspaceRoot ? String(body.workspaceRoot) : null;
  const action = body.action ? String(body.action) : null;
  const turnPlan = planTurn({ message, action, workspaceContext: { workspaceRoot } });
  const route = await routeRequest({ rootDir: projectRoot, message, workspaceContext: { workspaceRoot }, turnPlan });
  const session = turnPlan.intentFacts?.authoritative
    ? { kind: turnPlan.intentFacts.kind, reason: 'explicit-action' }
    : { kind: 'chat', reason: 'model-owned' };
  const item = await createWorkItem({ dataRoot: await dataRootForAgent(agentRuntime), message, workspaceRoot, title: body.title || null, kind: session.kind, sessionId: body.sessionId || null });
  return { ok: true, item: { ...item, allowedNextSteps: allowedNextSteps(item) }, session };
}

async function runWorkbenchItemStep(id, body = {}, agentRuntime = null) {
  const dataRoot = await dataRootForAgent(agentRuntime);
  const item = await readWorkItem({ dataRoot, id });
  if (!item) return { ok: false, error: 'work_item_not_found' };
  const step = body.step || 'inspect';
  const override = body.override === true;
  const eligibility = workItemEligibility(item, step, { override });
  if (!eligibility.ok) return { ok: false, decision: 'blocked', blockers: eligibility.blockers, allowedNextSteps: eligibility.allowedNextSteps, item };
  const result = await runWorkbenchStep({
    rootDir: projectRoot,
    step,
    message: body.message || item.message,
    workspaceRoot: body.workspaceRoot ? String(body.workspaceRoot) : item.workspaceRoot,
    verifyCommand: body.verifyCommand ? String(body.verifyCommand) : null,
    args: agentRuntimeArgs(agentRuntime, dataRoot),
    agentRuntime,
  });
  const updated = await appendWorkItemStep({ dataRoot, id: item.id, step, result });
  return { ok: result.ok, eligibility, item: updated, stepResult: result };
}

async function archiveWorkbenchItem(id, agentRuntime = null) {
  const item = await archiveWorkItem({ dataRoot: await dataRootForAgent(agentRuntime), id, archived: true });
  if (!item) return { ok: false, error: 'work_item_not_found' };
  return { ok: true, item };
}

async function listSubagentSummaries(agentRuntime = null) {
  const records = await listSubagentRecords({ dataRoot: await dataRootForAgent(agentRuntime), limit: 100 });
  return records.map(subagentVisibilitySummary);
}

const CHILD_LIVE_FINAL_WINDOW_MS = 60 * 60 * 1000;
function visibleChildWorkRecords(records = [], now = Date.now()) {
  return records.filter((item) => {
    if (!item?.final) return true;
    const updatedAt = Date.parse(item.updatedAt || '');
    return Number.isFinite(updatedAt) && now - updatedAt <= CHILD_LIVE_FINAL_WINDOW_MS;
  });
}

async function agentOverview(body = {}) {
  normalizeOverviewBody(body);
  const identities = (await chatIdentities()).agents || [];
  const identitiesByAgentId = new Map(identities.map((identity) => [identity.id, identity]));
  const agents = agentsStore().list({ includeDisabled: true });
  const overview = await Promise.all(agents.map(async (agent) => {
    const sessionId = typeof body.sessions?.[agent.id] === 'string' && body.sessions[agent.id].trim()
      ? body.sessions[agent.id].trim()
      : 'default';
    const base = { agent, identity: identitiesByAgentId.get(agent.id) || null, sessionId, selection: modelsStore().modelSelection(agent.id) };
    if (!agent.enabled) return { ...base, status: { agents: [] }, contexts: {} };
    try {
      const agentRuntime = await resolveAgentRuntime(agent.id);
      const [status, runtime] = await Promise.all([
        agentStatusForSession(sessionId, agentRuntime),
        runtimeConfig(agent.id),
      ]);
      const active = [...activeChatRuns.values()].find((run) => run.agentId === agent.id && run.sessionId === sessionId && !run.controller.signal.aborted) || null;
      const limits = activeConversationLimits({ modelConfig: runtime.modelConfig, contextConfig: runtime.contextConfig });
      const childSessionIds = status.agents
        .filter((item) => item.sessionId !== sessionId)
        .map((item) => item.sessionId)
        .filter(Boolean);
      const { all: sessionIds, hydrated: hydratedSessionIds, truncated } = overviewSessionIds(sessionId, childSessionIds);
      const contextEntries = await Promise.all(hydratedSessionIds.map(async (currentSessionId) => {
        const liveRun = currentSessionId === sessionId ? active : null;
        const context = await inspectSessionContextStatus({ rootDir: projectRoot, dataRoot: agentRuntime.agentWorkspaceRoot, sessionId: currentSessionId, limits, contextConfig: runtime.contextConfig, contextWindow: runtime.modelConfig?.contextWindow, contextTokens: runtime.modelConfig?.contextTokens, liveContext: liveRun?.contextUsage || null });
        return [currentSessionId, context];
      }));
      return {
        ...base,
        status,
        contexts: Object.fromEntries(contextEntries),
        contextHydration: {
          limit: MAX_OVERVIEW_CHILD_CONTEXTS,
          requested: sessionIds.length,
          hydrated: hydratedSessionIds.length,
          truncated,
        },
      };
    } catch (error) {
      return { ...base, status: { agents: [] }, contexts: {}, error: String(error?.message || error) };
    }
  }));
  return { ok: true, agents: overview };
}

async function agentStatusForSession(sessionId = 'default', agentRuntime = null) {
  const records = visibleChildWorkRecords(await listSubagentSummaries(agentRuntime));
  const child = records.find((item) => item.trace?.childSessionId === sessionId);
  const statusFor = (item) => item.status === 'running'
    ? (item.phase === 'streaming' ? 'STREAMING' : item.phase === 'verifying' ? 'VERIFYING' : 'THINKING')
    : item.status === 'succeeded' ? 'DONE'
      : item.status === 'failed' || item.status === 'timed_out' ? 'ERROR'
        : 'IDLE';
  if (child) {
    return {
      sessionId,
      agents: [{
        sessionId,
        parentSessionId: child.owner?.sessionId || null,
        label: child.label || child.purpose || child.id,
        status: statusFor(child),
        since: child.updatedAt || null,
        subagentId: child.id,
      }],
    };
  }
  const children = records
    .filter((item) => item.owner?.sessionId === sessionId && item.trace?.childSessionId)
    .map((item) => ({
      sessionId: item.trace.childSessionId,
      parentSessionId: sessionId,
      label: item.label || item.purpose || item.id,
      status: statusFor(item),
      since: item.updatedAt || null,
      subagentId: item.id,
    }));
  const active = [...activeChatRuns.values()].find((run) => run.agentId === agentRuntime?.agentId && run.sessionId === sessionId && !run.controller.signal.aborted) || null;
  return {
    sessionId,
    agents: [
      { sessionId, parentSessionId: null, label: agentRuntime?.agent?.name || agentRuntime?.agentId || 'Hatchet', status: active ? (active.phase === 'streaming' ? 'STREAMING' : 'THINKING') : 'IDLE', since: active ? new Date().toISOString() : null },
      ...children,
    ],
  };
}

async function continueWorkbenchItem(id, body = {}, agentRuntime = null) {
  const dataRoot = await dataRootForAgent(agentRuntime);
  const item = await readWorkItem({ dataRoot, id });
  if (!item) return { ok: false, error: 'work_item_not_found', backgroundWork: { itemId: id, blockers: ['work_item_not_found'] } };
  const result = await runChatTurnFromWorkbenchContinuation({
    item,
    body,
    rootDir: projectRoot,
    ...(agentRuntime ? { agentRuntime, resolveAgentRuntime } : (await runtimeAgentDataRoot() ? { agentDataRoot: await runtimeAgentDataRoot() } : { dataRoot })),
  });
  return chatTurnResponse(result);
}

function commandText(title, fields = []) {
  return [title, ...fields.filter((field) => field?.[1] !== null && field?.[1] !== undefined).map(([label, value]) => `${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)].join('\n');
}

function redactProviderRequest(value, key = '') {
  if (/authorization|api[-_]?key|token|secret|password/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redactProviderRequest(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactProviderRequest(item, name)]));
  return value;
}

function providerContentChars(message = {}) {
  const value = message?.type === 'function_call_output' ? message.output : message.content;
  const content = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls.reduce((total, call) => total + String(call?.function?.name || '').length + String(call?.function?.arguments || '').length, 0) : 0;
  return content.length + toolCalls;
}

function contextFullText({ request, agentRuntime, sessionId, status }) {
  const body = redactProviderRequest(request.body);
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  const manifest = Array.isArray(request.payload?.providerMessageManifest) ? request.payload.providerMessageManifest : [];
  const messageLines = messages.map((message, index) => {
    const item = manifest[index] || {};
    const role = message?.role || message?.type || 'unknown';
    const source = item.source || 'provider-visible';
    const state = item.status || 'selected';
    return `## ${index + 1}. ${role} — ${source} (${state}; ${providerContentChars(message)} chars)\n\n\`\`\`json\n${JSON.stringify(message, null, 2)}\n\`\`\``;
  });
  const sourceTotals = manifest.reduce((totals, item, index) => {
    const source = item.source || 'provider-visible';
    const current = totals.get(source) || { messages: 0, chars: 0 };
    current.messages += 1; current.chars += providerContentChars(messages[index] || {}); totals.set(source, current); return totals;
  }, new Map());
  const accounting = [...sourceTotals.entries()].map(([source, item]) => `- ${source}: ${item.messages} message${item.messages === 1 ? '' : 's'}, ${item.chars} chars`).join('\n') || '- [No role-structured provider messages]';
  const estimatedTokens = status?.context?.estimatedTokens ?? null;
  const capacityTokens = status?.context?.capacityTokens ?? null;
  return [
    'Context — full running provider context',
    `Agent: ${agentRuntime.agentId}`,
    `Session: ${sessionId}`,
    `Run: ${request.runId}`,
    `Sent: ${request.ts}`,
    `Provider request: ${request.payload?.api || 'unknown'}`,
    `Messages: ${messages.length}`,
    `Provider-visible chars: ${request.payload?.promptChars ?? messages.reduce((total, message) => total + providerContentChars(message), 0)}`,
    `Estimated context tokens: ${estimatedTokens ?? 'unavailable'}${capacityTokens ? ` / ${capacityTokens}` : ''}`,
    '',
    '# accounting', accounting,
    '',
    '# exact role-structured messages sent to the model',
    messageLines.join('\n\n') || '[No role-structured provider messages; inspect the exact transport payload below.]',
    '',
    '# provider request options',
    'These affect provider behavior but are not context messages.',
    `\`\`\`json\n${JSON.stringify(Object.fromEntries(Object.entries(body).filter(([key]) => !['messages', 'input'].includes(key))), null, 2)}\n\`\`\``,
    '',
    '# unavailable from this completed request',
    'Nothing provider-visible is reconstructed or omitted above. Categories absent from the messages were not sent on this request. A future next-turn preview would be a different command and must be labeled as a preview.',
  ].join('\n');
}

function contextMeterLines(context = {}, compaction = {}, memory = {}) {
  return [
    ['Usage', context.percent === null || context.percent === undefined ? 'unknown' : `${context.percent}% (${context.pressure || 'unknown'})`],
    ['Estimated tokens', context.estimatedTokens ?? 'unknown'],
    ...(context.provenance ? [['Context basis', context.provenance]] : []),
    ['Capacity tokens', context.capacityTokens ?? 'unknown'],
    ['Compaction', compaction.active ? 'active' : 'idle'],
    ['Memory source', memory.source || 'none'],
  ];
}

function renderContextInspection({ inspection = {}, status = {}, agentRuntime, model } = {}) {
  const files = inspection.support?.profileFiles?.files || [];
  const profile = files.length ? ['# profile-files', ...files.map((file) => `## ${file.name}\n${file.content || ''}`)].join('\n\n') : '# profile-files\n[No profile files selected]';
  const summary = inspection.priorSummary?.present ? `# prior-conversation-summary\n${inspection.priorSummary.text}` : '# prior-conversation-summary\n[None]';
  const conversation = inspection.recentMessages?.length
    ? ['# conversation', ...inspection.recentMessages.map((message) => `## ${message.role || message.type || 'message'}\n${String(message.content || '')}`)].join('\n\n')
    : '# conversation\n[No retained conversation turns]';
  const meter = status.context || {};
  const continuity = inspection.workingContinuity || {};
  const continuityLines = continuity.scope
    ? ['# working-continuity', `Scope: ${continuity.scope}`, `Selection: ${continuity.reason || 'unknown'}; ${continuity.included?.length || 0}/${continuity.candidateCount || 0} active records included; ${continuity.omittedCount || 0} omitted; ${continuity.chars || 0} chars.`, ...(continuity.included || []).map((item) => `- ${item.id} [${item.kind}/${item.state}] — ${item.selectionReason || 'unknown'}; sources: ${(item.sourceRefs || []).join(', ') || 'none'}; expires: ${item.expiresAt || 'unknown'}`)].join('\n')
    : '# working-continuity\n[No explicit project scope; no ambient STM was included.]';
  return [
    commandText('Context — current reconstruction', [['Agent', agentRuntime.agentId], ['Session', inspection.sessionId], ['Model', model || 'unconfigured'], ...contextMeterLines(meter, status.compaction, { source: inspection.memoryProvenance?.source || 'none' }), ['Selected profile files', files.map((file) => file.name).join(', ') || 'none'], ['Retained conversation turns', inspection.rawRecentTurnCount ?? 0], ['Prior summary', inspection.priorSummary?.present ? `${inspection.priorSummary.chars} chars` : 'none']]),
    'This is the current reconstructible prompt context: selected profile files, retained summary, retained conversation, and the latest receipt-backed Working Continuity projection. STM is local operational context, not current verified evidence. Dynamic request-only support is identified in the runtime receipt but is not replayed here.',
    profile,
    continuityLines,
    summary,
    conversation,
  ].join('\n\n');
}

async function handleChatCommand({ parsed, sessionId, agentRuntime } = {}) {
  if (parsed?.error) return { status: 400, response: chatCommandResponse({ command: null, sessionId, text: `Invalid command.\n\n${chatCommandHelpText()}`, receipt: { error: parsed.error }, ok: false }) };
  if (!parsed?.definition) return { status: 400, response: chatCommandResponse({ command: parsed?.command || null, sessionId, text: `Unknown command: /${parsed?.command || ''}\n\n${chatCommandHelpText()}`, receipt: { error: 'command_unknown' }, ok: false }) };
  if (parsed.args && !(parsed.command === 'context' && parsed.args === 'full')) return { status: 400, response: chatCommandResponse({ command: parsed.command, sessionId, text: `${parsed.definition.usage} does not accept arguments.`, receipt: { error: 'command_arguments_not_supported' }, ok: false }) };
  if (parsed.command === 'help') return { status: 200, response: chatCommandResponse({ command: 'help', sessionId, text: chatCommandHelpText(), receipt: { available: ['help', 'context', 'status', 'new', 'stop'] } }) };
  if (parsed.command === 'new') {
    const active = [...activeChatRuns.values()].find((run) => run.agentId === agentRuntime.agentId && run.sessionId === sessionId && !run.controller.signal.aborted) || null;
    if (active) await cancelChatRun(active.runId, { reason: 'superseded by /new' }, agentRuntime);
    await sessionWriteHandoff({ agentId: agentRuntime.agentId, sessionId, title: `Boundary checkpoint before new conversation: ${sessionId}`, runId: `session-reset-${Date.now()}`, message: `Preserve the useful state from session ${sessionId} before starting a new conversation.` });
    const reset = await resetSession({ rootDir: agentRuntime.agentWorkspaceRoot, sessionId });
    const archive = reset.archivedPath ? (await listResetSessionArchives({ rootDir: agentRuntime.agentWorkspaceRoot, limit: 20 })).find((item) => item.fileName === path.basename(reset.archivedPath)) : null;
    if (archive) await archiveSummaryForReset({ agentId: agentRuntime.agentId, rootDir: agentRuntime.agentWorkspaceRoot, archiveId: archive.id });
    return { status: 200, response: chatCommandResponse({ command: 'new', sessionId, text: 'Started a fresh conversation. Prior history was archived; it was not deleted.', receipt: { conversationId: reset.conversationId, archivedPath: reset.archivedPath || null, resetAt: reset.resetAt || null, ...(active ? { cancelledRunId: active.runId } : {}) } }) };
  }
  if (parsed.command === 'stop') {
    const active = [...activeChatRuns.values()].find((run) => run.agentId === agentRuntime.agentId && run.sessionId === sessionId && !run.controller.signal.aborted) || null;
    if (!active) return { status: 200, response: chatCommandResponse({ command: 'stop', sessionId, text: 'No active run in this session.', receipt: { status: 'idle' } }) };
    const cancelled = await cancelChatRun(active.runId, { reason: 'stopped by /stop' }, agentRuntime);
    return { status: 200, response: chatCommandResponse({ command: 'stop', sessionId, text: `Stopped active run ${active.runId}.`, receipt: cancelled }) };
  }
  const runtime = await runtimeConfig(agentRuntime.agentId);
  const limits = activeConversationLimits({ modelConfig: runtime.modelConfig, contextConfig: runtime.contextConfig });
  const active = [...activeChatRuns.values()].find((run) => run.agentId === agentRuntime.agentId && run.sessionId === sessionId && !run.controller.signal.aborted) || null;
  const status = await inspectSessionContextStatus({ rootDir: projectRoot, dataRoot: agentRuntime.agentWorkspaceRoot, sessionId, limits, contextConfig: runtime.contextConfig, contextWindow: runtime.modelConfig?.contextWindow, contextTokens: runtime.modelConfig?.contextTokens, liveContext: active?.contextUsage || null });
  const context = status.context || {};
  if (parsed.command === 'context') {
    if (parsed.args === 'full') {
      const traceSessionRoot = resolveRuntimeTracePath({ cacheRoot: runtime.runtimeState.cacheRoot, workspaceRoot: runtime.runtimeState.workspaceRoot, agentId: agentRuntime.agentId, sessionId });
      const request = await latestProviderRequest({ traceSessionRoot, sessionId, runId: context.runId || null });
      if (!request) return { status: 404, response: chatCommandResponse({ command: 'context', sessionId, text: 'No full running provider context is available for this session. The selected request may predate persisted request capture.', receipt: { error: 'provider_request_unavailable', runId: context.runId || null }, ok: false }) };
      return { status: 200, response: chatCommandResponse({ command: 'context', sessionId, text: contextFullText({ request, agentRuntime, sessionId, status }), receipt: { mode: 'full', runId: request.runId, sentAt: request.ts, requestId: request.payload?.requestId || null, messageCount: request.payload?.messageCount ?? null, promptChars: request.payload?.promptChars ?? null, bodyChars: request.payload?.bodyChars ?? null, estimatedTokens: context.estimatedTokens ?? null, capacityTokens: context.capacityTokens ?? null } }) };
    }
    const inspection = await inspectSessionContext({ rootDir: projectRoot, dataRoot: agentRuntime.agentWorkspaceRoot, sessionId, limits, includeProfileFiles: true, agentRuntime, contextWindow: runtime.modelConfig?.contextWindow, contextTokens: runtime.modelConfig?.contextTokens });
    return { status: 200, response: chatCommandResponse({ command: 'context', sessionId, text: renderContextInspection({ inspection, status, agentRuntime, model: runtime.modelConfig?.model }), receipt: { context: { estimatedTokens: context.estimatedTokens ?? null, capacityTokens: context.capacityTokens ?? null, percent: context.percent ?? null, pressure: context.pressure ?? 'unknown', source: context.source ?? null }, reconstruction: { profileFiles: inspection.support?.profileFiles?.files?.map((file) => ({ name: file.name, chars: file.chars })) || [], rawRecentTurnCount: inspection.rawRecentTurnCount ?? 0, priorSummaryChars: inspection.priorSummary?.chars ?? 0 }, compaction: { active: Boolean(status.compaction?.active), next: status.compaction?.next || null }, memory: { source: inspection.memoryProvenance?.source || 'none' } } }) };
  }
  return { status: 200, response: chatCommandResponse({ command: 'status', sessionId, text: commandText('Status', [['Agent', agentRuntime.agentId], ['Session', sessionId], ['Model', runtime.modelConfig?.model || 'unconfigured'], ['Model configured', Boolean(runtime.modelConfig?.model)], ['Run', active ? `${active.runId} (${active.phase})` : 'idle'], ...contextMeterLines(context, status.compaction, { source: status.recall?.used ? 'session recall' : 'none' })]), receipt: { agentId: agentRuntime.agentId, model: runtime.modelConfig?.model || null, modelConfigured: Boolean(runtime.modelConfig?.model), activeRun: active ? activeChatRunSummary(active) : null, context, compaction: { active: Boolean(status.compaction?.active), next: status.compaction?.next || null }, memory: { source: status.recall?.used ? 'session recall' : 'none' } } }) };
}

async function handleChat(req, res) {
  const body = validateBoundaryBody('chat', await readJsonBody(req));
  let agentRuntime;
  try {
    agentRuntime = await resolveAgentRuntime(body.agentId);
  } catch (error) {
    return sendJson(res, error?.statusCode || 500, { ok: false, error: String(error?.message || error) });
  }
  const sessionId = String(body.sessionId || 'default');
  return serializeSessionChat({ agentId: agentRuntime.agentId, sessionId, operation: () => handleSerializedChat({ req, res, body, agentRuntime, sessionId }) });
}

async function handleSerializedChat({ req, res, body, agentRuntime, sessionId }) {
  const streaming = acceptsNdjson(req);
  const command = parseChatCommand(body.message);
  if (command) {
    const result = await handleChatCommand({ parsed: command, sessionId, agentRuntime });
    if (streaming) {
      const runId = body.runId ? String(body.runId) : createChatTurnRunId({ sessionId, prefix: 'command' });
      beginNdjson(res);
      writeNdjson(res, { type: result.response.ok ? 'run.completed' : 'run.failed', runId, sessionId, ts: new Date().toISOString(), data: { response: { ...result.response, result: { ...result.response.result, runId } } } });
      return res.end();
    }
    return sendJson(res, result.status, result.response);
  }
  const runId = body.runId ? String(body.runId) : createChatTurnRunId({ sessionId, prefix: 'ui' });
  const controller = new AbortController();
  const record = { agentId: agentRuntime.agentId, runId, sessionId, controller, startedAt: new Date().toISOString(), phase: 'thinking', latestUserMessage: String(body.message || '').trim().slice(0, 16_000), progress: [], contextUsage: null, cancelled: false, reason: null, detached: false };
  const headKey = sessionContinuityHeadKey(agentRuntime.agentId, sessionId);
  sessionContinuityHeads.set(headKey, record);
  activeChatRuns.set(activeChatRunKey(agentRuntime.agentId, runId), record);
  if (streaming) {
    beginNdjson(res);
    writeNdjson(res, { type: 'run.started', runId, sessionId, ts: record.startedAt, data: { command: 'chat' } });
  }
  req.on('close', () => {
    if (!res.writableEnded && !controller.signal.aborted) record.detached = true;
  });
  try {
    const chatBody = await resolveModelConnectionChatBody(body);
    const result = await runChatTurnFromBody({
      body: { ...chatBody, runId, abortSignal: controller.signal },
      rootDir: projectRoot,
      agentRuntime,
      resolveAgentRuntime,
      registerNestedAgentRun: ({ agentRuntime: nestedRuntime, sessionId: nestedSessionId, runId: nestedRunId, message, source, ...a2a }) => registerActiveAgentRun(activeChatRuns, { agentId: nestedRuntime.agentId, sessionId: nestedSessionId, runId: nestedRunId, message, source, a2a: source === 'a2a' ? a2a : null }),
      onTraceRecord: streaming ? (traceRecord) => {
        const progress = publicChatProgress(traceRecord);
        if (progress) {
          const event = { ...progress, runId, sessionId, ts: traceRecord.ts || new Date().toISOString() };
          record.progress = [...record.progress, event].slice(-50);
          writeNdjson(res, event);
        }
      } : null,
      onModelTextDelta: streaming ? ({ delta, totalChars, modelCall }) => {
        record.phase = 'streaming';
        writeNdjson(res, { type: 'assistant.delta', runId, sessionId, ts: new Date().toISOString(), data: { delta, totalChars, modelCall } });
      } : null,
      onModelThoughtDelta: streaming ? ({ delta, totalChars, modelCall }) => {
        record.phase = 'streaming';
        writeNdjson(res, { type: 'assistant.thought', runId, sessionId, ts: new Date().toISOString(), data: { delta, totalChars, modelCall } });
      } : null,
      onModelContextUsage: async (usage) => {
        if (!usage || typeof usage !== 'object') return;
        // Keep every raw measurement in telemetry, while the active card uses
        // a monotonic per-run high-water mark across initial and continuation requests.
        record.contextUsage = updateContextUsageHighWater(record.contextUsage, usage);
        try {
          await appendSessionEntry({
            rootDir: agentRuntime.agentWorkspaceRoot,
            sessionId,
            type: 'event',
            role: null,
            content: 'Provider canonical context measurement updated.',
            runId,
            metadata: { contextMeter: record.contextUsage },
            visibility: 'debug',
            entersPrompt: false,
          });
        } catch {
          // Meter persistence is observational; it must never interrupt a run.
        }
      },
    });
    if (sessionContinuityHeads.get(headKey) !== record) {
      const response = { ok: false, decision: 'superseded', runId, sessionId, blockers: ['superseded_by_newer_session_run'] };
      if (streaming) { writeNdjson(res, { type: 'run.superseded', runId, sessionId, ts: new Date().toISOString(), data: { response } }); return res.end(); }
      return sendJson(res, 409, response);
    }
    const response = chatTurnResponse(result, { ok: result.ok });
    const streamResponse = chatTurnProgressResponse(result, { ok: result.ok });
    if (streaming) { writeNdjson(res, { type: 'run.completed', runId, sessionId, ts: new Date().toISOString(), data: { response: streamResponse } }); return res.end(); }
    return sendJson(res, 200, response);
  } catch (error) {
    const errorResponse = chatTurnErrorResponse(error);
    if (errorResponse) {
      if (streaming) { writeNdjson(res, { type: 'run.failed', runId, sessionId, ts: new Date().toISOString(), data: { response: errorResponse.body } }); return res.end(); }
      return sendJson(res, errorResponse.status, errorResponse.body);
    }
    if (controller.signal.aborted) {
      const response = { ok: false, error: String(record.reason || error?.message || 'agent_stopped'), runId };
      if (streaming) { writeNdjson(res, { type: 'run.cancelled', runId, sessionId, ts: new Date().toISOString(), data: { response } }); return res.end(); }
      return sendJson(res, 499, response);
    }
    if (streaming) { writeNdjson(res, { type: 'run.failed', runId, sessionId, ts: new Date().toISOString(), data: { response: { ok: false, error: String(error?.message || error), runId } } }); return res.end(); }
    throw error;
  } finally {
    if (activeChatRuns.get(activeChatRunKey(agentRuntime.agentId, runId)) === record) activeChatRuns.delete(activeChatRunKey(agentRuntime.agentId, runId));
  }
}

async function startGroupChannelMessage(channelId, body = {}) {
  const rootDir = await runtimeDataRoot();
  const channel = await readGroupChannel({ rootDir, id: channelId });
  if (!channel) return { ok: false, error: 'group_channel_not_found' };
  const message = String(body.message || '').trim();
  if (!message) return { ok: false, error: 'message_required' };
  const requested = Array.isArray(body.agentIds) ? body.agentIds.map(String) : [];
  const participantProfiles = await Promise.all(channel.participantAgentIds.map(async (agentId) => {
    const runtime = await resolveAgentRuntime(agentId);
    return { id: agentId, name: runtime.agent?.name || agentId };
  }));
  const mentions = resolveGroupMentionTargets({ message, participants: participantProfiles });
  if (mentions.unknown.length) return { ok: false, error: 'group_channel_unknown_mentions', mentions: mentions.unknown };
  const mentionTargets = mentions.targets;
  const targetIds = requested.length ? requested : (mentionTargets.length ? mentionTargets : channel.participantAgentIds);
  const targets = targetIds.filter((agentId) => channel.participantAgentIds.includes(agentId));
  if (!targets.length) return { ok: false, error: 'group_channel_targets_required' };
  const operatorTurn = await appendGroupChannelTurn({ rootDir, channelId, role: 'user', content: message, metadata: { sender: 'operator', recipientAgentIds: targets, delivery: requested.length || mentionTargets.length ? 'targeted' : 'broadcast', mentions: mentions.mentions } });
  const room = await readGroupChannelTurns({ rootDir, channelId, limit: 500 });
  const launches = await Promise.all(targets.map(async (agentId) => {
    const agentRuntime = await resolveAgentRuntime(agentId);
    const sessionId = `group-${channelId}`;
    const runId = createChatTurnRunId({ sessionId, prefix: `group-${agentId}` });
    const controller = new AbortController();
    const record = { channelId, agentId, runId, sessionId, controller, startedAt: new Date().toISOString(), phase: 'thinking', cancelled: false, reason: null };
    groupChannelRuns.set(groupChannelRunKey(channelId, agentId, runId), record);
    // Each participant gets its own runtime/session and therefore its own
    // identity, tools, memory scope, and continuity head. The shared channel
    // is only a visible operator transcript.
    void runChatTurnFromBody({
      body: { message, sessionId, runId, abortSignal: controller.signal }, rootDir: projectRoot, agentRuntime, resolveAgentRuntime,
      groupChannelContext: { channelId, channelName: channel.name, turns: room?.turns || [] },
    }).then(async (result) => {
      if (!controller.signal.aborted && result?.answerText) await appendGroupChannelTurn({ rootDir, channelId, role: 'agent', content: result.answerText, runId, metadata: { fromAgentId: agentId, fromAgentName: agentRuntime.agent?.name || agentId, recipient: 'group', participantSessionId: sessionId } });
    }).catch(async (error) => {
      if (!controller.signal.aborted) await appendGroupChannelTurn({ rootDir, channelId, role: 'agent', content: `Request failed: ${String(error?.message || error)}`, runId, metadata: { fromAgentId: agentId, fromAgentName: agentRuntime.agent?.name || agentId, recipient: 'group', participantSessionId: sessionId, failed: true } });
    }).finally(() => groupChannelRuns.delete(groupChannelRunKey(channelId, agentId, runId)));
    return { agentId, runId, sessionId };
  }));
  return { ok: true, channelId, operatorTurn, runs: launches };
}

async function cancelGroupChannelRun(channelId, runId, body = {}) {
  const record = [...groupChannelRuns.values()].find((item) => item.channelId === channelId && item.runId === runId);
  if (!record) return { ok: false, error: 'group_channel_run_not_found', runId };
  record.cancelled = true;
  record.reason = String(body.reason || 'stopped from group channel');
  record.controller.abort(new Error(record.reason));
  return { ok: true, channelId, runId, agentId: record.agentId, status: 'cancelled', reason: record.reason };
}

async function cancelChatRun(runId, body = {}, agentRuntime = null) {
  return cancelActiveChatRun(activeChatRuns, runId, { body, agentId: agentRuntime?.agentId || null });
}

function currentActiveChatRunSummaries({ agentId = null, sessionId = null } = {}) {
  return activeChatRunSummaries(activeChatRuns, { agentId, sessionId });
}

const exportRoute = createExportRoutes({ readJsonBody, sendJson, exportCatalog, normalizeImportRequest, decodeExport, buildExport, exportSnapshot, importPreview, applyImport });
const taskBoardRoute = createTaskBoardRoutes({ readJsonBody, sendJson, validateBoundaryBody, withTaskBoard, taskStatuses: TASK_STATUSES, taskPriorities: TASK_PRIORITIES, executeBoardTask });
const workbenchRoute = createWorkbenchRoutes({ readJsonBody, sendJson, selectedAgentRuntime, dataRootForAgent, listWorkItemSummaries, createWorkbenchItem, readWorkItem, runWorkbenchItemStep, continueWorkbenchItem, archiveWorkbenchItem, workbenchPlan, workbenchRun });
const dreamRoute = createDreamRoutes({ readJsonBody, sendJson, agentDreamSettings, agentDreamDiary, agentDreamMemoryConsolidate, agentDreamCycle });
const settingsRoute = createSettingsRoutes({ readJsonBody, sendJson, modelConnections, claudeCliCredentialStatus, importClaudeCliCredential, startOpenAiOAuthLoginApi, openAiOAuthLoginStatus, submitOpenAiOAuthLoginApi, cancelOpenAiOAuthLoginApi, startClaudeCodeLoginApi, claudeCodeLoginStatus, submitClaudeCodeLoginApi, cancelClaudeCodeLoginApi, importClaudeCodeLoginApi, mcpConnections, discoverMcpConnection, diagnoseMcpConnection, saveMcpConnection, removeMcpConnection, agentMcpTools, saveAgentMcpTools, agentModelSelection, saveAgentModelSelection, archiveSummaryModelSelection: async (agentId) => ({ ok: true, selection: archiveSummarySelection((await resolveAgentRuntime(agentId)).agentId) }), saveArchiveSummaryModelSelection, discoverModelConnection, saveModelConnection, removeModelConnection: (id) => modelsStore().remove(id), setupStatus: async () => readSetupStatus(modelsStore().db), completeSetup: async () => completeSetup(modelsStore().db) });
const agentRoute = createAgentRoutes({ readJsonBody, sendJson, validateBoundaryBody, agentsStore, createAgent, updateAgent, deleteAgent, agentProfileDocuments, selectedAgentRuntime, agentStatusForSession, agentOverview });
const sessionRoute = createSessionRoutes({ rootDir: projectRoot, readJsonBody, sendJson, resolveAgentRuntime, runtimeAgentWorkspaceRoot, runtimeDataRoot, runtimeSessionRoot, runtimeConfig, activeConversationLimits, inspectSessionContext, inspectSessionContextStatus, activeChatRuns, searchSessionEvidence, searchBurrowSessionEvidence, agentsStore, agentRuntimeContext, archiveSessions, archiveSessionDetail, archiveRuns, archiveRunDetail, archiveDreams, archiveDreamDetail, archiveContinuityCards, archiveContinuityCardDetail, listSessions, sessionDetail, exportSessionTranscript, writeSessionMetadata, resetSession, renameSession, archiveSession, forkSession, sessionWriteHandoff, sessionContinuityScope, setSessionContinuityScope, clearSessionContinuityScope, sessionReadHandoff, sessionWriteHandoffCandidate, archiveSummaryForReset, archiveSummaryForSession, latestAuthorityExplanationForSession, listAuthorityExplanationsForSession });
const generalSettingsRoute = createGeneralSettingsRoutes({ readJsonBody, sendJson, chatIdentities, saveChatIdentity, curatorSettings, saveCuratorSettings, tiddleSettings: async (agentId) => tiddleStatus({ agentId, databasePath: settingsDatabasePath() }), tiddleCards: async (query) => listTiddleCards({ ...query, databasePath: settingsDatabasePath() }), tiddleHistory: async (query) => tiddleHistory({ ...query, databasePath: settingsDatabasePath() }), uiAuthSettings, saveUiAuthSettings, executionBoundarySettings, saveExecutionBoundarySettings, retentionPolicySettings, saveRetentionPolicySettings, retentionCleanup });
const observabilityRoute = createObservabilityRoutes({ readJsonBody, sendJson, validateBoundaryBody, runtimeStatus, runtimeMetrics, codexLbAccounts, anthropicOauthUsage, openaiOauthUsage, currentActiveChatRunSummaries, selectedAgentRuntime, resolveAgentRuntime, listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile, listTraces, runtimeConfig, traceRootForRun, summarizeTrace, authorityExplanationFromTraceSummary, projectRoot });
const scheduledChannelRoute = createScheduledChannelRoutes({ readJsonBody, sendJson, validateBoundaryBody, withScheduledJobs, scheduler, listGroupChannels, createGroupChannel, readGroupChannelTurns, groupChannelRuns, startGroupChannelMessage, cancelGroupChannelRun, runtimeDataRoot });
const authRoute = createAuthRoutes({ runtimeConfig, oidcLoginUrl, setOidcStateCookie, completeOidcCallback, sendOidcSessionCookie, clearOidcCookies, oidcCookieClearHeader, oidcSessionFromRequest, sendJson });
const chatRoute = createChatRoutes({ handleChat, readJsonBody, sendJson, selectedAgentRuntime, cancelChatRun });
const mods = await loadMods({
  runtimeRoot: process.env.BURROW_RUNTIME_ROOT || process.env.BURROW_DATA_ROOT || '/mnt/local/burrow',
  databasePath: settingsDatabasePath(),
  executionProviders,
  systemModCapabilities: (() => {
    try { return JSON.parse(process.env.BURROW_SYSTEM_MOD_CAPABILITIES || '{}'); }
    catch { throw new Error('system_mod_capabilities_invalid'); }
  })(),
});
const modRoute = createModRoute({ mods, readJsonBody, sendJson });

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  let responseStatus = null;
  res.once('finish', () => { void serverLogger.event('http_request', { method: req.method || null, path: new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`).pathname, status: responseStatus || res.statusCode, durationMs: Date.now() - startedAt }); });
  req.once('aborted', () => { void serverLogger.event('client_disconnect', { method: req.method || null, path: req.url || null, phase: 'request_aborted', durationMs: Date.now() - startedAt }); });
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
    const origin = `${url.protocol}//${url.host}`;
    if (applyApiCors(req, res, url)) return;
    if (await authRoute({ req, res, url, origin })) return;
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, await runtimeStatus(url.searchParams.get('agentId')));
    if (!(await authorizeRequest(req, res, url))) return;
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (await serveV18Asset(url, res)) return;
      return sendJson(res, 404, { ok: false, error: 'ui_artifact_not_found' });
    }
    if (await modRoute({ req, res, url })) return;
    if (await exportRoute({ req, res, url })) return;
    if (req.method === 'GET' && url.pathname === '/api/openapi.json') {
      const document = JSON.parse(await fs.readFile(path.join(sourceRoot, 'docs', 'openapi.json'), 'utf8'));
      return sendJson(res, 200, document);
    }
    if (req.method === 'GET' && url.pathname === '/api/docs') {
      const html = `<!doctype html><html><head><title>Burrow API</title><meta charset="utf-8" /><link rel="stylesheet" href="/api/docs/scalar.css" /></head><body><script id="api-reference" data-configuration="${JSON.stringify({ url: '/api/openapi.json', theme: 'purple' }).replace(/"/g, '&quot;')}"></script><script src="/api/docs/scalar.js"></script></body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/docs/')) {
      const asset = url.pathname.slice('/api/docs/'.length);
      const filePath = path.join(apiDocsRoot, path.normalize(asset));
      const relative = path.relative(apiDocsRoot, filePath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return sendJson(res, 404, { ok: false, error: 'not_found' });
      try { return await sendStaticFile(res, filePath); } catch (error) { if (error?.code === 'ENOENT') return sendJson(res, 404, { ok: false, error: 'not_found' }); throw error; }
    }
    if (req.method === 'GET' && url.pathname === '/api/attachments') {
      const agentRuntime = await resolveAgentRuntime(url.searchParams.get('agentId'));
      const sessionId = url.searchParams.get('sessionId') || 'default';
      const turns = await readSessionTurns({ rootDir: agentRuntime.agentWorkspaceRoot, sessionId, limit: 500, includeHistory: true });
      return sendJson(res, 200, { ok: true, agentId: agentRuntime.agentId, sessionId, attachments: await listSessionAttachments({ agentWorkspaceRoot: agentRuntime.agentWorkspaceRoot, sessionTurns: turns, sessionId, limit: url.searchParams.get('limit') || 200 }) });
    }
    if (url.pathname.startsWith('/api/attachments/')) {
      const parts = url.pathname.slice('/api/attachments/'.length).split('/').map(decodeURIComponent);
      const [agentId, ...artifactParts] = parts;
      const artifactPath = artifactParts.join('/');
      if (!agentId || !artifactPath) return sendJson(res, 400, { ok: false, error: 'attachment_target_required' });
      const agentRuntime = await resolveAgentRuntime(agentId);
      if (req.method === 'GET') {
        const artifact = await resolveAttachmentArtifact({ agentWorkspaceRoot: agentRuntime.agentWorkspaceRoot, artifactPath });
        if (!artifact) return sendJson(res, 404, { ok: false, error: 'attachment_not_found' });
        return sendStaticFile(res, artifact.filePath, { downloadName: path.basename(artifact.filePath).replace(/^\d{4}-\d{2}-\d{2}T[^-]+-\d+-/, '') });
      }
      if (req.method === 'DELETE') return sendJson(res, 200, await deleteAttachmentArtifact({ agentWorkspaceRoot: agentRuntime.agentWorkspaceRoot, artifactPath }));
    }
    if (await observabilityRoute({ req, res, url })) return;
    if (await agentRoute({ req, res, url })) return;
    if (await sessionRoute({ req, res, url })) return;
    if (await generalSettingsRoute({ req, res, url })) return;
    if (await dreamRoute({ req, res, url })) return;
    if (await settingsRoute({ req, res, url })) return;
    if (req.method === 'GET' && url.pathname === '/api/memory/brain-promotion-candidates') return sendJson(res, 200, await brainPromotionCandidates(Object.fromEntries(url.searchParams)));
    if (req.method === 'PATCH' && url.pathname === '/api/memory/brain-promotion-candidates') return sendJson(res, 200, await updateBrainPromotionCandidate(await readJsonBody(req)));
    if (await scheduledChannelRoute({ req, res, url })) return;
    if (await taskBoardRoute({ req, res, url })) return;
    if (await workbenchRoute({ req, res, url })) return;
    if (await chatRoute({ req, res, url })) return;
    return sendJson(res, 404, { ok: false, error: 'not_found' });
  } catch (error) {
    const status = Number(error?.statusCode) >= 400 && Number(error.statusCode) < 500 ? Number(error.statusCode) : 500;
    void serverLogger.event('request_error', { method: req.method || null, path: req.url || null, status, error: String(error?.message || error), durationMs: Date.now() - startedAt });
    return sendJson(res, status, { ok: false, error: String(error?.message || error), ...(error?.details ? { details: error.details } : {}), stack: process.env.NODE_ENV === 'development' ? error?.stack : undefined });
  }
});

let shuttingDown = false;
const SHUTDOWN_DRAIN_MS = Math.max(1_000, Number(process.env.BURROW_SHUTDOWN_DRAIN_MS || 10_000));
async function shutdownRuntime(signal, { exitCode = signal === 'SIGINT' ? 130 : signal === 'unhandledRejection' ? 1 : 0 } = {}) {
  if (shuttingDown) return;
  shuttingDown = true; let forced = false;
  try {
    await serverLogger.event('shutdown_started', { signal, activeRuns: activeChatRuns.size });
    const closePromise = new Promise((resolve) => server.close(() => resolve()));
    await recordActiveRunInterruptions({ activeRuns: activeChatRuns, resolveAgentRuntime, reason: signal === 'SIGINT' ? 'service_interrupt' : 'service_shutdown' });
    server.closeIdleConnections?.();
    await Promise.race([closePromise, new Promise((resolve) => setTimeout(() => { forced = true; server.closeAllConnections?.(); resolve(); }, SHUTDOWN_DRAIN_MS))]);
    await cleanupMods(mods);
    await serverLogger.event('shutdown_complete', { signal, forced, drainMs: SHUTDOWN_DRAIN_MS });
  } catch (error) {
    await serverLogger.event('shutdown_error', { signal, error: String(error?.message || error) });
    console.error(`Burrow shutdown recovery failed: ${String(error?.message || error)}`); exitCode = exitCode || 1;
  } finally { await serverLogger.flush().catch(() => {}); process.exit(exitCode); }
}
process.once('uncaughtException', (error) => { void serverLogger.event('uncaught_exception', { error: String(error?.stack || error) }).finally(() => shutdownRuntime('uncaughtException', { exitCode: 1 })); });
process.once('unhandledRejection', (error) => { void serverLogger.event('unhandled_rejection', { error: String(error?.stack || error) }).finally(() => shutdownRuntime('unhandledRejection', { exitCode: 1 })); });
process.once('SIGTERM', () => { void shutdownRuntime('SIGTERM'); });
process.once('SIGINT', () => { void shutdownRuntime('SIGINT'); });

// A duplicate launcher/service must not become an unhandled EventEmitter
// exception that buries the actual bind conflict in a Node stack trace.
server.once('error', (error) => {
  const code = String(error?.code || 'server_error');
  const detail = code === 'EADDRINUSE'
    ? `Burrow UI could not bind ${host}:${port}: address already in use.`
    : `Burrow UI failed to listen on ${host}:${port}: ${String(error?.message || error)}`;
  void serverLogger.event('listener_error', { code, host, port, error: String(error?.message || error) }).finally(() => { console.error(detail); process.exit(1); });
});

server.on('clientError', (error, socket) => { void serverLogger.event('client_error', { code: error?.code || null, error: String(error?.message || error), remoteAddress: socket?.remoteAddress || null }); socket?.destroy(); });
server.on('connection', (socket) => { socket.once('error', (error) => { void serverLogger.event('socket_error', { code: error?.code || null, error: String(error?.message || error), remoteAddress: socket.remoteAddress || null }); }); });
server.listen(port, host, async () => {
  await serverLogger.event('listener_started', { host, port, pid: process.pid, version: releaseVersion });
  if (backgroundSchedulersEnabled()) {
    const store = new ScheduledJobStore({ databasePath: settingsDatabasePath() });
    try { store.markMissedRuns(); store.markMissedSchedules(); } finally { store.close(); }
    await scheduler().start();
    await dreamScheduler().start();
    await rollingContinuityScheduler().start();
    await attachmentScheduler().start();
    await retentionPolicyScheduler().start();
    await installerStagingScheduler().start();
    startCodexClientVersionRefresh();
  }
  console.log(`Burrow UI listening on http://${host}:${port}`);
  // Recovery uses the same durable per-session queue and runtime turn path as
  // ordinary chat. It starts only after the listener is live, and a queue claim
  // prevents duplicate recovery when startup is retried.
  void runPendingRecoveryContinuations({
    agentRuntimes: await Promise.all(agentsStore().list({ includeDisabled: false }).map((agent) => resolveAgentRuntime(agent.id))),
    createRunId: createChatTurnRunId,
    runContinuation: async ({ runtime, sessionId, runId, manifest, continuation }) => {
      const recoveryInstruction = continuation?.decision === 'resume'
        ? 'Continue the interrupted work using the runtime recovery record and bounded same-session transcript.'
        : 'Recover the interrupted work using the runtime recovery record. Reconcile durable state before acting; do not repeat completed work blindly.';
      const lifecycle = registerActiveAgentRun(activeChatRuns, { agentId: runtime.agentId, sessionId, runId, message: `Recover interrupted run: ${manifest.objective || 'reconcile durable state'}`, source: 'recovery' });
      try {
        return await runChatTurnFromBody({
          body: { message: recoveryInstruction, sessionId, runId, abortSignal: lifecycle.signal },
          rootDir: projectRoot, agentRuntime: runtime, resolveAgentRuntime,
          onTraceRecord: lifecycle.onTraceRecord, onModelTextDelta: lifecycle.onModelTextDelta,
          onModelThoughtDelta: lifecycle.onModelThoughtDelta, onModelContextUsage: lifecycle.onModelContextUsage,
          registerNestedAgentRun: ({ agentRuntime: nestedRuntime, sessionId: nestedSessionId, runId: nestedRunId, message, source, ...a2a }) => registerActiveAgentRun(activeChatRuns, { agentId: nestedRuntime.agentId, sessionId: nestedSessionId, runId: nestedRunId, message, source, a2a: source === 'a2a' ? a2a : null }),
        });
      } finally { lifecycle.finish(); }
    },
  }).catch((error) => console.error(`Burrow recovery startup failed: ${String(error?.message || error)}`));
});
