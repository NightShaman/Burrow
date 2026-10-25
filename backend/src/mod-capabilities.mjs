import { isInternalContextSession } from './model-context-boundary.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readModConversationPage } from './mod-conversation-pager.mjs';
import { MODEL_REASONING_EFFORT_VALUES, modelSupportsTemperature, normalizeModelReasoningEffort, resolveModelConfig } from './config.mjs';
import { createModelAdapter } from './model-adapter.mjs';

function invalid() { throw new Error('mod_capability_input_invalid'); }
function bounded(value, max) { if (typeof value !== 'string' || !value || value.length > max) invalid(); return value; }
function count(value, fallback, max) { if (value === undefined) return fallback; if (!Number.isInteger(value) || value < 1 || value > max) invalid(); return value; }
function positiveSafeInteger(value) { if (value === undefined) return undefined; if (!Number.isSafeInteger(value) || value < 1) invalid(); return value; }
function optionalTemperature(value) { if (value === undefined) return undefined; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) invalid(); return value; }
function exactKeys(value, allowed) { if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(); return value; }
function publicReasoningEfforts(value) { return [...new Set((Array.isArray(value) ? value : []).map((item) => typeof item === 'string' ? item.trim().toLowerCase() : '').filter((item) => MODEL_REASONING_EFFORT_VALUES.includes(item)))]; }
function plain(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value; }
const SCHEDULER_PAGE_MAX_BYTES = 240_000;
function resultBytes(value) { return Buffer.byteLength(JSON.stringify(value)); }
function boundedDiagnosticText(value, max = 512) { return typeof value === 'string' ? value.slice(0, max) : null; }
function safeProviderErrorDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of ['type', 'code', 'param', 'eventType', 'responseStatus']) {
    const item = value[key];
    if (typeof item === 'string' && item) out[key] = boundedDiagnosticText(item, 128);
  }
  for (const key of ['status']) {
    const item = value[key];
    if (Number.isInteger(item) || (typeof item === 'string' && item)) out[key] = item;
  }
  return Object.keys(out).length ? out : null;
}
function parseLimitError(error) {
  const match = /^([a-z0-9_]+):(\d+)>(\d+)$/.exec(String(error || ''));
  return match ? { code: match[1], bytes: Number(match[2]), limit: Number(match[3]) } : null;
}
function modelGenerationFailure(result = {}, reason = 'model_generation_failed') {
  const error = new Error('mod_model_generation_failed');
  const limit = parseLimitError(result.error);
  const providerDetails = safeProviderErrorDetails(result.raw?.error?.details);
  const status = Number(result.status);
  const cause = limit ? 'output_limit' : Number.isInteger(status) && status >= 400 ? 'provider_rejection' : reason;
  error.details = {
    version: 1,
    cause,
    ...(typeof result.provider === 'string' ? { provider: boundedDiagnosticText(result.provider, 64) } : {}),
    ...(typeof result.api === 'string' ? { api: boundedDiagnosticText(result.api, 64) } : {}),
    ...(typeof result.model === 'string' ? { model: boundedDiagnosticText(result.model, 256) } : {}),
    ...(typeof result.requestId === 'string' ? { requestId: boundedDiagnosticText(result.requestId, 128) } : {}),
    ...(Number.isInteger(status) ? { status } : {}),
    ...(typeof result.choice?.finishReason === 'string' ? { finishReason: boundedDiagnosticText(result.choice.finishReason, 128) } : {}),
    ...(limit ? { outputLimit: { code: limit.code, bytes: limit.bytes, limit: limit.limit } } : {}),
    ...(providerDetails ? { providerError: providerDetails } : {}),
  };
  return error;
}
function summarizedRun(run) {
  return {
    id: run.id,
    jobId: run.jobId,
    scheduledFor: run.scheduledFor,
    status: run.status,
    agentId: run.agentId,
    sessionId: run.sessionId,
    runId: run.runId,
    dispatchedAt: run.dispatchedAt,
    completedAt: run.completedAt,
    ok: run.ok,
    error: run.error ? String(run.error).slice(0, 1024) : null,
    result: { truncated: true, reason: 'scheduled_job_run_output_limit' },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

// Only this core-side service has access to PostgreSQL secrets and provider credentials.
export function createModCapabilities({ resolveAgentRuntime, resolveAgentWorkspaceRoot, fetchImpl = fetch, ownerModId, scheduledJobScheduler = null, externalTurnDispatcher = null, generationDispatcher = null, stores = null, modStore = null, runtimeDiagnostics = null, modManagement = null, modAuthority = null } = {}) {
  if (typeof resolveAgentRuntime !== 'function') throw new Error('mod_agent_resolver_required');
  const injected = stores || {};
  for (const key of ['agents','models','scheduledJobs','conversations']) if (!injected[key]) throw new Error(`mod_${key}_store_required`);
  const generateTextImpl = createModTextGenerator({ models: injected.models, fetchImpl });
  const withStore = async (key, fn) => fn(injected[key]);
  const withJobs = (fn) => withStore('scheduledJobs', fn);
  const conversationStore = injected.conversations;
  const schedulerOwner = () => { if (typeof ownerModId !== 'string' || !ownerModId) throw new Error('mod_scheduler_owner_unavailable'); return ownerModId; };
  const forgeOwner = () => { if (typeof ownerModId !== 'string' || !ownerModId) throw new Error('mod_forge_owner_unavailable'); return ownerModId; };
  const forgeKeyPrefix = () => `mod:${forgeOwner()}:`;
  const forgeStore = () => { if (!injected.forge) throw new Error('forge_unavailable'); return injected.forge; };
  function projectForgeImageJob(store, job) {
    const prefix = forgeKeyPrefix();
    if (!job || job.kind !== 'image' || job.modOwnerId !== forgeOwner() || typeof job.idempotencyKey !== 'string' || !job.idempotencyKey.startsWith(prefix)) throw new Error('forge_job_not_found');
    const projected = store.public(job);
    return {
      id: projected.id,
      kind: 'image',
      status: projected.status,
      createdAt: projected.createdAt,
      updatedAt: projected.updatedAt,
      error: projected.error || null,
      artifacts: (projected.artifacts || []).map(({ id, kind, name, mimeType, sizeBytes, previewUrl }) => ({ id, kind, name, mimeType, sizeBytes, previewUrl })),
    };
  }
  async function readRuntimeDiagnostics(input, { caller, signal } = {}) {
    if (!runtimeDiagnostics?.read || !modAuthority || !caller?.agentId) throw new Error('mod_diagnostic_caller_required');
    const value = plain(input);
    const global = await modAuthority.allowed(ownerModId, 'diagnostics-global', caller.agentId);
    try {
      return await runtimeDiagnostics.read(value, { caller: Object.freeze({ agentId: caller.agentId, sessionId: caller.sessionId || 'default', conversationId: caller.conversationId || null, runId: caller.runId || null }), global, signal });
    } catch (error) {
      if (!global && ['diagnostic_scope_forbidden', 'diagnostic_global_scope_required'].includes(error?.message)) await modAuthority.deny(ownerModId, 'diagnostics-global', caller.agentId);
      throw error;
    }
  }
  async function manage(method, input, { caller, assertCallerActive, waitForCaller } = {}) {
    if (!modManagement || !modAuthority || !caller?.agentId || typeof assertCallerActive !== 'function') throw new Error('mod_management_caller_required');
    assertCallerActive();
    await modAuthority.assertAllowed(ownerModId, 'mod-management-v1', caller.agentId);
    assertCallerActive();
    return modManagement[method](input, { ownerModId, caller: Object.freeze({ agentId: caller.agentId, sessionId: caller.sessionId || null, conversationId: caller.conversationId || null, runId: caller.runId || null }), waitForCaller, assertCallerActive });
  }
  const ownedJob = (store, jobId) => store.getOwnedJob(schedulerOwner(), bounded(jobId, 96));
  function page(input = {}, max = 100) { const value = plain(input); const limit = count(value.limit, 50, max); let offset = 0; if (value.cursor !== undefined && value.cursor !== null) { let cursor; try { cursor = JSON.parse(Buffer.from(bounded(value.cursor, 512), 'base64url').toString('utf8')); } catch { invalid(); } if (cursor?.ownerModId !== schedulerOwner() || !Number.isSafeInteger(cursor.offset) || cursor.offset < 1) invalid(); offset = cursor.offset; } return { value, limit, offset }; }
  const cursor = (offset) => Buffer.from(JSON.stringify({ ownerModId: schedulerOwner(), offset })).toString('base64url');
  function budgetPage(key, candidates, { offset, limit, transform = (item) => item } = {}) {
    const items = [];
    for (const candidate of candidates.slice(0, limit)) {
      const item = transform(candidate);
      const tentative = { [key]: [...items, item], hasMore: true, nextCursor: cursor(offset + items.length + 1) };
      if (resultBytes(tentative) > SCHEDULER_PAGE_MAX_BYTES) break;
      items.push(item);
    }
    const hasMore = items.length < candidates.length;
    return { [key]: items, hasMore, nextCursor: hasMore ? cursor(offset + items.length) : null };
  }
  async function agentRoot(id) {
    bounded(id, 96);
    const agent = await withStore('agents', (store) => store.get(id));
    if (!agent) throw new Error('agent_not_found');
    if (!agent.enabled && typeof resolveAgentWorkspaceRoot !== 'function') throw new Error('agent_disabled');
    const root = agent.enabled ? (await resolveAgentRuntime(id)).agentWorkspaceRoot : await resolveAgentWorkspaceRoot(id);
    if (typeof root !== 'string' || !root) throw new Error('agent_workspace_unavailable');
    return root;
  }
  async function enabledAgent(agentId) {
    bounded(agentId, 96);
    const agent = await injected.agents.get(agentId);
    if (!agent) throw new Error('agent_not_found');
    if (!agent.enabled) throw new Error('agent_disabled');
  }
  function sessionTarget(input, extra = []) {
    const value = exactKeys(plain(input), ['agentId', 'sessionId', ...extra]);
    bounded(value.agentId, 96); bounded(value.sessionId, 128);
    return value;
  }
  async function ownedSession(value) {
    const metadata = await conversationStore.getMetadata(value);
    if (metadata?.externalModOwnerId !== schedulerOwner()) throw new Error('mod_session_not_found');
    return metadata;
  }
  function sessionModel(value, metadata) {
    return { agentId: value.agentId, sessionId: value.sessionId, selection: metadata.externalModModel || null };
  }
  // Per-installed-mod host instance: opaque cursors cannot cross owners, roots,
  // filters or reloads. Fixed expiry bounds abandoned traversals; disposal clears
  // all inventory on host shutdown. Never evict an active traversal silently.
  const inventories = new Map();
  const inventoryTtlMs = 5 * 60_000;
  let disposed = false;
  const dispose = () => { disposed = true; for (const item of inventories.values()) clearTimeout(item.timer); inventories.clear(); };
  return Object.freeze({
    dispose,
    readRuntimeDiagnostics,
    managementInventory: (input, options) => manage('inventory', input, options),
    managementSubmit: (input, options) => manage('submit', input, options),
    managementOperation: (input, options) => manage('operation', input, options),
    async getOperatorTimezone() { return { timezone: await injected.scheduledJobs.effective(null) }; },
    async listScheduledJobs(input) {
      const { value, limit, offset } = page(input);
      if (!Number.isSafeInteger(offset) || offset < 0) invalid();
      if (value.enabled !== undefined && typeof value.enabled !== 'boolean') invalid();
      const jobs = await withJobs((store) => store.listJobs({ ownerModId: schedulerOwner(), enabled: value.enabled ?? null, limit: limit + 1, offset }));
      return budgetPage('jobs', jobs, { offset, limit });
    },
    async readScheduledJob(input) {
      const value = plain(input); const job = await withJobs((store) => ownedJob(store, value.jobId));
      if (!job) throw new Error('scheduled_job_not_found'); return job;
    },
    async createScheduledJob(input) {
      const value = plain(input);
      if ('ownerModId' in value || 'id' in value) invalid();
      return await withJobs((store) => store.createJob(value, { ownerModId: schedulerOwner() }));
    },
    async updateScheduledJob(input) {
      const value = plain(input); const jobId = bounded(value.jobId, 96); const patch = plain(value.patch);
      if ('ownerModId' in patch || 'id' in patch) invalid();
      const job = await withJobs((store) => store.updateJob(jobId, patch, { ownerModId: schedulerOwner() }));
      if (!job) throw new Error('scheduled_job_not_found'); return job;
    },
    async deleteScheduledJob(input) {
      const value = plain(input); const job = await withJobs((store) => store.deleteJob(value.jobId, { ownerModId: schedulerOwner() }));
      if (!job) throw new Error('scheduled_job_not_found'); return job;
    },
    async listScheduledJobRuns(input) {
      const { value, limit, offset } = page(input, 100); const jobId = bounded(value.jobId, 96);
      if (!Number.isSafeInteger(offset) || offset < 0) invalid();
      const exists = await withJobs((store) => ownedJob(store, jobId)); if (!exists) throw new Error('scheduled_job_not_found');
      const runs = await withJobs((store) => store.listRuns(jobId, { ownerModId: schedulerOwner(), limit: limit + 1, offset }));
      return budgetPage('runs', runs, { offset, limit, transform: (run) => resultBytes({ runs: [run], hasMore: true, nextCursor: cursor(offset + 1) }) <= SCHEDULER_PAGE_MAX_BYTES ? run : summarizedRun(run) });
    },
    async triggerScheduledJob(input) {
      const value = plain(input); const jobId = bounded(value.jobId, 96);
      if (!(await withJobs((store) => ownedJob(store, jobId)))) throw new Error('scheduled_job_not_found');
      if (!scheduledJobScheduler) throw new Error('scheduled_job_scheduler_unavailable');
      return scheduledJobScheduler.trigger(jobId, { ownerModId: schedulerOwner() });
    },
    async submitExternalTurn(input) {
      if (!externalTurnDispatcher) throw new Error('mod_external_turns_unavailable');
      const value = exactKeys(plain(input), ['agentId', 'sessionId', 'message', 'displayMessage', 'idempotencyKey']);
      const agentId = bounded(value.agentId, 96).trim();
      const sessionId = bounded(value.sessionId, 128).trim();
      const message = bounded(value.message, 100_000);
      const displayMessage = value.displayMessage === undefined ? message : bounded(value.displayMessage, 100_000);
      const idempotencyKey = bounded(value.idempotencyKey, 256).trim();
      if (!agentId || !sessionId || !message.trim() || !displayMessage.trim() || !idempotencyKey) invalid();
      const request = { ownerModId: schedulerOwner(), agentId, sessionId, message, displayMessage, idempotencyKey };
      const replay = await externalTurnDispatcher.replay?.(request);
      if (replay) return replay;
      const agent = await withStore('agents', store => store.get(agentId));
      if (!agent) throw new Error('agent_not_found');
      if (!agent.enabled) throw new Error('agent_disabled');
      const metadata = await conversationStore.getMetadata?.({ agentId, sessionId });
      if (metadata?.externalModOwnerId && metadata.externalModOwnerId !== schedulerOwner()) throw new Error('mod_session_not_found');
      return externalTurnDispatcher.submit(request);
    },
    async readExternalTurn(input) {
      if (!externalTurnDispatcher) throw new Error('mod_external_turns_unavailable');
      const value = exactKeys(plain(input), ['turnId']);
      const turn = await externalTurnDispatcher.read(schedulerOwner(), bounded(value.turnId, 96));
      if (!turn) throw new Error('mod_external_turn_not_found');
      return turn;
    },
    async cancelExternalTurn(input) {
      if (!externalTurnDispatcher) throw new Error('mod_external_turns_unavailable');
      const value = exactKeys(plain(input), ['turnId']);
      const result = await externalTurnDispatcher.cancel(schedulerOwner(), bounded(value.turnId, 96));
      if (!result) throw new Error('mod_external_turn_not_found');
      return result;
    },
    async createExternalSession(input) {
      const value = exactKeys(plain(input), ['agentId', 'idempotencyKey']);
      await enabledAgent(value.agentId);
      const key = bounded(value.idempotencyKey, 256);
      if (!key.trim()) invalid();
      const operationId = 'mod:' + createHash('sha256').update(JSON.stringify([schedulerOwner(), value.agentId, key])).digest('hex');
      const sessionId = operationId;
      await conversationStore.createEmpty({ agentId: value.agentId, sessionId, operationId });
      await conversationStore.updateMetadata({ agentId: value.agentId, sessionId, update: metadata => {
        if (metadata.creationOperationId !== operationId || (metadata.externalModOwnerId && metadata.externalModOwnerId !== schedulerOwner())) throw new Error('mod_session_not_found');
        return { ...metadata, externalModOwnerId: schedulerOwner() };
      } });
      return { agentId: value.agentId, sessionId };
    },
    async readExternalSessionModel(input) {
      const value = sessionTarget(input);
      return sessionModel(value, await ownedSession(value));
    },
    async setExternalSessionModel(input) {
      const value = sessionTarget(input, ['connectionId', 'model']);
      await ownedSession(value);
      await enabledAgent(value.agentId);
      let selection = null;
      if (value.connectionId !== null || value.model !== null) {
        bounded(value.connectionId, 128); bounded(value.model, 256);
        if (!(await injected.models.hasAuth(value.connectionId))) throw new Error('model_connection_auth_required');
        // Same selected/authenticated model resolver as ordinary chat; credentials stay in Core.
        await resolveModelConfig({ modelConnectionId: value.connectionId, model: value.model, modelSettings: injected.models, fetchImpl });
        selection = { connectionId: value.connectionId, model: value.model };
      }
      const metadata = await conversationStore.updateMetadata({ agentId: value.agentId, sessionId: value.sessionId, update: prior => {
        if (prior.externalModOwnerId !== schedulerOwner()) throw new Error('mod_session_not_found');
        return { ...prior, externalModModel: selection };
      } });
      return sessionModel(value, metadata);
    },
    async listAgents() {
      return await withStore('agents', async (store) => (await store.list()).map(({ id, name, enabled }) => ({ id, name, enabled })));
    },
    async getOperatorIdentity() {
      // Deliberately project only public display identity. Avatars and the rest of
      // the settings/profile surface are not mod capabilities.
      return await withStore('models', async (store) => {
        const operator = (await store.identities()).operator;
        return { id: operator.id, name: operator.name || null };
      });
    },
    async listConversations(input) {
      const { agentId, limit, includeArchived = true, cursor = null } = plain(input);
      if (typeof includeArchived !== 'boolean') invalid();
      if (cursor !== null) bounded(cursor, 8192);
      const rootDir = await agentRoot(agentId);
      const max = count(limit, 50, 100);
      if (disposed) throw new Error('mod_capability_shutdown');
      let snapshot;
      let offset = 0;
      if (cursor !== null) {
        let parsed;
        try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { invalid(); }
        snapshot = inventories.get(parsed?.id);
        if (!snapshot?.entries || snapshot.expiresAt <= Date.now() || snapshot.agentId !== agentId || snapshot.rootDir !== rootDir || snapshot.includeArchived !== includeArchived || !Number.isSafeInteger(parsed.offset) || parsed.offset < 1 || parsed.offset >= snapshot.entries.length) throw new Error('mod_conversation_cursor_stale');
        offset = parsed.offset;
      } else {
        if (inventories.size >= 16) throw new Error('mod_conversation_snapshot_capacity');
        const id = randomUUID();
        snapshot = { id, agentId, rootDir, includeArchived, expiresAt: Date.now() + inventoryTtlMs };
        snapshot.timer = setTimeout(() => inventories.delete(id), inventoryTtlMs);
        snapshot.timer.unref?.();
        inventories.set(id, snapshot);
        try {
          // Read the whole inventory only at traversal creation, never per page.
          const sessions = (await conversationStore.listSessions({ agentId, includeArchived })).filter(record => !isInternalContextSession(record));
          const resets = !includeArchived ? [] : (await conversationStore.listArchives({ agentId, limit: null })).filter((archive) => archive.kind === 'reset' && !isInternalContextSession(archive));
          const entryKey = (entry) => entry.archiveId ? `archive:${entry.archiveId}` : `session:${entry.id}`;
          const entries = [...sessions.map((record) => {
              const id = record.sessionId || record.id;
              const metadata = record.metadata || record;
              return { id, agentId, archiveTitle: metadata?.archiveTitle || null, updatedAt: record.updatedAt, archived: Boolean(metadata?.archived), archiveId: null };
            }),
            ...resets.map((record) => {
              const id = record.archiveId || record.id;
              const sourceSessionId = record.sessionId || record.sourceSessionId;
              return { id, agentId, sourceSessionId, archiveTitle: record.metadata?.archiveTitle || record.archiveTitle || null, updatedAt: record.createdAt || record.updatedAt, archived: true, archiveId: id };
            })]
            .sort((a, b) => entryKey(a) < entryKey(b) ? -1 : entryKey(a) > entryKey(b) ? 1 : 0);
          snapshot.entries = Object.freeze(entries.map((entry) => Object.freeze(entry)));
          if (disposed) throw new Error('mod_capability_shutdown');
        } catch (error) { clearTimeout(snapshot.timer); inventories.delete(id); throw error; }
      }
      // Clone the public page: callers cannot mutate the retained snapshot.
      const conversations = snapshot.entries.slice(offset, offset + max).map((entry) => ({ ...entry }));
      const hasMore = offset + conversations.length < snapshot.entries.length;
      const nextCursor = hasMore ? Buffer.from(JSON.stringify({ id: snapshot.id, offset: offset + conversations.length })).toString('base64url') : null;
      if (!hasMore) { clearTimeout(snapshot.timer); inventories.delete(snapshot.id); }
      return { conversations, hasMore, nextCursor };

    },
    async readConversation(input, { signal } = {}) {
      const { agentId, sessionId, archiveId = null, limit, before = null, from = null, to = null } = plain(input);
      const rootDir = await agentRoot(agentId);
      bounded(sessionId, 128);
      if (archiveId !== null) bounded(archiveId, 256);
      if (before !== null) bounded(before, 8192);
      for (const date of [from, to]) if (date !== null) bounded(date, 64);
      const page = await readModConversationPage({ rootDir, conversationStore, agentId, sessionId, archiveId, limit: count(limit, 50, 100), before, from, to, signal });
      if (!page) throw new Error('archive_conversation_not_found');
      // Preserve the archive reader's completeness marker: legacy snapshots can
      // still expose their retained turns without claiming the missing history.
      return page;
    },
    async listModels() {
      return withStore('models', async (store) => {
        const out = [];
        for (const connection of await store.list()) {
          if (!(await store.hasAuth(connection.id))) continue;
          for (const model of connection.models || []) {
            if (model.selected === false) continue;
            const reasoningEfforts = publicReasoningEfforts(model.reasoningEfforts);
            const declaredDefaultReasoningEffort = typeof model.defaultReasoningEffort === 'string' ? model.defaultReasoningEffort.trim().toLowerCase() : '';
            const defaultReasoningEffort = MODEL_REASONING_EFFORT_VALUES.includes(declaredDefaultReasoningEffort)
              && (declaredDefaultReasoningEffort === 'off' || reasoningEfforts.includes(declaredDefaultReasoningEffort))
              ? declaredDefaultReasoningEffort
              : reasoningEfforts[0] ?? 'off';
            const supportsTemperature = modelSupportsTemperature({ provider: connection.provider, api: connection.apiType, model: model.id, declared: model.supportsTemperature });
            out.push({ connectionId: connection.id, model: model.id, provider: connection.provider,
              ...(typeof model.displayName === 'string' && model.displayName.trim() ? { label: model.displayName.trim() } : {}),
              ...(Number(model.contextWindow) > 0 ? { contextWindow: Number(model.contextWindow) } : {}),
              reasoningEfforts,
              defaultReasoningEffort,
              supportsTemperature,
              ...(supportsTemperature ? { defaultTemperature: 0.2 } : {}) });
          }
        }
        return out;
      });
    },
    async getForgeImageStatus(input = {}) {
      exactKeys(plain(input), []);
      const store = forgeStore();
      const [catalog, selections] = await Promise.all([store.catalog(), store.selections()]);
      const selection = selections?.image;
      if (!selection) return { available: false, reason: 'forge_selection_missing' };
      const model = catalog?.models?.find((item) => item.connectionId === selection.connectionId && item.modelId === selection.modelId && item.kind === 'image' && item.available === true);
      if (!model) return { available: false, reason: 'forge_model_unavailable' };
      return { available: true };
    },
    async createForgeImage(input) {
      const value = exactKeys(plain(input), ['prompt', 'idempotencyKey']);
      const prompt = bounded(value.prompt, 100_000);
      const idempotencyKey = bounded(value.idempotencyKey, 256);
      const store = forgeStore();
      const result = await store.create({ mode: 'image', prompt, idempotencyKey: `${forgeKeyPrefix()}${idempotencyKey}` }, { ownerModId: forgeOwner() });
      return { job: projectForgeImageJob(store, await store.get(result.job.id)), replayed: result.replayed === true };
    },
    async readForgeImageJob(input) {
      const value = exactKeys(plain(input), ['jobId']);
      const store = forgeStore();
      return projectForgeImageJob(store, await store.get(bounded(value.jobId, 96)));
    },
    generateText: generateTextImpl,
    async submitGeneration(input) {
      if (!generationDispatcher) throw new Error('mod_generations_unavailable');
      const value = exactKeys(plain(input), ['connectionId', 'model', 'prompt', 'maxTokens', 'effort', 'reasoningEffort', 'temperature', 'idempotencyKey']);
      const idempotencyKey = bounded(value.idempotencyKey, 256);
      if (!idempotencyKey.trim()) invalid();
      const payload = canonicalGenerationInput(value);
      return generationDispatcher.submit({ ownerModId: schedulerOwner(), idempotencyKey, payload });
    },
    async readGeneration(input) {
      if (!generationDispatcher) throw new Error('mod_generations_unavailable');
      const value = exactKeys(plain(input), ['jobId']);
      const job = await generationDispatcher.read(schedulerOwner(), bounded(value.jobId, 96));
      if (!job) throw new Error('mod_generation_not_found');
      return job;
    },
  });
}

export function canonicalGenerationInput(value) {
  bounded(value.connectionId, 128); bounded(value.model, 256);
  if (typeof value.prompt !== 'string' || !value.prompt || value.prompt.length > 100_000) invalid();
  positiveSafeInteger(value.maxTokens);
  optionalTemperature(value.temperature);
  if (value.effort !== undefined && value.reasoningEffort !== undefined && value.effort !== value.reasoningEffort) invalid();
  const effort = value.reasoningEffort ?? value.effort;
  let normalized;
  if (effort !== undefined) {
    if (typeof effort !== 'string') invalid();
    try { normalized = normalizeModelReasoningEffort(effort); } catch { invalid(); }
  }
  return { connectionId: value.connectionId, model: value.model, prompt: value.prompt,
    ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens }),
    ...(normalized === undefined ? {} : { effort: normalized }),
    ...(value.temperature === undefined ? {} : { temperature: value.temperature }) };
}

export function createModTextGenerator({ models, fetchImpl = fetch }) {
  return async function generateText(input, { signal } = {}) {
      const { connectionId, model, prompt, maxTokens, effort, reasoningEffort, temperature } = plain(input);
      bounded(connectionId, 128); bounded(model, 256);
      if (typeof prompt !== 'string' || !prompt) invalid();
      if (effort !== undefined && reasoningEffort !== undefined && effort !== reasoningEffort) invalid();
      const tokens = positiveSafeInteger(maxTokens);
      const requestedEffortValue = reasoningEffort ?? effort;
      let requestedEffort;
      if (requestedEffortValue !== undefined) {
        if (typeof requestedEffortValue !== 'string') invalid();
        try { requestedEffort = normalizeModelReasoningEffort(requestedEffortValue); } catch { invalid(); }
      }
      const requestedTemperature = optionalTemperature(temperature);
      if (signal?.aborted) throw new Error('mod_capability_cancelled');
      const config = await resolveModelConfig({ modelConnectionId: connectionId, model, fetchImpl, modelSettings: models, abortSignal: signal,
        ...(requestedEffort === undefined ? {} : { model_reasoning_effort: requestedEffort }),
        ...(requestedTemperature === undefined ? {} : { temperature: requestedTemperature }) });
      if (requestedEffort !== undefined && requestedEffort !== 'off' && Array.isArray(config.reasoningEfforts) && config.reasoningEfforts.length && !config.reasoningEfforts.includes(requestedEffort)) throw new Error('model_reasoning_effort_not_supported');
      if (requestedTemperature !== undefined && config.supportsTemperature === false) throw new Error('model_temperature_not_supported');
      if (signal?.aborted) throw new Error('mod_capability_cancelled');
      let result;
      try {
        result = await createModelAdapter({ config, fetchImpl }).complete({ prompt, ...(tokens === undefined ? {} : { maxTokens: tokens }), tools: null, signal });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw new Error('mod_capability_cancelled');
        throw error;
      }
      if (signal?.aborted) throw new Error('mod_capability_cancelled');
      if (result.error || !result.choice || result.choice.toolCalls?.length) throw modelGenerationFailure(result, result.choice?.toolCalls?.length ? 'unexpected_tool_call' : 'model_generation_failed');
      const text = result.choice.text;
      if (typeof text !== 'string' || (result.choice.finishReason === 'max_tokens' && !text)) throw modelGenerationFailure(result, 'model_generation_failed');
      return { text };
  };
}
