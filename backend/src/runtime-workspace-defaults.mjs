import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SkillSettingsStore } from './skill-settings-store.mjs';

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function copyMissingTree(source, destination) {
  if (await exists(destination)) return false;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, dereference: false, errorOnExist: true });
  return true;
}

function frontmatterMetadata(content = '') {
  const match = String(content).match(/^---\r?\n([\s\S]{0,8192}?)\r?\n---/);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z][\w-]*):\s*["']?(.+?)["']?\s*$/.exec(line);
    if (entry) fields[entry[1]] = entry[2];
  }
  return fields;
}

async function bundledSkillKind(skillRoot) {
  const entries = await fs.readdir(skillRoot, { withFileTypes: true });
  const assets = entries.filter((entry) => entry.name !== 'SKILL.md' && !entry.name.startsWith('.'));
  return assets.length === 0 ? 'text' : 'asset';
}

async function syncBundledTextSkill({ skillRoot, skillId, databasePath }) {
  const content = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const metadata = frontmatterMetadata(content);
  const store = new SkillSettingsStore({ databasePath });
  try {
    const existing = store.get(skillId);
    const shipped = {
      id: skillId,
      name: metadata.name || skillId,
      description: metadata.description || '',
      content,
      lifecycle: 'available',
      global: true,
    };
    if (existing) {
      // Shipped IDs are release-owned. Preserve operator availability/assignments,
      // but publish the complete current release text and metadata.
      if (existing.content === content && existing.name === shipped.name && existing.description === shipped.description) return false;
      store.update(skillId, { name: shipped.name, description: shipped.description, content });
    } else store.create(shipped);
    return true;
  } finally { store.close(); }
}

/**
 * Creates the shared workspace roots every runtime needs. Bundled text-only
 * skills are synchronized into SQLite on install and startup. Shipped IDs are
 * release-owned; operator-created IDs and assignments are untouched. Asset-bearing
 * packages retain their existing filesystem lifecycle.
 */
export async function ensureDefaultGlobalWorkspace({ installDir, workspaceRoot, defaultsRoot, databasePath } = {}) {
  const root = path.resolve(installDir || '');
  const workspace = path.resolve(workspaceRoot || path.join(root, 'workspace'));
  const globalRoot = path.join(workspace, 'global');
  const skillsRoot = path.join(globalRoot, 'skills');
  const toolsRoot = path.join(globalRoot, 'tools');
  await Promise.all([
    fs.mkdir(skillsRoot, { recursive: true, mode: 0o755 }),
    fs.mkdir(toolsRoot, { recursive: true, mode: 0o755 }),
  ]);

  const source = path.resolve(defaultsRoot || path.join(root, 'global-skills'));
  const resolvedDatabasePath = databasePath || path.join(path.dirname(workspace), 'config', 'settings.sqlite');
  const seededSkills = [];
  const seededDatabaseSkills = [];
  let entries = [];
  try { entries = await fs.readdir(source, { withFileTypes: true }); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const sourceSkill = path.join(source, entry.name);
    if (!(await exists(path.join(sourceSkill, 'SKILL.md')))) continue;
    if (await bundledSkillKind(sourceSkill) === 'text') {
      if (await syncBundledTextSkill({ skillRoot: sourceSkill, skillId: entry.name, databasePath: resolvedDatabasePath })) seededDatabaseSkills.push(entry.name);
      // Retire the old shipped text copy only after SQLite synchronization succeeds.
      // Asset packages and agent-local overrides are not part of this release sync.
      const legacyRoot = path.join(skillsRoot, entry.name);
      if (await exists(path.join(legacyRoot, 'SKILL.md')) && await bundledSkillKind(legacyRoot) === 'text') {
        await fs.rm(path.join(legacyRoot, 'SKILL.md'));
        if ((await fs.readdir(legacyRoot)).length === 0) await fs.rmdir(legacyRoot);
      }
      continue;
    }
    if (await copyMissingTree(sourceSkill, path.join(skillsRoot, entry.name))) seededSkills.push(entry.name);
  }
  return { globalRoot, skillsRoot, toolsRoot, seededSkills, seededDatabaseSkills };
}
