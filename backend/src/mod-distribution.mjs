import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { discoverMods } from './mod-runtime.mjs';
import { openSettingsDatabase } from './settings-database.mjs';

const execFileAsync = promisify(execFile);
const MOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^v?(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?|\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const locks = new Set();

function now() { return new Date().toISOString(); }
function sourceId(url) { return crypto.createHash('sha256').update(url).digest('hex').slice(0, 24); }
function normalizeVersion(value) { const text = String(value || '').trim(); return text.startsWith('v') ? text.slice(1) : text; }
function versionParts(value) { return normalizeVersion(value).split('.').map((part) => Number.parseInt(part, 10)); }
function compareVersions(a, b) {
  const aa = versionParts(a); const bb = versionParts(b);
  for (let index = 0; index < Math.max(aa.length, bb.length); index += 1) {
    const difference = (aa[index] || 0) - (bb[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

export function normalizeModSourceUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch { throw new Error('mod_source_url_invalid'); }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') throw new Error('mod_source_github_https_required');
  const parts = parsed.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) throw new Error('mod_source_repository_invalid');
  parsed.pathname = `/${parts[0]}/${parts[1]}`; parsed.search = ''; parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function githubCoordinates(url) { const parsed = new URL(url); const [owner, repo] = parsed.pathname.split('/').filter(Boolean); return { owner, repo }; }
async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Burrow-Mod-Manager' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`mod_source_fetch_failed:${response.status}`);
  return response.json();
}

async function inspectSource(url) {
  const { owner, repo } = githubCoordinates(url);
  const repository = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`);
  const branch = String(repository?.default_branch || 'main');
  const manifest = await fetchJson(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/burrow.mod.json`);
  const modId = String(manifest?.id || '').trim();
  const modName = String(manifest?.name || '').trim();
  if (!MOD_ID.test(modId) || !modName) throw new Error('mod_source_manifest_invalid');
  let release;
  try { release = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`); }
  catch (error) {
    if (!String(error?.message || error).endsWith(':404')) throw error;
    const tags = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/tags?per_page=1`);
    release = Array.isArray(tags) && tags[0] ? { tag_name: tags[0].name, tarball_url: tags[0].tarball_url } : null;
  }
  const tag = String(release?.tag_name || '').trim();
  if (!VERSION.test(tag)) throw new Error('mod_source_version_invalid');
  return { modId, modName, latestVersion: normalizeVersion(tag), archiveUrl: String(release?.tarball_url || `https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(tag)}`) };
}

async function downloadArchive(url, destination) {
  const response = await fetch(url, { headers: { accept: 'application/octet-stream', 'user-agent': 'Burrow-Mod-Manager' }, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`mod_archive_download_failed:${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_ARCHIVE_BYTES) throw new Error('mod_archive_too_large');
  let received = 0;
  const limiter = new TransformStream({ transform(chunk, controller) { received += chunk.byteLength; if (received > MAX_ARCHIVE_BYTES) throw new Error('mod_archive_too_large'); controller.enqueue(chunk); } });
  await pipeline(response.body.pipeThrough(limiter), createWriteStream(destination, { mode: 0o600 }));
}

async function archiveSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); } finally { await handle.close(); }
  return hash.digest('hex');
}

async function validateArchiveEntries(archivePath) {
  const [{ stdout: names }, { stdout: verbose }] = await Promise.all([
    execFileAsync('tar', ['-tzf', archivePath], { maxBuffer: 8 * 1024 * 1024 }),
    execFileAsync('tar', ['-tvzf', archivePath], { maxBuffer: 16 * 1024 * 1024 }),
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

export function createModDistribution({ runtimeRoot, databasePath, restart = null, logger = console } = {}) {
  if (!runtimeRoot || !databasePath) throw new Error('mod_distribution_configuration_required');
  const modsRoot = path.join(runtimeRoot, 'mods');
  async function refreshSource(db, row) {
    const checkedAt = now();
    try {
      const inspected = await inspectSource(row.url);
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
      const sources = sourceRows(db);
      const sourceByMod = new Map(sources.filter((row) => row.mod_id).map((row) => [row.mod_id, row]));
      const mods = discovered.map((mod) => {
        const record = installed.get(mod.id); const source = sourceByMod.get(mod.id) || (record?.source_id ? sources.find((item) => item.id === record.source_id) : null);
        const version = record?.version || normalizeVersion(mod.manifest?.version || '') || undefined;
        const latestVersion = source?.latest_version || undefined;
        return { id: mod.id, name: mod.name, version, status: mod.status === 'failed' ? 'failed' : 'installed', system: mod.manifest?.system === true, source: source?.url, latestVersion, updateAvailable: Boolean(version && latestVersion && compareVersions(latestVersion, version) > 0), canInstall: source?.status === 'ready', ...(source?.error ? { reason: source.error } : {}) };
      });
      for (const source of sources) if (source.mod_id && !mods.some((mod) => mod.id === source.mod_id)) mods.push({ id: source.mod_id, name: source.mod_name || source.mod_id, status: 'available', source: source.url, latestVersion: source.latest_version || undefined, canInstall: source.status === 'ready', ...(source.error ? { reason: source.error } : {}) });
      return { ok: true, restartRequired: false, mods, sources: sources.map((row) => ({ id: row.id, url: row.url, status: row.status, ...(row.error ? { error: row.error } : {}), ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}) })) };
    } finally { db.close(); }
  }
  async function addSource(urlValue) {
    const url = normalizeModSourceUrl(urlValue); const id = sourceId(url); const timestamp = now(); const db = openSettingsDatabase({ databasePath });
    try {
      db.prepare(`INSERT INTO mod_sources (id,url,provider,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?) ON CONFLICT(url) DO NOTHING`).run(id, url, 'github', timestamp, timestamp);
      const row = db.prepare('SELECT * FROM mod_sources WHERE url=?').get(url);
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
      source = await refreshSource(db, source);
      if (source.status !== 'ready') throw new Error(source.error || 'mod_source_unavailable');
      const version = normalizeVersion(requestedVersion || source.latestVersion);
      if (!version || version !== source.latestVersion) throw new Error('mod_version_unavailable');
      scratch = await fs.mkdtemp(path.join(runtimeRoot, `.mod-staging-${process.pid}-`));
      const archive = path.join(scratch, 'mod.tar.gz'); const extract = path.join(scratch, 'extract');
      await downloadArchive(source.archiveUrl, archive); await validateArchiveEntries(archive); await fs.mkdir(extract);
      await execFileAsync('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', archive, '-C', extract]);
      const prepared = await findPreparedMod(extract);
      if (prepared.id !== id && source.mod_id) throw new Error('mod_manifest_id_mismatch');
      const target = path.join(modsRoot, prepared.id); const digest = await archiveSha256(archive);
      await swapMod(target, prepared.root);
      const timestamp = now();
      db.prepare('UPDATE mod_sources SET mod_id=?,mod_name=?,latest_version=?,status=\'ready\',error=NULL,updated_at=? WHERE id=?').run(prepared.id, prepared.name, version, timestamp, source.id);
      db.prepare(`INSERT INTO mod_installations (mod_id,source_id,version,archive_sha256,installed_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(mod_id) DO UPDATE SET source_id=excluded.source_id,version=excluded.version,archive_sha256=excluded.archive_sha256,installed_at=excluded.installed_at,updated_at=excluded.updated_at`).run(prepared.id, source.id, version, digest, timestamp, timestamp);
      restart?.();
      return { ok: true, modId: prepared.id, version, archiveSha256: digest, restartRequired: true };
    } finally { db.close(); if (scratch) await fs.rm(scratch, { recursive: true, force: true }); locks.delete(id); }
  }
  async function uninstall(modId) {
    const id = String(modId || '').trim(); if (!MOD_ID.test(id)) throw new Error('mod_id_invalid');
    if (locks.has(id)) throw Object.assign(new Error('mod_install_in_progress'), { statusCode: 409 });
    locks.add(id); const db = openSettingsDatabase({ databasePath });
    try {
      const discovered = await discoverMods({ runtimeRoot, logger });
      const mod = discovered.find((entry) => entry.id === id);
      if (!mod) throw Object.assign(new Error('mod_not_found'), { statusCode: 404 });
      if (mod.manifest?.system === true) throw Object.assign(new Error('system_mod_uninstall_forbidden'), { statusCode: 409 });
      await fs.rm(path.join(modsRoot, id), { recursive: true, force: true });
      db.prepare('DELETE FROM mod_installations WHERE mod_id=?').run(id);
      restart?.();
      return { ok: true, modId: id, uninstalled: true, settingsPreserved: true, restartRequired: true };
    } finally { db.close(); locks.delete(id); }
  }
  return { list, addSource, refresh, removeSource, install, uninstall };
}

export function createModManagementRoute({ distribution, readJsonBody, sendJson } = {}) {
  return async ({ req, res, url } = {}) => {
    if (url.pathname === '/api/mod-management' && req.method === 'GET') { sendJson(res, 200, await distribution.list()); return true; }
    if (url.pathname === '/api/mod-management/sources' && req.method === 'POST') { const body = await readJsonBody(req); const result = await distribution.addSource(body.url); sendJson(res, result.ok ? 201 : 502, result); return true; }
    if (url.pathname === '/api/mod-management/refresh' && req.method === 'POST') { sendJson(res, 200, await distribution.refresh()); return true; }
    let match = url.pathname.match(/^\/api\/mod-management\/sources\/([^/]+)$/);
    if (match && req.method === 'DELETE') { const result = await distribution.removeSource(decodeURIComponent(match[1])); sendJson(res, result.ok ? 200 : 404, result); return true; }
    match = url.pathname.match(/^\/api\/mod-management\/([^/]+)\/(install|uninstall)$/);
    if (match && req.method === 'POST') {
      const id = decodeURIComponent(match[1]); const body = await readJsonBody(req);
      const result = match[2] === 'install' ? await distribution.install(id, body.version || body.targetVersion) : await distribution.uninstall(id);
      sendJson(res, 200, result); return true;
    }
    return false;
  };
}
