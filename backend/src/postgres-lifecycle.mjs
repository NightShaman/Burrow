import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EXPECTED_MAJOR = 17;
const DEFAULT_TIMEOUT_MS = 30_000;

export class PostgresLifecycleError extends Error {
  constructor(message, options = {}) { super(message, options); this.name = 'PostgresLifecycleError'; }
}

function majorFromVersion(text) {
  const match = String(text).match(/(?:PostgreSQL|postgres)\D*(\d+)(?:\.\d+)?/i) || String(text).match(/\b(\d+)(?:\.\d+)?\b/);
  return match ? Number(match[1]) : null;
}

// pg_ctl passes -o through a shell. Quote each complete -c assignment so paths
// (including apostrophes and whitespace) survive both shell parsing and GUC parsing.
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function command(binary, args, { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, new PostgresLifecycleError(`${path.basename(binary)} timed out`)); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(reject, new PostgresLifecycleError(`Unable to execute ${path.basename(binary)}`, { cause: error })));
    child.once('close', (code, signal) => code === 0
      ? finish(resolve, { stdout, stderr })
      : finish(reject, new PostgresLifecycleError(`${path.basename(binary)} failed${signal ? ` (${signal})` : ` (exit ${code})`}`)));
  });
}

async function binaryMajor(binary, timeoutMs) { return majorFromVersion((await command(binary, ['--version'], { timeoutMs })).stdout); }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

function configOf(options = {}) {
  const mode = options.mode ?? options.lifecycle ?? 'managed';
  if (mode !== 'managed') throw new PostgresLifecycleError(`Unsupported PostgreSQL lifecycle mode "${mode}"`);
  const expectedMajor = options.expectedMajor ?? EXPECTED_MAJOR;
  if (!Number.isInteger(expectedMajor) || expectedMajor < 1) throw new PostgresLifecycleError('expectedMajor must be a positive integer');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new PostgresLifecycleError('timeoutMs must be a positive number');
  const dataDir = path.resolve(options.dataDir || options.directory || './.burrow/postgres');
  const socketDir = path.resolve(options.socketDir || path.join(dataDir, 'socket'));
  const logFile = path.resolve(options.logFile || path.join(dataDir, 'postgres.log'));
  return Object.freeze({ ...options, dataDir, socketDir, logFile, expectedMajor, timeoutMs, initdb: options.initdb || 'initdb', pgCtl: options.pgCtl || 'pg_ctl', postgres: options.postgres || 'postgres', initdbArgs: options.initdbArgs || [], pgCtlArgs: options.pgCtlArgs || [] });
}

export function createManagedPostgresLifecycle(options = {}) {
  const config = configOf(options);
  let state = 'stopped'; let initialized = false; let running = false;
  function assertNonRoot() { if (typeof process.getuid === 'function' && process.getuid() === 0 && !config.allowRoot) throw new PostgresLifecycleError('Managed PostgreSQL must not run as root'); }
  async function ensureDataDir() { await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 }); await fs.chmod(config.dataDir, 0o700); }
  async function ensureSocketDir() { await fs.mkdir(config.socketDir, { recursive: true, mode: 0o700 }); await fs.chmod(config.socketDir, 0o700); }
  async function checkBinary() { const major = await binaryMajor(config.postgres, config.timeoutMs); if (major !== config.expectedMajor) throw new PostgresLifecycleError(`Managed PostgreSQL binary major ${major ?? 'unknown'} does not match required major ${config.expectedMajor}`); return major; }
  async function init() {
    assertNonRoot();
    if (state !== 'stopped') throw new PostgresLifecycleError(`Cannot initialize PostgreSQL while lifecycle is ${state}`);
    await ensureDataDir();
    if (await exists(path.join(config.dataDir, 'PG_VERSION'))) { initialized = true; await ensureSocketDir(); return { initialized: false, dataDir: config.dataDir }; }
    const major = await checkBinary();
    // Do not create socketDir until initdb has finished: initdb requires an empty data directory.
    await command(config.initdb, ['-D', config.dataDir, '--no-locale', '--encoding=UTF8', ...config.initdbArgs], { timeoutMs: config.timeoutMs });
    await ensureSocketDir();
    initialized = true; return { initialized: true, major, dataDir: config.dataDir };
  }
  async function start() {
    assertNonRoot();
    if (state === 'running') return { state };
    if (state !== 'stopped') throw new PostgresLifecycleError(`Cannot start PostgreSQL while lifecycle is ${state}`);
    await ensureDataDir();
    if (!(await exists(path.join(config.dataDir, 'PG_VERSION')))) await init();
    await ensureSocketDir();
    const fileMajor = Number((await fs.readFile(path.join(config.dataDir, 'PG_VERSION'), 'utf8')).trim());
    const binary = await checkBinary();
    if (fileMajor !== binary) throw new PostgresLifecycleError(`Managed PostgreSQL data directory major ${fileMajor} does not match binary major ${binary}`);
    state = 'starting';
    try {
      const socketOption = `-c ${shellQuote(`unix_socket_directories=${config.socketDir}`)}`;
      const listenOption = `-c ${shellQuote('listen_addresses=')}`;
      await command(config.pgCtl, ['-D', config.dataDir, '-o', `${socketOption} ${listenOption}`, '-l', config.logFile, '-w', 'start', ...config.pgCtlArgs], { timeoutMs: config.timeoutMs });
      running = true; state = 'running'; return { state, socketDir: config.socketDir, major: binary };
    } catch (error) { state = 'stopped'; throw error; }
  }
  async function stop() {
    if (state === 'stopped') return { state };
    if (state !== 'running') throw new PostgresLifecycleError(`Cannot stop PostgreSQL while lifecycle is ${state}`);
    state = 'stopping';
    try { await command(config.pgCtl, ['-D', config.dataDir, '-m', 'fast', '-w', 'stop'], { timeoutMs: config.timeoutMs }); running = false; state = 'stopped'; return { state }; }
    catch (error) { state = 'running'; throw error; }
  }
  async function probeStatus() {
    assertNonRoot();
    try { await command(config.pgCtl, ['-D', config.dataDir, 'status'], { timeoutMs: config.timeoutMs }); return true; }
    catch { return false; }
  }
  return Object.freeze({ mode: 'managed', config, init, initialize: init, start, stop, probeStatus, status: () => Object.freeze({ state, initialized, running, dataDir: config.dataDir, socketDir: config.socketDir }) });
}

export async function validateExternalPostgres({ client, query, expectedMajor = EXPECTED_MAJOR, vectorExtension = 'vector', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(expectedMajor) || expectedMajor < 1) throw new PostgresLifecycleError('expectedMajor must be a positive integer');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new PostgresLifecycleError('timeoutMs must be a positive number');
  const execute = query || client?.query?.bind(client);
  if (!execute) throw new PostgresLifecycleError('External PostgreSQL validation requires a query function');
  const versionResult = await execute('SHOW server_version_num');
  const versionNum = Number(versionResult.rows?.[0]?.server_version_num);
  const major = Number.isFinite(versionNum) ? Math.floor(versionNum / 10000) : majorFromVersion((await execute('SELECT version()')).rows?.[0]?.version);
  if (major !== expectedMajor) throw new PostgresLifecycleError(`External PostgreSQL major ${major ?? 'unknown'} does not match required major ${expectedMajor}`);
  const extensionResult = await execute('SELECT extname FROM pg_extension WHERE extname = $1', [vectorExtension]);
  if (!extensionResult.rows?.some((row) => row.extname === vectorExtension)) throw new PostgresLifecycleError(`Required PostgreSQL extension "${vectorExtension}" is missing; install it before starting Burrow (external lifecycle never creates extensions)`);
  return Object.freeze({ major, vectorExtension, vectorAvailable: true });
}

export function createExternalPostgresLifecycle(options = {}) {
  const mode = options.mode ?? options.lifecycle ?? 'external';
  if (mode !== 'external') throw new PostgresLifecycleError(`Unsupported PostgreSQL lifecycle mode "${mode}"`);
  let state = 'stopped';
  const validate = () => validateExternalPostgres(options);
  async function start() { if (state === 'running') return { state }; await validate(); state = 'running'; return { state }; }
  async function stop() { if (state === 'running') state = 'stopped'; return { state }; }
  return Object.freeze({ mode: 'external', validate, start, stop, status: () => Object.freeze({ state }) });
}

export function createPostgresLifecycle(options = {}) {
  const mode = options.mode || options.lifecycle || 'managed';
  if (mode === 'external') return createExternalPostgresLifecycle(options);
  if (mode === 'managed') return createManagedPostgresLifecycle(options);
  throw new PostgresLifecycleError(`Unsupported PostgreSQL lifecycle mode "${mode}"`);
}
export { majorFromVersion };
