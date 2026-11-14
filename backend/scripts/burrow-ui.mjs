#!/usr/bin/env node
import { classifyModelFailure, withProviderErrorScope } from '../src/model-failure.mjs';
import { httpFailureResponse, postgresDiagnosticSecrets, otelDiagnosticSecrets } from './ui/http-error-response.mjs';
import { uiPreferences, saveUiPreferences } from '../src/ui-preferences.mjs';
import { createImportExportApplication } from './ui/import-export-application.mjs';
import { createModelConnectionService } from './ui/model-connection-service.mjs';
import { createMcpConnectionService } from './ui/mcp-connection-service.mjs';
import { createChatSessionService, publicChatProgress } from './ui/chat-session-service.mjs';
import { createModLifecycleService } from './ui/mod-lifecycle-service.mjs';
import { createPostgresOpenAiResetStore } from '../src/postgres-openai-reset-store.mjs';
import { startOpenAiResetScheduler } from '../src/openai-reset-scheduler.mjs';
import { activeSessionDetail } from './ui/active-session-detail.mjs';
import { assertModAgentAvailable } from '../src/mod-agent-runtime.mjs';
import { createAgentReferenceImageRoutes, createModReferenceImageContentRoute, createOperatorReferenceImageRoutes } from './ui/agent-reference-image-routes.mjs';
import { createBoardTaskExecutor } from '../src/task-execution.mjs';

import { compactChatTurn } from '../src/compact-chat-turn.mjs';
import { createArchiveReadProcess } from './ui/archive-read-process.mjs';
import { createArchiveAgentContext } from './ui/archive-agent-context.mjs';
import { createChatInputRunner } from '../src/chat-input-runner.mjs';
import { createChatInputService } from '../src/chat-input-service.mjs';
import { createCompletionEventSettings } from '../src/completion-event-settings.mjs';
import { createCompletionEventRunner } from '../src/completion-event-runner.mjs';
import { createCompletionEventRoutes } from './ui/completion-event-routes.mjs';
import { createDreamMemoryPreviewService } from '../src/dream-memory-preview.mjs';

import { isInternalContextSession } from '../src/model-context-boundary.mjs';
import { createModGenerationDispatcher } from '../src/mod-generations.mjs';
import { createModTextGenerator } from '../src/mod-capabilities.mjs';
import { migrateLegacyExecutionProviderApproval } from '../src/execution-provider-approval.mjs';
import { createCoreApiDispatcher, coreApiCaller } from '../src/core-api-dispatch.mjs';
import { createModAuthority, createModAuthorityRoute } from '../src/mod-authority.mjs';
import { createProviderUsageService } from '../src/provider-usage-service.mjs';
import { createBackgroundLifecycle, createCoordinatedShutdown } from '../src/background-lifecycle.mjs';
import { SkillGitSync } from '../src/skill-git-sync.mjs';
import { createSkillSourceRoutes } from './ui/skill-source-routes.mjs';

import { applyModelRecoveryProgress } from '../src/model-recovery-projection.mjs';

import { createBrainRoutes } from './ui/brain-routes.mjs';
import { createArchiveService } from './ui/archive-service.mjs';
import { completeSetupOperation } from '../src/setup-operation.mjs';
import { createGroupChannelMessageStarter } from '../src/group-channel-message.mjs';
import { buildIdentity } from './build-identity.mjs';
import { releaseProvenance } from './release-provenance.mjs';
import { httpAuthorityConfig, hostAuthorityPolicy } from '../src/http-authority.mjs';
import { browserOriginConfig, browserRequestPolicy } from '../src/browser-origin-policy.mjs';
import { browserTabSettings, saveBrowserTabSettings } from '../src/browser-tab-settings.mjs';
import { otelSettings, readOtelRuntimeConfig, saveOtelSettings } from '../src/otel-settings.mjs';
import { createReconfigurableOtelRuntime } from '../src/otel-runtime.mjs';
import { artifactResponseHeaders } from '../src/artifact-response-policy.mjs';
import { postgresConfig } from '../src/postgres-foundation.mjs';
import { acquirePostgresRuntimeOwnership } from '../src/postgres-runtime-ownership.mjs';
import { readJsonBody } from '../src/request-resource-budgets.mjs';
import { operatorTimezone, saveOperatorTimezone } from '../src/timezone.mjs';
import { ensureDefaultGlobalWorkspace } from '../src/runtime-workspace-defaults.mjs';

import { diagnosticMods, modJobs, pendingModOperations } from '../src/mod-diagnostics.mjs';
import { forgeDiagnosticJobs, forgeDiagnosticJob, postgresDiagnostic } from '../src/forge-diagnostic-summary.mjs';
import { brainDiagnosticSummary, brainDiagnosticMemories, brainDiagnosticEmbeddingJobs } from '../src/brain-diagnostic-summary.mjs';
import { runtimeDiagnosticSessionSummaries } from '../src/runtime-diagnostic-sessions.mjs';
import { runtimeDiagnosticSessionDetail, runtimeDiagnosticContextSummary, runtimeDiagnosticActiveRuns, runtimeDiagnosticTraces } from '../src/runtime-diagnostic-details.mjs';
import { releaseVersion } from '../src/release-version.mjs';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSessionContext, inspectSessionContextStatus } from '../src/context-engine.mjs';

import { serializeSessionExecution } from '../src/app-runtime.mjs';

import { activeConversationLimits } from '../src/context-preparation.mjs';
import { createChatTurnRunId, runChatTurnFromBody, runChatTurnFromWorkbenchContinuation, chatTurnResponse, loadRuntimeConfig } from '../src/chat-turn-controller.mjs';
import { resolveModelConfig, resolveRuntimeTracePath, resolveRuntimeTraceRoot } from '../src/config.mjs';
import { API_TOKEN_SCOPES } from '../src/api-token-store.mjs';
import { loadEffectiveSkillCatalog, skillManifest } from '../src/skill-catalog.mjs';
import { collectTraceObservability } from '../src/trace-observability.mjs';
import { listSubagentRecords, subagentVisibilitySummary } from '../src/subagent-store.mjs';
import { readMinionSettings } from '../src/minion-depth.mjs';
import { projectSubagentTree, sessionMinionAncestry } from '../src/subagent-projection.mjs';
import { buildContinuityHandoff } from '../src/continuity-handoff-store.mjs';
import { createRecoveryContinuationScheduler } from '../src/recovery-continuation-runner.mjs';
import { recordActiveRunInterruptions } from '../src/interrupted-run-recovery.mjs';

import { generateArchiveSummary } from '../src/archive-summary.mjs';
import { loadWorkingContinuityAsync, normalizeContinuityScope, projectHandoffsIntoWorkingContinuity } from '../src/working-memory-continuity.mjs';
import { workingContextFromSession } from '../src/working-context.mjs';
import { createGroupChannel, listGroupChannels, readGroupChannelTurns } from '../src/group-channel-store.mjs';
import { runRetentionCleanup } from '../src/retention.mjs';
import { normalizeRetentionPolicy, readRetentionPolicy, readRetentionPolicyState, retentionPolicyFailureState, retentionPolicySuccessState, saveRetentionPolicy, writeRetentionPolicyState } from '../src/retention-settings.mjs';
import { createRetentionScheduler } from '../src/retention-scheduler.mjs';
import { createInstallStagingCleanupScheduler } from '../src/install-staging-cleanup.mjs';
import { authorityExplanationFromTraceSummary, latestAuthorityExplanationForSession, listAuthorityExplanationsForSession, summarizeTrace, validTraceRunId } from '../src/trace-summary.mjs';
import { planTurn } from '../src/turn-planner.mjs';
import { workbenchWorkflow } from '../src/workbench-workflow.mjs';
import { runWorkbenchStep } from '../src/workbench-runner.mjs';
import { createExecutionProviderRegistry } from '../src/process-execution-router.mjs';
import { buildWorkbenchStatus } from '../src/workbench-status.mjs';
import { allowedNextSteps, appendWorkItemStep, archiveWorkItem, createWorkItem, listWorkItems, readWorkItem, workItemEligibility } from '../src/work-item-store.mjs';
import { searchBurrowSessionEvidence, searchSessionEvidence } from '../src/session-search.mjs';
import { CODEX_CLIENT_VERSION_CACHE_TTL_MS, refreshCodexClientVersionCache } from '../src/model-settings-store.mjs';

import { curatorRoot, curatorRuntimeStatus, saveCuratorSelection } from '../src/curator-runtime.mjs';
import { agentRuntimeContext, ensureAgentRoots } from '../src/agent-registry.mjs';

import { consolidateDreamMemoryAsync } from '../src/dream-memory-consolidator.mjs';
import { createDreamCycleScheduler, runDreamCycle } from '../src/dream-cycle-runner.mjs';
import { createTiddleScheduler, listTiddleCards, tiddleHistory, tiddleStatus } from '../src/tiddle-continuity.mjs';
import { cleanupAgentAttachments, deleteAttachmentArtifact, listSessionAttachments, resolveAttachmentArtifact } from '../src/attachment-store.mjs';
import { resolveGeneratedArtifact } from '../src/generated-artifact-store.mjs';
import { TASK_PRIORITIES, TASK_STATUSES } from '../src/task-board-store.mjs';
import { createScheduledJobScheduler } from '../src/scheduled-job-scheduler.mjs';
import { createModExternalTurnDispatcher } from '../src/mod-external-turns.mjs';
import { backgroundSchedulersEnabled } from '../src/background-scheduler-policy.mjs';
import { configureMcpProviderStateStore, hydrateMcpProviderStates } from '../src/mcporter-adapter.mjs';
import { createRuntimeMetricsCollector } from '../src/runtime-metrics.mjs';
import { createRuntimeServerLogger, safeOperationalError } from '../src/runtime-server-log.mjs';
import { operationalEvent } from '../src/operational-log.mjs';
import { instrumentHttpResponse, correlateHttpRun, recordHttpFailure, observeHttpResult, observeHttpRunEvent, observeModelRecovery, createCatalogRefreshDiagnostics } from '../src/http-operational-log.mjs';
import { BASIC_SESSION_COOKIE, basicCredentials, parseCookieHeader, setBasicSessionCookie, verifyBasicSessionCookie, verifyScryptPassword, createUiAuthService } from '../src/ui-auth-service.mjs';
import { logAuthFailure, startAuthLoginTelemetry, observeAuthEnvironmentOverride } from '../src/ui-auth-diagnostics.mjs';
import { latestProviderRequest } from '../src/provider-request-inspection.mjs';
import { contextReport } from '../src/context-report.mjs';

import { createAgentRunCompletionDispatch } from '../src/agent-run-completion-dispatch.mjs';
import { activeChatRunKey, activeChatRunSummary } from '../src/active-chat-runs.mjs';

import { executionBoundaryStatus, readExecutionBoundaries, saveExecutionBoundaries } from '../src/execution-boundaries.mjs';
import { clearOidcCookies, completeOidcCallback, oidcCookieClearHeader, oidcLoginUrl, oidcSessionFromRequest, sendOidcSessionCookie, setOidcStateCookie } from '../src/ui-oidc-auth.mjs';
import { buildExport, decodeExport, exportCatalog, normalizeImportRequest } from '../src/export-service.mjs';
import { createExportRoutes } from './ui/export-routes.mjs';
import { createTaskBoardRoutes } from './ui/task-board-routes.mjs';
import { createWorkbenchRoutes } from './ui/workbench-routes.mjs';
import { configureForgeStoreFactory } from '../src/forge-agent-tools.mjs';
import { createPostgresApplication } from '../src/postgres-composition.mjs';
import { settingsKeyFromEnvironment } from '../src/settings-key.mjs';
import { createForgeRoutes } from './ui/forge-routes.mjs';
import { createDreamRoutes } from './ui/dream-routes.mjs';
import { createSettingsRoutes } from './ui/settings-routes.mjs';
import { createAgentRoutes } from './ui/agent-routes.mjs';
import { createSessionRoutes } from './ui/session-routes.mjs';
import { createGeneralSettingsRoutes } from './ui/general-settings-routes.mjs';
import { createObservabilityRoutes } from './ui/observability-routes.mjs';
import { createScheduledChannelRoutes } from './ui/scheduled-channel-routes.mjs';
import { createAuthRoutes } from './ui/auth-routes.mjs';
import { createChatRoutes } from './ui/chat-routes.mjs';
import { cleanupMods, createModRoute, discoverMods } from '../src/mod-runtime.mjs';
import { inspectManagedSkills } from '../src/managed-skills.mjs';
import { createModManagement } from '../src/mod-management.mjs';
import { createModDistribution, createModManagementRoute } from '../src/mod-distribution.mjs';
import { listSecretReferences, resolveSecretReference } from '../src/secret-references.mjs';
import { MAX_OVERVIEW_CHILD_CONTEXTS, normalizeOverviewBody, overviewSessionIds } from '../src/agent-overview.mjs';

function isChatMessage(entry) {
  return entry?.type === 'message' && ['user', 'assistant', 'agent'].includes(String(entry?.role || ''))
    && entry?.visibility === 'chat' && entry?.entersPrompt === true
    && Boolean(String(entry?.content || '').trim() || (Array.isArray(entry?.metadata?.attachments) && entry.metadata.attachments.length));
}

function summarizeSessionTurns(turns = [], { maxChars = 4000 } = {}) {
  const rendered = (turns || []).map((turn) => turn.role === 'agent'
    ? `[Agent message from ${turn.metadata?.fromAgentName || turn.metadata?.fromAgentId || 'another agent'}]: ${turn.content}`
    : `${turn.role}: ${turn.content}`).join('\n\n').trim();
  if (!rendered || !Number.isFinite(maxChars) || rendered.length <= maxChars) return rendered;
  const markerFor = (omitted) => `\n\n[truncated ${omitted} chars from earlier session turns]`;
  let retainedChars = Math.max(0, maxChars - markerFor(0).length);
  let retained = rendered.slice(Math.max(0, rendered.length - retainedChars)).trim();
  for (let index = 0; index < 3; index += 1) {
    const marker = markerFor(rendered.length - retained.length);
    retainedChars = Math.max(0, maxChars - marker.length);
    retained = rendered.slice(Math.max(0, rendered.length - retainedChars)).trim();
  }
  return `${retained}${markerFor(rendered.length - retained.length)}`;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, '..');
const runtimeRoot = process.env.BURROW_RUNTIME_ROOT || process.env.BURROW_DATA_ROOT || '/mnt/local/burrow';
// PostgreSQL owns server persistence; startup fails if composition is unavailable.
const serverLogger = createRuntimeServerLogger({ runtimeRoot });
// Install before awaited composition/startup, not only after a listener exists.
// Early startup cannot safely call the resource drain before its consts exist.
let runtimeShutdownHandler = null;
function fatalRuntimeFailure(event, signal, error) {
  void serverLogger.event(event, { error: safeOperationalError(error) }, { level: 'fatal' }).finally(async () => {
    if (runtimeShutdownHandler) return runtimeShutdownHandler(signal, { exitCode: 1 });
    await serverLogger.flush().catch(() => {});
    process.exit(1);
  });
}
process.once('uncaughtException', error => fatalRuntimeFailure('uncaught_exception', 'uncaughtException', error));
process.once('unhandledRejection', error => fatalRuntimeFailure('unhandled_rejection', 'unhandledRejection', error));
const healthBuildIdentity = await buildIdentity(sourceRoot);
const healthReleaseProvenance = await releaseProvenance(sourceRoot);
const projectRoot = path.resolve(process.env.BURROW_SOURCE_ROOT || sourceRoot);
const uiDistRoot = path.join(projectRoot, 'public', 'ui');
const apiDocsRoot = path.join(sourceRoot, 'public', 'api-docs');
const port = Number(process.env.BURROW_UI_PORT || process.argv.find((arg) => arg.startsWith('--port='))?.split('=')[1] || 42817);
const host = process.env.BURROW_UI_HOST || '0.0.0.0';
const configuredRunCancellationGraceMs = Number(process.env.BURROW_RUN_CANCELLATION_GRACE_MS || 5_000);
const RUN_CANCELLATION_GRACE_MS = Number.isFinite(configuredRunCancellationGraceMs) ? Math.max(1_000, configuredRunCancellationGraceMs) : 5_000;
const authorityConfig = httpAuthorityConfig({ host, port });
browserOriginConfig(); // Validate optional environment override at startup.
let completionDispatch = null;
const executionProviders = createExecutionProviderRegistry();
const groupChannelRuns = new Map();
let scheduledJobScheduler = null;
let dreamCycleScheduler = null;
let tiddleScheduler = null;
let retentionScheduler = null;
let installStagingCleanupScheduler = null;
let recoveryContinuationScheduler = null;
const traceStatusCache = new Map();
const TRACE_STATUS_CACHE_MS = 30_000;
const OPENAI_OAUTH_USAGE_URL = process.env.BURROW_OPENAI_OAUTH_USAGE_URL || 'https://chatgpt.com/backend-api/wham/usage';
const requestLifecycle = createBackgroundLifecycle({ name: 'runtime_request', logger: serverLogger });
const runtimePostgresConfig = postgresConfig();
// Acquire before composition starts any producers, and before orphan repair.
// Keep the dedicated session through shutdown and store teardown until exit.
let runtimeOwnership;
try { runtimeOwnership = await acquirePostgresRuntimeOwnership({ config: runtimePostgresConfig }); }
catch (error) { await serverLogger.event('startup_ownership_failed', { reason: String(error?.message || '').startsWith('runtime_database_already_owned:') ? 'runtime_database_already_owned' : 'runtime_database_ownership_failed', error }, { level: 'fatal', component: 'postgres' }); await serverLogger.flush(); process.exit(1); }
const postgresApplication = await createPostgresApplication({
  poolConfig: runtimePostgresConfig,
  logger: serverLogger,
  encryptionKey: settingsKeyFromEnvironment(),
  runtimeRoot,
  resolveAgent: async (agentId) => resolveAgentRuntime(agentId),
  resolveOperator: async () => ({ operatorId: 'operator', agentWorkspaceRoot: runtimeRoot }),
  connections: async (filter) => postgresApplication.stores.models.list(filter),
  resolveConfig: (connectionId, modelId) => resolveModelConfig({ stores: postgresApplication.stores, modelConnectionId: connectionId, model: modelId }),
});
const { anthropicOauthUsage, openaiOauthUsage, openaiResetCredits, consumeOpenaiResetCredit, pollExpiringResets } = createProviderUsageService({ modelLookup: modelsStore, authSecretToken, fetchImpl: globalThis.fetch, clock: Date.now,
  resetStore: createPostgresOpenAiResetStore(modelsStore().pool), openaiUsageUrl: OPENAI_OAUTH_USAGE_URL });
await serverLogger.event('database_ready', {}, { component: 'postgres' });
configureMcpProviderStateStore(postgresApplication.stores.mcpProviderStates, { logger: serverLogger });
await hydrateMcpProviderStates({ runtimeRoot: process.env.BURROW_MCPORTER_ROOT || path.join(runtimeRoot, 'integrations', 'mcporter') }).catch(() => serverLogger.event('mcp_provider_state_hydration_failed', { errorCode: 'mcp_provider_state_hydration_failed' }, { level: 'warn', component: 'mcp' }));
const runtimeMetrics = createRuntimeMetricsCollector({ runtimeRoot });
const otelRuntime = createReconfigurableOtelRuntime({ serviceVersion: releaseVersion, logger: serverLogger });
await otelRuntime.apply(await readOtelRuntimeConfig({ store: postgresApplication.stores.opentelemetry, metadata: postgresApplication.stores.metadata }));
await runtimeConfig();
await runtimeOwnership.reconcileModJobs(postgresApplication.stores);
const generationDispatcher = createModGenerationDispatcher({ logger: serverLogger, store: postgresApplication.stores.generations, generateText: createModTextGenerator({ models: postgresApplication.stores.models }) });
const {
  modelConnections, startClaudeCodeLoginApi, claudeCodeLoginStatus,
  submitClaudeCodeLoginApi, cancelClaudeCodeLoginApi, importClaudeCodeLoginApi,
  startOpenAiOAuthLoginApi, openAiOAuthLoginStatus, submitOpenAiOAuthLoginApi,
  cancelOpenAiOAuthLoginApi, claudeCliCredentialStatus, importClaudeCliCredential,
  agentModelSelection, saveAgentModelSelection, agentMinionModelSelection,
  saveAgentMinionModelSelection, agentMinionSettings, saveAgentMinionSettings,
  chatIdentities, saveChatIdentity, discoverModelConnection, saveModelConnection,
  resolveModelConnectionChatBody,
} = createModelConnectionService({ modelsStore, metadataStore, resolveAgentRuntime,
  logger: serverLogger, runtimeRoot: process.env.BURROW_RUNTIME_ROOT || path.dirname(projectRoot), projectRoot });
const {
  mcpConnections, saveMcpConnection, removeMcpConnection, discoverMcpConnection,
  diagnoseMcpConnection, agentMcpTools, saveAgentMcpTools,
} = createMcpConnectionService({ mcpStore, resolveAgentRuntime, logger: serverLogger });
const chatSession = createChatSessionService({
  runtime: { projectRoot, postgresApplication, requestLifecycle, resolveAgentRuntime,
    resolveModelConnectionChatBody, runChatTurnFromBody, serializeSessionExecution,
    telemetry: otelRuntime, logger: serverLogger, getCompletionDispatch: () => completionDispatch,
    cancellationGraceMs: RUN_CANCELLATION_GRACE_MS },
  http: { readJsonBody, validateBoundaryBody, sendJson, correlateHttpRun, recordHttpFailure,
    observeHttpResult, observeHttpRunEvent },
  commands: { runtimeConfig, activeConversationLimits, inspectSessionContextStatus,
    latestProviderRequest, contextReport, commandText, contextMeterLines },
  sessions: { sessionWriteHandoff, archiveSummaryForReset },
  observability: { agentsStore, resolveAgentContext, listSubagentSummaries, readMinionSettings, metadataStore },
  runPolicy: { onActiveRunRemoved: () => completionDispatch?.activityChanged() },
});
const { activeChatRuns, sessionContinuityHeads, serializeSessionChat, sessionContinuityHeadKey,
  registerRuntimeActiveRun, retireCancelledRun, handleChat, cancelChatRun, supersedeSessionRuns,
  beginSessionAdmissionsReset, finishSessionAdmissionsReset, steerChatRun, listChatSteering,
  currentActiveChatRunSummaries } = chatSession;
const chatInputRunner = createChatInputRunner({ store: postgresApplication.stores.chatInputs, stores: postgresApplication.stores,
  resolveAgentRuntime, rootDir: projectRoot, registerActiveRun: registerRuntimeActiveRun, telemetry: otelRuntime,
  requestRecovery: () => recoveryContinuationScheduler?.wake() || Promise.resolve(),
  admitMain: (job, operation, signal) => serializeSessionChat({ ...job, operation, signal }),
});
chatSession.configureChatInputRunner(chatInputRunner);
const chatInputs = createChatInputService({ stores: postgresApplication.stores, activeRuns: activeChatRuns, runner: chatInputRunner, resolveAgentRuntime });
const completionEventRunner = createCompletionEventRunner({ store: postgresApplication.stores.completionEvents, stores: postgresApplication.stores, resolveAgentRuntime, rootDir: projectRoot, registerActiveRun: registerRuntimeActiveRun, telemetry: otelRuntime });
const externalTurnDispatcher = createModExternalTurnDispatcher({ logger: serverLogger, store: postgresApplication.stores.externalTurns, stores: postgresApplication.stores, resolveAgentRuntime, rootDir: projectRoot, registerActiveRun: registerRuntimeActiveRun, telemetry: otelRuntime });
const NODE_GOBLIN_OTEL_CONFIGURATION_REASONS = new Set([
  'provider_configuration_unsupported', 'configuration_failed',
  'remote_configuration_controller_unavailable', 'remote_configuration_invalid',
  'remote_configuration_failed', 'remote_configuration_send_failed', 'remote_configuration_timeout',
  'gateway_not_connected', 'gateway_not_ready', 'gateway_disconnected', 'gateway_configuration_failed',
  'gateway_configuration_timeout', 'telemetry_configuration_invalid',
  'telemetry_endpoint_invalid', 'telemetry_headers_invalid',
]);
let nodeGoblinOtelConfigurationUnavailable = false;
async function applyOtelConfigurationToNodeGoblins() {
  const configuration = otelRuntime.remoteConfiguration();
  const expected = configuration.enabled === true && Boolean(executionProviders.get('node-goblin'))
    && modLifecycle.getMods().some(mod => mod.id === 'node-goblin' && mod.status === 'loaded');
  // Disabling/removing a provider is not a failure or a recovery. Still send the
  // configuration below, including disabled configurations, as before.
  if (!expected) nodeGoblinOtelConfigurationUnavailable = false;
  const failed = fields => {
    if (!expected || nodeGoblinOtelConfigurationUnavailable) return;
    nodeGoblinOtelConfigurationUnavailable = true;
    operationalEvent(serverLogger, 'node_goblin_otel_configuration_failed', { providerId: 'node-goblin', ...fields }, { level: 'warn', component: 'opentelemetry' });
  };
  try {
    const result = await executionProviders.configure('node-goblin', configuration);
    if (result?.configured === false || (Number.isInteger(result?.failed) && result.failed > 0)
      || result?.controllerRunning === false) {
      // The controller aggregates gateway failures; retain only its known
      // classifications, never arbitrary reply text or gateway metadata.
      const failureReasons = [...new Set((Array.isArray(result.failures) ? result.failures.slice(0, 20) : [])
        .map(failure => failure?.reason).filter(reason => NODE_GOBLIN_OTEL_CONFIGURATION_REASONS.has(reason)))];
      failed({ reason: NODE_GOBLIN_OTEL_CONFIGURATION_REASONS.has(result.reason) ? result.reason
        : failureReasons.length === 1 ? failureReasons[0] : 'configuration_failed',
        ...(failureReasons.length ? { failureReasons } : {}),
        ...(Number.isSafeInteger(result?.failed) && result.failed > 0 ? { failedGateways: result.failed } : {}) });
    } else {
      // A count is the number attempted, not an acknowledgement. Zero
      // connected gateways cannot prove recovery from a previous outage.
      const configured = result?.configured === true || (Number.isSafeInteger(result?.configured)
        && result.configured > 0 && result.succeeded === result.configured
        && result.failed === 0 && result.controllerRunning !== false);
      if (expected && configured && nodeGoblinOtelConfigurationUnavailable) {
        nodeGoblinOtelConfigurationUnavailable = false;
        operationalEvent(serverLogger, 'node_goblin_otel_configuration_restored', { providerId: 'node-goblin' }, { level: 'info', component: 'opentelemetry' });
      }
    }
    return result;
  } catch (error) {
    const { errorCode, errorType, upstreamStatus } = safeOperationalError(error, 'remote_configuration_failed');
    failed({ reason: 'configuration_failed', errorCode, errorType, ...(upstreamStatus === undefined ? {} : { upstreamStatus }) });
    return { configured: false, reason: 'configuration_failed' };
  }
}

function profilesStore() { return postgresApplication.stores.profiles; }
function dreamDiaryStore() { return postgresApplication.stores.dreamDiary; }
function dreamSettingsStore() { return postgresApplication.stores.dreamSettings; }

function agentsStore() { return postgresApplication.stores.agents; }

async function withTaskBoard(operation) { return operation(postgresApplication.stores.tasks); }

async function withScheduledJobs(operation) { return operation(postgresApplication.stores.scheduledJobs); }

function scheduler() {
  if (!scheduledJobScheduler) {
    const borrowedStore = postgresApplication.stores.scheduledJobs;
    scheduledJobScheduler = createScheduledJobScheduler({
      storeFactory: () => borrowedStore,
      executeTurn: runChatTurnFromBody, createRunId: createChatTurnRunId, executeTask: executeBoardTask,
      closeStore: async () => {},
      resolveAgentRuntime, rootDir: projectRoot, stores: postgresApplication.stores, telemetry: otelRuntime,
      activeOwnerModIds: () => modLifecycle.getMods().filter((mod) => mod.status === 'loaded').map((mod) => mod.id),
    });
  }
  return scheduledJobScheduler;
}

function dreamScheduler() {
  if (!dreamCycleScheduler) dreamCycleScheduler = createDreamCycleScheduler({

    stores: postgresApplication.stores,
    resolveAgentRoot: async (agentId) => (await resolveAgentRuntime(agentId))?.agentWorkspaceRoot || null,
  });
  return dreamCycleScheduler;
}

function rollingContinuityScheduler() {
  if (!tiddleScheduler) tiddleScheduler = createTiddleScheduler({
    stores: postgresApplication.stores,

    runtimeRoot: process.env.BURROW_RUNTIME_ROOT || '/mnt/local/burrow',
  });
  return tiddleScheduler;
}

function retentionPolicyScheduler() {
  if (!retentionScheduler) retentionScheduler = createRetentionScheduler({
    store: postgresApplication.stores.retentionSettings,
    runIndependentCleanup: async () => {
      const stores = postgresApplication.stores;
      const policy = await stores.albdruck.readRetention();
      await stores.workingMemory.pruneExpiredWorkingMemory();
      if (policy.operationalDays !== null) {
        const runtime = await runtimeConfig();
        await runRetentionCleanup({ dataRoot: runtime.runtimeState.agentDataRoot, traceRoot: path.join(runtime.runtimeState.cacheRoot, 'traces'), retention: { traceMaxAgeDays: policy.operationalDays }, confirm: true });
      }
      for (const agent of await stores.agents.list({ includeDisabled: true })) {
        const runtime = await resolveAgentContext(agent.id);
        if (!runtime) continue;
        await runRetentionCleanup({ dataRoot: runtime.agentDataRoot, traceRoot: path.join(runtime.agentDataRoot, 'traces'), conversationStore: stores.conversations, taskStore: stores.tasks, agentId: agent.id, retention: { conversationDays: policy.conversationDays }, confirm: true });
      }
      await cleanupAgentAttachments({ agentStore: stores.agents, retentionDays: policy.attachmentDays, resolveAgentWorkspaceRoot: async (id) => (await resolveAgentContext(id))?.agentWorkspaceRoot || null });
    },
    runCleanup: async (policy) => retentionCleanup({ policy, confirm: true, includeAttachments: true }),
  });
  return retentionScheduler;
}

function installerStagingScheduler() {
  if (!installStagingCleanupScheduler) installStagingCleanupScheduler = createInstallStagingCleanupScheduler({ runtimeRoot });
  return installStagingCleanupScheduler;
}

async function executeBoardTask(taskId, options = {}) {
  return createBoardTaskExecutor({
    withTaskBoard, resolveAgentRuntime, createChatTurnRunId, runChatTurnFromBody,
    projectRoot, postgresApplication, otelRuntime, requestLifecycle,
    activeChatRuns, sessionContinuityHeads, activeChatRunKey, sessionContinuityHeadKey,
    RUN_CANCELLATION_GRACE_MS, retireCancelledRun, registerRuntimeActiveRun,
    publicChatProgress, observeModelRecovery, serverLogger, applyModelRecoveryProgress,
  })(taskId, options);
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
const versionRefreshLifecycle = createBackgroundLifecycle({ name: 'codex_client_version_refresh', logger: serverLogger });
const modelCatalogDiagnostics = createCatalogRefreshDiagnostics(serverLogger, 'models');
function refreshCodexClientVersionNow() {
  if (versionRefreshLifecycle.stopped) return;
  void versionRefreshLifecycle.track(async () => {
    if (versionRefreshLifecycle.stopped) return;
    try {
      const cache = await refreshCodexClientVersionCache({ store: modelsStore(), signal: AbortSignal.any([versionRefreshLifecycle.signal, AbortSignal.timeout(15_000)]) });
      if (!versionRefreshLifecycle.stopped) modelCatalogDiagnostics('codex_client_version_refresh', !cache?.lastError, { error: cache?.lastError });
    } catch (error) {
      if (!versionRefreshLifecycle.stopped) modelCatalogDiagnostics('codex_client_version_refresh', false, { error });
    }
    if (versionRefreshLifecycle.stopped) return;
    try {
      const results = await modelsStore().refreshOAuthCatalogs({ useModelsDev: true, signal: versionRefreshLifecycle.signal });
      if (!versionRefreshLifecycle.stopped) {
        modelCatalogDiagnostics('model_catalog_refresh', true);
        for (const result of results || []) modelCatalogDiagnostics('model_catalog_refresh', result.ok === true, { connectionId: result.id, error: result.error });
      }
    } catch (error) {
      if (!versionRefreshLifecycle.stopped) modelCatalogDiagnostics('model_catalog_refresh', false, { error });
    }
  }).catch(() => {});
}
function startCodexClientVersionRefresh() {
  if (versionRefreshLifecycle.stopped) return;
  refreshCodexClientVersionNow();
  if (!codexClientVersionRefreshInterval) codexClientVersionRefreshInterval = setInterval(refreshCodexClientVersionNow, CODEX_CLIENT_VERSION_CACHE_TTL_MS);
  codexClientVersionRefreshInterval.unref?.();
}
const versionRefreshProducer = {
  stop() { versionRefreshLifecycle.stop(); clearInterval(codexClientVersionRefreshInterval); codexClientVersionRefreshInterval = null; },
  close() { this.stop(); return versionRefreshLifecycle.close(); },
};
const startupLifecycle = createBackgroundLifecycle({ name: 'runtime_startup', logger: serverLogger });

let metadataStoreFactory = () => postgresApplication.stores.metadata;
let uiAuthSecretStoreFactory = () => postgresApplication.stores.uiAuthSecrets;
export function configureMetadataStoreFactory(factory) {
  if (typeof factory !== 'function') throw new TypeError('metadata_store_factory_required');
  metadataStoreFactory = factory;
}
function metadataStore() { return metadataStoreFactory(); }
function uiAuthSecretStore() { return uiAuthSecretStoreFactory(); }
export function configureUiAuthSecretStoreFactory(factory) {
  if (typeof factory !== 'function') throw new TypeError('ui_auth_secret_store_factory_required');
  uiAuthSecretStoreFactory = factory;
}

function modelsStore() { return postgresApplication.stores.models; }
function mcpStore() { return postgresApplication.stores.mcp; }
async function archiveSummarySelection(agentId) {
  return metadataStore().get(`archive_summary_model:${agentId}`);
}
async function saveArchiveSummaryModelSelection(agentId, body = {}) {
  try {
    const runtime = await resolveAgentRuntime(agentId);
    const connectionId = body.connectionId || body.modelConnectionId;
    const model = body.model || body.modelId;
    if (!connectionId || !model) { await metadataStore().set(`archive_summary_model:${runtime.agentId}`, null); return { ok: true, selection: null }; }
    const connection = await modelsStore().get(connectionId);
    if (!connection || !connection.models.some((item) => item.id === model && item.selected !== false) || !await modelsStore().hasAuth(connectionId)) throw new Error('archive_summary_model_invalid');
    const selection = { connectionId, model, reasoningEffort: body.reasoningEffort || 'off', temperature: body.temperature ?? 0 };
    await metadataStore().set(`archive_summary_model:${runtime.agentId}`, selection);
    return { ok: true, selection };
  } catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; }
}

async function archiveSummaryModelConfig(agentId) {
  const selection = await archiveSummarySelection(agentId);
  if (!selection?.connectionId || !selection?.model) return null;
  return resolveModelConfig({ stores: postgresApplication.stores, agentId: null, modelConnectionId: selection.connectionId, model: selection.model, reasoningEffort: selection.reasoningEffort || 'off', temperature: selection.temperature ?? 0 });
}
async function archiveSummaryForSession({ agentId, rootDir, sessionId } = {}) {
  const modelConfig = await archiveSummaryModelConfig(agentId);
  if (!modelConfig) return null;
  const store = postgresApplication.stores.conversations;
  const turns = [];
  let after = 0;
  for (;;) { const page = await store.page({ agentId, sessionId, after, limit: 200 }); turns.push(...page.entries.filter(isChatMessage)); if (!page.hasMore) break; after = page.next; }
  const metadata = await store.getMetadata({agentId,sessionId});
  const summary = await generateArchiveSummary({ modelConfig, title: metadata?.archiveTitle || sessionId, turns });
  if (!summary) return null;
  return store.patchMetadata({agentId,sessionId,metadata:{archiveSummary:summary,archiveSummaryStatus:'ready',archiveSummarizedAt:new Date().toISOString()}});
}

async function archiveSummaryForReset({ agentId, rootDir, sessionId, archiveId = null, archivedPath = null } = {}) {
  if (!archiveId) return null;
  const store = postgresApplication.stores.conversations;
  const transcript = await store.exportArchiveTranscript({agentId,sessionId,archiveId});
  const snapshot = transcript ? { entries: transcript.entries, metadata: transcript.session.metadata } : null;
  if (!snapshot) return null;
  const modelConfig = await archiveSummaryModelConfig(agentId);
  if (!modelConfig) return null;
  const summary = await generateArchiveSummary({modelConfig,title:snapshot.metadata?.archiveTitle || sessionId,turns:snapshot.entries.filter(isChatMessage)});
  return summary ? store.patchArchiveMetadata({agentId,sessionId,archiveId,metadata:{summary,summaryStatus:'ready',summarizedAt:new Date().toISOString()}}) : null;
}

async function curatorSettings() {
  const root = curatorRoot();
  return { ok: true, ...(await curatorRuntimeStatus({ stores: postgresApplication.stores, root })) };
}
async function saveCuratorSettings(body = {}) {
  try {
    const root = curatorRoot();
    const selection = await saveCuratorSelection(body, { stores: postgresApplication.stores, root });
    return { ok: true, selection, ...(await curatorRuntimeStatus({ stores: postgresApplication.stores, root })) };
  } catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; }
}

const { readUiAuthRecord, uiAuthSettings, saveUiAuthSettings } = createUiAuthService({ metadataStore, uiAuthSecretStore, runtimeConfig });

async function runtimeConfig(agentId = 'hatchet') {
  const runtime = await loadRuntimeConfig({ rootDir: projectRoot, args: { agent_id: String(agentId || 'hatchet') }, stores: postgresApplication.stores, tolerateModelResolutionError: true });
  observeAuthEnvironmentOverride(runtime);
  return runtime;
}

// Settings and retention maintenance need identity/context, not permission to execute a turn.
async function resolveAgentContext(agentId = null) {
  const runtime = await runtimeConfig();
  const id = String(agentId || runtime.runtimeState.agentId || 'hatchet').trim();
  const agent = await agentsStore().resolve(id) || (id === 'hatchet' ? await agentsStore().bootstrap() : null);
  if (!agent) {
    const error = new Error('agent_not_found');
    error.statusCode = 404;
    throw error;
  }
  return agentRuntimeContext({ runtimeState: runtime.runtimeState, agent });
}

async function resolveAgentRuntime(agentId = null) {
  const resolved = await resolveAgentContext(agentId);
  const { agent } = resolved;
  if (!agent.enabled) {
    const error = new Error('agent_disabled');
    error.statusCode = 409;
    throw error;
  }
  assertModAgentAvailable(agent);
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
    const agent = await agentsStore().create(body);
    const runtime = await runtimeConfig();
    const context = await ensureAgentRoots({ runtimeState: runtime.runtimeState, agent });
    const dreamStore = dreamSettingsStore();
    try { await dreamStore.save(agent.id, { enabled: true }); } finally { await dreamStore.close(); }
    // Every agent starts with a real default conversation scope. Without this
    // metadata record, the first /api/sessions request returns an empty list
    // until some later action happens to materialize the session.
    await postgresApplication.stores.conversations.updateMetadata({ agentId: agent.id, sessionId: 'default', update: (metadata) => metadata });

    return { ok: true, agent, context: { agentWorkspaceRoot: context.agentWorkspaceRoot, agentDataRoot: context.agentDataRoot, skillsRoot: context.skillsRoot } };
  } catch (error) {
    return { ok: false, status: String(error?.message || error) === 'agent_id_exists' ? 409 : 400, error: String(error?.message || error) };
  }
}

async function updateAgent(id, body = {}) {
  try {
    const agent = await agentsStore().update(id, body);
    // Dedicated peer inboxes are created by actual A2A ingress, not the toggle.
    return { ok: true, agent };
  }
  catch (error) { return { ok: false, status: String(error?.message || error) === 'agent_not_found' ? 404 : 400, error: String(error?.message || error) }; }
}

async function deleteAgent(id) {
  try { return { ok: true, agent: await agentsStore().delete(id) }; }
  catch (error) { return { ok: false, status: String(error?.message || error) === 'agent_not_found' ? 404 : 400, error: String(error?.message || error) }; }
}

async function agentProfileDocuments(agentId, body = null) {
  const managed = await agentsStore().get(agentId);
  if (managed?.modAgent && body !== null) return { ok:false, status:409, error:'agent_profile_managed_by_mod' };
  const store = profilesStore();
  try {
    if (body === null) return { ok: true, documents: await store.list(agentId), globalProfile: await store.globalProfile(agentId) };
    const result = await store.replaceWithGlobalProfile(agentId, body.documents, body.globalProfile);
    return { ok: true, ...result };
  } catch (error) {
    const message = String(error?.message || error);
    return { ok: false, status: message === 'agent_not_found' ? 404 : 400, error: message };
  } finally { await store.close(); }
}

async function globalProfileDocuments(body = null) {
  const store = profilesStore();
  try { return { ok: true, documents: body === null ? await store.listGlobal() : await store.replaceGlobal(body.documents) }; }
  catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; }
  finally { await store.close(); }
}

async function agentDreamSettings(agentId, body = null) {
  const managed = await agentsStore().get(agentId);
  if (managed?.modAgent) return { ok:false, status:409, error:'agent_dream_managed_by_mod' };
  const store = dreamSettingsStore();
  try {
    const settings = body === null ? await store.get(agentId) : await store.save(agentId, body);
    // Resolve exactly as the Dream runner does; never persist the inherited result.
    let effectiveModel = null;
    let modelResolutionError = null;
    try {
      const config = await resolveModelConfig(settings.modelConnectionId && settings.model
        ? { modelConnectionId: settings.modelConnectionId, model: settings.model, stores: postgresApplication.stores, }
        : { agentId, stores: postgresApplication.stores, });
      if (config) effectiveModel = { modelConnectionId: config.connectionId, model: config.model };
    } catch (error) { modelResolutionError = String(error?.message || error); }
    return { ok: true, settings, effectiveModel, modelResolutionError };
  } catch (error) {
    const message = String(error?.message || error);
    return { ok: false, status: message === 'agent_not_found' ? 404 : 400, error: message };
  } finally { await store.close(); }
}

async function agentDreamDiary(agentId, body = null, query = {}) {
  const store = dreamDiaryStore();
  try {
    const markdownMode = query.format || query.markdown;
    if (body === null) return { ok: true, entries: await store.list(agentId, { date: query.date || null, phase: query.phase || null, limit: query.limit || 30 }), markdown: markdownMode ? await store.renderMarkdown(agentId, { date: query.date || null, phase: query.phase || null, limit: query.limit || 30, format: markdownMode }) : null };
    return { ok: true, entry: await store.append(agentId, body) };
  } catch (error) {
    const message = String(error?.message || error);
    return { ok: false, status: message === 'agent_not_found' ? 404 : 400, error: message };
  } finally { await store.close(); }
}

let memoryPreviewService;
async function agentDreamMemoryPreview(agentId, body = {}) {
  try {
    memoryPreviewService ||= createDreamMemoryPreviewService({ stores: postgresApplication.stores,
      traceRoot: agentId => resolveRuntimeTraceRoot(projectRoot, { agent_id: agentId }) });
    return await memoryPreviewService(agentId, body);
  } catch (error) {
    const message = String(error?.message || error);
    return { ok: false, status: message === 'agent_not_found' ? 404 : 400, error: message };
  }
}

async function agentDreamMemoryConsolidate(agentId, body = {}) {
  try {
    return await consolidateDreamMemoryAsync({ agentId, workingMemoryStore: postgresApplication.stores.workingMemory, profileStore: postgresApplication.stores.profiles, limit: body.limit, generatedAt: body.generatedAt });
  } catch (error) {
    const message = String(error?.message || error);
    return { ok: false, status: message === 'agent_not_found' ? 404 : 400, error: message };
  }
}

async function agentDreamCycle(agentId, body = null, query = {}) {
  try {
    if (body === null) return { ok: true, receipts: await postgresApplication.stores.dreamCycles.latest({ agentId, limit: query.limit || 20 }) };
    const context = await resolveAgentRuntime(agentId);
    if (context.agent?.modAgent) return { ok:false, status:409, error:'agent_dream_managed_by_mod' };
    return { ok: true, result: await runDreamCycle({ agentId, rootDir: context?.agentWorkspaceRoot || null, limit: body.limit, generatedAt: body.generatedAt, stores: postgresApplication.stores || undefined }) };
  } catch (error) {
    const message = String(error?.message || error);
    return { ok: false, status: message === 'agent_not_found' ? 404 : 400, error: message };
  }
}

function authSecretToken(auth = {}) {
  if (auth.type === 'oauth') return auth.accessToken || auth.token || '';
  if (auth.type === 'token' || auth.type === 'bearer_token') return auth.token || '';
  if (auth.type === 'api_key') return auth.apiKey || auth.token || '';
  return '';
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
  // Paths remain artifact locations, not session persistence authorities.
  const agentRuntime = await resolveAgentRuntime(agentId);
  return agentRuntime.agentWorkspaceRoot;
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

function denyBasic(res, reason) {
  res.setHeader('www-authenticate', 'Basic realm="Burrow", charset="UTF-8"');
  sendJson(res, 401, { ok: false, error: 'unauthorized', auth: { required: true, mode: 'basic', reason } });
}

function bearerToken(req) {
  const authorization = String(req.headers.authorization || '');
  return authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
}

function apiTokenScopeForRequest(req, url) {
  if (req.method !== 'GET') return null;
  const pathname = url.pathname;
  if (pathname === '/api/health' || pathname === '/api/status' || pathname === '/api/metrics' || pathname === '/api/metrics/provider-pools' || pathname === '/api/diagnostics/inventory' || pathname === '/api/diagnostics/postgres' || pathname === '/api/diagnostics/brains' || pathname === '/api/diagnostics/brains/memories' || pathname === '/api/diagnostics/brains/embedding-jobs' || pathname === '/api/diagnostics/forge/jobs' || /^\/api\/diagnostics\/forge\/jobs\/[0-9a-f-]{36}$/i.test(pathname) || pathname === '/api/diagnostics/mods' || /^\/api\/diagnostics\/mods\/[a-z0-9-]+\/pending$/.test(pathname) || /^\/api\/diagnostics\/mods\/[a-z0-9-]+\/jobs(?:\/[A-Za-z0-9_-]+)?$/.test(pathname) || pathname === '/api/agents' || pathname === '/api/agent-status' || pathname === '/api/sessions' || /^\/api\/sessions\/[^/]+$/.test(pathname) || pathname === '/api/session/context' || pathname === '/api/session/context-status' || pathname === '/api/context' || pathname === '/api/chat/runs/active' || pathname === '/api/traces' || pathname.startsWith('/api/traces/') || pathname === '/api/archive/calendar' || pathname === '/api/archive/runs' || pathname.startsWith('/api/archive/runs/') || pathname === '/api/archive/sessions' || pathname.startsWith('/api/archive/sessions/')) return 'diagnostics:read';
  return null;
}

async function authenticateApiToken(req, url) {
  const token = bearerToken(req);
  if (!token) return null;
  const requiredScope = apiTokenScopeForRequest(req, url);
  if (!requiredScope) return null;
  const store = postgresApplication.stores.apiTokens;
  try { return await store.authenticate(token, { requiredScope }); }
  finally { await store.close?.(); }
}

// Keep optional diagnostics guarded: focused auth fixtures extract this region
// without importing server composition or requiring its logger dependencies.
async function logAuthorizationFailure(req, reason, { level = 'warn', stage = 'authorization' } = {}) {
  if (typeof serverLogger === 'undefined' || typeof serverLogger?.event !== 'function') return;
  req.operationalFailureLogged = true;
  try {
    await serverLogger.event('auth.failure', { reason, stage, ...(typeof req.requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(req.requestId) ? { requestId: req.requestId } : {}) }, { level, component: 'auth' });
  } catch { /* Authentication behavior does not depend on diagnostic delivery. */ }
}

async function authorizeRequest(req, res, url) {
  const apiToken = await authenticateApiToken(req, url);
  if (apiToken) { req.burrowApiToken = apiToken; req.burrowVerifiedAuth = Object.freeze({ enabled: ((await runtimeConfig()).ui?.authMode || 'none') !== 'none', authenticated: false }); return true; }
  if (bearerToken(req)) {
    await logAuthorizationFailure(req, 'api_token_rejected');
    sendJson(res, 403, { ok: false, error: 'api_token_forbidden' });
    return false;
  }
  const runtime = await runtimeConfig();
  const auth = runtime.ui || {};
  const mode = auth.authMode || 'none';
  if (mode === 'none') { req.burrowVerifiedAuth = Object.freeze({ enabled: false, authenticated: false }); return true; }
  if (mode === 'trusted-proxy') {
    const address = remoteAddress(req);
    const allowed = auth.trustedProxy?.allowedProxies || [];
    if (!allowed.includes(address)) {
      await logAuthorizationFailure(req, 'trusted_proxy_not_allowed', { stage: 'configuration' });
      sendJson(res, 401, { ok: false, error: 'unauthorized', auth: { required: true, mode, reason: 'proxy_not_allowed' } });
      return false;
    }
    const user = String(headerValue(req, auth.trustedProxy?.userHeader || 'x-forwarded-user') || '').trim();
    if (!user) {
      await logAuthorizationFailure(req, 'trusted_proxy_user_missing', { stage: 'configuration' });
      sendJson(res, 401, { ok: false, error: 'unauthorized', auth: { required: true, mode, reason: 'missing_proxy_user' } });
      return false;
    }
    req.burrowVerifiedAuth = Object.freeze({ enabled: true, authenticated: true });
    return true;
  }
  if (mode === 'basic') {
    if (!auth.basic?.username || !auth.basic?.passwordHash) {
      await logAuthorizationFailure(req, 'auth_configuration_missing', { level: 'error', stage: 'configuration' });
      sendJson(res, 503, { ok: false, error: 'auth_not_configured', auth: { required: true, mode } });
      return false;
    }
    const session = verifyBasicSessionCookie(parseCookieHeader(req.headers.cookie || '')[BASIC_SESSION_COOKIE], auth);
    if (session) {
      setBasicSessionCookie(res, auth);
      req.burrowVerifiedAuth = Object.freeze({ enabled: true, authenticated: true });
      return true;
    }
    const loginObservation = /^basic(?:\s|$)/i.test(String(req.headers.authorization || '')) && typeof startAuthLoginTelemetry === 'function' ? startAuthLoginTelemetry('basic') : null;
    const credentials = basicCredentials(req);
    if (!credentials) {
      loginObservation?.('failure', { diagnostics:{ reason:'basic_credentials_invalid', stage:'login' } });
      if (/^basic(?:\s|$)/i.test(String(req.headers.authorization || ''))) await logAuthorizationFailure(req, 'basic_credentials_invalid');
      denyBasic(res, 'missing_basic_credentials');
      return false;
    }
    if (credentials.username !== auth.basic.username || !verifyScryptPassword(credentials.password, auth.basic.passwordHash)) {
      loginObservation?.('failure', { diagnostics:{ reason:'basic_credentials_invalid', stage:'login' } });
      await logAuthorizationFailure(req, 'basic_credentials_invalid');
      denyBasic(res, 'invalid_basic_credentials');
      return false;
    }
    setBasicSessionCookie(res, auth);
    loginObservation?.('success');
    req.burrowVerifiedAuth = Object.freeze({ enabled: true, authenticated: true });
    return true;
  }
  if (mode === 'oidc') {
    if (!auth.oidc?.issuer || !auth.oidc?.clientId || !auth.oidc?.clientSecret) {
      await logAuthorizationFailure(req, 'auth_configuration_missing', { level: 'error', stage: 'configuration' });
      sendJson(res, 503, { ok: false, error: 'auth_not_configured', auth: { required: true, mode } });
      return false;
    }
    let diagnostics;
    let session;
    try { session = oidcSessionFromRequest(req, runtime, { onFailure: value => { diagnostics = value; } }); }
    catch (error) {
      if (typeof logAuthFailure === 'function' && typeof serverLogger !== 'undefined') {
        req.operationalFailureLogged = true;
        await logAuthFailure(serverLogger, { req, error, stage: 'session' });
      }
      throw error;
    }
    if (diagnostics && typeof logAuthFailure === 'function' && typeof serverLogger !== 'undefined') {
      req.operationalFailureLogged = true;
      await logAuthFailure(serverLogger, { req, diagnostics });
    }
    if (session) { req.burrowVerifiedAuth = Object.freeze({ enabled: true, authenticated: true }); return true; }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      res.writeHead(302, { location: `/auth/oidc/login?returnTo=${encodeURIComponent(url.pathname + url.search)}` });
      res.end();
      return false;
    }
    sendJson(res, 401, { ok: false, error: 'unauthorized', auth: { required: true, mode, loginUrl: '/auth/oidc/login' } });
    return false;
  }
  await logAuthorizationFailure(req, 'auth_mode_unsupported', { level: 'error', stage: 'configuration' });
  sendJson(res, 501, { ok: false, error: 'auth_mode_not_implemented', auth: { required: true, mode } });
  return false;
}

function sendJson(res, status, body) {
  observeHttpResult(res, status, body);
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function applyApiCors(req, res, url) {
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/')) return false;
  const policy = browserRequestPolicy(req, url, browserOriginConfig());
  if (policy.error) { sendJson(res, policy.status, { ok: false, error: policy.error }); return true; }
  if (policy.origin) {
    res.setHeader('access-control-allow-origin', policy.origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-max-age', '600');
  }
  if (policy.status !== 204) return false;
  res.writeHead(204); res.end(); return true;
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
    ...(downloadName ? artifactResponseHeaders({ name: downloadName, mimeType: MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream' }) : {}),
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
  if (kind === 'chat') { const hasMessage = typeof body.message === 'string' && body.message.trim(); const hasAttachment = Array.isArray(body.attachments) && body.attachments.length > 0; if (!hasMessage && !hasAttachment) throw Object.assign(new Error('message_required'), { statusCode: 400 }); }
  if (kind === 'workspace-write') { requireStringField(body, 'path'); if (typeof body.content !== 'string') throw Object.assign(new Error('content_required'), { statusCode: 400 }); }
  if (kind === 'project-create') requireStringField(body, 'name');
  if (kind === 'task-create') { requireStringField(body, 'projectId'); requireStringField(body, 'title'); }
  if (kind === 'scheduled-job-create') {
    for (const field of ['agentId', 'name']) requireStringField(body, field);
    requireStringField(body, body.jobKind === 'task' ? 'taskId' : 'prompt');
    requireStringField(body, body.scheduleKind === 'once' ? 'runAt' : 'cron');
  }
  if (kind === 'group-create') { requireStringField(body, 'name'); if (!Array.isArray(body.participantAgentIds) || !body.participantAgentIds.length || body.participantAgentIds.some((id) => typeof id !== 'string' || !id.trim())) throw Object.assign(new Error('group_participants_required'), { statusCode: 400 }); }
  if (kind === 'group-message') { const hasMessage = typeof body.message === 'string' && body.message.trim(); const hasAttachment = Array.isArray(body.attachments) && body.attachments.length > 0; if (!hasMessage && !hasAttachment) throw Object.assign(new Error('message_required'), { statusCode: 400 }); }
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

function boundedInteger(value, { fallback = 100, min = 1, max = 500 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

async function listSessions({ rootDir, rootDirs = null, agentId = null, includeArchived = false, query = '', updatedSince = null, limit = null } = {}) {
  const resolvedLimit = limit == null ? null : Number(limit);
  if (resolvedLimit !== null && (!Number.isSafeInteger(resolvedLimit) || resolvedLimit < 1)) throw new RangeError('session_list_limit_invalid');
  agentId ||= (await resolveAgentRuntime()).agentId;
  let rows = await postgresApplication.stores.conversations.listSessions({ agentId, includeArchived });
  if (!rows.length) {
    await agentsStore().ensureInitialSession(agentId);
    // A concurrent request may have repaired the scope first; reread even
    // when this request did not insert it.
    rows = await postgresApplication.stores.conversations.listSessions({ agentId, includeArchived });
  }
  const since = updatedSince && !Number.isNaN(Date.parse(updatedSince)) ? String(updatedSince) : null;
  return rows.filter((item) => !isInternalContextSession(item)).filter((item) => !query || JSON.stringify(item).toLowerCase().includes(String(query).toLowerCase())).filter((item) => !since || String(item.updatedAt || "") > since).slice(0, resolvedLimit ?? undefined).map((item) => ({ ...item, id: item.sessionId }));
}

function runtimeTraceRoot(runtime, sessionId = 'default', agentId = runtime.runtimeState.agentId) {
  return resolveRuntimeTracePath({
    cacheRoot: runtime.runtimeState.cacheRoot,
    workspaceRoot: runtime.runtimeState.workspaceRoot,
    agentId,
    sessionId,
  });
}

async function sessionDetail(id, { rootDir, agentId = null, limit, before } = {}) {
  agentId ||= (await resolveAgentRuntime()).agentId;
  return activeSessionDetail({ store: postgresApplication.stores.conversations, agentId, sessionId: id,
    cursorSecret: settingsKeyFromEnvironment(), limit, before, summarizeSessionTurns });
}

async function listTraces(sessionId = 'default', agentId = null) {
  const runtime = await runtimeConfig();
  const ids = await listDirs(runtimeTraceRoot(runtime, sessionId, agentId || runtime.runtimeState.agentId));
  return ids.slice(0, 100).map((id) => ({ id, url: `/api/traces/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId)}` }));
}

async function traceRootForRun({ rootDir, sessionId, runId, runtime, agentId } = {}) {
  const findTraceDir = async (id) => {
    const turns = (await postgresApplication.stores.conversations.exportTranscript({ agentId, sessionId: id }))?.entries || [];
    return turns.findLast((turn) => turn.runId === runId && turn.traceDir)?.traceDir || null;
  };
  let traceDir = rootDir ? await findTraceDir(sessionId) : null;
  // Legacy trace URLs do not carry sessionId. Resolve through the selected
  // agent's session lineage rather than mixing unrelated session histories.
  if (!traceDir && rootDir) {
    const records = await postgresApplication.stores.conversations.listSessions({ agentId, includeArchived: true });
    for (const record of records) {
      if (record.sessionId === sessionId) continue;
      traceDir = await findTraceDir(record.sessionId);
      if (traceDir) break;
    }
  }
  return traceDir ? path.dirname(traceDir) : runtimeTraceRoot(runtime, sessionId, agentId);
}

function runtimePolicyStatus(runtime) {
  const boundaries = runtime.executionBoundaries;
  const status = executionBoundaryStatus(boundaries);
  return { retired: false, packs: 0, hardBlockCount: status.hardBlockCount, enabledHardBlockCount: status.enabledHardBlockCount, hardBlocks: status.hardBlocks.map((rule) => ({ id: rule.id, enabled: rule.enabled, type: rule.type, match: rule.match, operations: rule.operations, reason: rule.reason || null })) };
}

async function executionBoundarySettings() {
  const boundaries = await readExecutionBoundaries({ metadataStore: postgresApplication.stores.metadata, });
  return { ok: true, boundaries, status: executionBoundaryStatus(boundaries) };
}

async function saveExecutionBoundarySettings(body = {}) {
  const result = await saveExecutionBoundaries(body, { metadataStore: metadataStore() });
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
    const selected = agentRuntime ? await modelsStore().modelSelection(agentRuntime.agentId) : null;
    const selectedRuntime = selected ? await loadRuntimeConfig({ rootDir: projectRoot, args: { agent_id: agentRuntime.agentId }, stores: postgresApplication.stores, tolerateModelResolutionError: true }) : runtime;
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
      model: selectedRuntime.modelConfig ? { configured: Boolean(selectedRuntime.modelConfig.model), selectionRequired: !selectedRuntime.modelConfig.model, provider: selectedRuntime.modelConfig.provider, providerName: selectedRuntime.modelConfig.providerName || selectedRuntime.modelConfig.provider, api: selectedRuntime.modelConfig.api, baseUrl: selectedRuntime.modelConfig.baseUrl, model: selectedRuntime.modelConfig.model, selectedProfile: selectedRuntime.modelConfig.selectedProfile || null, profiles: selectedRuntime.modelConfig.availableProfiles || [], hasApiKey: Boolean(selectedRuntime.modelConfig.apiKey), reasoningEffort: selectedRuntime.modelConfig.reasoningEffort ?? selectedRuntime.modelConfig.extra?.reasoning?.effort ?? 'off', thinkingMode: selectedRuntime.modelConfig.thinkingMode ?? null, temperature: selectedRuntime.modelConfig.temperature ?? 0.2, thinkingModes: selectedRuntime.modelConfig.availableModels?.find(m => m.id === selectedRuntime.modelConfig.model)?.thinkingModes, thinkingEfforts: selectedRuntime.modelConfig.availableModels?.find(m => m.id === selectedRuntime.modelConfig.model)?.thinkingEfforts, reasoningEfforts: selectedRuntime.modelConfig.reasoningEfforts || ['off', 'minimal', 'low', 'medium', 'high'], contextWindow: selectedRuntime.modelConfig.contextWindow || null, contextTokens: selectedRuntime.modelConfig.contextTokens || null, selectionSource: selectedRuntime.modelConfig.selectionSource || null, agentId: agentRuntime?.agentId || null } : { configured: false, selectionRequired: true, selectedProfile: null, profiles: [], reasoningEfforts: ['off', 'minimal', 'low', 'medium', 'high'], contextWindow: null, contextTokens: null },
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
  const metadata = await postgresApplication.stores.conversations.getMetadata({agentId:agentRuntime.agentId,sessionId});
  return { ok: true, agentId: agentRuntime.agentId, sessionId, continuityScope: workingContextFromSession({ metadata }).continuityScope || null };
}

async function setSessionContinuityScope(body = {}) {
  const agentRuntime = await resolveAgentRuntime(body.agentId);
  const sessionId = String(body.sessionId || 'default').trim() || 'default';
  const continuityScope = normalizeContinuityScope(body.continuityScope ?? body.scope);
  if (!continuityScope) return { ok: false, error: 'continuity_scope_required' };
  const metadata = await postgresApplication.stores.conversations.getMetadata({agentId:agentRuntime.agentId,sessionId});
  const workingContext = workingContextFromSession({ metadata });
  await postgresApplication.stores.conversations.patchMetadata({agentId:agentRuntime.agentId,sessionId,metadata:{workingContext:{...workingContext,continuityScope}}});

  return { ok: true, agentId: agentRuntime.agentId, sessionId, continuityScope };
}

async function clearSessionContinuityScope(body = {}) {
  const agentRuntime = await resolveAgentRuntime(body.agentId);
  const sessionId = String(body.sessionId || 'default').trim() || 'default';
  const metadata = await postgresApplication.stores.conversations.getMetadata({agentId:agentRuntime.agentId,sessionId});
  const { continuityScope: _removed, ...workingContext } = workingContextFromSession({ metadata });
  await postgresApplication.stores.conversations.patchMetadata({agentId:agentRuntime.agentId,sessionId,metadata:{workingContext}});

  return { ok: true, agentId: agentRuntime.agentId, sessionId, continuityScope: null };
}

async function sessionReadHandoff(body = {}) {
  try {
    const { agentRuntime, sessionId, dataRoot } = await localContinuityContext(body);
    const session = await sessionDetail(sessionId, { rootDir: agentRuntime.agentWorkspaceRoot, agentId: agentRuntime.agentId });
    const metadata = await postgresApplication.stores.conversations.getMetadata({agentId:agentRuntime.agentId,sessionId});
    const workingContext = workingContextFromSession({ metadata });
    const continuityScope = normalizeContinuityScope(workingContext.continuityScope) || `conversation:${metadata?.conversationId || sessionId}`;
    const handoffs = await postgresApplication.stores.continuity.list({ agentId: agentRuntime.agentId, limit: 1 });
    const workingContinuity = projectHandoffsIntoWorkingContinuity({
      continuity: await loadWorkingContinuityAsync({ store: postgresApplication.stores.workingMemory, agentId: agentRuntime.agentId, continuityScope }),
      handoffs,
      agentId: agentRuntime.agentId,
      continuityScope,
    });
    return { ok: true, owner: 'postgres', handoffModel: 'rolling_continuity_metadata', agentId: agentRuntime.agentId, sessionId, continuityScope, sessionSummary: session?.summary || null, handoffs, workingContinuity };
  } catch (error) { return { ok: false, error: String(error?.message || error) }; }
}

async function sessionWriteHandoff(body = {}) {
  try {
    const { agentRuntime, sessionId, dataRoot } = await localContinuityContext(body);
    const session = await sessionDetail(sessionId, { rootDir: agentRuntime.agentWorkspaceRoot, agentId: agentRuntime.agentId });
    const content = String(body.content || session?.summary || '').trim();
    if (!content) return { ok: false, error: 'handoff_content_empty' };
    const runId = String(body.runId || `ui-handoff-${Date.now()}`);
    const handoff = buildContinuityHandoff({ agentId: agentRuntime.agentId, sessionId, runId, message: body.message || `Session ${sessionId} continuity handoff`, answerText: content, toolResults: [], curated: { title: body.title || `Burrow session handoff: ${sessionId}`, content } });
    if (!handoff) return { ok: false, error: 'handoff_content_insufficient' };
    const store = postgresApplication.stores.continuity;
    return { ok: true, owner: 'postgres', handoff: await store.upsert(handoff) };
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
  const store = postgresApplication.stores.workingMemory;
  try {
    return { ok: true, owner: 'local_review_queue', entersPrompt: false, writesBrain: false, agentId: agentRuntime.agentId, candidates: await store.listBrainPromotionCandidates({ agentId: agentRuntime.agentId, status: body.status || 'pending', limit: body.limit || 20 }) };
  } catch (error) { return { ok: false, error: String(error?.message || error) }; }
}

async function updateBrainPromotionCandidate(body = {}) {
  const agentRuntime = await resolveAgentRuntime(body.agentId);
  const store = postgresApplication.stores.workingMemory;
  try {
    return { ok: true, owner: 'local_review_queue', entersPrompt: false, writesBrain: false, candidate: await store.updateBrainPromotionCandidate({ agentId: agentRuntime.agentId, candidateId: body.candidateId || body.id, status: body.status, reason: body.reason }) };
  } catch (error) { return { ok: false, error: String(error?.message || error) }; }
}

async function retentionPolicySettings() {
  // Loading a form must not resolve execution context or scan trace storage.
  const store = postgresApplication.stores.retentionSettings;
  const [policy, state] = await Promise.all([
    readRetentionPolicy({ store }), readRetentionPolicyState({ store }),
  ]);
  return { ok: true, policy, state };
}

async function saveRetentionPolicySettings(body = {}) {
  try {
    const policy = await saveRetentionPolicy(body.policy || body, { store: postgresApplication.stores.retentionSettings });
    const state = await readRetentionPolicyState({ store: postgresApplication.stores.retentionSettings });
    return { ok: true, policy, state };
  } catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; }
}

async function retentionCleanup(body = {}) {
  const runtime = await runtimeConfig();
  const savedPolicy = await readRetentionPolicy({ store: postgresApplication.stores.retentionSettings });
  const policy = body.policy ? normalizeRetentionPolicy(body.policy, savedPolicy) : savedPolicy;
  if (body.confirm === true && !policy.enabled && body.requireEnabled !== false) return { ok: false, status: 409, error: 'retention_policy_disabled', policy };
  try {
    const result = await runRetentionCleanup({ taskStore: postgresApplication.stores.tasks, conversationStore: postgresApplication.stores.conversations, agentId: runtime.runtimeState.agentId, dataRoot: runtime.runtimeState.agentDataRoot, traceRoot: path.join(runtime.runtimeState.cacheRoot, 'traces'), retention: policy, confirm: body.confirm === true });
    const attachments = body.confirm === true && body.includeAttachments === true ? await cleanupAgentAttachments({ agentStore: postgresApplication.stores.agents, retentionDays: (await postgresApplication.stores.albdruck.readRetention()).attachmentDays, resolveAgentWorkspaceRoot: async (agentId) => (await resolveAgentContext(agentId))?.agentWorkspaceRoot || null }) : null;
    const state = body.confirm === true ? await writeRetentionPolicyState(retentionPolicySuccessState({ policy, result, previous: await readRetentionPolicyState({ store: postgresApplication.stores.retentionSettings }) }), { store: postgresApplication.stores.retentionSettings }) : await readRetentionPolicyState({ store: postgresApplication.stores.retentionSettings });
    return { ok: true, policy, state, ...result, attachments };
  } catch (error) {
    if (body.confirm === true) await writeRetentionPolicyState(retentionPolicyFailureState({ policy, error, previous: await readRetentionPolicyState({ store: postgresApplication.stores.retentionSettings }) }), { store: postgresApplication.stores.retentionSettings });
    return { ok: false, status: 500, error: String(error?.message || error), policy, state: await readRetentionPolicyState({ store: postgresApplication.stores.retentionSettings }) };
  }
}

async function workbenchPlan(body = {}, agentRuntime = null) {
  const message = String(body.message || '').trim();
  if (!message) return { ok: false, error: 'message_required' };
  const workspaceRoot = body.workspaceRoot ? String(body.workspaceRoot) : null;
  const action = body.action ? String(body.action) : null;
  const turnPlan = planTurn({ message, action, workspaceContext: { workspaceRoot } });
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
    stores: postgresApplication.stores,
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
    stores: postgresApplication.stores,
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

async function listSubagentSummaries(agentRuntime) {
  // Truncating before ancestry selection can strand a live grandchild behind
  // its older/final parent. Bound context hydration, not the projected tree.
  const records = await listSubagentRecords({ dataRoot: agentRuntime.agentDataRoot, includeFinal: true, limit: Number.MAX_SAFE_INTEGER });
  return records
    .filter(record => [record.agentId, record.owner?.agentId].every(id => !id || id === agentRuntime.agentId))
    .map(record => ({ ...subagentVisibilitySummary(record), ...(record.minionDepth || {}) }));
}

const CHILD_LIVE_FINAL_WINDOW_MS = 60 * 60 * 1000;
function visibleChildWorkRecord(item, now = Date.now()) {
  if (!item?.final) return true;
  const updatedAt = Date.parse(item.updatedAt || '');
  return Number.isFinite(updatedAt) && now - updatedAt <= CHILD_LIVE_FINAL_WINDOW_MS;
}

async function agentOverview(body = {}) {
  normalizeOverviewBody(body);
  const identities = (await chatIdentities()).agents || [];
  const identitiesByAgentId = new Map(identities.map((identity) => [identity.id, identity]));
  const agents = await agentsStore().list({ includeDisabled: true });
  const overview = await Promise.all(agents.map(async (agent) => {
    const sessionId = typeof body.sessions?.[agent.id] === 'string' && body.sessions[agent.id].trim()
      ? body.sessions[agent.id].trim()
      : 'default';
    const base = { agent, identity: identitiesByAgentId.get(agent.id) || null, sessionId, selection: await modelsStore().modelSelection(agent.id) };
    if (!agent.enabled) return { ...base, status: { agents: [] }, contexts: {} };
    try {
      const agentRuntime = await resolveAgentRuntime(agent.id);
      const [status, runtime] = await Promise.all([
        agentStatusForSession(sessionId, agentRuntime, { minionScope: body.minionScope }),
        runtimeConfig(agent.id),
      ]);
      const matchingRuns = [...activeChatRuns.values()].filter((run) => run.agentId === agent.id && run.sessionId === sessionId);
      const active = matchingRuns.find((run) => !run.controller.signal.aborted) || matchingRuns.at(-1) || null;
      const limits = activeConversationLimits({ modelConfig: runtime.modelConfig, contextConfig: runtime.contextConfig });
      const childSessionIds = status.agents
        .filter((item) => item.sessionId !== sessionId)
        .map((item) => item.sessionId)
        .filter(Boolean);
      const { all: sessionIds, hydrated: hydratedSessionIds, truncated } = overviewSessionIds(sessionId, childSessionIds);
      const contextEntries = await Promise.all(hydratedSessionIds.map(async (currentSessionId) => {
        const liveRun = currentSessionId === sessionId ? active : [...activeChatRuns.values()].find(run => run.agentId === agent.id && run.sessionId === currentSessionId && !run.controller.signal.aborted);
        const context = await inspectSessionContextStatus({ stores: postgresApplication.stores, agentId: agentRuntime.agentId, rootDir: projectRoot, dataRoot: agentRuntime.agentWorkspaceRoot, sessionId: currentSessionId, limits, contextConfig: runtime.contextConfig, contextWindow: runtime.modelConfig?.contextWindow, contextTokens: runtime.modelConfig?.contextTokens, liveContext: liveRun?.contextUsage || null });
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

async function agentStatusForSession(sessionId = 'default', agentRuntime = null, { minionScope = 'session' } = {}) {
  agentRuntime ||= await resolveAgentRuntime();
  const [records, metadata, settings] = await Promise.all([
    listSubagentSummaries(agentRuntime),
    postgresApplication.stores.conversations.getMetadata({ agentId: agentRuntime.agentId, sessionId }),
    readMinionSettings(metadataStore(), agentRuntime.agentId),
  ]);
  const requested = sessionMinionAncestry({ sessionId, metadata, maxDepth: settings.maxDepth });
  const agentRuns = [...activeChatRuns.values()].filter(run => run.agentId === agentRuntime.agentId);
  const activeForSession = id => {
    const matches = agentRuns.filter(run => run.sessionId === id);
    return matches.find(run => !run.controller.signal.aborted) || matches.at(-1) || null;
  };
  const liveSessions = new Set(agentRuns.map(run => run.sessionId));
  const activeSessions = await Promise.all(agentRuns.map(async run => ({
    ...activeChatRunSummary(run),
    metadata: run.sessionId === sessionId ? metadata : await postgresApplication.stores.conversations.getMetadata({ agentId: agentRuntime.agentId, sessionId: run.sessionId }),
  })));
  // Only bulk rail hydration opts into agent-wide discovery. Chat recovery and
  // cancellation stay scoped to the requested conversation's subtree.
  const tree = projectSubagentTree(records, { agentId: agentRuntime.agentId, sessionId: minionScope === 'agent' ? null : sessionId, rootSessionId: minionScope === 'agent' ? null : requested.depth > 0 ? requested.rootSessionId : null, activeSessions, visible: item => visibleChildWorkRecord(item) || liveSessions.has(item.sessionId) });
  const statusFor = (item) => item.status === 'running'
    ? (item.phase === 'streaming' ? 'STREAMING' : item.phase === 'verifying' ? 'VERIFYING' : 'THINKING')
    : item.status === 'succeeded' ? 'DONE'
      : item.status === 'failed' || item.status === 'timed_out' ? 'ERROR'
        : 'IDLE';
  const active = activeForSession(sessionId);
  const child = tree.find(item => item.sessionId === sessionId);
  const ancestry = sessionMinionAncestry({ sessionId, runId: active?.runId, metadata, maxDepth: settings.maxDepth, subagent: child });
  const liveStatusFor = run => run ? (run.controller.signal.aborted ? 'CANCELLING' : run.phase === 'streaming' ? 'STREAMING' : 'THINKING') : null;
  const rowFor = item => {
    const live = activeForSession(item.sessionId);
    return {
      ...sessionMinionAncestry({ sessionId: item.sessionId, runId: live?.runId, subagent: item }),
      label: item.label || item.purpose || item.id || item.sessionId,
      status: liveStatusFor(live) || statusFor(item),
      since: live?.startedAt || item.updatedAt || null,
      result: item.result || null,
    };
  };
  return {
    sessionId,
    minionScope,
    agents: [
      child ? { ...rowFor(child), ...ancestry } : {
        ...ancestry,
        label: agentRuntime.agent?.name || agentRuntime.agentId || 'Hatchet',
        status: liveStatusFor(active) || 'IDLE',
        since: active?.startedAt || null,
      },
      ...tree.filter(item => item.sessionId && item.sessionId !== sessionId).map(rowFor),
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
    stores: postgresApplication.stores,
    resolveAgentRuntime,
    ...(agentRuntime ? { agentRuntime } : (await runtimeAgentDataRoot() ? { agentDataRoot: await runtimeAgentDataRoot() } : { dataRoot })),
  });
  return chatTurnResponse(result);
}

function commandText(title, fields = []) {
  return [title, ...fields.filter((field) => field?.[1] !== null && field?.[1] !== undefined).map(([label, value]) => `${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)].join('\n');
}

function contextMeterLines(context = {}, compaction = {}, memory = {}) {
  return [
    ['Context scope', context.scope || 'historical'],
    ['Usage', context.percent === null || context.percent === undefined ? 'unknown' : `${context.percent}%`],
    ['Budget pressure (classification, not execution status)', context.pressure || 'unknown'],
    [context.source === 'provider-input-tokens' ? 'Reported input tokens' : 'Estimated tokens', context.estimatedTokens ?? 'unknown'],
    ...(context.requestId ? [['Request ID', context.requestId], ['Requested model', context.model || 'unknown'], ['Reported model', context.responseModel || 'unknown'], ['Serving provider', context.providerName || context.provider || 'unknown']] : []),
    ...(context.provenance ? [['Context basis', context.provenance]] : []),
    ['Capacity tokens', context.capacityTokens ?? 'unknown'],
    ['Compaction', compaction.active ? 'active' : 'idle'],
    ['Memory source', memory.source || 'none'],
  ];
}

const startGroupChannelMessage = createGroupChannelMessageStarter({ runtimeDataRoot, resolveAgentRuntime, conversationStore: postgresApplication.stores.conversations, stores: postgresApplication.stores, retentionDays: async () => (await postgresApplication.stores.albdruck.readRetention()).attachmentDays, projectRoot, groupChannelRuns, groupChannelRunKey, runChatTurnFromBody, telemetry: otelRuntime, lifecycle: requestLifecycle });

async function cancelGroupChannelRun(channelId, runId, body = {}) {
  const record = [...groupChannelRuns.values()].find((item) => item.channelId === channelId && item.runId === runId);
  if (!record) return { ok: false, error: 'group_channel_run_not_found', runId };
  record.cancelled = true;
  record.reason = String(body.reason || 'stopped from group channel');
  record.controller.abort(new Error(record.reason));
  return { ok: true, channelId, runId, agentId: record.agentId, status: 'cancelled', reason: record.reason };
}

const { importPreview, applyImport, exportSnapshot } = createImportExportApplication({
  stores: postgresApplication.stores, metadataStore, uiAuthSecretStore,
  runtime: { sourceRoot, config: runtimeConfig, ensureAgentRoots, metrics: runtimeMetrics, curatorRoot,
    archiveSummary: { read: archiveSummarySelection, save: saveArchiveSummaryModelSelection } },
});
const exportRoute = createExportRoutes({ readJsonBody, sendJson, exportCatalog, normalizeImportRequest, decodeExport, buildExport, exportSnapshot, importPreview, applyImport });
const completionEventReceiverSettings = createCompletionEventSettings({ store: postgresApplication.stores.completionEventSettings });
const completionEventRoute = createCompletionEventRoutes({ store: postgresApplication.stores.completionEvents, readJsonBody, sendJson, resolveAgentRuntime, wake: () => completionEventRunner.wake(), getWebhookSecret: () => completionEventReceiverSettings.secret(), receiverSettings: completionEventReceiverSettings });
const taskBoardRoute = createTaskBoardRoutes({ readJsonBody, sendJson, validateBoundaryBody, withTaskBoard, taskStatuses: TASK_STATUSES, taskPriorities: TASK_PRIORITIES, executeBoardTask });
const workbenchRoute = createWorkbenchRoutes({ readJsonBody, sendJson, selectedAgentRuntime, dataRootForAgent, listWorkItemSummaries, createWorkbenchItem, readWorkItem, runWorkbenchItemStep, continueWorkbenchItem, archiveWorkbenchItem, workbenchPlan, workbenchRun });
const forgeStoreFactory = () => postgresApplication.stores.forge;
configureForgeStoreFactory(forgeStoreFactory);
const forgeRoute = createForgeRoutes({ store: forgeStoreFactory, readJsonBody, sendJson, sendStaticFile });
const dreamRoute = createDreamRoutes({ readJsonBody, sendJson, agentDreamSettings, agentDreamDiary, agentDreamMemoryConsolidate, agentDreamMemoryPreview, agentDreamCycle });
const skillGitSync = new SkillGitSync({ pool: postgresApplication.pool, skills: postgresApplication.stores.skills, sources: postgresApplication.stores.skillSources, packageRoot: path.join(runtimeRoot,'skill-packages'), logger: serverLogger });
const skillSourceRoute = createSkillSourceRoutes({ sources: postgresApplication.stores.skillSources, skills: postgresApplication.stores.skills, sync: skillGitSync, pool: postgresApplication.pool, readJsonBody, sendJson });
const skillStoreCall = async (operation) => operation(postgresApplication.stores.skills);
const skillApi = {
  listSkills: async () => { const [skills,sources]=await Promise.all([postgresApplication.stores.skills.list(),postgresApplication.stores.skillSources.list()]);const byId=new Map(sources.map(source=>[source.skillId,source]));return {ok:true,skills:skills.map(skill=>({...skill,gitSource:byId.get(skill.id)||null}))}; },
  createSkill: async (body) => ({ ok: true, skill: await skillStoreCall(store => store.create(body)) }),
  getSkill: async (id) => { const skill = await skillStoreCall(async store => await store.get(id)); return skill ? { ok: true, skill:{...skill,gitSource:await postgresApplication.stores.skillSources.get(id)} } : { ok: false, status: 404, error: 'skill_not_found' }; },
  updateSkill: async (id, body) => { const skill = await skillStoreCall(async store => await store.update(id, body)); return skill ? { ok: true, skill } : { ok: false, status: 404, error: 'skill_not_found' }; },
  deleteSkill: async (id) => await skillStoreCall(async store => await store.delete(id)) ? { ok: true } : { ok: false, status: 404, error: 'skill_not_found' },
  agentSkills: async (id) => { const runtime = await resolveAgentContext(id); const assignments = await skillStoreCall(store => store.assignments(runtime.agentId)); const catalog = await loadEffectiveSkillCatalog({ workspaceRoot: runtime.workspaceRoot, agentRuntime: runtime, skillStore: postgresApplication.stores.skills }); return { ok: true, ...assignments, effectiveSkills: catalog.skills.map(skillManifest) }; },
  saveAgentSkills: async (id, body) => { const runtime = await resolveAgentContext(id); await skillStoreCall(store => store.replaceAssignments(runtime.agentId, body.skillIds)); return skillApi.agentSkills(runtime.agentId); },
};
const settingsRoute = createSettingsRoutes({ globalProfileDocuments, timezoneSettings: async () => ({ ok: true, timezone: await operatorTimezone(postgresApplication.stores.metadata) }), saveTimezoneSettings: (body) => saveOperatorTimezone(postgresApplication.stores.metadata, body), ...skillApi, readJsonBody, sendJson, modelConnections, claudeCliCredentialStatus, importClaudeCliCredential, startOpenAiOAuthLoginApi, openAiOAuthLoginStatus, submitOpenAiOAuthLoginApi, cancelOpenAiOAuthLoginApi, startClaudeCodeLoginApi, claudeCodeLoginStatus, submitClaudeCodeLoginApi, cancelClaudeCodeLoginApi, importClaudeCodeLoginApi, mcpConnections, discoverMcpConnection, diagnoseMcpConnection, saveMcpConnection, removeMcpConnection, agentMcpTools, saveAgentMcpTools, agentModelSelection, saveAgentModelSelection, agentMinionModelSelection, saveAgentMinionModelSelection, agentMinionSettings, saveAgentMinionSettings, archiveSummaryModelSelection: async (agentId) => ({ ok: true, selection: await archiveSummarySelection((await resolveAgentRuntime(agentId)).agentId) }), saveArchiveSummaryModelSelection, discoverModelConnection, saveModelConnection, removeModelConnection: async (id) => await modelsStore().remove(id), completeSetupOperation: async body => { try { return await completeSetupOperation({ pool: postgresApplication.pool, encryptionKey: modelsStore().key, body }); } catch (error) { return { ok: false, status: error.message === 'setup_operation_conflict' || error.message === 'agent_id_exists' ? 409 : 400, error: error.message }; } }, setupStatus: async () => postgresApplication.stores.setupState.readStatus(), completeSetup: async () => postgresApplication.stores.setupState.completeSetup() });
const modReferenceImageRoute = createModReferenceImageContentRoute({ store: () => postgresApplication.stores.referenceImages, sendJson });
const agentReferenceImageRoute = createAgentReferenceImageRoutes({ store: () => postgresApplication.stores.referenceImages, readJsonBody, sendJson });
const operatorReferenceImageRoute = createOperatorReferenceImageRoutes({ store: () => postgresApplication.stores.referenceImages, readJsonBody, sendJson });
const agentRoute = createAgentRoutes({ readJsonBody, sendJson, validateBoundaryBody, agentsStore, createAgent, updateAgent, deleteAgent, agentProfileDocuments, selectedAgentRuntime, agentStatusForSession, agentOverview });
const archiveAgentContext = createArchiveAgentContext({ agentsStore, rootDir: projectRoot });
const { archiveSessions, archiveCalendar, archiveSessionDetail, archiveRuns, archiveRunDetail, archiveDreams, archiveDreamDetail, archiveDreamGroups, archiveDreamGroupDetail, archiveWorkflowEvents, archiveContinuityCards, archiveContinuityCardDetail } = createArchiveService({
  stores: () => postgresApplication.stores, agentsStore: archiveAgentContext.agentsStore, dreamDiaryStore,
  resolveAgentRuntime: archiveAgentContext.resolveAgentRuntime, runtimeConfig: archiveAgentContext.runtimeConfig, runtimeTraceRoot, settingsKeyFromEnvironment,
  isChatMessage, compactChatTurn, summarizeSessionTurns, boundedInteger,
});
// One bounded read process owns expensive Chat Archive/Proof parsing, heap and
// a separate two-connection queue; no second authority, migrations or producers.
const archiveReadProcess = createArchiveReadProcess({ poolConfig: runtimePostgresConfig, rootDir: projectRoot,
  onResult: (res, status, error) => observeHttpResult(res, status, error ? { ok: false, error } : { ok: true }),
});
const sessionRoute = createSessionRoutes({ resolveArchiveAgentRuntime: archiveAgentContext.resolveAgentRuntime, rootDir: projectRoot, readJsonBody, sendJson, resolveAgentRuntime, runtimeAgentWorkspaceRoot, runtimeDataRoot, runtimeSessionRoot, runtimeConfig, activeConversationLimits, inspectSessionContext, inspectSessionContextStatus, activeChatRuns, searchSessionEvidence, searchBurrowSessionEvidence, agentsStore, agentRuntimeContext, archiveSessions, archiveCalendar, archiveSessionDetail, archiveRuns, archiveRunDetail, archiveDreams, archiveDreamDetail, archiveDreamGroups, archiveDreamGroupDetail, archiveWorkflowEvents, archiveContinuityCards, archiveContinuityCardDetail, listSessions, sessionDetail, sessionWriteHandoff, sessionContinuityScope, setSessionContinuityScope, clearSessionContinuityScope, sessionReadHandoff, sessionWriteHandoffCandidate, archiveSummaryForReset, archiveSummaryForSession, supersedeSessionRuns, beginSessionAdmissionsReset, finishSessionAdmissionsReset, latestAuthorityExplanationForSession, listAuthorityExplanationsForSession, conversationStore: postgresApplication.stores.conversations });
const brainRoute = createBrainRoutes({ store: postgresApplication.stores.brains, metadata: metadataStore(), embeddings: postgresApplication.stores.brainEmbeddings, readJsonBody, sendJson });
const generalSettingsRoute = createGeneralSettingsRoutes({ readJsonBody, sendJson, chatIdentities, saveChatIdentity, curatorSettings, saveCuratorSettings, tiddleSettings: async (agentId) => tiddleStatus({ agentId, stores: postgresApplication.stores, }), tiddleCards: async (query) => listTiddleCards({ ...query, stores: postgresApplication.stores, }), tiddleHistory: async (query) => tiddleHistory({ ...query, stores: postgresApplication.stores, }), uiAuthSettings, saveUiAuthSettings, uiPreferences: () => uiPreferences({ metadata: metadataStore() }), saveUiPreferences: body => saveUiPreferences(body, { metadata: metadataStore() }), browserTabSettings: () => browserTabSettings({ metadata: metadataStore() }), saveBrowserTabSettings: body => saveBrowserTabSettings(body, { metadata: metadataStore() }), otelSettings: () => otelSettings({ store: postgresApplication.stores.opentelemetry, metadata: metadataStore(), runtimeStatus: otelRuntime.status }), saveOtelSettings: async body => { let result = await saveOtelSettings(body, { store: postgresApplication.stores.opentelemetry, metadata: metadataStore(), runtimeStatus: otelRuntime.status }); if (result.ok) { try { const config = await readOtelRuntimeConfig({ store: postgresApplication.stores.opentelemetry, metadata: metadataStore() }); await withProviderErrorScope(otelDiagnosticSecrets(config), async () => { await otelRuntime.apply(config); await applyOtelConfigurationToNodeGoblins(); }); } catch (error) { serverLogger.event('otel_configuration_apply_failed', { error }); return { ok: false, status: 500, error: 'opentelemetry_configuration_apply_failed', message: classifyModelFailure(error).message }; } result = await otelSettings({ store: postgresApplication.stores.opentelemetry, metadata: metadataStore(), runtimeStatus: otelRuntime.status }); } return result; }, executionBoundarySettings, saveExecutionBoundarySettings, retentionPolicySettings, saveRetentionPolicySettings, retentionCleanup });
const observabilityRoute = createObservabilityRoutes({ providerPoolMetrics: () => postgresApplication.stores.models.providerPoolMetrics.summary(), readJsonBody, sendJson, validateBoundaryBody, runtimeStatus, runtimeMetrics, anthropicOauthUsage, openaiOauthUsage, openaiResetCredits, consumeOpenaiResetCredit, currentActiveChatRunSummaries, selectedAgentRuntime, resolveAgentRuntime, listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile, listTraces, runtimeConfig, traceRootForRun, conversationStore: postgresApplication.stores.conversations, summarizeTrace, authorityExplanationFromTraceSummary, projectRoot });
const scheduledChannelRoute = createScheduledChannelRoutes({ readJsonBody, sendJson, validateBoundaryBody, withScheduledJobs, scheduler, listGroupChannels, createGroupChannel, readGroupChannelTurns, groupChannelRuns, startGroupChannelMessage, cancelGroupChannelRun, runtimeDataRoot, conversationStore: postgresApplication.stores.conversations });
const authRoute = createAuthRoutes({ serverLogger, runtimeConfig, oidcLoginUrl, setOidcStateCookie, completeOidcCallback, sendOidcSessionCookie, clearOidcCookies, oidcCookieClearHeader, oidcSessionFromRequest, sendJson });
const chatRoute = createChatRoutes({ handleChat, readJsonBody, sendJson, selectedAgentRuntime, cancelChatRun, steerChatRun, listChatSteering, chatInputs });
const modsRuntimeRoot = process.env.BURROW_RUNTIME_ROOT || process.env.BURROW_DATA_ROOT || '/mnt/local/burrow';
const modAuthority = createModAuthority({ repositoryFactory: postgresApplication.modDistributionRepositoryFactory });
await modAuthority.ready;
const runtimeDiagnostics = Object.freeze({
  async read(input = {}, { caller, global = false } = {}) {
    const operation = String(input.operation || '');
    const callerAgentId = String(caller?.agentId || '').trim();
    if (!callerAgentId) throw Object.assign(new Error('diagnostic_caller_required'), { statusCode: 403 });
    const targetAgentId = (requested = null) => {
      const target = String(requested || callerAgentId).trim();
      if (!target || (!global && target !== callerAgentId)) throw Object.assign(new Error('diagnostic_scope_forbidden'), { statusCode: 403 });
      return target;
    };
    const agentRuntime = async (requested = null) => resolveAgentRuntime(targetAgentId(requested));
    const requireGlobal = () => { if (!global) throw Object.assign(new Error('diagnostic_global_scope_required'), { statusCode: 403 }); };
    const sessionId = () => String(input.sessionId || caller.sessionId || 'default');
    if (operation === 'health') return { ok: true, runtime: 'burrow', version: releaseVersion, buildIdentity: healthBuildIdentity, ...(healthReleaseProvenance ? { releaseProvenance: healthReleaseProvenance } : {}) };
    if (operation === 'runtime-status') {
      const status = await runtimeStatus(targetAgentId(input.agentId));
      if (!status.ok) return status;
      return { ok: true, runtime: status.runtime, version: status.version, ui: status.ui, memory: status.memory, model: status.model, policy: status.policy, retention: status.retention, traces: status.traces };
    }
    if (operation === 'metrics') return runtimeMetrics();
    if (operation === 'inventory') {
      const modInventory = await modDistribution.list();
      const installed = modInventory.mods.filter((mod) => mod.status === 'installed');
      return { ok: true, inventory: { mcp: { configured: (await mcpStore().list()).length }, mods: { installed: installed.length, enabled: installed.filter((mod) => mod.enabled === true).length } } };
    }
    if (operation === 'postgres-status') return postgresDiagnostic(postgresApplication.pool);
    if (operation === 'brains-status') return brainDiagnosticSummary(postgresApplication.pool, { agentId: targetAgentId(input.agentId) });
    if (operation === 'brain-memories') return brainDiagnosticMemories(postgresApplication.pool, { agentId: targetAgentId(input.agentId), limit: input.limit, cursor: input.cursor });
    if (operation === 'brain-embedding-jobs') return brainDiagnosticEmbeddingJobs(postgresApplication.pool, { agentId: targetAgentId(input.agentId), limit: input.limit, cursor: input.cursor });
    if (operation === 'forge-jobs') { requireGlobal(); return forgeDiagnosticJobs(postgresApplication.pool, { limit: input.limit, cursor: input.cursor }); }
    if (operation === 'forge-job') { requireGlobal(); return forgeDiagnosticJob(postgresApplication.pool, input.jobId); }
    if (operation === 'mods') return { ok: true, mods: diagnosticMods(modLifecycle.getMods()) };
    if (operation === 'mod-jobs') { requireGlobal(); return { ok: true, ...await modJobs(modLifecycle.getMods(), input.modId, { limit: input.limit, cursor: input.cursor }) }; }
    if (operation === 'mod-job') { requireGlobal(); return { ok: true, ...await modJobs(modLifecycle.getMods(), input.modId, { jobId: input.jobId }) }; }
    if (operation === 'mod-pending') { requireGlobal(); return { ok: true, ...pendingModOperations(modLifecycle.getMods(), input.modId) }; }
    if (operation === 'agents') return { ok: true, agents: await agentsStore().list({ includeDisabled: input.includeDisabled !== false }) };
    if (operation === 'agent-status') { const runtime = await agentRuntime(input.agentId); return { ok: true, ...(await agentStatusForSession(sessionId(), runtime)) }; }
    if (operation === 'sessions') {
      const runtime = await agentRuntime(input.agentId);
      const sessions = await listSessions({ rootDir: runtime.agentWorkspaceRoot, agentId: runtime.agentId, includeArchived: input.archived === true, limit: input.limit });
      return { ok: true, sessions: runtimeDiagnosticSessionSummaries(sessions) };
    }
    if (operation === 'session') { const runtime = await agentRuntime(input.agentId); const value = await runtimeDiagnosticSessionDetail(postgresApplication.stores.conversations, { agentId: runtime.agentId, sessionId: sessionId(), limit: input.limit, maxContentChars: input.maxContentChars }); return value ? { ok: true, session: value } : { ok: false, error: 'not_found' }; }
    if (operation === 'active-runs') return { ok: true, ...runtimeDiagnosticActiveRuns(await currentActiveChatRunSummaries({ agentId: targetAgentId(input.agentId), sessionId: input.sessionId || null })) };
    if (operation === 'traces') { const runtime = await agentRuntime(input.agentId); const config = await runtimeConfig(runtime.agentId); return { ok: true, ...await runtimeDiagnosticTraces({ traceRoot: runtimeTraceRoot(config, sessionId(), runtime.agentId), agentId: runtime.agentId, sessionId: sessionId(), limit: input.limit, cursor: input.cursor }) }; }
    if (operation === 'trace' || operation === 'trace-authority') {
      const runtime = await agentRuntime(input.agentId); const runId = String(input.runId || '');
      if (!validTraceRunId(runId)) throw Object.assign(new Error('trace_run_id_invalid'), { statusCode: 400 });
      const config = await runtimeConfig(runtime.agentId);
      const trace = await summarizeTrace({ conversationStore: postgresApplication.stores.conversations, agentId: runtime.agentId, rootDir: await traceRootForRun({ rootDir: runtime.agentWorkspaceRoot, sessionId: sessionId(), runId, runtime: config, agentId: runtime.agentId }), runId, includeToolOutput: operation === 'trace' && input.includeToolOutput === true });
      return operation === 'trace' ? { ok: true, trace } : { ok: true, runId, authority: authorityExplanationFromTraceSummary(trace) };
    }
    if (operation === 'run-proofs') { const runtime = await agentRuntime(input.agentId); const query = new URLSearchParams({ agentId: runtime.agentId, limit: String(input.limit || 100) }); if (input.sessionId) query.set('sessionId', input.sessionId); if (input.cursor) query.set('cursor', input.cursor); return archiveReadProcess.request('/api/archive/runs?' + query); }
    if (operation === 'run-proof') { const runtime = await agentRuntime(input.agentId); return archiveReadProcess.request('/api/archive/runs/' + encodeURIComponent(String(input.runId || '')) + '?agentId=' + encodeURIComponent(runtime.agentId)); }
    if (operation === 'session-context' || operation === 'context-status') {
      const runtime = await agentRuntime(input.agentId); const config = await runtimeConfig(runtime.agentId); const sid = sessionId();
      const limits = activeConversationLimits({ modelConfig: config.modelConfig, contextConfig: config.contextConfig });
      const active = [...activeChatRuns.values()].find((run) => run.agentId === runtime.agentId && run.sessionId === sid && !run.controller.signal.aborted) || null;
      const status = runtimeDiagnosticContextSummary(await inspectSessionContextStatus({ conversationStore: postgresApplication.stores.conversations, agentId: runtime.agentId, rootDir: projectRoot, dataRoot: runtime.agentWorkspaceRoot, sessionId: sid, limits, contextConfig: config.contextConfig, contextWindow: config.modelConfig?.contextWindow, contextTokens: config.modelConfig?.contextTokens, liveContext: active?.contextUsage || null }));
      return operation === 'session-context' ? { ok: true, context: status } : { ok: true, status };
    }
    throw Object.assign(new Error('diagnostic_operation_invalid'), { statusCode: 400 });
  },
});
// Stable Core facade survives all requesting mod host replacements. Activation
// cannot call it: management requires an active trusted tool invocation.
let coreModManagement = null;
const modManagementCapability = Object.freeze(Object.fromEntries(['inventory', 'submit', 'operation'].map(method => [method, (...args) => {
  if (!coreModManagement) throw new Error('mod_management_unavailable');
  return coreModManagement[method](...args);
}])));
const coreApi = createCoreApiDispatcher({
  handleRequest,
  trackRequest: (operation, phase) => requestLifecycle.track(operation, phase),
  onComplete: ({ method, route, status, actor }) => serverLogger.event('core_api_request', {
    method, route, status, modId: actor?.ownerModId, agentId: actor?.caller.agentId,
    sessionId: actor?.caller.sessionId, runId: actor?.caller.runId,
  }, { component: 'api' }),
});
const modLoadOptions = { coreApi, logger: serverLogger, modAuthority, modManagement: modManagementCapability, onExecutionProviderActivated: async modId => { if (modId === 'node-goblin') await applyOtelConfigurationToNodeGoblins(); }, stores: postgresApplication.stores, modStoreFactory: postgresApplication.modStoreFactory, enabledModIds: postgresApplication.enabledModIds, modCatalogWriter: postgresApplication.modCatalogWriter, runtimeRoot: modsRuntimeRoot, executionProviders, resolveAgentRuntime, scheduledJobScheduler: scheduler(), externalTurnDispatcher, generationDispatcher, runtimeDiagnostics, activeAgentRuns: activeChatRuns, pendingHttpRuns: () => completionDispatch?.pendingHttpRuns() || [], resolveAgentWorkspaceRoot: async (id) => {
  const agent = await agentsStore().get(id);
  if (!agent) throw new Error('agent_not_found');
  return agentRuntimeContext({ runtimeState: (await runtimeConfig()).runtimeState, agent }).agentWorkspaceRoot;
} };
const modLifecycle = createModLifecycleService({
  modLoadOptions, logger: serverLogger,
  getManagedSkillRoot: async () => path.join((await runtimeConfig()).runtimeState.workspaceRoot, 'global', 'managed-skills'),
  managedSkillSyncIntervalMs: Math.max(60_000, Number(process.env.BURROW_MANAGED_SKILL_SYNC_INTERVAL_MS || 6 * 60 * 60 * 1000)),
});
const managedSkillSynchronizer = modLifecycle.managedSkillSynchronizer;
const modRoute = createModRoute({ getMods: modLifecycle.getMods, readJsonBody, sendJson });
const modDistribution = createModDistribution({
  logger: serverLogger,
  runtimeRoot: modsRuntimeRoot,
  repositoryFactory: postgresApplication.modDistributionRepositoryFactory,
  onLifecycleChange: modLifecycle.transition,
  resolveSecretReference: reference => resolveSecretReference(modLifecycle.getMods(), reference),
});
// Complete durable uninstall reconciliation before accepting requests. The
// callback above is self-contained and does not call back into the distribution,
// so this readiness barrier cannot form a lifecycle/distribution cycle.
await modDistribution.ready;
await migrateLegacyExecutionProviderApproval({
  repositoryFactory: postgresApplication.modDistributionRepositoryFactory,
  mods: await discoverMods({ runtimeRoot: modsRuntimeRoot, logger: serverLogger }),
  agents: await agentsStore().list({ includeDisabled: true }),
});
await modLifecycle.initialize();
completionDispatch = createAgentRunCompletionDispatch({ feed: postgresApplication.stores.agentRuns,
  activeRuns: activeChatRuns, getHosts: () => modLifecycle.getMods().filter(mod => mod.status === 'loaded').map(mod => mod.host) });
await managedSkillSynchronizer.tick();
await applyOtelConfigurationToNodeGoblins();
modLifecycle.markReady();
coreModManagement = createModManagement({ logger: serverLogger, modAuthority, distribution: modDistribution, repositoryFactory: postgresApplication.modDistributionRepositoryFactory });
await coreModManagement.ready;
const modAuthorityRoute = createModAuthorityRoute({ authority: modAuthority, getMods: () => modLifecycle.getMods(), readJsonBody, sendJson });
const modManagementDistribution = {
  ...modDistribution,
  listSecretReferences: scheme => listSecretReferences(modLifecycle.getMods(), { scheme }),
  async list() {
    const result = await modDistribution.list();
    const workspaceRoot = (await runtimeConfig()).runtimeState.workspaceRoot;
    const managedRoot = path.join(workspaceRoot, 'global', 'managed-skills');
    const loadedById = new Map(modLifecycle.getMods().map(mod => [mod.id, mod]));
    return {
      ...result,
      mods: await Promise.all(result.mods.map(async mod => {
        const declarations = loadedById.get(mod.id)?.managedSkills || [];
        if (!declarations.length) return mod;
        const installed = await inspectManagedSkills({ root: managedRoot, declarations });
        const managedSkillVersion = installed.length === 1 ? installed[0].version : null;
        return managedSkillVersion ? { ...mod, managedSkillVersion } : mod;
      })),
    };
  },
};
const modManagementRoute = createModManagementRoute({ distribution: modManagementDistribution, readJsonBody, sendJson });

const server = createServer((req, res) => {
  instrumentHttpResponse({ req, res, logger: serverLogger });
  void requestLifecycle.track(async () => {
    try { await withProviderErrorScope(postgresDiagnosticSecrets(runtimePostgresConfig), () => handleRequest(req, res)); }
    catch (error) { recordHttpFailure(res, { error, status: 500 }); res.destroy(error); }
  }).catch(() => {});
});
async function handleRequest(req, res) {
  let diagnosticsAuthorized = false;
  if (shuttingDown) return sendJson(res, 503, { ok: false, error: 'runtime_shutting_down' });
  try {
    const internal = coreApiCaller(req);
    // Only Core-created request objects can take this path. No header/token/
    // cookie or mod-owned HTTP route can mint this trusted caller identity.
    const authority = internal ? { protocol: 'http:', authority: 'core-api.invalid' }
      : hostAuthorityPolicy(req, authorityConfig, authorityConfig.enabled ? (await runtimeConfig()).ui.authMode : 'none');
    if (authority.error) return sendJson(res, authority.status, { ok: false, error: authority.error });
    const url = new URL(req.url || '/', `${authority.protocol}//${authority.authority || `${host}:${port}`}`);
    // Absolute-form request targets cannot override the checked authority.
    if (authorityConfig.enabled && url.host !== authority.authority) return sendJson(res, 403, { ok: false, error: 'host_authority_not_allowed' });
    const origin = `${url.protocol}//${url.host}`;
    if (!internal && await applyApiCors(req, res, url)) return;
    if (internal && req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try { if (await authRoute({ req, res, url, origin })) return; }
    catch (error) { req.operationalFailureLogged = true; throw error; } // Auth routes already emit safe auth.failure.
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) return sendJson(res, 200, { ok: true, runtime: 'burrow', version: releaseVersion, buildIdentity: healthBuildIdentity, ...(healthReleaseProvenance ? { releaseProvenance: healthReleaseProvenance } : {}), ...(process.env.BURROW_SMOKE_TOKEN && req.headers['x-burrow-smoke-token'] === process.env.BURROW_SMOKE_TOKEN ? { smokeToken: process.env.BURROW_SMOKE_TOKEN } : {}) });
    if (await completionEventRoute({ req, res, url, webhookOnly: true })) return;
    if (!internal && !(await authorizeRequest(req, res, url))) return;
    diagnosticsAuthorized = true;
    if (await completionEventRoute({ req, res, url })) return;
    if (req.method === 'GET' && url.pathname === '/api/auth/validate') {
      const runtime = await runtimeConfig();
      const mode = runtime?.ui?.authMode || 'none';
      if (mode === 'none') return sendJson(res, 401, { ok: false, error: 'authentication_not_enabled', auth: { mode, enabled: false, authenticated: false } });
      return sendJson(res, 200, { ok: true, auth: { mode, enabled: true, authenticated: req.burrowVerifiedAuth?.authenticated === true, ...(internal ? { authorized: true, actor: { type: 'agent', id: internal.caller.agentId } } : {}) } });
    }
    if (await forgeRoute({ req, res, url })) return;
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (await serveV18Asset(url, res)) return;
      return sendJson(res, 404, { ok: false, error: 'ui_artifact_not_found' });
    }
    if (req.method === 'GET' && ['/api/diagnostics/brains', '/api/diagnostics/brains/memories', '/api/diagnostics/brains/embedding-jobs'].includes(url.pathname)) {
      try {
        const params = url.searchParams;
        if ([...params.keys()].some(key => !['agentId', 'limit', 'cursor'].includes(key)) ||
            [...new Set(params.keys())].some(key => params.getAll(key).length !== 1) ||
            (url.pathname === '/api/diagnostics/brains' && (params.has('limit') || params.has('cursor'))))
          return sendJson(res, 400, { ok: false, error: 'invalid_diagnostics_query' });
        const options = { ...(params.has('agentId') ? { agentId: params.get('agentId') } : {}),
          ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
          ...(params.has('cursor') ? { cursor: params.get('cursor') } : {}) };
        const diagnostic = url.pathname === '/api/diagnostics/brains' ? brainDiagnosticSummary
          : url.pathname === '/api/diagnostics/brains/memories' ? brainDiagnosticMemories : brainDiagnosticEmbeddingJobs;
        return sendJson(res, 200, await diagnostic(postgresApplication.pool, options));
      } catch (error) { return sendJson(res, error.statusCode || 500, { ok: false, error: error.statusCode ? classifyModelFailure(error).message : 'brain_diagnostics_unavailable', message: classifyModelFailure(error).message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/diagnostics/postgres') return sendJson(res, 200, await postgresDiagnostic(postgresApplication.pool));
    if (req.method === 'GET' && url.pathname === '/api/diagnostics/forge/jobs') {
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
      const cursor = url.searchParams.get('cursor') || undefined;
      try { return sendJson(res, 200, await forgeDiagnosticJobs(postgresApplication.pool, { limit, cursor })); }
      catch (error) { return sendJson(res, error.statusCode || 500, { ok: false, error: error.statusCode ? classifyModelFailure(error).message : 'forge_diagnostics_unavailable', message: classifyModelFailure(error).message }); }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/diagnostics/forge/jobs/')) {
      try { return sendJson(res, 200, await forgeDiagnosticJob(postgresApplication.pool, url.pathname.slice('/api/diagnostics/forge/jobs/'.length))); }
      catch (error) { return sendJson(res, error.statusCode || 500, { ok: false, error: error.statusCode ? classifyModelFailure(error).message : 'forge_diagnostics_unavailable', message: classifyModelFailure(error).message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/diagnostics/mods') return sendJson(res, 200, { ok: true, mods: diagnosticMods(modLifecycle.getMods()) });
    if (req.method === 'GET' && /^\/api\/diagnostics\/mods\/[a-z0-9-]+\/pending$/.test(url.pathname)) {
      try { return sendJson(res, 200, { ok: true, ...pendingModOperations(modLifecycle.getMods(), url.pathname.split('/')[4]) }); }
      catch (error) { return sendJson(res, error.statusCode || 500, { ok: false, error: error.statusCode ? classifyModelFailure(error).message : 'mod_diagnostics_unavailable', message: classifyModelFailure(error).message }); }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/diagnostics/mods/')) {
      const match = /^\/api\/diagnostics\/mods\/([a-z0-9-]+)\/jobs(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname);
      if (!match) return sendJson(res, 404, { ok: false, error: 'not_found' });
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
      const cursor = url.searchParams.has('cursor') ? url.searchParams.get('cursor') : undefined;
      try { return sendJson(res, 200, { ok: true, ...await modJobs(modLifecycle.getMods(), match[1], { jobId: match[2], limit, cursor }) }); }
      catch (error) { return sendJson(res, error.statusCode || 500, { ok: false, error: error.statusCode ? classifyModelFailure(error).message : 'mod_diagnostics_unavailable', message: classifyModelFailure(error).message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/diagnostics/inventory') {
      const mcpConfigured = (await mcpStore().list()).length;
      const modInventory = await modDistribution.list();
      const installedMods = modInventory.mods.filter((mod) => mod.status === 'installed');
      return sendJson(res, 200, {
        ok: true,
        inventory: {
          mcp: { configured: mcpConfigured },
          mods: { installed: installedMods.length, enabled: installedMods.filter((mod) => mod.enabled === true).length },
        },
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/settings/api-tokens') {
      const store = postgresApplication.stores.apiTokens;
      try { return sendJson(res, 200, { ok: true, supportedScopes: API_TOKEN_SCOPES, tokens: await store.list() }); }
      finally { await store.close?.(); }
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/api-tokens') {
      const store = postgresApplication.stores.apiTokens;
      try { return sendJson(res, 201, { ok: true, token: await store.create(await readJsonBody(req)) }); }
      finally { await store.close?.(); }
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/settings/api-tokens/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/settings/api-tokens/'.length));
      const store = postgresApplication.stores.apiTokens;
      try {
        const token = await store.revoke(id);
        return sendJson(res, token ? 200 : 404, token ? { ok: true, token } : { ok: false, error: 'api_token_not_found' });
      } finally { await store.close?.(); }
    }
    if (await modAuthorityRoute({ req, res, url })) return;
    if (await modManagementRoute({ req, res, url })) return;
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
      const turns = (await postgresApplication.stores.conversations.exportTranscript({ agentId: agentRuntime.agentId, sessionId }))?.entries || [];
      return sendJson(res, 200, { ok: true, agentId: agentRuntime.agentId, sessionId, attachments: await listSessionAttachments({ agentWorkspaceRoot: agentRuntime.agentWorkspaceRoot, sessionTurns: turns, sessionId, limit: url.searchParams.get('limit') || 200 }) });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/generated-artifacts/')) {
      const parts = url.pathname.slice('/api/generated-artifacts/'.length).split('/').map(decodeURIComponent);
      const [agentId, ...referenceParts] = parts;
      const storageReference = referenceParts.join('/');
      if (!agentId || !storageReference) return sendJson(res, 400, { ok: false, error: 'artifact_target_required' });
      const agentRuntime = await resolveAgentRuntime(agentId);
      const artifact = await resolveGeneratedArtifact({ agentWorkspaceRoot: agentRuntime.agentWorkspaceRoot, storageReference });
      if (!artifact) return sendJson(res, 404, { ok: false, error: 'artifact_not_found' });
      return sendStaticFile(res, artifact.filePath, { downloadName: artifact.name });
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
    if (await modReferenceImageRoute({ req, res, url })) return;
    if (await operatorReferenceImageRoute({ req, res, url })) return;
    if (await agentReferenceImageRoute({ req, res, url })) return;
    if (await agentRoute({ req, res, url })) return;
    if (await archiveReadProcess.route({ req, res, url })) return;
    if (await sessionRoute({ req, res, url })) return;
    if (await brainRoute({ req, res, url })) return;
    if (await generalSettingsRoute({ req, res, url })) return;
    if (await dreamRoute({ req, res, url })) return;
    if (await skillSourceRoute({ req, res, url })) return;
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
    const failure = httpFailureResponse(error, { authorized: diagnosticsAuthorized });
    recordHttpFailure(res, { error: new Error(classifyModelFailure(error).message || 'http_request_failed'), status });
    return sendJson(res, status, failure);
  }
}

let shuttingDown = false;
const configuredShutdownDrainMs = Number(process.env.BURROW_SHUTDOWN_DRAIN_MS || 10_000);
const SHUTDOWN_DRAIN_MS = Number.isFinite(configuredShutdownDrainMs) ? Math.max(1_000, configuredShutdownDrainMs) : 10_000;
let shutdownReason = 'service_shutdown';
let httpClosePromise = null;
// These existing producer close methods stop polling and drain their retained
// work. Invoke them in the stop phase, not after other stores start closing.
function closeOnlyProducer(resource) {
  let closing = null;
  return { stop() { closing ||= Promise.resolve().then(() => resource.close()); closing.catch(() => {}); }, close() { this.stop(); return closing; } };
}
const openaiResetScheduler = startOpenAiResetScheduler(pollExpiringResets);
const archiveReadProducer = closeOnlyProducer(archiveReadProcess);
const skillSyncProducer = closeOnlyProducer(skillGitSync);
const modDistributionProducer = closeOnlyProducer({ async close() {
  // Drain durable work while hosts and PostgreSQL remain alive. Host teardown
  // must not cancel a submitted operation, including manager self-updates.
  try { await coreModManagement.close(); }
  finally { await modDistribution.close(); }
} });
const closeRuntimeResources = createCoordinatedShutdown({
  drainMs: SHUTDOWN_DRAIN_MS,
  stopAdmission: () => {
    shuttingDown = true;
    httpClosePromise = new Promise(resolve => server.close(() => resolve()));
    server.closeIdleConnections?.();
  },
  producers: () => [openaiResetScheduler, archiveReadProducer, skillSyncProducer, managedSkillSynchronizer, modDistributionProducer, completionEventRunner, chatInputRunner, externalTurnDispatcher, generationDispatcher, requestLifecycle, startupLifecycle, scheduledJobScheduler, dreamCycleScheduler, tiddleScheduler, retentionScheduler, installStagingCleanupScheduler, recoveryContinuationScheduler, versionRefreshProducer],
  beforeDrain: async () => {
    try {
      await recordActiveRunInterruptions({ stores: postgresApplication.stores, activeRuns: activeChatRuns, resolveAgentRuntime, reason: shutdownReason });
    } finally {
      // Failed recovery persistence must not leave a producer uncancelled.
      for (const record of [...activeChatRuns.values(), ...groupChannelRuns.values()]) record.controller?.abort(new Error('service_shutdown'));
    }
  },
  drainAdmission: () => httpClosePromise,
  closers: () => [() => archiveReadProcess.close(), () => cleanupMods(modLifecycle.getMods(), { logger: serverLogger }), () => otelRuntime.shutdown(), () => postgresApplication.close()],
  onTimeout: () => server.closeAllConnections?.(),
});
let shutdownPromise = null;
function shutdownRuntime(signal, { exitCode = signal === 'SIGINT' ? 130 : signal === 'unhandledRejection' ? 1 : 0 } = {}) {
  if (shutdownPromise) return shutdownPromise;
  shutdownReason = signal === 'SIGINT' ? 'service_interrupt' : 'service_shutdown';
  const drain = closeRuntimeResources(); // Stop admission synchronously, before logging.
  shutdownPromise = (async () => {
    try {
      await serverLogger.event('shutdown_started', { signal, activeRuns: activeChatRuns.size });
      const { forced, errors } = await drain;
      if (errors.length) {
        exitCode ||= 1;
        await serverLogger.event('shutdown_error', { signal, errors });
      }
      await serverLogger.event(forced ? 'shutdown_forced' : 'shutdown_complete', { signal, forced, drainMs: SHUTDOWN_DRAIN_MS }, { level: forced ? 'warn' : 'info' });
    } catch (error) {
      await serverLogger.event('shutdown_recovery_failed', { signal, error }); exitCode ||= 1;
      await drain;
    } finally { await serverLogger.flush().catch(() => {}); process.exit(exitCode); }
  })();
  return shutdownPromise;
}
runtimeShutdownHandler = shutdownRuntime;
process.once('SIGTERM', () => { void shutdownRuntime('SIGTERM'); });
process.once('SIGINT', () => { void shutdownRuntime('SIGINT'); });

// A duplicate launcher/service must not become an unhandled EventEmitter
// exception that buries the actual bind conflict in a Node stack trace.
server.once('error', (error) => {
  const { errorCode: code } = safeOperationalError(error, 'listener_failed');
  const detail = code === 'EADDRINUSE'
    ? `Burrow UI could not bind ${host}:${port}: address already in use.`
    : `Burrow UI failed to listen on ${host}:${port}: ${code}.`;
  void serverLogger.event('listener_error', { host, port, error }).finally(() => { console.error(detail); process.exit(1); });
});

server.on('clientError', (error, socket) => { void serverLogger.event('client_error', { error }); socket?.destroy(); });
server.on('connection', (socket) => { socket.once('error', (error) => { void serverLogger.event('socket_error', { error }); }); });
// Direct server/Docker startup must publish bundled skills just like the installer.
const bundledSkillRuntime = await runtimeConfig();
await ensureDefaultGlobalWorkspace({ installDir: projectRoot, workspaceRoot: bundledSkillRuntime.runtimeState.workspaceRoot, skillStore: postgresApplication.stores.skills });

server.listen(port, host, () => {
  void startupLifecycle.track(async () => {
  try {
  await serverLogger.event('startup_summary', {
    version: releaseVersion, authMode: bundledSkillRuntime.ui.authMode, authSource: bundledSkillRuntime.ui.authSource,
    environmentOverride: Object.keys(process.env).some(key => key.startsWith('BURROW_UI_AUTH_') && Boolean(process.env[key])),
    database: 'ready', schedulers: backgroundSchedulersEnabled() ? 'enabled' : 'disabled',
    mods: { total: modLifecycle.getMods().length, loaded: modLifecycle.getMods().filter(mod => mod.status === 'loaded').length,
      disabled: modLifecycle.getMods().filter(mod => mod.status === 'disabled').length, failed: modLifecycle.getMods().filter(mod => mod.status === 'failed').length },
  });
  await serverLogger.event('listener_started', { host, port, pid: process.pid, version: releaseVersion });
  const forgeDelivery = await postgresApplication.stores.forge.reconcileChatDeliveries();
  if (forgeDelivery.failed) await serverLogger.event('forge_delivery_recovery_failed', forgeDelivery, { level: 'warn', component: 'forge' });
  await postgresApplication.stores.dreamCycles.reconcileInterrupted();
  if (shuttingDown) return;
  if (backgroundSchedulersEnabled()) {
    void managedSkillSynchronizer.start().catch(() => {}); // Synchronizer owns failure/recovery diagnostics.
    void skillGitSync.start().catch(error => serverLogger.event('skill_sync_startup_failed',{ error }, { level: 'warn', component: 'skills' }));
    const store = postgresApplication.stores.scheduledJobs;
    try { await postgresApplication.stores.tasks.reconcileInterruptedExecutions(); await store.markMissedRuns(); await store.markMissedSchedules({ activeOwnerModIds: modLifecycle.getMods().filter((mod) => mod.status === 'loaded').map((mod) => mod.id) }); } finally { /* Shared application store remains open. */ }
    if (shuttingDown) return;
    await completionEventRunner.start();
    await chatInputRunner.start();
    if (shuttingDown) return;
    await scheduler().start();
    if (shuttingDown) return;
    await dreamScheduler().start();
    if (shuttingDown) return;
    await rollingContinuityScheduler().start();
    // Attachment cleanup shares the existing retention scheduler.
    if (shuttingDown) return;
    await retentionPolicyScheduler().start();
    if (shuttingDown) return;
    await installerStagingScheduler().start();
    if (shuttingDown) return;
    startCodexClientVersionRefresh();
  }
  console.log(`Burrow UI listening on http://${host}:${port}`);
  // Recovery uses the same durable per-session queue and runtime turn path as
  // ordinary chat. It starts only after the listener is live, and a queue claim
  // prevents duplicate recovery when startup is retried.
  if (shuttingDown) return;
  recoveryContinuationScheduler = createRecoveryContinuationScheduler({ resolveOptions: async () => ({
    stores:postgresApplication.stores,
    agentRuntimes: (await Promise.allSettled((await agentsStore().list({ includeDisabled: false })).map((agent) => resolveAgentRuntime(agent.id)))).filter(result => result.status === 'fulfilled').map(result => result.value),
    createRunId: createChatTurnRunId,
    cancellationGraceMs: Math.min(RUN_CANCELLATION_GRACE_MS, Math.max(0, SHUTDOWN_DRAIN_MS - 1_000)),
    runContinuation: async ({ runtime, sessionId, runId, manifest, continuation, signal }) => {
      const recoveryInstruction = continuation?.decision === 'resume'
        ? 'Continue the interrupted work using the runtime recovery record and bounded same-session transcript.'
        : 'Recover the interrupted work using the runtime recovery record. Reconcile durable state before acting; do not repeat completed work blindly.';
      const lifecycle = registerRuntimeActiveRun({ agentId: runtime.agentId, sessionId, runId, message: `Recover interrupted run: ${manifest.objective || 'reconcile durable state'}`, objective: manifest.objective || null, source: 'recovery', parentSignal: signal });
      try {
        return await runChatTurnFromBody({
          stores:postgresApplication.stores,
          body: { message: recoveryInstruction, sessionId, runId, abortSignal: lifecycle.signal },
          rootDir: projectRoot, agentRuntime: runtime, resolveAgentRuntime,
          telemetry: otelRuntime, runSource: 'recovery',
          onTraceRecord: lifecycle.onTraceRecord, onModelTextDelta: lifecycle.onModelTextDelta,
          onModelThoughtDelta: lifecycle.onModelThoughtDelta, onModelContextUsage: lifecycle.onModelContextUsage,
          onSteeringReady: lifecycle.onSteeringReady,
          cancellationGraceMs: lifecycle.cancellationGraceMs,
          onCancellationDeadline: lifecycle.onCancellationDeadline,
          registerNestedAgentRun: ({ agentRuntime: nestedRuntime, sessionId: nestedSessionId, runId: nestedRunId, message, source, ...a2a }) => registerRuntimeActiveRun({ agentId: nestedRuntime.agentId, sessionId: nestedSessionId, runId: nestedRunId, message, source, a2a: source === 'a2a' ? a2a : null }),
        });
      } finally { lifecycle.finish(); }
    },
  }) });
  void recoveryContinuationScheduler.start().catch(error => { if (!shuttingDown) void serverLogger.event('recovery_scheduler_start_failed', { error }); });
  } catch (error) { void serverLogger.event('startup_failed', { error }); void shutdownRuntime('startup_failure', { exitCode: 1 }); }
  }).catch(() => {});
});

