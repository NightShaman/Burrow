import crypto, { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { discoverMods, MOD_DATA_DIRECTORY } from './mod-runtime.mjs';
import { createModDistributionRepository } from './mod-distribution-repository.mjs';
import { settingsKeyFromEnvironment } from './model-settings-store.mjs';

const execFileAsync = promisify(execFile);
const MOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^v?(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?|\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;
const GIT_TIMEOUT_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_SOURCE_REFRESH = Object.freeze({ enabled: true, intervalMs: 21_600_000, staleMs: 900_000, concurrency: 4, maxBackoffMs: 86_400_000 });
const DEFAULT_ARCHIVE_RESOURCES = Object.freeze({ reserveBytes: 256 * 1024 * 1024, checkIntervalMs: 25 });

function positiveTimerMs(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw Object.assign(new Error(`mod_source_refresh_${field}_invalid`), { statusCode: 400 });
  return value;
}
export function validateModSourceRefreshConfig(value, { partial = false, base = DEFAULT_SOURCE_REFRESH } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('mod_source_refresh_config_invalid'), { statusCode: 400 });
  const allowed = new Set(['enabled', 'intervalMs', 'staleMs', 'concurrency', 'maxBackoffMs']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw Object.assign(new Error('mod_source_refresh_config_invalid'), { statusCode: 400 });
  if (!partial && !Object.hasOwn(value, 'enabled')) throw Object.assign(new Error('mod_source_refresh_enabled_invalid'), { statusCode: 400 });
  if (!partial && !Object.hasOwn(value, 'intervalMs')) throw Object.assign(new Error('mod_source_refresh_intervalMs_invalid'), { statusCode: 400 });
  if (!partial && !Object.hasOwn(value, 'staleMs')) throw Object.assign(new Error('mod_source_refresh_staleMs_invalid'), { statusCode: 400 });
  const output = { ...base };
  if (Object.hasOwn(value, 'enabled')) { if (typeof value.enabled !== 'boolean') throw Object.assign(new Error('mod_source_refresh_enabled_invalid'), { statusCode: 400 }); output.enabled = value.enabled; }
  if (Object.hasOwn(value, 'intervalMs')) output.intervalMs = positiveTimerMs(value.intervalMs, 'intervalMs');
  if (Object.hasOwn(value, 'staleMs')) output.staleMs = positiveTimerMs(value.staleMs, 'staleMs');
  if (Object.hasOwn(value, 'concurrency')) { if (!Number.isSafeInteger(value.concurrency) || value.concurrency < 1) throw Object.assign(new Error('mod_source_refresh_concurrency_invalid'), { statusCode: 400 }); output.concurrency = value.concurrency; }
  if (Object.hasOwn(value, 'maxBackoffMs')) output.maxBackoffMs = positiveTimerMs(value.maxBackoffMs, 'maxBackoffMs');
  return output;
}

function now() { return new Date().toISOString(); }
function sourceId(url) { return crypto.createHash('sha256').update(url).digest('hex').slice(0, 24); }
function normalizeVersion(value) { const text = String(value || '').trim(); return text.startsWith('v') ? text.slice(1) : text; }
function versionParts(value) {
  const text = normalizeVersion(value);
  const calendar = text.match(/^(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$/);
  if (calendar) return { core: calendar.slice(1, 4).map(BigInt).concat(BigInt(calendar[4] || 0)), pre: null };
  const match = text.match(/^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) throw new Error('mod_version_unavailable');
  return { core: match[1].split('.').map(BigInt), pre: match[2]?.split('.') || null };
}
function compareVersions(a, b) {
  const aa = versionParts(a); const bb = versionParts(b);
  for (let i = 0; i < Math.max(aa.core.length, bb.core.length); i += 1) {
    const difference = (aa.core[i] || 0n) - (bb.core[i] || 0n);
    if (difference) return difference > 0n ? 1 : -1;
  }
  if (!aa.pre || !bb.pre) return aa.pre ? -1 : bb.pre ? 1 : 0;
  for (let i = 0; i < Math.max(aa.pre.length, bb.pre.length); i += 1) {
    const left = aa.pre[i]; const right = bb.pre[i];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const ln = /^\d+$/.test(left); const rn = /^\d+$/.test(right);
    if (ln && rn) { const diff = BigInt(left) - BigInt(right); if (diff) return diff > 0n ? 1 : -1; }
    else if (ln !== rn) return ln ? -1 : 1;
    else return left < right ? -1 : 1;
  }
  return 0;
}

export function normalizeModSourceUrl(value) {
  const input = String(value || '').trim();
  if (!input || /[\r\n\0]/.test(input)) throw new Error('mod_source_url_invalid');
  const scp = input.match(/^([A-Za-z0-9_.-]+)@([A-Za-z0-9.-]+):(.+)$/);
  if (scp) {
    const repo = scp[3].replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
    if (!repo || repo.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('mod_source_repository_invalid');
    return `${scp[1]}@${scp[2]}:${repo}.git`;
  }
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error('mod_source_url_invalid'); }
  if (!['http:', 'https:', 'ssh:'].includes(parsed.protocol)) throw new Error('mod_source_protocol_unsupported');
  if (!parsed.hostname || parsed.search || parsed.hash) throw new Error('mod_source_repository_invalid');
  if (parsed.password || (parsed.username && parsed.protocol !== 'ssh:')) throw new Error('mod_source_embedded_credentials_forbidden');
  const pathname = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!pathname || pathname.split('/').some((part) => part === '..')) throw new Error('mod_source_repository_invalid');
  parsed.pathname = `${pathname}.git`;
  return parsed.toString().replace(/\/$/, '');
}

function credentialInput(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const username = String(value.username || (value.token ? 'oauth2' : '')).trim();
  const password = String(value.password || value.token || '');
  if (!password) return null;
  return { username: username || 'oauth2', password };
}
function aad(source) { return Buffer.from(`burrow-mod-source-secret-v1|${source}`); }
function sealCredential(key, source, value) {
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad(source));
  return { ciphertext: Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]), nonce, authTag: cipher.getAuthTag() };
}
function openCredential(key, source, row) {
  const decipher = createDecipheriv('aes-256-gcm', key, row.nonce); decipher.setAAD(aad(source)); decipher.setAuthTag(row.auth_tag);
  return JSON.parse(Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8'));
}
function safeGitError(error) {
  const text = String(error?.stderr || error?.message || error).replace(/(?:https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
  if (/authentication|authorization|credentials|could not read username|permission denied|access denied/i.test(text)) return 'mod_source_authentication_failed';
  if (/timed out|aborted/i.test(text)) return 'mod_source_timeout';
  return 'mod_source_git_failed';
}
async function gitContext(url, credential, { parentRoot = os.tmpdir(), resourceMonitor = null } = {}) {
  const root = await fs.mkdtemp(path.join(parentRoot, 'burrow-mod-git-'));
  let askpass = null;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_OPTIONAL_LOCKS: '0', GIT_ALLOW_PROTOCOL: 'http:https:ssh', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10' });
  if (process.env.GIT_SSL_CAINFO) env.GIT_SSL_CAINFO = process.env.GIT_SSL_CAINFO;
  if (credential) {
    if (!url.startsWith('https://')) { await fs.rm(root, { recursive: true, force: true }); throw new Error('mod_source_credentials_require_https'); }
    askpass = path.join(root, 'askpass.sh');
    await fs.writeFile(askpass, '#!/bin/sh\ncase "$1" in *sername*) printf "%s" "$BURROW_GIT_USERNAME";; *) printf "%s" "$BURROW_GIT_PASSWORD";; esac\n', { mode: 0o700 });
    env.GIT_CONFIG_COUNT = '1'; env.GIT_CONFIG_KEY_0 = 'http.followRedirects'; env.GIT_CONFIG_VALUE_0 = 'false';
    Object.assign(env, { GIT_ASKPASS: askpass, BURROW_GIT_USERNAME: credential.username, BURROW_GIT_PASSWORD: credential.password });
  }
  const run = async (args, options = {}) => {
    const { resourceMonitor: commandMonitor = resourceMonitor, ...execOptions } = options;
    try {
      if (!commandMonitor) return await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', ...args], { cwd: root, env, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, ...execOptions });
      const initial = await fs.statfs(commandMonitor.root, { bigint: true });
      if (initial.bavail * initial.bsize < BigInt(commandMonitor.reserveBytes)) throw new Error('mod_archive_resources_exceeded');
      return await new Promise((resolve, reject) => {
        let resourcesExceeded = false;
        const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', ...args], { cwd: root, env, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, ...execOptions }, (error, stdout, stderr) => error ? reject(resourcesExceeded ? new Error('mod_archive_resources_exceeded') : error) : resolve({ stdout, stderr }));
        let checking = false;
        const timer = setInterval(async () => {
          if (checking) return;
          checking = true;
          try {
            const stats = await fs.statfs(commandMonitor.root, { bigint: true });
            if (stats.bavail * stats.bsize < BigInt(commandMonitor.reserveBytes)) { resourcesExceeded = true; child.kill('SIGKILL'); }
          } catch { resourcesExceeded = true; child.kill('SIGKILL'); }
          finally { checking = false; }
        }, commandMonitor.checkIntervalMs);
        timer.unref?.(); child.once('close', () => clearInterval(timer)); child.once('error', () => clearInterval(timer));
      });
    } catch (error) { if (error?.message === 'mod_archive_resources_exceeded') throw error; throw new Error(safeGitError(error)); }
  };
  return { root, run, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
async function prepareRepository(url, credential, { archivePath = null, archiveReserve = null } = {}) {
  const context = await gitContext(url, credential, { ...(archivePath ? { parentRoot: path.dirname(archivePath) } : {}), resourceMonitor: archiveReserve });
  try {
    const { stdout } = await context.run(['ls-remote', '--tags', '--refs', url]);
    const tags = stdout.split('\n').filter(Boolean).map((line) => { const [oid, ref] = line.split('\t'); return { oid, tag: ref?.replace('refs/tags/', '') }; }).filter(({ tag }) => VERSION.test(tag));
    if (!tags.length) throw new Error('mod_source_version_invalid');
    tags.sort((a, b) => compareVersions(a.tag, b.tag) || a.tag.localeCompare(b.tag)); const { tag, oid } = tags.at(-1); const repo = path.join(context.root, 'repository.git');
    await context.run(['init', '--bare', repo]);
    await context.run(['--git-dir', repo, 'fetch', '--depth=1', '--no-tags', url, `refs/tags/${tag}:refs/tags/${tag}`]);
    const fetched = (await context.run(['--git-dir', repo, 'rev-parse', `refs/tags/${tag}`])).stdout.trim();
    if (fetched !== oid) throw new Error('mod_source_tag_changed');
    let manifest;
    try { manifest = JSON.parse((await context.run(['--git-dir', repo, 'show', `${tag}:burrow.mod.json`], { maxBuffer: 1024 * 1024 })).stdout); }
    catch { throw new Error('mod_source_manifest_invalid'); }
    const modId = String(manifest?.id || '').trim(); const modName = String(manifest?.name || '').trim();
    if ((modId === MOD_DATA_DIRECTORY || !MOD_ID.test(modId)) || !modName) throw new Error('mod_source_manifest_invalid');
    if (manifest.version != null && (!VERSION.test(String(manifest.version)) || compareVersions(manifest.version, tag) !== 0)) throw new Error('mod_source_manifest_version_mismatch');
    if (archivePath) {
      await context.run(['--git-dir', repo, 'archive', '--format=tar.gz', `--prefix=${modId}/`, `--output=${archivePath}`, tag]);
      await fs.stat(archivePath);
    }
    return { modId, modName, latestVersion: normalizeVersion(tag), archiveUrl: `git-tag:${tag}` };
  } finally { await context.cleanup(); }
}

async function archiveSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); } finally { await handle.close(); }
  return hash.digest('hex');
}

async function validateArchiveEntries(archivePath) {
  const [{ stdout: names }, { stdout: verbose }] = await Promise.all([
    execFileAsync('tar', ['-tzf', archivePath], { maxBuffer: 8 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' }),
    execFileAsync('tar', ['--numeric-owner', '-tvzf', archivePath], { maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' }),
  ]);
  const entries = names.split('\n').filter(Boolean);
  if (!entries.length || entries.length > 20_000) throw new Error('mod_archive_invalid');
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.split('/').some((part) => part === '..')) throw new Error('mod_archive_path_invalid');
  }
  let expandedBytes = 0;
  for (const line of verbose.split('\n').filter(Boolean)) {
    const type = line[0];
    if (type === 'l' || type === 'h' || type === 'b' || type === 'c' || type === 'p') throw new Error('mod_archive_special_entry_invalid');
    const match = line.match(/^.\S*\s+\d+\/\d+\s+(\d+)\s+/);
    if (!match) throw new Error('mod_archive_invalid');
    expandedBytes += Number(match[1]);
    if (!Number.isSafeInteger(expandedBytes)) throw new Error('mod_archive_resources_exceeded');
  }
  return { entries: entries.length, expandedBytes };
}

async function directoryBytes(root) {
  let total = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await fs.stat(target)).size;
  }
  return total;
}

async function archiveBudget(stagingRoot, archivePath, policy) {
  const stats = await fs.statfs(stagingRoot, { bigint: true });
  const available = Number(stats.bavail * stats.bsize);
  await fs.stat(archivePath);
  // The compressed archive is already reflected in available space. Preserve
  // the configured reserve rather than treating compression ratio as capacity.
  return Math.max(0, available - policy.reserveBytes);
}

async function extractArchiveWithBudget(archivePath, extractRoot, budgetBytes, policy) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) throw new Error('mod_archive_resources_unavailable');
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', archivePath, '-C', extractRoot], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; let exceeded = false; let checking = false;
    child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk; });
    const timeout = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, GIT_TIMEOUT_MS); timeout.unref?.();
    const timer = setInterval(async () => {
      if (checking || exceeded) return;
      checking = true;
      try {
        const [bytes, stats] = await Promise.all([directoryBytes(extractRoot), fs.statfs(extractRoot, { bigint: true })]);
        if (bytes > budgetBytes || stats.bavail * stats.bsize < BigInt(policy.reserveBytes)) { exceeded = true; child.kill('SIGKILL'); }
      } catch (error) { if (error?.code !== 'ENOENT') { exceeded = true; child.kill('SIGKILL'); } } finally { checking = false; }
    }, policy.checkIntervalMs);
    timer.unref?.();
    child.once('error', (error) => { clearInterval(timer); clearTimeout(timeout); reject(error); });
    child.once('close', async (code) => {
      clearInterval(timer); clearTimeout(timeout);
      try {
        if (exceeded || await directoryBytes(extractRoot) > budgetBytes) return reject(new Error('mod_archive_resources_exceeded'));
        if (code !== 0) return reject(new Error(stderr.trim() || 'mod_archive_extract_failed'));
        resolve();
      } catch (error) { reject(error); }
    });
  });
}

async function findPreparedMod(extractRoot) {
  const found = [];
  async function walk(dir, depth = 0) {
    if (depth > 5 || found.length > 1) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('mod_archive_symlink_invalid');
      if (entry.isFile() && entry.name === 'burrow.mod.json') found.push(dir);
      else if (entry.isDirectory()) await walk(target, depth + 1);
    }
  }
  await walk(extractRoot);
  if (found.length !== 1) throw new Error(found.length ? 'mod_archive_multiple_manifests' : 'mod_archive_manifest_missing');
  const manifest = JSON.parse(await fs.readFile(path.join(found[0], 'burrow.mod.json'), 'utf8'));
  const id = String(manifest?.id || '').trim();
  if ((id === MOD_DATA_DIRECTORY || !MOD_ID.test(id)) || !String(manifest?.name || '').trim()) throw new Error('mod_manifest_invalid');
  return { root: found[0], manifest, id, name: String(manifest.name).trim() };
}

async function swapMod(target, prepared) {
  const parent = path.dirname(target); const backup = `${target}.backup-${crypto.randomUUID()}`;
  await fs.mkdir(parent, { recursive: true });
  let backedUp = false;
  try {
    try { await fs.rename(target, backup); backedUp = true; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await fs.rename(prepared, target);
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    if (backedUp) await fs.rename(backup, target).catch(() => {});
    throw error;
  }
  return {
    // Once the replacement host is published the old host cannot be recreated.
    // Backup deletion is therefore cleanup, not a reason to roll files back
    // underneath the live replacement if the filesystem refuses the removal.
    async commit() { if (backedUp) await fs.rm(backup, { recursive: true, force: true }).catch(() => {}); },
    async rollback() {
      await fs.rm(target, { recursive: true, force: true });
      if (backedUp) await fs.rename(backup, target);
    },
  };
}

async function durableJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, filePath);
  const directory = await fs.open(path.dirname(filePath), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function removeDurably(filePath) {
  await fs.rm(filePath, { force: true });
  const directory = await fs.open(path.dirname(filePath), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export function createModDistribution({ runtimeRoot, databasePath, restart = null, onLifecycleChange = null, logger = console, settingsKey = null, archiveResources = {}, removePath = fs.rm, renamePath = fs.rename, copyPath = fs.cp, cleanupPath = fs.rm, repositoryPreparation = prepareRepository, repositoryFactory = createModDistributionRepository } = {}) {
  if (!runtimeRoot || !databasePath) throw new Error('mod_distribution_configuration_required');
  const modsRoot = path.join(runtimeRoot, 'mods');
  const archivePolicy = {
    ...DEFAULT_ARCHIVE_RESOURCES,
    ...(process.env.BURROW_MOD_ARCHIVE_RESERVE_BYTES ? { reserveBytes: Number(process.env.BURROW_MOD_ARCHIVE_RESERVE_BYTES) } : {}),
    ...archiveResources,
  };
  if (!Number.isSafeInteger(archivePolicy.reserveBytes) || archivePolicy.reserveBytes < 0 || !Number.isSafeInteger(archivePolicy.checkIntervalMs) || archivePolicy.checkIntervalMs < 1) throw new Error('mod_archive_resource_policy_invalid');
  const locks = new Set();
  let refreshPromise = null;
  let pollTimer = null;
  let closed = false;
  let failureCount = 0;
  const recoveryRoot = path.join(modsRoot, '.recovery');
  async function reconcileUninstalls() {
    let names;
    try { names = await fs.readdir(recoveryRoot); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const journalPath = path.join(recoveryRoot, name);
      const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
      const expectedTarget = path.join(modsRoot, journal.modId || '');
      if (journal.operation !== 'uninstall' || (journal.modId === MOD_DATA_DIRECTORY || !MOD_ID.test(journal.modId)) || journal.target !== expectedTarget || !journal.quarantine.startsWith(`${expectedTarget}.uninstall-`) || journal.recovery !== `${journal.quarantine}.recovery`) throw new Error('mod_uninstall_recovery_journal_invalid');
      if (journal.committed) {
        await cleanupPath(journal.quarantine, { recursive: true, force: true });
        await cleanupPath(journal.recovery, { recursive: true, force: true });
        await removeDurably(journalPath);
        continue;
      }
      const targetPresent = await fs.stat(journal.target).then(() => true, () => false);
      if (!targetPresent) {
        const preferred = journal.phase === 'journaled' ? journal.quarantine : journal.recovery;
        const fallback = preferred === journal.recovery ? journal.quarantine : journal.recovery;
        const restore = await fs.stat(preferred).then(() => preferred, () => fallback);
        await renamePath(restore, journal.target);
      }
      await cleanupPath(journal.quarantine, { recursive: true, force: true });
      await cleanupPath(journal.recovery, { recursive: true, force: true });
      const recoveryDb = await repositoryFactory({ databasePath });
      try {
        await recoveryDb.transaction((tx) => tx.restoreMetadata(journal));
      } finally { await recoveryDb.close(); }
      await onLifecycleChange?.({ modId: journal.modId, enabled: journal.lifecycle?.enabled === 1, installed: true, action: 'uninstall-recovery' });
      await removeDurably(journalPath);
    }
    await fs.rmdir(recoveryRoot).catch((error) => { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error; });
  }
  const ready = reconcileUninstalls();
  // Install a rejection observer immediately: callers still receive the same
  // rejected promise, but startup failures cannot become transient unhandled
  // rejections before the server reaches its explicit readiness await.
  void ready.catch(() => {});
  async function refreshSettings(db) {
    const row = await db.refreshSettings();
    try { return validateModSourceRefreshConfig(JSON.parse(row?.value_json || '{}'), { partial: true }); }
    catch { return { ...DEFAULT_SOURCE_REFRESH }; }
  }
  function clearPoll() { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }
  function armPoll(wait) {
    if (closed) return;
    const delay = Math.min(wait, MAX_TIMER_DELAY_MS);
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (wait > MAX_TIMER_DELAY_MS) { armPoll(wait - MAX_TIMER_DELAY_MS); return; }
      void refresh().catch((error) => logger.error?.(`Burrow mod source refresh failed: ${String(error?.message || error)}`)).finally(() => schedulePoll()).catch((error) => logger.error?.(`Burrow mod source polling failed: ${String(error?.message || error)}`));
    }, delay);
    pollTimer.unref?.();
  }
  async function schedulePoll(delay = null) {
    clearPoll();
    if (closed) return;
    const db = await repositoryFactory({ databasePath });
    let settings;
    try { settings = await refreshSettings(db); } finally { await db.close(); }
    if (!settings.enabled) return;
    const multiplier = 2 ** Math.min(failureCount, 52);
    const backedOff = Math.min(settings.intervalMs * multiplier, settings.maxBackoffMs);
    const wait = delay ?? (Number.isSafeInteger(backedOff) ? backedOff : settings.maxBackoffMs);
    if (!closed) armPoll(wait);
  }
  async function sourceRefreshConfig() {
    const db = await repositoryFactory({ databasePath });
    try { return { ok: true, sourceRefresh: await refreshSettings(db) }; } finally { await db.close(); }
  }
  async function saveSourceRefreshConfig(value) {
    const db = await repositoryFactory({ databasePath });
    try {
      const config = validateModSourceRefreshConfig(value, { base: await refreshSettings(db) });
      await db.saveRefreshSettings(config, now());
      await schedulePoll();
      return { ok: true, sourceRefresh: config };
    } finally { await db.close(); }
  }
  async function sourceCredential(db, id) {
    const row = await db.sourceCredential(id);
    if (!row) return null;
    return openCredential(settingsKey || settingsKeyFromEnvironment(), id, row);
  }
  async function refreshSource(db, row) {
    const checkedAt = now();
    try {
      const inspected = await repositoryPreparation(row.url, await sourceCredential(db, row.id));
      await db.updateSourceReady({ ...inspected, id: row.id }, checkedAt);
      return { ...row, ...inspected, status: 'ready', error: null };
    } catch (error) {
      const message = String(error?.message || error);
      await db.updateSourceFailed(row.id, message, checkedAt);
      return { ...row, status: 'failed', error: message };
    }
  }
  async function list() {
    await ready;
    const db = await repositoryFactory({ databasePath });
    try {
      const discovered = await discoverMods({ runtimeRoot, logger });
      const installed = new Map((await db.installationRows()).map((row) => [row.mod_id, row]));
      const lifecycle = new Map((await db.lifecycleRows()).map((row) => [row.mod_id, row]));
      const sources = await db.sourceRows();
      const sourceByMod = new Map(sources.filter((row) => row.mod_id).map((row) => [row.mod_id, row]));
      const mods = discovered.map((mod) => {
        const record = installed.get(mod.id); const source = sourceByMod.get(mod.id) || (record?.source_id ? sources.find((item) => item.id === record.source_id) : null);
        const version = record?.version || normalizeVersion(mod.manifest?.version || '') || undefined;
        const latestVersion = source?.latest_version || undefined;
        const enabled = lifecycle.get(mod.id)?.enabled !== 0;
        return { id: mod.id, name: mod.name, version, status: mod.status === 'failed' ? 'failed' : 'installed', enabled, system: mod.manifest?.system === true, source: source?.url, latestVersion, updateAvailable: Boolean(version && latestVersion && VERSION.test(version) && VERSION.test(latestVersion) && compareVersions(latestVersion, version) > 0), canInstall: source?.status === 'ready', ...(source?.error ? { reason: source.error } : {}) };
      });
      for (const source of sources) if (source.mod_id && !mods.some((mod) => mod.id === source.mod_id)) mods.push({ id: source.mod_id, name: source.mod_name || source.mod_id, status: 'available', source: source.url, latestVersion: source.latest_version || undefined, canInstall: source.status === 'ready', ...(source.error ? { reason: source.error } : {}) });
      const refreshConfig = await refreshSettings(db);
      const stale = sources.some((row) => !row.last_checked_at || Date.now() - Date.parse(row.last_checked_at) >= refreshConfig.staleMs);
      if (refreshConfig.enabled && stale && !refreshPromise) queueMicrotask(() => { void refresh(); });
      return { ok: true, restartRequired: false, sourceRefresh: { enabled: Boolean(refreshConfig.enabled), intervalMs: refreshConfig.intervalMs, staleMs: refreshConfig.staleMs, concurrency: refreshConfig.concurrency, maxBackoffMs: refreshConfig.maxBackoffMs, refreshing: Boolean(refreshPromise), failures: failureCount }, mods, sources: sources.map((row) => ({ id: row.id, url: row.url, status: row.status, ...(row.error ? { error: row.error } : {}), ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}) })) };
    } finally { await db.close(); }
  }
  async function addSource(urlValue, authValue = null) {
    await ready;
    const url = normalizeModSourceUrl(urlValue); const id = sourceId(url); const timestamp = now(); const auth = credentialInput(authValue); const db = await repositoryFactory({ databasePath });
    try {
      const row = await db.ensureSource(id, url, timestamp);
      if (auth) {
        const encrypted = sealCredential(settingsKey || settingsKeyFromEnvironment(), row.id, auth);
        await db.saveCredential(row, encrypted, timestamp);
      }

      const refreshed = await refreshSource(db, row);
      return { ok: refreshed.status === 'ready', source: refreshed, ...(refreshed.error ? { error: refreshed.error } : {}) };
    } finally { await db.close(); }
  }
  async function refresh() {
    await ready;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const db = await repositoryFactory({ databasePath });
      let rows; let settings;
      try { rows = await db.sourceRows(); settings = await refreshSettings(db); } finally { await db.close(); }
      let failed = false; let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(settings.concurrency, rows.length) }, async () => {
        while (cursor < rows.length) {
          const row = rows[cursor++]; const workerDb = await repositoryFactory({ databasePath });
          try { const result = await refreshSource(workerDb, row); failed ||= result.status === 'failed'; } finally { await workerDb.close(); }
        }
      }));
      failureCount = failed ? failureCount + 1 : 0;
      return list();
    })();
    try { return await refreshPromise; } finally { refreshPromise = null; }
  }
  async function removeSource(id) {
    await ready; const db = await repositoryFactory({ databasePath }); try { const removed = (await db.removeSource(String(id))).changes > 0; return { ok: removed, removed }; } finally { await db.close(); } }
  async function install(modId, requestedVersion = null) {
    await ready;
    const id = String(modId || '').trim(); if ((id === MOD_DATA_DIRECTORY || !MOD_ID.test(id))) throw new Error('mod_id_invalid');
    if (locks.has(id)) throw Object.assign(new Error('mod_install_in_progress'), { statusCode: 409 });
    locks.add(id); const db = await repositoryFactory({ databasePath }); let scratch;
    try {
      let source = await db.sourceByMod(id);
      if (!source) throw new Error('mod_source_not_resolved');
      scratch = await fs.mkdtemp(path.join(runtimeRoot, `.mod-staging-${process.pid}-`));
      const archive = path.join(scratch, 'mod.tar.gz'); const extract = path.join(scratch, 'extract');
      const inspected = await repositoryPreparation(source.url, await sourceCredential(db, source.id), { archivePath: archive, archiveReserve: { root: scratch, reserveBytes: archivePolicy.reserveBytes, checkIntervalMs: archivePolicy.checkIntervalMs } });
      if (inspected.modId !== id) throw new Error('mod_manifest_id_mismatch');
      const version = inspected.latestVersion;
      if (requestedVersion && compareVersions(requestedVersion, version) !== 0) throw new Error('mod_version_unavailable');
      const archiveInfo = await validateArchiveEntries(archive); await fs.mkdir(extract);
      const budget = await archiveBudget(scratch, archive, archivePolicy);
      if (archiveInfo.expandedBytes > budget) throw new Error('mod_archive_resources_exceeded');
      await extractArchiveWithBudget(archive, extract, budget, archivePolicy);
      const prepared = await findPreparedMod(extract);
      if (prepared.id !== id && source.mod_id) throw new Error('mod_manifest_id_mismatch');
      const target = path.join(modsRoot, prepared.id); const digest = await archiveSha256(archive);
      const wasInstalled = Boolean(await db.installationExists(prepared.id));
      const enabled = (await db.lifecycle(prepared.id))?.enabled === 1;
      // Reject already-active work before touching the files used by the live
      // registry. transitionMod checks again after candidate activation to close
      // the race with work that starts during staging.
      if (wasInstalled && enabled) await onLifecycleChange?.({ modId: prepared.id, enabled: true, installed: true, action: 'update-preflight' });
      const swap = await swapMod(target, prepared.root);
      try {
        if (wasInstalled && enabled) await onLifecycleChange?.({ modId: prepared.id, enabled: true, installed: true, action: 'update' });
        await swap.commit();
      } catch (error) {
        await swap.rollback();
        throw error;
      }
      const timestamp = now();
      await db.transaction((tx) => tx.saveInstallation(source, prepared, version, digest, timestamp));
      restart?.();
      return { ok: true, modId: prepared.id, version, archiveSha256: digest, restartRequired: Boolean(restart) };
    } finally { await db.close(); if (scratch) await fs.rm(scratch, { recursive: true, force: true }); locks.delete(id); }
  }
  async function setEnabled(modId, enabled) {
    await ready;
    const id = String(modId || '').trim(); if ((id === MOD_DATA_DIRECTORY || !MOD_ID.test(id))) throw new Error('mod_id_invalid');
    if (locks.has(id)) throw Object.assign(new Error('mod_install_in_progress'), { statusCode: 409 });
    locks.add(id); const db = await repositoryFactory({ databasePath });
    try {
      const discovered = await discoverMods({ runtimeRoot, logger });
      if (!discovered.some((entry) => entry.id === id)) throw Object.assign(new Error('mod_not_found'), { statusCode: 404 });
      const timestamp = now();
      const previous = await db.previousLifecycle(id);
      await db.setLifecycle(id, enabled, timestamp);
      try { await onLifecycleChange?.({ modId: id, enabled: Boolean(enabled), installed: true, action: enabled ? 'enable' : 'disable' }); }
      catch (error) {
        await db.restoreLifecycle(id, previous, timestamp);
        throw error;
      }
      restart?.();
      return { ok: true, modId: id, enabled: Boolean(enabled), restartRequired: Boolean(restart) };
    } finally { await db.close(); locks.delete(id); }
  }
  async function uninstall(modId) {
    await ready;
    const id = String(modId || '').trim(); if ((id === MOD_DATA_DIRECTORY || !MOD_ID.test(id))) throw new Error('mod_id_invalid');
    if (locks.has(id)) throw Object.assign(new Error('mod_install_in_progress'), { statusCode: 409 });
    locks.add(id); const db = await repositoryFactory({ databasePath });
    try {
      const discovered = await discoverMods({ runtimeRoot, logger });
      const mod = discovered.find((entry) => entry.id === id);
      if (!mod) throw Object.assign(new Error('mod_not_found'), { statusCode: 404 });
      if (mod.manifest?.system === true) throw Object.assign(new Error('system_mod_uninstall_forbidden'), { statusCode: 409 });
      const target = path.join(modsRoot, id); const quarantine = `${target}.uninstall-${crypto.randomUUID()}`; const recovery = `${quarantine}.recovery`;
      const { installation, lifecycle } = await db.uninstallMetadata(id);
      const journalPath = path.join(recoveryRoot, `uninstall-${id}-${crypto.randomUUID()}.json`);
      const journal = { version: 1, operation: 'uninstall', modId: id, target, quarantine, recovery, installation, lifecycle, phase: 'journaled', committed: false };
      await durableJson(journalPath, journal);
      await renamePath(target, quarantine);
      // Recursive removal may fail after deleting part of the tree. Preserve an
      // independent recovery copy until files, runtime registry, and DB agree.
      try {
        await copyPath(quarantine, recovery, { recursive: true, preserveTimestamps: true });
        await durableJson(journalPath, { ...journal, phase: 'prepared' });
      } catch (error) {
        try {
          await renamePath(quarantine, target);
          await cleanupPath(recovery, { recursive: true, force: true });
          await removeDurably(journalPath);
        } catch (recoveryError) { error.filesystemRecoveryError = recoveryError; }
        throw error;
      }
      let runtimeRemoved = false; let recordsDeleted = false; let committed = false;
      try {
        await onLifecycleChange?.({ modId: id, enabled: false, installed: false, action: 'uninstall' });
        runtimeRemoved = true;
        await db.transaction((tx) => tx.removeMetadata(id));
        recordsDeleted = true;
        await durableJson(journalPath, { ...journal, phase: 'removing' });
        await removePath(quarantine, { recursive: true, force: true });
        await durableJson(journalPath, { ...journal, phase: 'committed', committed: true });
        committed = true;
        await cleanupPath(recovery, { recursive: true, force: true });
        await removeDurably(journalPath);
        await fs.rmdir(recoveryRoot).catch((error) => { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error; });
      } catch (error) {
        // Once the durable committed marker exists, cleanup is retryable startup
        // work. Never resurrect files or records for an already-committed delete.
        if (committed) throw error;
        try {
          await cleanupPath(quarantine, { recursive: true, force: true });
          await renamePath(recovery, target);
        } catch (recoveryError) { error.filesystemRecoveryError = recoveryError; }
        if (recordsDeleted) {
          try { await db.transaction((tx) => tx.restoreMetadata({ installation, lifecycle })); }
          catch (recoveryError) { error.databaseRecoveryError = recoveryError; }
        }
        if (runtimeRemoved) {
          try { await onLifecycleChange?.({ modId: id, enabled: lifecycle?.enabled === 1, installed: true, action: 'uninstall-recovery' }); }
          catch (recoveryError) { error.runtimeRecoveryError = recoveryError; }
        }
        if (!error.filesystemRecoveryError && !error.databaseRecoveryError && !error.runtimeRecoveryError) {
          try { await removeDurably(journalPath); } catch (recoveryError) { error.journalCleanupError = recoveryError; }
        }
        throw error;
      }
      restart?.();
      return { ok: true, modId: id, uninstalled: true, settingsPreserved: true, restartRequired: Boolean(restart) };
    } finally { await db.close(); locks.delete(id); }
  }
  const pollingReady = ready.then(() => schedulePoll());
  void pollingReady.catch((error) => logger.error?.(`Burrow mod source polling failed: ${String(error?.message || error)}`));
  return { ready, list, sourceRefreshConfig, saveSourceRefreshConfig, addSource, refresh, removeSource, install, enable: (id) => setEnabled(id, true), disable: (id) => setEnabled(id, false), uninstall, async close() { closed = true; clearPoll(); try { await ready; await pollingReady; await refreshPromise; } catch {} } };
}

export function createModManagementRoute({ distribution, readJsonBody, sendJson } = {}) {
  return async ({ req, res, url } = {}) => {
    if (url.pathname === '/api/mod-management' && req.method === 'GET') { sendJson(res, 200, await distribution.list()); return true; }
    if (url.pathname === '/api/mod-management/source-refresh' && req.method === 'GET') { sendJson(res, 200, await distribution.sourceRefreshConfig()); return true; }
    if (url.pathname === '/api/mod-management/source-refresh' && req.method === 'PUT') { const body = await readJsonBody(req); sendJson(res, 200, await distribution.saveSourceRefreshConfig(body)); return true; }
    if (url.pathname === '/api/mod-management/sources' && req.method === 'POST') { const body = await readJsonBody(req); const result = await distribution.addSource(body.url, body.auth || body.credentials || (body.token ? { token: body.token, username: body.username } : null)); sendJson(res, result.ok ? 201 : 502, result); return true; }
    if (url.pathname === '/api/mod-management/refresh' && req.method === 'POST') { sendJson(res, 200, await distribution.refresh()); return true; }
    let match = url.pathname.match(/^\/api\/mod-management\/sources\/([^/]+)$/);
    if (match && req.method === 'DELETE') { const result = await distribution.removeSource(decodeURIComponent(match[1])); sendJson(res, result.ok ? 200 : 404, result); return true; }
    match = url.pathname.match(/^\/api\/mod-management\/([^/]+)\/(install|enable|disable|uninstall)$/);
    if (match && req.method === 'POST') {
      const id = decodeURIComponent(match[1]);
      let result;
      if (match[2] === 'install') {
        const body = await readJsonBody(req);
        result = await distribution.install(id, body.version || body.targetVersion);
      } else {
        result = await distribution[match[2]](id);
      }
      sendJson(res, 200, result); return true;
    }
    return false;
  };
}
