import { normalizeCodexModelSelection, validateCodexModelSelection } from './codex-model-selection.mjs';

import { normalizeClaudeModelSelection, validateClaudeModelSelection } from './claude-model-selection.mjs';

export const DEFAULT_MINION_DEPTH = 1;
export const MAX_MINION_DEPTH = 2;
export const DEFAULT_MINION_HARNESS = 'burrow';

function validHarness(value) {
  return value === 'burrow' || value === 'codex' || value === 'claude';
}

function normalizeSettings(saved) {
  let burrowModel = null;
  try { burrowModel = normalizeCodexModelSelection(saved?.burrowModel ?? null); } catch {}
  let codexModel = null;
  let claudeModel = null;
  try { codexModel = normalizeCodexModelSelection(saved?.codexModel ?? null); } catch {}
  try { claudeModel = normalizeClaudeModelSelection(saved?.claudeModel ?? null); } catch {}
  return {
    maxDepth: validMaxDepth(saved?.maxDepth) ? saved.maxDepth : DEFAULT_MINION_DEPTH,
    defaultHarness: validHarness(saved?.defaultHarness) ? saved.defaultHarness : DEFAULT_MINION_HARNESS,
    burrowModel,
    codexEnabled: typeof saved?.codexEnabled === 'boolean' ? saved.codexEnabled : Boolean(codexModel),
    claudeEnabled: typeof saved?.claudeEnabled === 'boolean' ? saved.claudeEnabled : Boolean(claudeModel),
    codexModel,
    claudeModel,
    defaultMinionProfileId: typeof saved?.defaultMinionProfileId === 'string' ? saved.defaultMinionProfileId : null,
  };
}

function validMaxDepth(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_MINION_DEPTH;
}

export const MINION_GLOBAL_SETTINGS_KEY = 'minion_settings';
const settingsKey = agentId => agentId ? `minion_settings:${agentId}` : MINION_GLOBAL_SETTINGS_KEY;
export function minionOverrideEnabled(saved) {
  return typeof saved?.overrideEnabled === 'boolean' ? saved.overrideEnabled
    : Boolean(saved && Object.keys(saved).some(key => ['maxDepth', 'defaultHarness', 'burrowModel', 'codexEnabled', 'claudeEnabled', 'codexModel', 'claudeModel', 'defaultMinionProfileId'].includes(key)));
}

/** Saved editor state and resolved runtime state share one resolution path. */
export async function readMinionSettingsState(metadata, agentId = null) {
  const global = normalizeSettings(await metadata?.get?.(MINION_GLOBAL_SETTINGS_KEY));
  if (!agentId) return global;
  const saved = await metadata?.get?.(settingsKey(agentId));
  const overrideEnabled = minionOverrideEnabled(saved);
  const stored = normalizeSettings(saved);
  return { ...stored, overrideEnabled, profileOverrides: saved?.profileOverrides || {},
    effective: overrideEnabled ? stored : global };
}
export async function readMinionSettings(metadata, agentId) {
  const state = await readMinionSettingsState(metadata, agentId);
  return state.effective || state;
}

export async function saveMinionSettings(metadata, agentId, input = {}, { models } = {}) {
  const object = input !== null && typeof input === 'object' && !Array.isArray(input);
  const hasDepth = object && Object.hasOwn(input, 'maxDepth');
  const hasHarness = object && Object.hasOwn(input, 'defaultHarness');
  const hasBurrow = object && Object.hasOwn(input, 'burrowModel');
  const enableFields = ['codexEnabled', 'claudeEnabled'].filter(key => object && Object.hasOwn(input, key));
  if (enableFields.some(key => typeof input[key] !== 'boolean')) throw Object.assign(new Error('minion_enabled_invalid'), { statusCode: 400 });
  const hasCodex = object && Object.hasOwn(input, 'codexModel');
  const hasClaude = object && Object.hasOwn(input, 'claudeModel');
  const hasDefaultProfile = object && Object.hasOwn(input, 'defaultMinionProfileId');
  const hasOverride = object && Object.hasOwn(input, 'overrideEnabled');
  const hasProfiles = object && Object.hasOwn(input, 'profileOverrides');
  if ((hasOverride && (!agentId || typeof input.overrideEnabled !== 'boolean')) || (hasProfiles && !agentId)) throw Object.assign(new Error('minion_override_invalid'), { statusCode: 400 });
  if ((!hasBurrow && !enableFields.length && !hasDepth && !hasHarness && !hasCodex && !hasClaude && !hasDefaultProfile && !hasOverride && !hasProfiles) || (hasDepth && !validMaxDepth(input.maxDepth))) {
    throw Object.assign(new Error('minion_max_depth_invalid'), { statusCode: 400 });
  }
  if (hasHarness && !validHarness(input.defaultHarness)) {
    throw Object.assign(new Error('minion_default_harness_invalid'), { statusCode: 400 });
  }
  if (hasDefaultProfile && input.defaultMinionProfileId !== null && (typeof input.defaultMinionProfileId !== 'string' || !input.defaultMinionProfileId.trim())) throw Object.assign(new Error('minion_default_profile_invalid'), { statusCode: 400 });
  const burrowModel = hasBurrow ? normalizeCodexModelSelection(input.burrowModel) : null;
  if (burrowModel) {
    const { validateBurrowProfileModel } = await import('./minion-profiles.mjs');
    await validateBurrowProfileModel(models, burrowModel);
  }
  const codexModel = hasCodex ? normalizeCodexModelSelection(input.codexModel) : null;
  if (codexModel) await validateCodexModelSelection(models, codexModel);
  const claudeModel = hasClaude ? normalizeClaudeModelSelection(input.claudeModel) : null;
  if (claudeModel) await validateClaudeModelSelection(models, claudeModel);
  if (hasProfiles) {
    const { validateMinionProfileOverrides } = await import('./minion-profiles.mjs');
    await validateMinionProfileOverrides(metadata, input.profileOverrides, models);
  }
  const key = settingsKey(agentId);
  // First customization starts from global defaults, not hard-coded blanks.
  // Toggle-only off does not seed: first enabling can still inherit newer globals.
  const update = saved => {
    const hasSavedDefaults = saved && ['maxDepth', 'defaultHarness', 'burrowModel', 'codexEnabled', 'claudeEnabled', 'codexModel', 'claudeModel', 'defaultMinionProfileId'].some(k => Object.hasOwn(saved, k));
    const firstCustomization = agentId && !hasSavedDefaults && !(hasOverride && !input.overrideEnabled);
    const writeDefaults = firstCustomization || hasBurrow || enableFields.length > 0 || hasDepth || hasHarness || hasCodex || hasClaude || hasDefaultProfile || (!agentId && !saved);
    const merge = seed => ({
      ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}),
      ...(writeDefaults ? seed : {}),
      ...(agentId ? { overrideEnabled: hasOverride ? input.overrideEnabled : (saved ? minionOverrideEnabled(saved) : true) } : {}),
      ...(hasProfiles ? { profileOverrides: structuredClone(input.profileOverrides) } : {}),
      ...(hasDepth ? { maxDepth: input.maxDepth } : {}),
      ...(hasHarness ? { defaultHarness: input.defaultHarness } : {}),
      ...(hasBurrow ? { burrowModel } : {}),
      ...Object.fromEntries(enableFields.map(key => [key, input[key]])),
      ...(hasCodex ? { codexModel } : {}),
      ...(hasClaude ? { claudeModel } : {}),
      ...(!Object.hasOwn(saved || {}, 'codexEnabled') && !enableFields.includes('codexEnabled') && hasCodex ? { codexEnabled: Boolean(codexModel) } : {}),
      ...(!Object.hasOwn(saved || {}, 'claudeEnabled') && !enableFields.includes('claudeEnabled') && hasClaude ? { claudeEnabled: Boolean(claudeModel) } : {}),
      ...(hasDefaultProfile ? { defaultMinionProfileId: input.defaultMinionProfileId } : {}),
    });
    return firstCustomization
      ? metadata.get(MINION_GLOBAL_SETTINGS_KEY).then(global => merge(normalizeSettings(global)))
      : merge(normalizeSettings(saved));
  };
  // The PostgreSQL metadata owner serializes partial updates, including insert.
  if (metadata.atomicUpdate) return normalizeSettings(await metadata.atomicUpdate(key, update));
  const settings = await update(await metadata.get(key));
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
