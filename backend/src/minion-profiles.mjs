import { minionOverrideEnabled } from './minion-depth.mjs';
import { randomUUID } from 'node:crypto';
import { normalizeCodexModelSelection, validateCodexModelSelection } from './codex-model-selection.mjs';
import { normalizeClaudeModelSelection, validateClaudeModelSelection } from './claude-model-selection.mjs';
import { localExecutionTarget, remoteExecutionTarget, resolveProcessExecutionTarget } from './process-execution-router.mjs';

export const MINION_PROFILE_HARNESSES = Object.freeze(['burrow', 'codex', 'claude']);
const HARNESS = new Set(MINION_PROFILE_HARNESSES);

export const MINION_PROFILE_FIELDS = Object.freeze(['name', 'harness', 'enabled', 'model', 'executionHostId', 'instructions']);

export const MINION_PROFILES_KEY = 'minion_profiles';
const profilesKey = () => MINION_PROFILES_KEY;
const legacyProfilesKey = agentId => `minion_profiles:${agentId}`;
const settingsKey = agentId => `minion_settings:${agentId}`;
const text = value => String(value ?? '').trim();
const fail = (code, statusCode = 400) => { throw Object.assign(new Error(code), { statusCode }); };

/** Serialize a partial write through the metadata owner when it offers one. */
async function mutate(metadata, key, update) {
  if (!metadata) fail('minion_profile_store_required', 500);
  if (typeof metadata.atomicUpdate === 'function') return metadata.atomicUpdate(key, update);
  const value = await update(await metadata.get(key));
  await metadata.set(key, value);
  return value;
}

/**
 * Structural shape only. Harness/model compatibility is a write-time rule
 * (see validateMinionProfile) so that a profile saved before a connection was
 * removed still reads back truthfully instead of disappearing from the list.
 */
export function normalizeMinionProfile(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('minion_profile_invalid');
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!HARNESS.has(row.harness)) fail('minion_profile_harness_invalid');
  if (!name) fail('minion_profile_name_invalid');
  if (typeof row.enabled !== 'boolean') fail('minion_profile_enabled_invalid');
  const instructions = typeof row.instructions === 'string' ? row.instructions : fail('minion_profile_instructions_invalid');
  if (row.executionHostId !== null && (typeof row.executionHostId !== 'string' || !row.executionHostId.trim())) fail('minion_profile_host_invalid');
  const model = row.model == null ? null
    : (row.harness === 'claude' ? normalizeClaudeModelSelection(row.model) : normalizeCodexModelSelection(row.model));
  return {
    id: text(row.id) || randomUUID(),
    name,
    harness: row.harness,
    enabled: row.enabled,
    model,
    executionHostId: row.executionHostId === null ? null : text(row.executionHostId),
    instructions,
  };
}

/** Harness/model compatibility, checked before any profile row is committed. */
export async function validateMinionProfile(profile, models) {
  if (profile.harness === 'burrow') {
    if (profile.model) await validateBurrowProfileModel(models, profile.model);
    return profile;
  }
  if (!profile.model) fail('minion_profile_model_required');
  await (profile.harness === 'claude' ? validateClaudeModelSelection : validateCodexModelSelection)(models, profile.model);
  return profile;
}

/** Same enabled connection/model catalog used by ordinary Burrow selection.
 * Secrets are resolved only at dispatch by resolveModelConfig, not on writes.
 */
export async function validateBurrowProfileModel(models, selection) {
  if (!models?.get) fail('model_settings_store_required');
  const connection = await models.get(selection.connectionId);
  if (!connection) fail('model_connection_not_found');
  if (!(connection.models || []).some(row => row.id === selection.model && row.selected !== false)) fail('model_not_enabled_for_connection');
  return selection;
}

/** Immutable copy persisted with a child so later edits cannot rewrite history. */
export function minionProfileSnapshot(profile) {
  if (!profile) return null;
  return Object.freeze({
    id: profile.id,
    name: profile.name,
    harness: profile.harness,
    model: profile.model ? Object.freeze({ ...profile.model }) : null,
    executionHostId: profile.executionHostId ?? null,
    instructions: typeof profile.instructions === 'string' ? profile.instructions : '',
  });
}

function readProfiles(saved) {
  if (!Array.isArray(saved?.profiles)) return [];
  const rows = [];
  for (const row of saved.profiles) {
    // One corrupt row must not make every other profile unselectable. A missing
    // profile still fails selection loudly with minion_profile_not_found.
    try { rows.push(normalizeMinionProfile(row)); } catch {}
  }
  return rows;
}

export function legacyMinionProfileId(agentId, harness) {
  return `legacy-${text(agentId) || 'agent'}-${harness}`;
}

function legacyProfileRows(agentId, legacy, agentName = agentId) {
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return [];
  const harness = HARNESS.has(legacy.defaultHarness) ? legacy.defaultHarness : null;
  const model = name => {
    try {
      if (name === 'codex') return normalizeCodexModelSelection(legacy.codexModel ?? null);
      if (name === 'claude') return normalizeClaudeModelSelection(legacy.claudeModel ?? null);
    } catch { return null; }
    return null;
  };
  const rows = [];
  for (const name of MINION_PROFILE_HARNESSES) {
    const selected = model(name);
    // Import only what the operator actually configured: the selected default
    // harness, plus any harness that already carries a configured model.
    if (name !== harness && !selected) continue;
    rows.push({
      id: legacyMinionProfileId(agentId, name),
      name: `Imported ${agentName} ${name} minion`,
      harness: name,
      enabled: true,
      model: selected,
      executionHostId: null,
      instructions: '',
    });
  }
  return rows;
}

/** Reconcile only provenance-backed generated identities; never names. Archive
 * before hiding so interrupted writes cannot discard operator edits. */
export async function migrateLegacyMinionProfiles(metadata, agentId, { agentName = agentId } = {}) {
  if (!metadata?.get) return { migrated: false, profiles: [] };
  const existing = await metadata.get(MINION_PROFILES_KEY);
  if (!text(agentId)) return { migrated: false, profiles: readProfiles(existing) };
  let legacy = await metadata.get(settingsKey(agentId));
  const oldRoster = await metadata.get(legacyProfilesKey(agentId));
  const generatedIds = new Set(MINION_PROFILE_HARNESSES.map(h => legacyMinionProfileId(agentId, h)));
  const proven = existing?.importedAgents?.[agentId] || Array.isArray(oldRoster?.profiles);
  const imported = proven ? readProfiles(existing).filter(p => generatedIds.has(p.id)) : [];
  const oldRows = readProfiles(oldRoster);
  const archived = readProfiles({ profiles: legacy?.legacyProfiles });
  const generated = existing?.reconciledAgents?.[agentId] ? [] :
    (Array.isArray(oldRoster?.profiles) ? oldRows.filter(p => generatedIds.has(p.id))
      : existing?.importedAgents?.[agentId] ? [] : legacyProfileRows(agentId, legacy, agentName));
  let local = new Map([...generated, ...imported, ...archived].map(p => [p.id, p]));
  const custom = existing?.reconciledAgents?.[agentId] ? [] : oldRows.filter(p => !generatedIds.has(p.id));
  const reconcile = saved => {
    const profiles = Array.isArray(saved?.profiles) ? saved.profiles : [];
    const ids = new Set(profiles.map(p => p?.id));
    return { ...(saved || {}), profiles: [...profiles.filter(p => !imported.some(i => i.id === p?.id)), ...custom.filter(p => !ids.has(p.id))],
      importedAgents: { ...(saved?.importedAgents || {}), [agentId]: true },
      reconciledAgents: { ...(saved?.reconciledAgents || {}), [agentId]: true } };
  };
  let saved = reconcile(existing);
  if (!existing?.reconciledAgents?.[agentId] && (metadata.atomicUpdate || metadata.set)) {
    try {
      // Archive first. Keep existing explicit null/default choices authoritative.
      if (legacy || local.size) {
        legacy = await mutate(metadata, settingsKey(agentId), prior => {
          // The pre-lock snapshot is only an import source. Current archived
          // rows win, including concurrent repairs and newly archived siblings.
          const current = new Map([...generated, ...imported,
            ...readProfiles({ profiles: prior?.legacyProfiles })].map(p => [p.id, p]));
          return { ...(prior || {}),
            ...(current.size ? { legacyProfiles: [...current.values()] } : {}),
            ...(prior && !Object.hasOwn(prior, 'overrideEnabled') ? { overrideEnabled: minionOverrideEnabled(prior) } : {}),
            ...(!Object.hasOwn(prior || {}, 'defaultMinionProfileId') && current.size ? {
              defaultMinionProfileId: [...current.values()].find(p => p.harness === prior?.defaultHarness)?.id || [...current.keys()][0] } : {}) };
        });
        local = new Map(readProfiles({ profiles: legacy?.legacyProfiles }).map(p => [p.id, p]));
      }
      saved = await mutate(metadata, MINION_PROFILES_KEY, reconcile);
    } catch { /* read-only view still resolves deterministically */ }
  }
  const enabled = minionOverrideEnabled(legacy);
  const globalProfiles = readProfiles(saved);
  const patches = enabled ? legacy?.profileOverrides || {} : {};
  const profiles = globalProfiles.map(p => {
    try { return { ...normalizeMinionProfile({ ...p, ...patches[p.id], id: p.id }), enabled: p.enabled && patches[p.id]?.enabled !== false }; }
    catch { return p; }
  });
  if (enabled) profiles.push(...[...local.values()].filter(p => !profiles.some(g => g.id === p.id)));
  return { migrated: !existing?.reconciledAgents?.[agentId], profiles };
}

export async function listMinionProfiles(metadata, agentId, options = {}) {
  return { ok: true, profiles: (await migrateLegacyMinionProfiles(metadata, agentId, options)).profiles };
}

export async function validateMinionProfileOverrides(metadata, patches, models) {
  if (!patches || typeof patches !== 'object' || Array.isArray(patches)) fail('minion_profile_overrides_invalid');
  const profiles = readProfiles(await metadata.get(MINION_PROFILES_KEY));
  for (const [id, patch] of Object.entries(patches)) {
    assertKnownFields(patch);
    if (Object.hasOwn(patch, 'id')) fail('minion_profile_field_unknown');
    const prior = profiles.find(p => p.id === id);
    if (!prior) fail('minion_profile_not_found', 404);
    await validateMinionProfile(normalizeMinionProfile({ ...prior, ...patch, id }), models);
  }
}

/** Reject unknown fields so a mistyped UI key can never silently do nothing. */
function assertKnownFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('minion_profile_invalid');
  if (Object.keys(input).some(key => key !== 'id' && !MINION_PROFILE_FIELDS.includes(key))) fail('minion_profile_field_unknown');
}

export async function createMinionProfile(metadata, agentId, input, { models } = {}) {
  assertKnownFields(input);
  const profile = normalizeMinionProfile({
    enabled: true,
    model: null,
    executionHostId: null,
    instructions: '',
    ...input,
    id: randomUUID(),
  });
  await validateMinionProfile(profile, models);
  await migrateLegacyMinionProfiles(metadata, agentId);
  await mutate(metadata, profilesKey(agentId), saved => ({
    ...(saved || {}),
    profiles: [...(Array.isArray(saved?.profiles) ? saved.profiles : []), profile],
  }));
  return { ok: true, profile };
}

/**
 * Partial update: only supplied fields change, and the merged profile is fully
 * normalized and validated before anything is written. A rejected patch leaves
 * the stored profile byte-for-byte unchanged.
 */
export async function updateMinionProfile(metadata, agentId, id, patch, { models } = {}) {
  assertKnownFields(patch);
  if (!readProfiles(await metadata.get(MINION_PROFILES_KEY)).some(p => p.id === id)) {
    const state = await metadata.get(MINION_PROFILES_KEY);
    if (!state?.importedAgents?.[agentId] && !state?.reconciledAgents?.[agentId]) await migrateLegacyMinionProfiles(metadata, agentId);
  }
  let updated;
  const agentSettings = agentId ? await metadata.get(settingsKey(agentId)) : null;
  if (agentSettings?.legacyProfiles?.some(p => p.id === id)) {
    await mutate(metadata, settingsKey(agentId), async saved => {
      const prior = saved?.legacyProfiles?.find(p => p.id === id);
      if (!prior) fail('minion_profile_not_found', 404);
      if (Object.hasOwn(patch, 'id') && patch.id !== id) fail('minion_profile_id_mismatch');
      const merged = { ...prior, ...patch, id };
      if (patch.harness && patch.harness !== prior.harness && !Object.hasOwn(patch, 'model')) merged.model = null;
      updated = normalizeMinionProfile(merged);
      await validateMinionProfile(updated, models);
      return { ...saved, legacyProfiles: saved.legacyProfiles.map(p => p.id === id ? updated : p) };
    });
    return { ok: true, profile: updated };
  }
  // Merge against the current row *inside* the metadata owner's lock. Merging
  // outside it loses concurrent partial changes even when the final set is locked.
  await mutate(metadata, profilesKey(agentId), async value => {
    const profiles = Array.isArray(value?.profiles) ? value.profiles : [];
    const prior = readProfiles(value).find(row => row.id === id);
    if (!prior) fail('minion_profile_not_found', 404);
    if (Object.hasOwn(patch, 'id') && text(patch.id) !== prior.id) fail('minion_profile_id_mismatch');
    const merged = { ...prior, ...patch, id: prior.id };
    if (patch.harness && patch.harness !== prior.harness && !Object.hasOwn(patch, 'model')) merged.model = null;
    updated = normalizeMinionProfile(merged);
    await validateMinionProfile(updated, models);
    return { ...(value || {}), profiles: profiles.map(row => (text(row?.id) === id ? updated : row)) };
  });
  return { ok: true, profile: updated };
}

/**
 * Resolve which profile governs one spawn. An explicit profile wins; otherwise
 * the agent default applies unless the caller named an explicit harness. An
 * unknown or disabled selection is a blocker, never a silent fallback.
 */
export function selectMinionProfile({ profiles = [], settings = {}, requestedProfileId = null, requestedHarness = null } = {}) {
  const explicit = text(requestedProfileId);
  const selectedProfileId = explicit || (requestedHarness ? '' : text(settings?.defaultMinionProfileId));
  if (!selectedProfileId) return { profile: null, selectedProfileId: null, explicit: false, blockers: [] };
  const found = profiles.find(row => row.id === selectedProfileId) || null;
  if (!found) return { profile: null, selectedProfileId, explicit: Boolean(explicit), blockers: [`minion_profile_not_found:${selectedProfileId}`] };
  if (!found.enabled) return { profile: null, selectedProfileId, explicit: Boolean(explicit), blockers: [`minion_profile_disabled:${selectedProfileId}`] };
  return { profile: found, selectedProfileId, explicit: Boolean(explicit), blockers: [] };
}

/** Resolve existing Node Goblin catalog identities; `local` is reserved by
 * that catalog. Null alone means inheritance. No fallback on unavailable pins.
 */
export async function resolveMinionProfileExecutionTarget({ executionContext = null, profile = null } = {}) {
  const inherited = resolveProcessExecutionTarget(executionContext || {});
  const hostId = text(profile?.executionHostId);
  if (!hostId) return { target: inherited, inherited: true, blockers: [] };
  if (hostId === 'local') return { target: localExecutionTarget(), inherited: inherited.kind === 'local', controller: null, blockers: [] };
  if (inherited.kind === 'remote' && inherited.targetId === hostId) return { target: inherited, inherited: true, blockers: [] };
  const providerId = inherited.kind === 'remote' ? inherited.providerId : 'node-goblin';
  const controller = executionContext?.executionProviders?.get(providerId)
    || (inherited.kind === 'remote' ? executionContext?.processExecutionController : null);
  const unavailable = { target: null, inherited: false, blockers: [`minion_profile_execution_host_unavailable:${hostId}`] };
  if (typeof controller?.describeHost !== 'function') return unavailable;
  try { if (!await controller.describeHost(hostId)) return unavailable; }
  catch { return unavailable; }
  return { target: remoteExecutionTarget(providerId, hostId), controller, inherited: false, blockers: [] };
}

/** Operator-facing remediation for a profile blocker, surfaced to the model. */
export function minionProfileAction(code) {
  const value = String(code || '');
  const id = value.slice(value.indexOf(':') + 1);
  if (value.startsWith('minion_profile_not_found:')) return `Minion profile ${id} does not exist. Name an existing enabled profile, or have the operator clear the agent default; spawning never substitutes another profile.`;
  if (value.startsWith('minion_profile_disabled:')) return `Minion profile ${id} is disabled. Ask the operator to enable it or name a different enabled profile; spawning never falls back to another profile or harness.`;
  if (value.startsWith('minion_profile_execution_host_unavailable:')) return `Minion profile execution host ${id} is not reachable from this agent's execution provider. Ask the operator to fix the profile host or clear it to inherit this agent's host.`;
  return null;
}

export const MINION_PROFILE_BLOCKER_PREFIXES = Object.freeze([
  'minion_profile_not_found:',
  'minion_profile_disabled:',
  'minion_profile_execution_host_unavailable:',
]);

/** Compact enabled-profile catalog rendered into the live spawn tool schema. */
export function minionProfileToolDescription(profiles = []) {
  const enabled = (Array.isArray(profiles) ? profiles : []).filter(row => row?.enabled);
  const base = 'Optional id of a reusable minion profile. The profile harness, model, execution host, and standing instructions are applied to this child.';
  if (!enabled.length) return `${base} No minion profiles are configured in the shared roster.`;
  const catalog = enabled.map(row => {
    const parts = [`harness ${row.harness}`];
    if (row.model?.model) parts.push(`model ${row.model.model}`);
    if (row.executionHostId) parts.push(`host ${row.executionHostId}`);
    return `${row.id} (${row.name}; ${parts.join(', ')})`;
  }).join('; ');
  return `${base} Enabled profiles: ${catalog}.`;
}
