import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sha256(text) {
  return `sha256:${createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16)}`;
}

function normalizeId(value = '') {
  return String(value || '').trim();
}

function adminLifecycle(skill, overrides = {}) {
  const id = normalizeId(skill.id);
  if (skill.disabled === true || asArray(overrides.disabledSkillIds).includes(id)) return 'disabled';
  if (skill.experimental === true || asArray(overrides.experimentalSkillIds).includes(id)) return 'experimental';
  if (skill.deprecated === true || asArray(overrides.deprecatedSkillIds).includes(id)) return 'deprecated';
  return 'available';
}

async function findSkillBodies(skillsRoot) {
  const found = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolutePath);
      else if (entry.isFile() && entry.name === 'SKILL.md') found.push(absolutePath);
    }
  }
  await walk(skillsRoot);
  return found.sort();
}

function frontmatterMetadata(text = '') {
  const match = String(text).match(/^---\r?\n([\s\S]{0,8192}?)\r?\n---/);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z][\w-]*):\s*["']?(.+?)["']?\s*$/.exec(line);
    if (entry) fields[entry[1]] = entry[2];
  }
  return fields;
}

async function loadOwnedSkillRoot({ skillsRoot, owner, overrides = {} } = {}) {
  const root = path.resolve(skillsRoot);
  const bodies = await findSkillBodies(root);
  const skills = [];
  for (const absolutePath of bodies) {
    // The directory name is the skill ID. No registry or routing metadata exists.
    const id = normalizeId(path.basename(path.dirname(absolutePath)));
    if (!id) continue;
    const stat = await fs.stat(absolutePath);
    // Catalog metadata is deliberately bounded: enough to advertise a capability,
    // never a substitute for loading its instructions.
    const header = await fs.readFile(absolutePath, 'utf8').then((body) => body.slice(0, 8192));
    const metadata = frontmatterMetadata(header);
    const lifecycle = adminLifecycle({ id }, overrides);
    skills.push({
      id,
      name: metadata.name || id,
      description: metadata.description || '',
      priority: 0,
      path: path.relative(root, absolutePath),
      sourcePath: path.relative(root, absolutePath),
      absolutePath,
      bytes: stat.size,
      // A body hash is computed only when this selected skill is actually loaded.
      version: null,
      sourceExists: true,
      owner,
      ownership: { scope: owner.scope, agentId: owner.agentId || null, skillsRoot: root },
      lifecycle,
      available: lifecycle !== 'disabled',
      portability: { memoryIndexable: true, memoryStoresBody: false },
    });
  }
  return skills;
}

function compactSkill(skill) {
  return {
    id: skill.id,
    name: skill.name || skill.id,
    description: skill.description || '',
    domains: asArray(skill.domains),
    paths: asArray(skill.paths),
    priority: Number(skill.priority || 0),
    path: skill.path,
    sourcePath: skill.sourcePath || skill.path,
    absolutePath: skill.absolutePath || null,
    version: skill.version || null,
    lifecycle: skill.lifecycle || 'available',
    available: skill.available !== false,
    owner: skill.owner || null,
    ownership: skill.ownership || null,
    memoryProjects: asArray(skill.memoryProjects),
    memoryTopics: asArray(skill.memoryTopics),
  };
}

/**
 * Build an agent's effective skill catalog from ownership only.
 * Agent-owned entries shadow shared entries with the same id.
 */
export async function loadEffectiveSkillCatalog({ workspaceRoot, agentId, agentRuntime = null, overrides = {} } = {}) {
  const runtimeAgentId = agentRuntime?.agentId == null ? null : normalizeId(agentRuntime.agentId);
  const runtimeAgentWorkspace = agentRuntime?.agentWorkspaceRoot ? path.resolve(agentRuntime.agentWorkspaceRoot) : null;
  const runtimeSkillsRoot = agentRuntime?.skillsRoot ? path.resolve(agentRuntime.skillsRoot) : null;
  if (agentRuntime && (!runtimeAgentId || !runtimeAgentWorkspace || !runtimeSkillsRoot)) throw new Error('agent_runtime_context_required');
  if (!agentRuntime && !workspaceRoot) throw new Error('workspaceRoot is required');
  if (!agentRuntime && !agentId) throw new Error('agentId is required');
  const workspace = path.resolve(workspaceRoot || path.dirname(runtimeAgentWorkspace));
  const resolvedAgentId = runtimeAgentId || normalizeId(agentId);
  const globalRoot = path.join(workspace, 'global', 'skills');
  const agentRoot = runtimeSkillsRoot || path.join(workspace, resolvedAgentId, 'skills');
  const [globalSkills, agentSkills] = await Promise.all([
    loadOwnedSkillRoot({ skillsRoot: globalRoot, owner: { scope: 'global', agentId: null }, overrides }),
    loadOwnedSkillRoot({ skillsRoot: agentRoot, owner: { scope: 'agent', agentId: resolvedAgentId }, overrides }),
  ]);
  const effective = new Map(globalSkills.map((skill) => [skill.id, skill]));
  for (const skill of agentSkills) effective.set(skill.id, skill);
  const skills = [...effective.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    workspaceRoot: workspace,
    agentId: resolvedAgentId,
    roots: { global: globalRoot, agent: agentRoot },
    overrides: {
      disabledSkillIds: asArray(overrides.disabledSkillIds).map(String),
      experimentalSkillIds: asArray(overrides.experimentalSkillIds).map(String),
      deprecatedSkillIds: asArray(overrides.deprecatedSkillIds).map(String),
    },
    skills,
    availableSkills: skills.filter((skill) => skill.available),
    unavailableSkills: skills.filter((skill) => !skill.available),
  };
}

export function skillManifest(skill) {
  return compactSkill(skill);
}

export function selectCatalogSkills({ catalog = [], ids = [], source = 'model-selected' } = {}) {
  const byId = new Map(asArray(catalog).map((skill) => [String(skill.id), skill]));
  const selected = [];
  const rejected = [];
  for (const id of unique(asArray(ids).map(String))) {
    const skill = byId.get(id);
    if (!skill) {
      rejected.push({ id, reason: 'skill_not_in_effective_catalog' });
      continue;
    }
    if (skill.available === false) {
      rejected.push({ id, reason: `skill_${skill.lifecycle || 'unavailable'}` });
      continue;
    }
    selected.push({
      ...compactSkill(skill),
      selection: {
        source,
        owner: skill.owner || null,
        lifecycle: skill.lifecycle || 'available',
      },
    });
  }
  return { selected, rejected };
}

// Only explicitly loaded/requested skill bodies belong in the prompt. The catalog is advertised separately; it never guesses relevance.
export function promptEligibleSkills({ catalog = [], selected = [] } = {}) {
  const selectedById = new Map(asArray(selected).map((skill) => [String(skill.id), skill]));
  return asArray(catalog)
    .filter((skill) => skill.available !== false)
    .filter((skill) => selectedById.has(String(skill.id)))
    .map((skill) => {
      const selectedSkill = selectedById.get(String(skill.id));
      return { ...compactSkill(skill), ...(selectedSkill?.selection ? { selection: selectedSkill.selection } : {}), promptInclusion: 'agent-loaded' };
    });
}

export function buildSkillCapabilitySnapshot({ selected = [], catalog = [], rejected = [] } = {}) {
  return {
    source: 'ownership-derived-catalog',
    selected: asArray(selected).map((skill) => ({
      id: skill.id,
      selection: skill.selection || null,
      owner: skill.owner || null,
      lifecycle: skill.lifecycle || 'available',
      version: skill.version || null,
    })),
    catalog: asArray(catalog).map(skillManifest),
    rejected: asArray(rejected),
  };
}

export function buildSkillMemoryIndex(skills = [], { namespace = 'skills' } = {}) {
  return asArray(skills).map((skill) => ({
    namespace,
    type: 'skill_metadata',
    id: skill.id,
    name: skill.name || skill.id,
    description: skill.description || '',
    sourcePath: skill.sourcePath || skill.path || null,
    version: skill.version || null,
    lifecycle: skill.lifecycle || 'available',
    available: skill.available !== false,
    owner: skill.owner || null,
    ownership: skill.ownership || null,
    memoryProjects: asArray(skill.memoryProjects),
    memoryTopics: asArray(skill.memoryTopics),
    portability: { memoryStoresBody: false, ...(skill.portability || {}) },
  }));
}

export function compareMemorySkillIndex({ memoryEntries = [], filesystemSkills = [] } = {}) {
  const byId = new Map(asArray(filesystemSkills).map((skill) => [String(skill.id), skill]));
  return asArray(memoryEntries).map((entry) => {
    const fsSkill = byId.get(String(entry.id));
    const stale = Boolean(fsSkill && entry.version && fsSkill.version && entry.version !== fsSkill.version);
    return {
      ...entry,
      lifecycle: !fsSkill ? 'missing' : stale ? 'stale' : fsSkill.lifecycle || 'available',
      stale,
      missing: !fsSkill,
      filesystemVersion: fsSkill?.version || null,
      sourcePath: fsSkill?.sourcePath || entry.sourcePath || null,
    };
  });
}

export async function loadSelectedSkillText(rootDir, selected, { maxTotalChars = 64_000, maxPerSkillChars = 32_000 } = {}) {
  const out = [];
  let remaining = Math.max(0, Number(maxTotalChars) || 0);
  for (const item of asArray(selected)) {
    const skillPath = item.absolutePath || path.resolve(rootDir, item.path || item.sourcePath || '');
    let handle = null;
    try {
      handle = await fs.open(skillPath, 'r');
      const { size } = await handle.stat();
      const requested = Math.max(0, Math.min(size, remaining, maxPerSkillChars));
      const buffer = Buffer.allocUnsafe(requested);
      if (requested) await handle.read(buffer, 0, requested, 0);
      const content = buffer.toString('utf8');
      remaining -= content.length;
      out.push({
        ...item,
        absolutePath: skillPath,
        sourceExists: true,
        content,
        contentTruncated: size > requested,
        sourceBytes: size,
        version: item.version || sha256(content),
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      out.push({ ...item, absolutePath: skillPath, sourceExists: false, missing: true, error: 'skill_source_missing', content: '' });
    } finally {
      await handle?.close();
    }
  }
  return out;
}
