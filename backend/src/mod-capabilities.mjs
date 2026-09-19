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
function plain(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value; }
const SCHEDULER_PAGE_MAX_BYTES = 240_000;
function resultBytes(value) { return Buffer.byteLength(JSON.stringify(value)); }
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
  return Object.freeze({
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
    async listConversations(input) {
      const { agentId, limit, includeArchived = true, cursor = null } = plain(input);
      if (typeof includeArchived !== 'boolean') invalid();
      if (cursor !== null) bounded(cursor, 8192);
      const rootDir = await agentRoot(agentId);
      const max = count(limit, 50, 100);
      // The store's limit is applied after sorting; fetch both complete sets so
      // no reset snapshot or session can be silently lost between page windows.
      const sessions = await listSessionRecords({ rootDir, includeArchived, limit: Infinity });
      const resets = includeArchived ? await listResetSessionArchives({ rootDir, limit: Infinity }) : [];
      const entryKey = (entry) => entry.archiveId ? `archive:${entry.archiveId}` : `session:${entry.id}`;
      const entries = [...sessions.map(({ id, metadata, updatedAt, archived }) => ({ id, agentId, archiveTitle: metadata?.archiveTitle || null, updatedAt, archived: Boolean(archived), archiveId: null })),
        ...resets.map(({ id, sourceSessionId, archiveTitle, updatedAt }) => ({ id, agentId, sourceSessionId, archiveTitle, updatedAt, archived: true, archiveId: id }))]
        .sort((a, b) => entryKey(a) < entryKey(b) ? -1 : entryKey(a) > entryKey(b) ? 1 : 0);
      let afterKey = null;
      if (cursor !== null) {
        let parsed;
        try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { invalid(); }
        if (parsed?.v !== 1) throw new Error('mod_conversation_cursor_stale');
        if (parsed.agentId !== agentId || parsed.includeArchived !== includeArchived || typeof parsed.afterKey !== 'string' || !/^(?:archive|session):.{1,512}$/.test(parsed.afterKey)) throw new Error('mod_conversation_cursor_stale');
        afterKey = parsed.afterKey;
      }
      // Stable identity keyset pagination deliberately ignores mutable listing
      // metadata (updatedAt/title/archive state) for cursor validity. Sessions
      // already beyond the cursor stay discoverable even if earlier items are
      // updated or deleted. New identities that sort at or before the cursor are
      // behind this traversal and require a fresh list traversal to discover.
      const start = afterKey === null ? 0 : entries.findIndex((entry) => entryKey(entry) > afterKey);
      const offset = start < 0 ? entries.length : start;
      const conversations = entries.slice(offset, offset + max);
      const hasMore = offset + conversations.length < entries.length;
      const nextCursor = hasMore ? Buffer.from(JSON.stringify({ v: 1, agentId, includeArchived, afterKey: entryKey(conversations.at(-1)) })).toString('base64url') : null;
      return { conversations, hasMore, nextCursor };

    },
    async readConversation(input) {
      const { agentId, sessionId, archiveId = null, limit, before = null, from = null, to = null } = plain(input);
      const rootDir = await agentRoot(agentId);
      bounded(sessionId, 128);
      if (archiveId !== null) bounded(archiveId, 256);
      if (before !== null) bounded(before, 8192);
      for (const date of [from, to]) if (date !== null) bounded(date, 64);
      const page = await readModConversationPage({ rootDir, agentId, sessionId, archiveId, limit: count(limit, 50, 100), before, from, to });
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
      bounded(connectionId, 128); bounded(model, 256); bounded(prompt, 24_000);
      const tokens = count(maxTokens, 512, 2048);
      if (signal?.aborted) throw new Error('mod_capability_cancelled');
      const config = await resolveModelConfig({ modelConnectionId: connectionId, model, settingsDb: databasePath, fetchImpl });
      if (signal?.aborted) throw new Error('mod_capability_cancelled');
      const result = await createModelAdapter({ config, fetchImpl }).complete({ prompt, maxTokens: tokens, tools: null, signal });
      if (signal?.aborted) throw new Error('mod_capability_cancelled');
      if (result.error || !result.choice || result.choice.toolCalls?.length) throw new Error('mod_model_generation_failed');
      const text = result.choice.text;
      if (typeof text !== 'string' || text.length > 16_000) throw new Error('mod_model_output_limit');
      return { text };
    },
  });
}
