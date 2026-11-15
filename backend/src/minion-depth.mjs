import { normalizeCodexModelSelection, validateCodexModelSelection } from './codex-model-selection.mjs';

import { normalizeClaudeModelSelection, validateClaudeModelSelection } from './claude-model-selection.mjs';

export const DEFAULT_MINION_DEPTH = 1;
export const MAX_MINION_DEPTH = 2;
export const DEFAULT_MINION_HARNESS = 'burrow';

function validHarness(value) {
  return value === 'burrow' || value === 'codex' || value === 'claude';
}

function normalizeSettings(saved) {
  let codexModel = null;
  let claudeModel = null;
  try { codexModel = normalizeCodexModelSelection(saved?.codexModel ?? null); } catch {}
  try { claudeModel = normalizeClaudeModelSelection(saved?.claudeModel ?? null); } catch {}
  return {
    maxDepth: validMaxDepth(saved?.maxDepth) ? saved.maxDepth : DEFAULT_MINION_DEPTH,
    defaultHarness: validHarness(saved?.defaultHarness) ? saved.defaultHarness : DEFAULT_MINION_HARNESS,
    codexModel,
    claudeModel,
  };
}

function validMaxDepth(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_MINION_DEPTH;
}

export async function readMinionSettings(metadata, agentId) {
  const saved = agentId && metadata?.get ? await metadata.get(`minion_settings:${agentId}`) : null;
  return normalizeSettings(saved);
}

export async function saveMinionSettings(metadata, agentId, input = {}, { models } = {}) {
  const object = input !== null && typeof input === 'object' && !Array.isArray(input);
  const hasDepth = object && Object.hasOwn(input, 'maxDepth');
  const hasHarness = object && Object.hasOwn(input, 'defaultHarness');
  const hasCodex = object && Object.hasOwn(input, 'codexModel');
  const hasClaude = object && Object.hasOwn(input, 'claudeModel');
  if ((!hasDepth && !hasHarness && !hasCodex && !hasClaude) || (hasDepth && !validMaxDepth(input.maxDepth))) {
    throw Object.assign(new Error('minion_max_depth_invalid'), { statusCode: 400 });
  }
  if (hasHarness && !validHarness(input.defaultHarness)) {
    throw Object.assign(new Error('minion_default_harness_invalid'), { statusCode: 400 });
  }
  const codexModel = hasCodex ? normalizeCodexModelSelection(input.codexModel) : null;
  if (codexModel) await validateCodexModelSelection(models, codexModel);
  const claudeModel = hasClaude ? normalizeClaudeModelSelection(input.claudeModel) : null;
  if (claudeModel) await validateClaudeModelSelection(models, claudeModel);
  const key = `minion_settings:${agentId}`;
  const update = saved => ({
    ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}),
    ...normalizeSettings(saved),
    ...(hasDepth ? { maxDepth: input.maxDepth } : {}),
    ...(hasHarness ? { defaultHarness: input.defaultHarness } : {}),
    ...(hasCodex ? { codexModel } : {}),
    ...(hasClaude ? { claudeModel } : {}),
  });
  // The PostgreSQL metadata owner serializes partial updates, including insert.
  if (metadata.atomicUpdate) return normalizeSettings(await metadata.atomicUpdate(key, update));
  const settings = update(await metadata.get(key));
  await metadata.set(key, settings);
  return normalizeSettings(settings);
}

// Runtime-owned lineage, never accepted from model tool arguments. At a leaf
// the spawning tool is absent and the executor independently rejects dispatch.
export function normalizeMinionDepth(input = {}) {
  const depth = Number.isInteger(input?.depth) && input.depth >= 0 ? input.depth : 0;
  return {
    depth,
    maxDepth: validMaxDepth(input?.maxDepth) ? input.maxDepth : DEFAULT_MINION_DEPTH,
    rootSessionId: typeof input?.rootSessionId === 'string' ? input.rootSessionId : null,
    rootRunId: typeof input?.rootRunId === 'string' ? input.rootRunId : null,
  };
}

export function canSpawnMinion(input) {
  const { depth, maxDepth } = normalizeMinionDepth(input);
  return depth < maxDepth && depth < MAX_MINION_DEPTH;
}

export function nextMinionDepth(input, { sessionId = null, runId = null } = {}) {
  const current = normalizeMinionDepth(input);
  return {
    ...current,
    depth: current.depth + 1,
    rootSessionId: current.rootSessionId || sessionId,
    rootRunId: current.rootRunId || runId,
  };
}

export async function resolveTurnMinionDepth({ metadata, conversations, agentId, sessionId, runId } = {}) {
  const { maxDepth } = await readMinionSettings(metadata, agentId);
  const session = conversations?.getMetadata && agentId
    ? await conversations.getMetadata({ agentId, sessionId }) : null;
  if (session?.sessionKind === 'subagent' || session?.parentChild || session?.minionDepth?.depth > 0) {
    // Historical direct children have no depth marker. They remain leaves by
    // default; their identity must not become a new depth-zero root on reopen.
    const marker = session.minionDepth || {};
    const prior = normalizeMinionDepth({ ...marker, depth: Number.isInteger(marker.depth) && marker.depth > 0 ? marker.depth : 1 });
    return { ...prior, maxDepth: Math.min(maxDepth, prior.maxDepth) };
  }
  return { depth: 0, maxDepth, rootSessionId: sessionId || 'default', rootRunId: runId || null };
}
