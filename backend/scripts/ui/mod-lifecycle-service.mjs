import { cleanupMods as cleanupModHosts, loadMods as loadModHosts } from '../../src/mod-runtime.mjs';
import { publishModTools as publishLoadedModTools } from '../../src/mod-agent-tools.mjs';
import {
  activeManagedSkillDeclarations,
  createManagedSkillSynchronizer,
  reconcileManagedSkills as reconcileManagedSkillFiles,
} from '../../src/managed-skills.mjs';
import { fetchGitSkill } from '../../src/git-skill-fetch.mjs';

const CORE_MANAGED_SKILLS = Object.freeze([
  Object.freeze({ id: 'burrow-runtime', repository: 'https://github.com/GoblinKing-Burrow/Burrow-Skills.git', path: 'burrow-runtime/SKILL.md' }),
]);

/** Own the in-memory mod set and the activation/replacement transition protocol.
 * Distribution, routes, and the server remain composition owners and consume
 * getMods() rather than maintaining a competing mod-list variable. */
export function createModLifecycleService({
  modLoadOptions,
  loadMods = loadModHosts,
  cleanupMods = cleanupModHosts,
  publishModTools = publishLoadedModTools,
  logger = console,
  getManagedSkillRoot,
  managedSkillFetch = fetchGitSkill,
  managedSkillSyncIntervalMs = 6 * 60 * 60 * 1000,
  managedSkillSynchronizer: managedSkillSynchronizerDependency = null,
  coreManagedSkills = CORE_MANAGED_SKILLS,
} = {}) {
  if (!modLoadOptions || typeof modLoadOptions !== 'object') throw new Error('mod_lifecycle_load_options_required');
  if (typeof loadMods !== 'function' || typeof cleanupMods !== 'function' || typeof publishModTools !== 'function') {
    throw new Error('mod_lifecycle_runtime_dependencies_required');
  }
  if (typeof getManagedSkillRoot !== 'function') throw new Error('mod_lifecycle_managed_skill_root_required');

  let loadedMods = [];
  let starting = true;
  let initialized = false;
  let managedSkillCoreDeclarations = [...coreManagedSkills];

  async function reconcileRuntimeManagedSkills(mods = loadedMods) {
    const root = await getManagedSkillRoot();
    return reconcileManagedSkillFiles({
      root,
      declarations: activeManagedSkillDeclarations(mods, managedSkillCoreDeclarations),
      fetchSkill: managedSkillFetch,
    });
  }

  let managedSkillSynchronizer = managedSkillSynchronizerDependency || createManagedSkillSynchronizer({
    logger,
    reconcile: () => reconcileRuntimeManagedSkills(),
    intervalMs: Math.max(60_000, Number(managedSkillSyncIntervalMs) || 6 * 60 * 60 * 1000),
  });
  function setManagedSkillSynchronizer(synchronizer) {
    if (!synchronizer || typeof synchronizer.tick !== 'function') throw new Error('mod_lifecycle_skill_synchronizer_required');
    managedSkillSynchronizer = synchronizer;
  }

  async function initialize() {
    if (!starting || initialized) throw new Error('mod_lifecycle_already_initialized');
    initialized = true;
    loadedMods = await loadMods(modLoadOptions);
    return getMods();
  }

  function markReady() { starting = false; }
  function getMods() { return [...loadedMods]; }
  function setCoreManagedSkills(skills) {
    if (!Array.isArray(skills)) throw new Error('mod_lifecycle_core_skills_invalid');
    managedSkillCoreDeclarations = [...skills];
  }

  async function transition({ modId, enabled, installed, action, reactivate = false } = {}) {
    // Distribution's startup journal repairs durable metadata before any host
    // activation. Keep callbacks delivered during that barrier non-operative.
    if (starting) return;

    const old = loadedMods.find((entry) => entry.id === modId) || null;
    // Repeated enable is a no-op only for a genuinely active loaded host.
    // Failed/disconnected hosts must still pass through activation on retry.
    if (!reactivate && ['enable', 'enable-recovery'].includes(action) && installed && enabled
      && old?.status === 'loaded' && old.host && !old.host.child?.killed && old.host.child?.connected) return;
    if (old?.host?.activeOperationCount?.() > 0) throw Object.assign(new Error('mod_busy'), { statusCode: 409 });
    if (action === 'update-preflight') return;

    // A failed uninstall can restore files and lifecycle records after the old
    // host/catalog entry was removed. Re-discover a disabled mod as well as
    // reactivating an enabled one so memory, filesystem, and PostgreSQL converge.
    if (action === 'uninstall-recovery' && installed && !enabled && !old) {
      const [restored] = await loadMods({ ...modLoadOptions, onlyModIds: [modId] });
      if (!restored) throw Object.assign(new Error('mod_recovery_failed'), { statusCode: 500 });
      loadedMods = [...loadedMods, restored];
      return;
    }

    if (!installed || !enabled) {
      if (old) await cleanupMods([old], { logger });
      loadedMods = installed
        ? loadedMods.map((entry) => entry.id === modId
          ? { ...entry, host: null, routes: [], store: null, lifecycleCleanup: null, status: 'disabled' }
          : entry)
        : loadedMods.filter((entry) => entry.id !== modId);
      await managedSkillSynchronizer.tick();
      return;
    }

    if (reactivate && old) {
      // Newly approved interfaces require a fresh host. Stop the old listener
      // before activation; overlapping Node Goblin listeners cannot share a port.
      await cleanupMods([old], { logger });
      Object.assign(old, { host: null, routes: [], store: null, lifecycleCleanup: null, status: 'disabled' });
    }

    const [next] = await loadMods({ ...modLoadOptions, onlyModIds: [modId], replaceExecutionProviders: action === 'update' });
    if (!next || next.status !== 'loaded') {
      if (next) await cleanupMods([next], { logger });
      throw Object.assign(new Error(next?.error || 'mod_activation_failed'), { statusCode: 409 });
    }

    // Activation awaits child IPC; acquire an idle admission barrier before
    // the fallible asynchronous catalog write. Keep the original host tracked
    // until publication succeeds, so distribution compensation cannot orphan it.
    let resumeAdmissions;
    try {
      if (old?.host?.activeOperationCount?.() > 0) throw Object.assign(new Error('mod_busy'), { statusCode: 409 });
      resumeAdmissions = old?.host?.pauseAdmissions?.();
      if (action === 'update') await publishModTools(next, modLoadOptions.modCatalogWriter);
      next.commitProviderReplacement?.();
      loadedMods = old
        ? loadedMods.map((entry) => entry.id === modId ? next : entry)
        : [...loadedMods, next];
    } catch (error) {
      await cleanupMods([next], { logger });
      resumeAdmissions?.();
      throw error;
    }

    if (old) await cleanupMods([old], { logger });
    // Skill delivery is auxiliary: its synchronizer owns failure diagnostics and
    // periodic retries. A missing upstream skill must not undo a valid mod update.
    await managedSkillSynchronizer.tick();
    await modLoadOptions.onExecutionProviderActivated?.(modId);
  }

  return Object.freeze({
    getMods,
    initialize,
    markReady,
    transition,
    reconcileManagedSkills: reconcileRuntimeManagedSkills,
    setCoreManagedSkills,
    setManagedSkillSynchronizer,
    get managedSkillSynchronizer() { return managedSkillSynchronizer; },
  });
}

export { CORE_MANAGED_SKILLS };