import { randomUUID } from 'node:crypto';
import { readModConversationPage } from './mod-conversation-pager.mjs';
import { AgentRegistryStore } from './agent-registry.mjs';
import { ModelSettingsStore } from './model-settings-store.mjs';
import { ScheduledJobStore } from './scheduled-job-store.mjs';
import { resolveModelConfig } from './config.mjs';
import { createModelAdapter } from './model-adapter.mjs';
import { listSessionRecords, listResetSessionArchives } from './session-store.mjs';

function invalid() { throw new Error('mod_capability_input_invalid'); }
function bounded(value, max) { if (typeof value !== 'string' || !value || value.length > max) invalid(); return value; }
function count(value, fallback, max) { if (value === undefined) return fallback; if (!Number.isInteger(value) || value < 1 || value > max) invalid(); return value; }
function positiveSafeInteger(value) { if (value === undefined) return undefined; if (!Number.isSafeInteger(value) || value < 1) invalid(); return value; }
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

// Only this core-side service has access to SQLite secrets and provider credentials.
export function createModCapabilities({ databasePath, resolveAgentRuntime, resolveAgentWorkspaceRoot, fetchImpl = fetch, ownerModId, scheduledJobScheduler = null } = {}) {
  if (typeof resolveAgentRuntime !== 'function') throw new Error('mod_agent_resolver_required');
  const withStore = (Store, fn) => { const store = new Store({ databasePath }); try { return fn(store); } finally { store.close(); } };
  const withJobs = (fn) => withStore(ScheduledJobStore, fn);
  const schedulerOwner = () => { if (typeof ownerModId !== 'string' || !ownerModId) throw new Error('mod_scheduler_owner_unavailable'); return ownerModId; };
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
    const agent = withStore(AgentRegistryStore, (store) => store.get(id));
    if (!agent) throw new Error('agent_not_found');
    if (!agent.enabled && typeof resolveAgentWorkspaceRoot !== 'function') throw new Error('agent_disabled');
    const root = agent.enabled ? (await resolveAgentRuntime(id)).agentWorkspaceRoot : await resolveAgentWorkspaceRoot(id);
    if (typeof root !== 'string' || !root) throw new Error('agent_workspace_unavailable');
    return root;
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
    async listScheduledJobs(input) {
      const { value, limit, offset } = page(input);
      if (!Number.isSafeInteger(offset) || offset < 0) invalid();
      if (value.enabled !== undefined && typeof value.enabled !== 'boolean') invalid();
      const jobs = withJobs((store) => store.listJobs({ ownerModId: schedulerOwner(), enabled: value.enabled ?? null, limit: limit + 1, offset }));
      return budgetPage('jobs', jobs, { offset, limit });
    },
    async readScheduledJob(input) {
      const value = plain(input); const job = withJobs((store) => ownedJob(store, value.jobId));
      if (!job) throw new Error('scheduled_job_not_found'); return job;
    },
    async createScheduledJob(input) {
      const value = plain(input);
      if ('ownerModId' in value || 'id' in value) invalid();
      return withJobs((store) => store.createJob(value, { ownerModId: schedulerOwner() }));
    },
    async updateScheduledJob(input) {
      const value = plain(input); const jobId = bounded(value.jobId, 96); const patch = plain(value.patch);
      if ('ownerModId' in patch || 'id' in patch) invalid();
      const job = withJobs((store) => store.updateJob(jobId, patch, { ownerModId: schedulerOwner() }));
      if (!job) throw new Error('scheduled_job_not_found'); return job;
    },
    async deleteScheduledJob(input) {
      const value = plain(input); const job = withJobs((store) => store.deleteJob(value.jobId, { ownerModId: schedulerOwner() }));
      if (!job) throw new Error('scheduled_job_not_found'); return job;
    },
    async listScheduledJobRuns(input) {
      const { value, limit, offset } = page(input, 100); const jobId = bounded(value.jobId, 96);
      if (!Number.isSafeInteger(offset) || offset < 0) invalid();
      const exists = withJobs((store) => ownedJob(store, jobId)); if (!exists) throw new Error('scheduled_job_not_found');
      const runs = withJobs((store) => store.listRuns(jobId, { ownerModId: schedulerOwner(), limit: limit + 1, offset }));
      return budgetPage('runs', runs, { offset, limit, transform: (run) => resultBytes({ runs: [run], hasMore: true, nextCursor: cursor(offset + 1) }) <= SCHEDULER_PAGE_MAX_BYTES ? run : summarizedRun(run) });
    },
    async triggerScheduledJob(input) {
      const value = plain(input); const jobId = bounded(value.jobId, 96);
      if (!withJobs((store) => ownedJob(store, jobId))) throw new Error('scheduled_job_not_found');
      if (!scheduledJobScheduler) throw new Error('scheduled_job_scheduler_unavailable');
      return scheduledJobScheduler.trigger(jobId, { ownerModId: schedulerOwner() });
    },
    async listAgents() {
      return withStore(AgentRegistryStore, (store) => store.list().map(({ id, name, enabled }) => ({ id, name, enabled })));
    },
    async getOperatorIdentity() {
      // Deliberately project only public display identity. Avatars and the rest of
      // the settings/profile surface are not mod capabilities.
      return withStore(ModelSettingsStore, (store) => {
        const operator = store.identities().operator;
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
          const sessions = await listSessionRecords({ rootDir, includeArchived, limit: Infinity });
          const resets = includeArchived ? await listResetSessionArchives({ rootDir, limit: Infinity }) : [];
          const entryKey = (entry) => entry.archiveId ? `archive:${entry.archiveId}` : `session:${entry.id}`;
          const entries = [...sessions.map(({ id, metadata, updatedAt, archived }) => ({ id, agentId, archiveTitle: metadata?.archiveTitle || null, updatedAt, archived: Boolean(archived), archiveId: null })),
            ...resets.map(({ id, sourceSessionId, archiveTitle, updatedAt }) => ({ id, agentId, sourceSessionId, archiveTitle, updatedAt, archived: true, archiveId: id }))]
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
      const page = await readModConversationPage({ rootDir, agentId, sessionId, archiveId, limit: count(limit, 50, 100), before, from, to, signal });
      if (!page) throw new Error('archive_conversation_not_found');
      // Preserve the archive reader's completeness marker: legacy snapshots can
      // still expose their retained turns without claiming the missing history.
      return page;
    },
    async listModels() {
      return withStore(ModelSettingsStore, (store) => store.list().flatMap((connection) => (connection.models || [])
        .filter((model) => model.selected !== false && store.hasAuth(connection.id))
        .map((model) => ({ connectionId: connection.id, model: model.id, provider: connection.provider, ...(Number(model.contextWindow) > 0 ? { contextWindow: Number(model.contextWindow) } : {}) }))));
    },
    async generateText(input, { signal } = {}) {
      const { connectionId, model, prompt, maxTokens } = plain(input);
      bounded(connectionId, 128); bounded(model, 256);
      if (typeof prompt !== 'string' || !prompt) invalid();
      const tokens = positiveSafeInteger(maxTokens);
      if (signal?.aborted) throw new Error('mod_capability_cancelled');
      const config = await resolveModelConfig({ modelConnectionId: connectionId, model, settingsDb: databasePath, fetchImpl });
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
    },
  });
}
