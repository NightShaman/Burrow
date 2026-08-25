import { promises as fs } from 'node:fs';
import path from 'node:path';

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function copyMissingTree(source, destination) {
  if (await exists(destination)) return false;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, dereference: false, errorOnExist: true });
  return true;
}

/**
 * Creates the shared workspace roots every runtime needs and seeds only missing
 * bundled skills. Existing administrator-managed skills are never replaced.
 */
export async function ensureDefaultGlobalWorkspace({ installDir, workspaceRoot, defaultsRoot } = {}) {
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
  const seededSkills = [];
  let entries = [];
  try { entries = await fs.readdir(source, { withFileTypes: true }); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const sourceSkill = path.join(source, entry.name);
    if (!(await exists(path.join(sourceSkill, 'SKILL.md')))) continue;
    if (await copyMissingTree(sourceSkill, path.join(skillsRoot, entry.name))) seededSkills.push(entry.name);
  }
  return { globalRoot, skillsRoot, toolsRoot, seededSkills };
}
