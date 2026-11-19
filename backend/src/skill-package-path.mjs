import path from 'node:path';
import { promises as fs } from 'node:fs';
import { skillSourceError } from './postgres-skill-sources.mjs';

// A Git package is content-addressed. Never follow the historical absolute
// pointer, which may refer to a different installation after a portable move.
export function skillPackagePath(root, skill) {
  if (!root || skill?.storage !== 'filesystem' || (skill.content_owner ?? skill.contentOwner) !== 'git') return null;
  const hash = /^sha256:([0-9a-f]{64})$/.exec(skill.installed_hash ?? skill.installedHash)?.[1];
  if (!hash || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skill.id)) return null;
  return path.resolve(root, skill.id, hash);
}

export async function checkedSkillPackagePath(root, skill) {
  const target = skillPackagePath(root, skill);
  if (!target) throw skillSourceError('skill_local_changes', 409);
  for (const dir of [path.resolve(root), path.dirname(target), target]) {
    try {
      if (!(await fs.lstat(dir)).isDirectory()) throw skillSourceError('skill_local_changes', 409);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw skillSourceError('skill_local_changes', 409);
      throw error;
    }
  }
  return target;
}
