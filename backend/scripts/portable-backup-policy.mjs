import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { postgresLifecycleConfig } from '../src/postgres-lifecycle-bootstrap.mjs';

export function parseEnvironment(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}
export async function coldBackupPolicy(root, runCommand) {
  const env = parseEnvironment(await fs.readFile(path.join(root, 'burrow.env'), 'utf8'));
  const config = postgresLifecycleConfig({ env, runtimeRoot: root });
  const exclusions = ['external PostgreSQL databases', 'external paths and symlink targets'];
  const result = { type: 'cold-install-tree', exclusions, databaseMode: config.mode, sourceOwner: os.userInfo().username, sourceUid: (await fs.stat(root)).uid, sourceRoot: root };
  if (config.mode !== 'managed') return result;
  if (config.dataDir !== root && !config.dataDir.startsWith(root + path.sep)) throw new Error('cold backup requires managed PostgreSQL data inside install root');
  const real = await fs.realpath(config.dataDir);
  if (!real.startsWith(root + path.sep)) throw new Error('cold backup excludes symlinked PostgreSQL data');
  // Any PID file is fail-closed: stale/ambiguous state requires operator recovery.
  try { await fs.lstat(path.join(config.dataDir, 'postmaster.pid')); throw new Error('cold backup refused: PostgreSQL postmaster.pid exists; stop cluster first'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { stdout } = await runCommand(env.BURROW_POSTGRES_CONTROLDATA || (path.isAbsolute(config.postgres) ? path.join(path.dirname(config.postgres), 'pg_controldata') : 'pg_controldata'), [config.dataDir], { env: { ...process.env, LC_ALL: 'C' }, timeout: 30_000 });
  if (!/^Database cluster state:\s+shut down\s*$/m.test(stdout)) throw new Error('cold backup requires cleanly shut down PostgreSQL cluster');
  return { ...result, clusterState: 'shut down' };
}
export function restoreInventory(text) {
  const env = parseEnvironment(text);
  return Object.entries(env).filter(([key, value]) => path.isAbsolute(value) || /POSTGRES|DATABASE_URL/.test(key)).map(([key, value]) => ({ key, absolutePath: path.isAbsolute(value) ? value : undefined, databaseIdentity: /POSTGRES|DATABASE_URL/.test(key), requiresMapping: !['BURROW_RUNTIME_ROOT', 'BURROW_WORKSPACE_ROOT', 'BURROW_CACHE_ROOT', 'BURROW_CLAUDE_BIN'].includes(key) }));
}
