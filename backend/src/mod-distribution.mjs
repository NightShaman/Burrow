import crypto, { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { discoverMods } from './mod-runtime.mjs';
import { openSettingsDatabase } from './settings-database.mjs';
import { settingsKeyFromEnvironment } from './model-settings-store.mjs';

const execFileAsync = promisify(execFile);
const MOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^v?(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?|\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const locks = new Set();

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
async function gitContext(url, credential) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'burrow-mod-git-'));
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
    try { return await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', ...args], { cwd: root, env, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, ...options }); }
    catch (error) { throw new Error(safeGitError(error)); }
  };
  return { root, run, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
async function prepareRepository(url, credential, { archivePath = null } = {}) {
  const context = await gitContext(url, credential);
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
    if (!MOD_ID.test(modId) || !modName) throw new Error('mod_source_manifest_invalid');
    if (manifest.version != null && (!VERSION.test(String(manifest.version)) || compareVersions(manifest.version, tag) !== 0)) throw new Error('mod_source_manifest_version_mismatch');
    if (archivePath) {
      await context.run(['--git-dir', repo, 'archive', '--format=tar.gz', `--prefix=${modId}/`, `--output=${archivePath}`, tag]);
      const stat = await fs.stat(archivePath); if (stat.size > MAX_ARCHIVE_BYTES) throw new Error('mod_archive_too_large');
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
    execFileAsync('tar', ['-tvzf', archivePath], { maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' }),
  ]);
  const entries = names.split('\n').filter(Boolean);
  if (!entries.length || entries.length > 20_000) throw new Error('mod_archive_invalid');
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.split('/').some((part) => part === '..')) throw new Error('mod_archive_path_invalid');
  }
  for (const line of verbose.split('\n').filter(Boolean)) {
    const type = line[0];
    if (type === 'l' || type === 'h' || type === 'b' || type === 'c' || type === 'p') throw new Error('mod_archive_special_entry_invalid');
  }
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
  if (!MOD_ID.test(id) || !String(manifest?.name || '').trim()) throw new Error('mod_manifest_invalid');
  return { root: found[0], manifest, id, name: String(manifest.name).trim() };
}

async function swapMod(target, prepared) {
  const parent = path.dirname(target); const backup = `${target}.backup-${crypto.randomUUID()}`;
  await fs.mkdir(parent, { recursive: true });
  let backedUp = false;
  try {
    try { await fs.rename(target, backup); backedUp = true; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await fs.rename(prepared, target);
    if (backedUp) await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    if (backedUp) await fs.rename(backup, target).catch(() => {});
    throw error;
  }
}

function sourceRows(db) { return db.prepare('SELECT id,url,provider,mod_id,mod_name,latest_version,archive_url,status,error,last_checked_at FROM mod_sources ORDER BY created_at').all(); }
function installationRows(db) { return new Map(db.prepare('SELECT mod_id,source_id,version,archive_sha256,installed_at,updated_at FROM mod_installations').all().map((row) => [row.mod_id, row])); }
function lifecycleRows(db) { return new Map(db.prepare('SELECT mod_id,enabled,created_at,updated_at FROM mod_lifecycle').all().map((row) => [row.mod_id, row])); }

export function createModDistribution({ runtimeRoot, databasePath, restart = null, logger = console, settingsKey = null } = {}) {
  if (!runtimeRoot || !databasePath) throw new Error('mod_distribution_configuration_required');
  const modsRoot = path.join(runtimeRoot, 'mods');
  function sourceCredential(db, id) {
    const row = db.prepare('SELECT ciphertext,nonce,auth_tag FROM mod_source_secrets WHERE source_id=?').get(id);
    if (!row) return null;
    return openCredential(settingsKey || settingsKeyFromEnvironment(), id, row);
  }
  async function refreshSource(db, row) {
    const checkedAt = now();
    try {
      const inspected = await prepareRepository(row.url, sourceCredential(db, row.id));
      db.prepare("UPDATE mod_sources SET mod_id=?,mod_name=?,latest_version=?,archive_url=?,status='ready',error=NULL,last_checked_at=?,updated_at=? WHERE id=?").run(inspected.modId, inspected.modName, inspected.latestVersion, inspected.archiveUrl, checkedAt, checkedAt, row.id);
      return { ...row, ...inspected, status: 'ready', error: null };
    } catch (error) {
      const message = String(error?.message || error);
      db.prepare("UPDATE mod_sources SET status='failed',error=?,last_checked_at=?,updated_at=? WHERE id=?").run(message, checkedAt, checkedAt, row.id);
      return { ...row, status: 'failed', error: message };
    }
  }
  async function list() {
    const db = openSettingsDatabase({ databasePath });
    try {
      const discovered = await discoverMods({ runtimeRoot, logger });
      const installed = installationRows(db);
      const lifecycle = lifecycleRows(db);
      const sources = sourceRows(db);
      const sourceByMod = new Map(sources.filter((row) => row.mod_id).map((row) => [row.mod_id, row]));
      const mods = discovered.map((mod) => {
        const record = installed.get(mod.id); const source = sourceByMod.get(mod.id) || (record?.source_id ? sources.find((item) => item.id === record.source_id) : null);
        const version = record?.version || normalizeVersion(mod.manifest?.version || '') || undefined;
        const latestVersion = source?.latest_version || undefined;
        const enabled = lifecycle.get(mod.id)?.enabled !== 0;
        return { id: mod.id, name: mod.name, version, status: mod.status === 'failed' ? 'failed' : 'installed', enabled, system: mod.manifest?.system === true, source: source?.url, latestVersion, updateAvailable: Boolean(version && latestVersion && VERSION.test(version) && VERSION.test(latestVersion) && compareVersions(latestVersion, version) > 0), canInstall: source?.status === 'ready', ...(source?.error ? { reason: source.error } : {}) };
      });
      for (const source of sources) if (source.mod_id && !mods.some((mod) => mod.id === source.mod_id)) mods.push({ id: source.mod_id, name: source.mod_name || source.mod_id, status: 'available', source: source.url, latestVersion: source.latest_version || undefined, canInstall: source.status === 'ready', ...(source.error ? { reason: source.error } : {}) });
      return { ok: true, restartRequired: false, mods, sources: sources.map((row) => ({ id: row.id, url: row.url, status: row.status, ...(row.error ? { error: row.error } : {}), ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}) })) };
    } finally { db.close(); }
  }
  async function addSource(urlValue, authValue = null) {
    const url = normalizeModSourceUrl(urlValue); const id = sourceId(url); const timestamp = now(); const auth = credentialInput(authValue); const db = openSettingsDatabase({ databasePath });
    try {
      db.prepare(`INSERT INTO mod_sources (id,url,provider,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?) ON CONFLICT(url) DO NOTHING`).run(id, url, 'git', timestamp, timestamp);
      const row = db.prepare('SELECT * FROM mod_sources WHERE url=?').get(url);
      if (auth) {
        const encrypted = sealCredential(settingsKey || settingsKeyFromEnvironment(), row.id, auth);
        db.prepare(`INSERT INTO mod_source_secrets (source_id,ciphertext,nonce,auth_tag,created_at,updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(source_id) DO UPDATE SET ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag,updated_at=excluded.updated_at`)
          .run(row.id, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, timestamp, timestamp);
      }

      const refreshed = await refreshSource(db, row);
      return { ok: refreshed.status === 'ready', source: refreshed, ...(refreshed.error ? { error: refreshed.error } : {}) };
    } finally { db.close(); }
  }
  async function refresh() { const db = openSettingsDatabase({ databasePath }); try { for (const row of sourceRows(db)) await refreshSource(db, row); } finally { db.close(); } return list(); }
  async function removeSource(id) { const db = openSettingsDatabase({ databasePath }); try { const removed = db.prepare('DELETE FROM mod_sources WHERE id=?').run(String(id)).changes > 0; return { ok: removed, removed }; } finally { db.close(); } }
  async function install(modId, requestedVersion = null) {
    const id = String(modId || '').trim(); if (!MOD_ID.test(id)) throw new Error('mod_id_invalid');
    if (locks.has(id)) throw Object.assign(new Error('mod_install_in_progress'), { statusCode: 409 });
    locks.add(id); const db = openSettingsDatabase({ databasePath }); let scratch;
    try {
      let source = db.prepare('SELECT * FROM mod_sources WHERE mod_id=? LIMIT 1').get(id);
      if (!source) throw new Error('mod_source_not_resolved');
      scratch = await fs.mkdtemp(path.join(runtimeRoot, `.mod-staging-${process.pid}-`));
      const archive = path.join(scratch, 'mod.tar.gz'); const extract = path.join(scratch, 'extract');
      const inspected = await prepareRepository(source.url, sourceCredential(db, source.id), { archivePath: archive });
      if (inspected.modId !== id) throw new Error('mod_manifest_id_mismatch');
      const version = inspected.latestVersion;
      if (requestedVersion && compareVersions(requestedVersion, version) !== 0) throw new Error('mod_version_unavailable');
      await validateArchiveEntries(archive); await fs.mkdir(extract);
      await execFileAsync('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', archive, '-C', extract], { timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' });
      const prepared = await findPreparedMod(extract);
      if (prepared.id !== id && source.mod_id) throw new Error('mod_manifest_id_mismatch');
      const target = path.join(modsRoot, prepared.id); const digest = await archiveSha256(archive);
      await swapMod(target, prepared.root);
      const timestamp = now();
      db.prepare('UPDATE mod_sources SET mod_id=?,mod_name=?,latest_version=?,status=\'ready\',error=NULL,updated_at=? WHERE id=?').run(prepared.id, prepared.name, version, timestamp, source.id);
      db.prepare(`INSERT INTO mod_installations (mod_id,source_id,version,archive_sha256,installed_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(mod_id) DO UPDATE SET source_id=excluded.source_id,version=excluded.version,archive_sha256=excluded.archive_sha256,installed_at=excluded.installed_at,updated_at=excluded.updated_at`).run(prepared.id, source.id, version, digest, timestamp, timestamp);
      db.prepare(`INSERT INTO mod_lifecycle (mod_id,enabled,created_at,updated_at) VALUES (?,0,?,?)
        ON CONFLICT(mod_id) DO NOTHING`).run(prepared.id, timestamp, timestamp);
      restart?.();
      return { ok: true, modId: prepared.id, version, archiveSha256: digest, restartRequired: true };
    } finally { db.close(); if (scratch) await fs.rm(scratch, { recursive: true, force: true }); locks.delete(id); }
  }
  async function setEnabled(modId, enabled) {
    const id = String(modId || '').trim(); if (!MOD_ID.test(id)) throw new Error('mod_id_invalid');
    if (locks.has(id)) throw Object.assign(new Error('mod_install_in_progress'), { statusCode: 409 });
    locks.add(id); const db = openSettingsDatabase({ databasePath });
    try {
      const discovered = await discoverMods({ runtimeRoot, logger });
      if (!discovered.some((entry) => entry.id === id)) throw Object.assign(new Error('mod_not_found'), { statusCode: 404 });
      const timestamp = now();
      db.prepare(`INSERT INTO mod_lifecycle (mod_id,enabled,created_at,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(mod_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`).run(id, enabled ? 1 : 0, timestamp, timestamp);
      restart?.();
      return { ok: true, modId: id, enabled: Boolean(enabled), restartRequired: true };
    } finally { db.close(); locks.delete(id); }
  }
  async function uninstall(modId) {
    const id = String(modId || '').trim(); if (!MOD_ID.test(id)) throw new Error('mod_id_invalid');
    if (locks.has(id)) throw Object.assign(new Error('mod_install_in_progress'), { statusCode: 409 });
    locks.add(id); const db = openSettingsDatabase({ databasePath });
    try {
      const discovered = await discoverMods({ runtimeRoot, logger });
      const mod = discovered.find((entry) => entry.id === id);
      if (!mod) throw Object.assign(new Error('mod_not_found'), { statusCode: 404 });
      await fs.rm(path.join(modsRoot, id), { recursive: true, force: true });
      db.prepare('DELETE FROM mod_installations WHERE mod_id=?').run(id);
      db.prepare('DELETE FROM mod_lifecycle WHERE mod_id=?').run(id);
      restart?.();
      return { ok: true, modId: id, uninstalled: true, settingsPreserved: true, restartRequired: true };
    } finally { db.close(); locks.delete(id); }
  }
  return { list, addSource, refresh, removeSource, install, enable: (id) => setEnabled(id, true), disable: (id) => setEnabled(id, false), uninstall };
}

export function createModManagementRoute({ distribution, readJsonBody, sendJson } = {}) {
  return async ({ req, res, url } = {}) => {
    if (url.pathname === '/api/mod-management' && req.method === 'GET') { sendJson(res, 200, await distribution.list()); return true; }
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
