import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModSettingsStore, modSecretsApi, modSettingsApi } from './mod-settings-store.mjs';

const MOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIME = Object.freeze({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' });

function safeRelative(value, errorCode) {
  const input = String(value || '').trim().replaceAll('\\', '/');
  if (!input || input.startsWith('/') || input.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(errorCode);
  return input;
}
function inside(root, relative) {
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('mod_path_invalid');
  return resolved;
}
function manifestUi(id, root, value = {}) {
  const ui = {};
  for (const slot of ['control', 'settings']) {
    if (!value?.[slot]) continue;
    const relative = safeRelative(value[slot], `mod_ui_${slot}_invalid`);
    ui[slot] = { relative, filePath: inside(root, relative), url: `/api/mods/${encodeURIComponent(id)}/${relative.split('/').map(encodeURIComponent).join('/')}` };
  }
  return ui;
}
function manifestContributions(id, value = {}) {
  const contributions = {};
  if (value?.apiTargets !== undefined) {
    const endpoint = String(value.apiTargets || '').trim();
    if (!endpoint.startsWith(`/api/mods/${id}/`) || endpoint.includes('?') || endpoint.includes('#') || endpoint.split('/').includes('..')) {
      throw new Error(`mod_api_targets_invalid:${id}`);
    }
    contributions.apiTargets = endpoint;
  }
  return contributions;
}

function failedMod({ id, name, root, error }) {
  return { id: id || path.basename(root), name: name || id || path.basename(root), root, manifest: null, server: null, ui: {}, contributions: {}, routes: [], store: null, status: 'failed', error: String(error?.message || error || 'mod_invalid').split(':')[0] };
}

export async function discoverMods({ runtimeRoot = process.env.BURROW_RUNTIME_ROOT || '/mnt/local/burrow', logger = console } = {}) {
  const modsRoot = path.join(runtimeRoot, 'mods');
  try { await fs.mkdir(modsRoot, { recursive: true }); }
  catch (error) { logger.warn?.(`Burrow mod directory unavailable: ${String(error?.message || error)}`); return []; }
  let entries;
  try { entries = await fs.readdir(modsRoot, { withFileTypes: true }); }
  catch (error) { logger.warn?.(`Burrow mod directory unreadable: ${String(error?.message || error)}`); return []; }
  const mods = [];
  const seen = new Map();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const root = path.join(modsRoot, entry.name);
    let manifest = null;
    let manifestId = '';
    try {
      manifest = JSON.parse(await fs.readFile(path.join(root, 'burrow.mod.json'), 'utf8'));
      manifestId = String(manifest.id || '').trim();
      const id = manifestId;
      const name = String(manifest.name || '').trim();
      if (!MOD_ID.test(id) || id !== entry.name) throw new Error(`mod_id_invalid:${entry.name}`);
      if (!name) throw new Error(`mod_name_required:${id}`);
      if (seen.has(id)) {
        const previous = seen.get(id);
        previous.status = 'failed'; previous.error = 'mod_id_duplicate';
        throw new Error(`mod_id_duplicate:${id}`);
      }
      const server = manifest.server ? safeRelative(manifest.server, `mod_server_invalid:${id}`) : null;
      const ui = manifestUi(id, root, manifest.ui);
      const contributions = manifestContributions(id, manifest.contributions);
      const mod = { id, name, root, manifest, server: server ? inside(root, server) : null, ui, contributions };
      seen.set(id, mod); mods.push(mod);
    } catch (error) {
      mods.push(failedMod({ id: manifestId, root, error }));
      logger.warn?.(`Burrow mod ${entry.name} ignored: ${String(error?.message || error)}`);
    }
  }
  return mods;
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function compileRoute(routePath) {
  const names = [];
  const pattern = routePath.split('/').map((part) => {
    if (!part.startsWith(':')) return escapeRegex(part);
    const name = part.slice(1);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error('mod_route_parameter_invalid');
    names.push(name);
    return '([^/]+)';
  }).join('/');
  return { names, expression: new RegExp(`^${pattern}$`) };
}
function matchRoute(route, value) {
  const match = route.expression.exec(value);
  if (!match) return null;
  return Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
}
function apiRegistrar(mod) {
  const routes = [];
  const add = (method, routePath, handler) => {
    const relative = String(routePath || '').trim();
    if (!relative.startsWith('/') || relative.includes('?') || relative.split('/').includes('..') || typeof handler !== 'function') throw new Error(`mod_route_invalid:${mod.id}`);
    const normalized = relative === '/' ? '' : relative.replace(/\/$/, '');
    routes.push({ method, path: normalized, handler, ...compileRoute(normalized) });
  };
  return { routes, api: Object.freeze({ get: (p, h) => add('GET', p, h), post: (p, h) => add('POST', p, h), put: (p, h) => add('PUT', p, h), patch: (p, h) => add('PATCH', p, h), delete: (p, h) => add('DELETE', p, h) }) };
}

export async function loadMods({ runtimeRoot, databasePath, logger = console } = {}) {
  const discovered = await discoverMods({ runtimeRoot });
  const loaded = [];
  for (const mod of discovered) {
    if (mod.status === 'failed') { loaded.push(mod); continue; }
    const registrar = apiRegistrar(mod);
    const store = new ModSettingsStore({ modId: mod.id, databasePath });
    try {
      if (mod.server) {
        const module = await import(`${pathToFileURL(mod.server).href}?loaded=${Date.now()}`);
        if (typeof module.activate !== 'function') throw new Error(`mod_activate_missing:${mod.id}`);
        await module.activate(Object.freeze({ id: mod.id, api: registrar.api, settings: modSettingsApi(store), secrets: modSecretsApi(store), logger }));
      }
      loaded.push({ ...mod, routes: registrar.routes, store, status: 'loaded' });
    } catch (error) {
      store.close();
      logger.error?.(`Burrow mod ${mod.id} failed: ${String(error?.message || error)}`);
      loaded.push({ ...mod, routes: [], store: null, status: 'failed', error: String(error?.message || error) });
    }
  }
  return loaded;
}

export function modCatalog(mods = []) {
  return mods.map((mod) => ({
    id: mod.id,
    name: mod.name,
    status: mod.status || 'discovered',
    ...(mod.status === 'failed' ? { error: mod.error || 'mod_failed' } : {}),
    ...(mod.status !== 'failed' && Object.keys(mod.contributions || {}).length ? { contributions: { ...mod.contributions } } : {}),
    ...(mod.status !== 'failed' && Object.keys(mod.ui || {}).length ? { ui: { ...(mod.ui.control ? { controlUrl: mod.ui.control.url } : {}), ...(mod.ui.settings ? { settingsUrl: mod.ui.settings.url } : {}) } } : {}),
  }));
}

async function sendAsset(res, filePath) {
  const content = await fs.readFile(filePath);
  res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'content-length': content.length, 'cache-control': 'no-cache' });
  res.end(content);
}

export function createModRoute({ mods = [], readJsonBody, sendJson } = {}) {
  const byId = new Map(mods.map((mod) => [mod.id, mod]));
  return async function handleModRoute({ req, res, url } = {}) {
    if (req.method === 'GET' && url.pathname === '/api/mods') { sendJson(res, 200, { ok: true, mods: modCatalog(mods) }); return true; }
    const match = url.pathname.match(/^\/api\/mods\/([^/]+)(?:\/(.*))?$/);
    if (!match) return false;
    const id = decodeURIComponent(match[1]);
    const mod = byId.get(id);
    if (!mod || mod.status !== 'loaded') { sendJson(res, 404, { ok: false, error: 'mod_not_found' }); return true; }
    const relative = (match[2] || '').split('/').filter(Boolean).map(decodeURIComponent).join('/');
    if (req.method === 'GET' && relative) {
      const filePath = inside(mod.root, relative);
      const uiRoots = [...new Set([mod.ui.control?.filePath, mod.ui.settings?.filePath].filter(Boolean).map((entry) => path.dirname(entry)))];
      const isUiAsset = uiRoots.some((root) => { const rel = path.relative(root, filePath); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
      if (isUiAsset) {
        try { await sendAsset(res, filePath); } catch (error) { if (error?.code === 'ENOENT') sendJson(res, 404, { ok: false, error: 'mod_asset_not_found' }); else throw error; }
        return true;
      }
    }
    const routePath = relative ? `/${relative}` : '';
    let route = null; let params = null;
    for (const candidate of mod.routes) {
      if (candidate.method !== req.method) continue;
      const matched = matchRoute(candidate, routePath);
      if (matched) { route = candidate; params = matched; break; }
    }
    if (!route) { sendJson(res, 404, { ok: false, error: 'mod_route_not_found' }); return true; }
    try {
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readJsonBody(req) : null;
      const result = await route.handler({ body, query: Object.fromEntries(url.searchParams), params, method: req.method, path: routePath });
      sendJson(res, Number(result?.status) || 200, result?.body ?? result ?? { ok: true });
    } catch (error) {
      sendJson(res, Number(error?.statusCode) || 500, { ok: false, error: String(error?.message || error) });
    }
    return true;
  };
}
