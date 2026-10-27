import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fetchGitSkill } from './git-skill-fetch.mjs';
import { createBackgroundLifecycle } from './background-lifecycle.mjs';
import { operationalEvent } from './operational-log.mjs';

const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function manifestManagedSkills(modId, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`mod_managed_skills_invalid:${modId}`);
  const ids = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`mod_managed_skill_invalid:${modId}`);
    const id = String(entry.id || '').trim();
    const repository = String(entry.repository || '').trim();
    const skillPath = String(entry.path || '').trim();
    if (!SKILL_ID.test(id) || !repository || !skillPath) throw new Error(`mod_managed_skill_invalid:${modId}`);
    if (ids.has(id)) throw new Error(`mod_managed_skill_duplicate:${modId}`);
    ids.add(id);
    return Object.freeze({ id, repository, path: skillPath });
  });
}

const MANAGED_METADATA = '.burrow-managed-skill.json';

async function writeTree(root, fetched, declaration) {
  for (const file of fetched.files) {
    const destination = path.join(root, file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.bytes, { mode: 0o444 });
    await fs.chmod(destination, 0o444);
  }
  const metadata = {
    id: declaration.id,
    owner: declaration.owner,
    repository: declaration.repository,
    path: declaration.path,
    revision: fetched.revision || null,
    version: fetched.version || null,
    contentHash: fetched.contentHash || null,
    synchronizedAt: new Date().toISOString(),
  };
  const metadataPath = path.join(root, MANAGED_METADATA);
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o444 });
  await fs.chmod(metadataPath, 0o444);
}

export async function inspectManagedSkills({ root, declarations = [] } = {}) {
  const targetRoot = path.resolve(root);
  return Promise.all(declarations.map(async declaration => {
    try {
      const value = JSON.parse(await fs.readFile(path.join(targetRoot, declaration.id, MANAGED_METADATA), 'utf8'));
      return {
        id: declaration.id,
        status: 'ready',
        ...(typeof value.version === 'string' && value.version ? { version: value.version } : {}),
      };
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return { id: declaration.id, status: 'pending' };
      throw error;
    }
  }));
}

/** Synchronize the complete desired set. The dedicated root is merged into every
 * effective catalog by skill-catalog; callers never mutate ordinary agent skills. */
export async function reconcileManagedSkills({ root, declarations = [], fetchSkill = fetchGitSkill } = {}) {
  if (!root) throw new Error('managed_skill_root_required');
  const targetRoot = path.resolve(root);
  const desired = new Map();
  for (const declaration of declarations) {
    if (desired.has(declaration.id)) throw new Error(`managed_skill_id_conflict:${declaration.id}`);
    desired.set(declaration.id, declaration);
  }
  await fs.mkdir(targetRoot, { recursive: true });
  const stagingRoot = path.join(targetRoot, `.staging-${randomUUID()}`);
  await fs.mkdir(stagingRoot, { recursive: true });
  try {
    for (const declaration of desired.values()) {
      const fetched = await fetchSkill({ repository: declaration.repository, path: declaration.path });
      await writeTree(path.join(stagingRoot, declaration.id), fetched, declaration);
    }
    for (const entry of await fs.readdir(targetRoot, { withFileTypes: true })) {
      if (entry.name.startsWith('.staging-')) continue;
      if (!desired.has(entry.name)) await fs.rm(path.join(targetRoot, entry.name), { recursive: true, force: true });
    }
    for (const id of desired.keys()) {
      const destination = path.join(targetRoot, id);
      await fs.rm(destination, { recursive: true, force: true });
      await fs.rename(path.join(stagingRoot, id), destination);
    }
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
  return { ids: [...desired.keys()].sort() };
}

export function activeManagedSkillDeclarations(mods = [], core = []) {
  return [
    ...core.map(skill => ({ ...skill, owner: 'core' })),
    ...mods.filter(mod => mod.status === 'loaded').flatMap(mod => (mod.managedSkills || []).map(skill => ({ ...skill, owner: mod.id }))),
  ];
}

export function createManagedSkillSynchronizer({ reconcile, intervalMs = 6 * 60 * 60 * 1000, logger = console } = {}) {
  if (typeof reconcile !== 'function') throw new Error('managed_skill_reconcile_required');
  let unavailable = false;
  const lifecycle = createBackgroundLifecycle({ name: 'managed_skill_sync', logger: {
    event(_type, fields) {
      // Keep every failure in lifecycle health, but emit only outage transitions.
      // An injected logger never falls back to lifecycle's raw exception output.
      if (unavailable) return;
      unavailable = true;
      operationalEvent(logger, 'managed_skill_sync_unavailable', { ...fields,
        errorCode: fields.errorCode === 'background_operation_failed' ? 'managed_skill_sync_failed' : fields.errorCode,
      }, { level: 'warn', component: 'skills' });
    },
  } });
  let timer = null;
  let ticking = false;
  async function runTick() {
    if (ticking || lifecycle.stopped) return { ok: true, skipped: true };
    ticking = true;
    try {
      const result = await reconcile();
      if (unavailable) {
        unavailable = false;
        operationalEvent(logger, 'managed_skill_sync_restored', {}, { level: 'info', component: 'skills' });
      }
      return { ok: true, result };
    }
    catch (error) { lifecycle.reportFailure(error); return { ok: false, error: String(error?.message || error) }; }
    finally { ticking = false; }
  }
  function tick() { return lifecycle.stopped ? Promise.resolve({ ok: true, skipped: true }) : lifecycle.track(runTick); }
  function start() {
    if (lifecycle.stopped) return Promise.resolve({ ok: true, skipped: true });
    if (!timer) { timer = setInterval(() => { void tick().catch(() => {}); }, intervalMs); timer.unref?.(); }
    return tick();
  }
  function stop() { lifecycle.stop(); if (timer) clearInterval(timer); timer = null; }
  function close() { stop(); return lifecycle.close(); }
  return { start, stop, close, tick, health: lifecycle.health };
}
