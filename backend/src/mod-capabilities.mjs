import { createHash } from 'node:crypto';
import { AgentRegistryStore } from './agent-registry.mjs';
import { ModelSettingsStore } from './model-settings-store.mjs';
import { resolveModelConfig } from './config.mjs';
import { createModelAdapter } from './model-adapter.mjs';
import { listSessionRecords, listResetSessionArchives, readArchiveConversationPage } from './session-store.mjs';

function invalid() { throw new Error('mod_capability_input_invalid'); }
function bounded(value, max) { if (typeof value !== 'string' || !value || value.length > max) invalid(); return value; }
function count(value, fallback, max) { if (value === undefined) return fallback; if (!Number.isInteger(value) || value < 1 || value > max) invalid(); return value; }
function plain(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value; }

// Only this core-side service has access to SQLite secrets and provider credentials.
export function createModCapabilities({ databasePath, resolveAgentRuntime, resolveAgentWorkspaceRoot, fetchImpl = fetch } = {}) {
  if (typeof resolveAgentRuntime !== 'function') throw new Error('mod_agent_resolver_required');
  const withStore = (Store, fn) => { const store = new Store({ databasePath }); try { return fn(store); } finally { store.close(); } };
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
      const entries = [...sessions.map(({ id, metadata, updatedAt, archived }) => ({ id, agentId, archiveTitle: metadata?.archiveTitle || null, updatedAt, archived: Boolean(archived), archiveId: null })),
        ...resets.map(({ id, sourceSessionId, archiveTitle, updatedAt }) => ({ id, agentId, sourceSessionId, archiveTitle, updatedAt, archived: true, archiveId: id }))]
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(a.archiveId || a.id).localeCompare(String(b.archiveId || b.id)));
      const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
      let offset = 0;
      if (cursor !== null) {
        let parsed;
        try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { invalid(); }
        if (parsed?.agentId !== agentId || parsed?.includeArchived !== includeArchived || parsed?.digest !== digest || !Number.isSafeInteger(parsed.offset) || parsed.offset < 1 || parsed.offset > entries.length) throw new Error('mod_conversation_cursor_stale');
        offset = parsed.offset;
      }
      const conversations = entries.slice(offset, offset + max);
      const hasMore = offset + conversations.length < entries.length;
      const nextCursor = hasMore ? Buffer.from(JSON.stringify({ agentId, includeArchived, digest, offset: offset + conversations.length })).toString('base64url') : null;
      return { conversations, hasMore, nextCursor };

    },
    async readConversation(input) {
      const { agentId, sessionId, archiveId = null, limit, before = null, from = null, to = null } = plain(input);
      const rootDir = await agentRoot(agentId);
      bounded(sessionId, 128);
      if (archiveId !== null) bounded(archiveId, 256);
      if (before !== null) bounded(before, 8192);
      for (const date of [from, to]) if (date !== null) bounded(date, 64);
      const page = await readArchiveConversationPage({ rootDir, sessionId, archiveId, limit: count(limit, 50, 100), before, from, to });
      if (!page) throw new Error('archive_conversation_not_found');
      // A partial or corrupt history cannot be presented as a complete conversation.
      if (page.historyStatus !== 'complete') throw new Error('archive_history_unavailable');
      if (JSON.stringify(page).length > 256_000) throw new Error("mod_capability_output_limit");
      return { agentId, sessionId, archiveId, ...page };
    },
    async listModels() {
      return withStore(ModelSettingsStore, (store) => store.list().flatMap((connection) => (connection.models || [])
        .filter((model) => model.selected !== false && store.hasAuth(connection.id))
        .map((model) => ({ connectionId: connection.id, model: model.id, provider: connection.provider }))));
    },
    async generateText(input, { signal } = {}) {
      const { connectionId, model, prompt, maxTokens } = plain(input);
      bounded(connectionId, 128); bounded(model, 256); bounded(prompt, 24_000);
      const tokens = count(maxTokens, 512, 2048);
      if (signal?.aborted) throw new Error('mod_capability_cancelled');
      const config = await resolveModelConfig({ modelConnectionId: connectionId, model, settingsDb: databasePath, fetchImpl });
      if (signal?.aborted) throw new Error('mod_capability_cancelled');
      const result = await createModelAdapter({ config: { ...config, maxResponseBytes: 64 * 1024 }, fetchImpl }).complete({ prompt, maxTokens: tokens, tools: null, signal });
      if (signal?.aborted) throw new Error('mod_capability_cancelled');
      if (result.error || !result.choice || result.choice.toolCalls?.length) throw new Error('mod_model_generation_failed');
      const text = result.choice.text;
      if (typeof text !== 'string' || text.length > 16_000) throw new Error('mod_model_output_limit');
      return { text };
    },
  });
}
