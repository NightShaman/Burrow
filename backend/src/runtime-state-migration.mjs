import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const migrationLocks = new Map();

async function sameFile(source, destination) {
  try {
    const [a, b] = await Promise.all([fs.stat(source), fs.stat(destination)]);
    if (!a.isFile() || !b.isFile() || a.size !== b.size) return false;
    const [left, right] = await Promise.all([fs.readFile(source), fs.readFile(destination)]);
    return left.equals(right);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function unlinkIfPresent(file) {
  try { await fs.unlink(file); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function mergeEntry(source, destination, result) {
  let sourceStat;
  try { sourceStat = await fs.lstat(source); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }

  let destinationStat = null;
  try { destinationStat = await fs.lstat(destination); } catch (error) { if (error?.code !== 'ENOENT') throw error; }

  if (sourceStat.isDirectory()) {
    if (destinationStat && !destinationStat.isDirectory()) {
      result.conflicts.push({ source, destination, reason: 'type_mismatch' });
      return;
    }
    await fs.mkdir(destination, { recursive: true, mode: sourceStat.mode & 0o777 });
    let names;
    try { names = await fs.readdir(source); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const name of names) await mergeEntry(path.join(source, name), path.join(destination, name), result);
    try { await fs.rmdir(source); result.removedDirectories.push(source); } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error?.code)) throw error; }
    return;
  }

  if (!sourceStat.isFile()) {
    result.conflicts.push({ source, destination, reason: 'unsupported_type' });
    return;
  }
  if (destinationStat) {
    if (destinationStat.isFile()) {
      const identical = await sameFile(source, destination);
      if (identical === null) return;
      if (identical) {
        if (await unlinkIfPresent(source)) result.deduplicated.push(source);
      } else result.conflicts.push({ source, destination, reason: 'different_content' });
    } else result.conflicts.push({ source, destination, reason: 'different_content' });
    return;
  }

  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    await fs.chmod(destination, sourceStat.mode & 0o777);
    if (await unlinkIfPresent(source)) result.moved.push({ source, destination });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error?.code !== 'EEXIST') throw error;
    const identical = await sameFile(source, destination);
    if (identical === null) return;
    if (identical) {
      if (await unlinkIfPresent(source)) result.deduplicated.push(source);
    } else result.conflicts.push({ source, destination, reason: 'different_content' });
  }
}

/** Merge legacy per-agent state into its canonical workspace without overwrites. */
export async function migrateLegacyAgentState({ runtimeRoot, workspaceRoot, agentId, legacyAgentDataRoot = null } = {}) {
  if (!runtimeRoot || !workspaceRoot || !agentId) throw new Error('runtime_state_migration_context_required');
  const destination = path.resolve(workspaceRoot, agentId);

  // Multiple runtime paths can request migration for the same agent during startup.
  // Serialize them in-process so a second caller never observes a half-copied destination.
  const previous = migrationLocks.get(destination) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  migrationLocks.set(destination, current);
  await previous;

  try {
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
  } finally {
    release();
    if (migrationLocks.get(destination) === current) migrationLocks.delete(destination);
  }
}
