export const DEFAULT_MINION_DEPTH = 1;
export const MAX_MINION_DEPTH = 2;

function validMaxDepth(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_MINION_DEPTH;
}

export async function readMinionSettings(metadata, agentId) {
  const saved = agentId && metadata?.get ? await metadata.get(`minion_settings:${agentId}`) : null;
  return { maxDepth: validMaxDepth(saved?.maxDepth) ? saved.maxDepth : DEFAULT_MINION_DEPTH };
}

export async function saveMinionSettings(metadata, agentId, input = {}) {
  if (!validMaxDepth(input?.maxDepth)) throw Object.assign(new Error('minion_max_depth_invalid'), { statusCode: 400 });
  const settings = { maxDepth: input.maxDepth };
  await metadata.set(`minion_settings:${agentId}`, settings);
  return settings;
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
