import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

async function sameFile(source, destination) {
  const [a, b] = await Promise.all([fs.stat(source), fs.stat(destination)]);
  if (!a.isFile() || !b.isFile() || a.size !== b.size) return false;
  const [left, right] = await Promise.all([fs.readFile(source), fs.readFile(destination)]);
  return left.equals(right);
}

async function mergeEntry(source, destination, result) {
  const sourceStat = await fs.lstat(source);
  let destinationStat = null;
  try { destinationStat = await fs.lstat(destination); } catch (error) { if (error?.code !== 'ENOENT') throw error; }

  if (sourceStat.isDirectory()) {
    if (destinationStat && !destinationStat.isDirectory()) {
      result.conflicts.push({ source, destination, reason: 'type_mismatch' });
      return;
    }
    await fs.mkdir(destination, { recursive: true, mode: sourceStat.mode & 0o777 });
    for (const name of await fs.readdir(source)) await mergeEntry(path.join(source, name), path.join(destination, name), result);
    try { await fs.rmdir(source); result.removedDirectories.push(source); } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error?.code)) throw error; }
    return;
  }

  if (!sourceStat.isFile()) {
    result.conflicts.push({ source, destination, reason: 'unsupported_type' });
    return;
  }
  if (destinationStat) {
    if (destinationStat.isFile() && await sameFile(source, destination)) {
      await fs.unlink(source);
      result.deduplicated.push(source);
    } else result.conflicts.push({ source, destination, reason: 'different_content' });
    return;
  }

  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    await fs.chmod(destination, sourceStat.mode & 0o777);
    await fs.unlink(source);
    result.moved.push({ source, destination });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (await sameFile(source, destination)) {
      await fs.unlink(source);
      result.deduplicated.push(source);
    } else result.conflicts.push({ source, destination, reason: 'different_content' });
  }
}

/** Merge legacy per-agent state into its canonical workspace without overwrites. */
export async function migrateLegacyAgentState({ runtimeRoot, workspaceRoot, agentId, legacyAgentDataRoot = null } = {}) {
  if (!runtimeRoot || !workspaceRoot || !agentId) throw new Error('runtime_state_migration_context_required');
  const destination = path.resolve(workspaceRoot, agentId);
  const candidates = [
    path.resolve(runtimeRoot, agentId),
    path.resolve(runtimeRoot, 'agentdata', agentId),
    ...(legacyAgentDataRoot ? [path.resolve(legacyAgentDataRoot)] : []),
  ];
  const sources = [...new Set(candidates)].filter((source) => source !== destination);
  const result = { destination, sources: [], moved: [], deduplicated: [], conflicts: [], removedDirectories: [] };
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const source of sources) {
    try { await fs.lstat(source); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    result.sources.push(source);
    await mergeEntry(source, destination, result);
    if (path.dirname(source) === path.resolve(runtimeRoot, 'agentdata')) {
      try { await fs.rmdir(path.dirname(source)); result.removedDirectories.push(path.dirname(source)); } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error?.code)) throw error; }
    }
  }
  return result;
}
