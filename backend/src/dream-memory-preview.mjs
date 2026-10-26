import { randomBytes, randomUUID } from 'node:crypto';
import { createTraceLogger } from './trace-logger.mjs';
import { redactProtectedText } from './redaction.mjs';
import { memoryExpressionSettings } from './dream-memory-prompt.mjs';
import { DREAM_EXTRACTION_CONTRACT_VERSION, dreamSourceIdentity } from './dream-incremental-extraction.mjs';
import { sessionWindow, reconcileDreamCandidates } from './dream-cycle-runner.mjs';
import { resolveModelConfig } from './config.mjs';
import { createModelAdapter } from './model-adapter.mjs';

export const MEMORY_PREVIEW_EVIDENCE_SCOPE = 'Recent validated extracted candidates from existing Dream extraction checkpoints, revalidated against current eligible REM-window source identities; not all history and not new extraction.';
const MAX_SNAPSHOT_BYTES = 512_000;
const MAX_SOURCES = 2000;

/** Read-only: unlike prepareDreamExtraction, this never removes stale coverage. */
export async function loadMemoryPreviewSource({ agentId, stores, generatedAt }) {
  const messages = await sessionWindow({ phase: 'rem', generatedAt, conversationStore: stores.conversations, conversationAgentId: agentId });
  const identities = new Map(messages.map(message => [message.sourceRef, dreamSourceIdentity(message)]));
  const batches = await stores.dreamExtractions.list({ agentId });
  const memories = [], sources = new Map();
  // Most recent complete checkpoints first. Do not split a claim or its batch context.
  for (const batch of [...batches].reverse()) {
    if (batch.contractVersion !== DREAM_EXTRACTION_CONTRACT_VERSION || !Array.isArray(batch.sources) || !batch.sources.length
      || batch.sources.some(source => identities.get(source.sourceRef) !== source.identity)) continue;
    const allowed = new Set(batch.sources.map(source => source.sourceRef));
    const valid = (batch.candidates?.memories || []).filter(candidate => typeof candidate.title === 'string' && candidate.title.trim()
      && typeof candidate.content === 'string' && candidate.content.trim() && Array.isArray(candidate.sourceRefs)
      && candidate.sourceRefs.length && candidate.sourceRefs.every(ref => allowed.has(ref)));
    if (!valid.length) continue;
    const nextSources = new Map([...sources, ...batch.sources.map(source => [source.sourceRef, source])]);
    if (nextSources.size > MAX_SOURCES || Buffer.byteLength(JSON.stringify([memories.concat(valid), [...nextSources.values()]])) > MAX_SNAPSHOT_BYTES) continue;
    memories.push(...valid);
    for (const source of batch.sources) sources.set(source.sourceRef, source);
  }
  return { memories, sources: [...sources.values()] };
}

/** Ephemeral agent-bound snapshot cache; no memory/settings store mutations.
 * Explicit invocation is the only path to a model request. Optional filesystem
 * traces retain execution evidence, not published memories or saved settings. */
export function createDreamMemoryPreviewService({ stores, clock = () => new Date().toISOString(), modelAdapter = null, modelConfig = null,
  resolveModel = resolveModelConfig, makeAdapter = createModelAdapter, traceRoot = null, makeTraceLogger = createTraceLogger, ttlMs = 15 * 60_000, maxSnapshots = 32 } = {}) {
  const snapshots = new Map();
  return async function preview(agentId, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['memoryEmphasis', 'memoryPromptOverride', 'sourceToken'].includes(key))) throw new Error('dream_memory_preview_body_invalid');
    if (input.sourceToken !== undefined && (typeof input.sourceToken !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(input.sourceToken))) throw new Error('dream_memory_preview_source_token_invalid');
    const generatedAt = clock(); const at = Date.parse(generatedAt);
    for (const [token, value] of snapshots) if (value.expiresAt <= at) snapshots.delete(token);
    const saved = await stores.dreamSettings.getReadOnly(agentId);
    const settings = { ...saved, ...memoryExpressionSettings({
      memoryEmphasis: input.memoryEmphasis === undefined ? saved.memoryEmphasis : input.memoryEmphasis,
      memoryPromptOverride: input.memoryPromptOverride === undefined ? saved.memoryPromptOverride : input.memoryPromptOverride,
    }) };
    let sourceToken = input.sourceToken;
    let snapshot;
    if (sourceToken !== undefined) {
      const cached = snapshots.get(sourceToken);
      if (!cached || cached.agentId !== agentId) throw new Error('dream_memory_preview_source_token_invalid');
      snapshot = cached.snapshot;
      // Reuse the exact snapshot, but never revive deleted/edited/out-of-window evidence.
      const current = await sessionWindow({ phase: 'rem', generatedAt, conversationStore: stores.conversations, conversationAgentId: agentId });
      const identities = new Map(current.map(message => [message.sourceRef, dreamSourceIdentity(message)]));
      if (snapshot.sources.some(source => identities.get(source.sourceRef) !== source.identity)) {
        snapshots.delete(sourceToken); throw new Error('dream_memory_preview_source_token_invalid');
      }
    } else {
      snapshot = await loadMemoryPreviewSource({ agentId, stores, generatedAt });
      sourceToken = randomBytes(24).toString('base64url');
      while (snapshots.size >= maxSnapshots) snapshots.delete(snapshots.keys().next().value);
      snapshots.set(sourceToken, { agentId, snapshot: structuredClone(snapshot), expiresAt: at + ttlMs });
    }
    const sourceCount = new Set(snapshot.memories.flatMap(item => item.sourceRefs)).size;
    const result = { ok: true, memories: [], sourceToken, sourceCount, generatedAt, evidenceScope: MEMORY_PREVIEW_EVIDENCE_SCOPE, persisted: false };
    if (!snapshot.memories.length) return result; // No model resolution or paid call.
    const runId = `dream-memory-preview-${randomUUID()}`;
    const root = typeof traceRoot === 'function' ? await traceRoot(agentId) : traceRoot;
    const traceLogger = root ? makeTraceLogger({ rootDir: root, runId }) : null;
    try {
      await traceLogger?.event?.('dream_memory_preview_started', { agentId, runId, generatedAt, sourceCount, persisted: false });
      const soul = (await stores.profiles.get(agentId, 'SOUL'))?.markdown || '';
      const config = modelConfig || (!modelAdapter ? await resolveModel(settings.modelConnectionId && settings.model
        ? { modelConnectionId: settings.modelConnectionId, model: settings.model, stores: { models: stores.models } }
        : { agentId, stores: { models: stores.models } }) : null);
      const adapter = modelAdapter || (config?.model ? makeAdapter({ config: { ...config, temperature: settings.temperature ?? config.temperature ?? 0.2, reasoningEffort: 'off' } }) : null);
      const synthesis = await reconcileDreamCandidates({ phase: 'rem', candidates: { memories: snapshot.memories, preferences: [] },
        messages: snapshot.sources.map(source => ({ sourceRef: source.sourceRef, at: source.at })), modelAdapter: adapter, modelConfig: config, settings, soul, traceLogger,
        onProgress: traceLogger ? async patch => { await traceLogger.event?.('dream_memory_preview_request', { agentId, ...patch }); } : null });
      result.memories = (synthesis.changes || []).filter(change => change.action === 'new').map(({ title, content, sourceRefs }) => ({ title, content, sourceRefs }));
      await traceLogger?.flushDiagnostics?.();
      await traceLogger?.event?.('dream_memory_preview_completed', { agentId, runId, sourceCount, memoryCount: result.memories.length, persisted: false });
      return result;
    } catch (error) {
      await traceLogger?.event?.('dream_memory_preview_failed', { agentId, runId, error: redactProtectedText(String(error?.message || error)).slice(0, 1000), persisted: false });
      throw error;
    } finally {
      await traceLogger?.flushDiagnostics?.();
      await traceLogger?.terminal?.();
    }
  };
}
