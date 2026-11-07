import { cacheGetAsync, cacheSetAsync } from './model-catalog-cache.mjs';
import { modelHttpError, modelSettingsFailureDiagnostic } from './model-settings-diagnostics.mjs';

export function parseSemver(value = '') {
  const match = String(value || '').trim().match(/^(?:rust-v|v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
  return match ? { raw: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`, parts: [Number(match[1]), Number(match[2]), Number(match[3])] } : null;
}

function compareSemver(a = '', b = '') {
  const left = parseSemver(a)?.parts;
  const right = parseSemver(b)?.parts;
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export function maxSemver(values = []) {
  return values.map((value) => parseSemver(value)?.raw).filter(Boolean).sort(compareSemver).at(-1) || null;
}

function codexClientVersionCacheFresh(cache = {}, nowMs = Date.now(), ttlMs = CODEX_CLIENT_VERSION_CACHE_TTL_MS) {
  const checked = Date.parse(cache.lastCheckedAt || '');
  return Number.isFinite(checked) && checked > 0 && nowMs - checked < Math.max(1, Number(ttlMs) || CODEX_CLIENT_VERSION_CACHE_TTL_MS);
}

export async function readCodexClientVersionCacheAsync(target) {
  return cacheGetAsync(target, CODEX_CLIENT_VERSION_META_KEY);
}

export async function writeCodexClientVersionCacheAsync(target, patch = {}, { nowMs = Date.now() } = {}) {
  const previous = await readCodexClientVersionCacheAsync(target);
  const next = { ...previous, ...patch, updatedAt: new Date(nowMs).toISOString() };
  return cacheSetAsync(target, CODEX_CLIENT_VERSION_META_KEY, next, nowMs);
}

function codexClientVersionFromCache(cache = {}) {
  return parseSemver(cache.currentVersion)?.raw || parseSemver(cache.lastGoodCatalogVersion)?.raw || CODEX_CLIENT_VERSION_FLOOR;
}

const CODEX_CLIENT_VERSION_META_KEY = 'openai_codex_client_version';

export const CODEX_CLIENT_VERSION_FLOOR = '0.145.0';

export const CODEX_CLIENT_VERSION_CACHE_TTL_MS = 24 * 60 * 60_000;

const NPM_CODEX_LATEST_URL = 'https://registry.npmjs.org/@openai%2Fcodex/latest';

const GITHUB_CODEX_LATEST_URL = 'https://api.github.com/repos/openai/codex/releases/latest';

async function fetchCodexVersionFromUrl(url, { fetchImpl = fetch, signal = undefined, source } = {}) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'Burrow/codex-version-resolver' }, signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw modelHttpError(`codex_client_version_${source}_failed`, response.status);
  const candidate = source === 'github' ? body.tag_name || body.name || body.version : body.version || body.tag_name || body.name;
  const parsed = parseSemver(candidate);
  if (!parsed) throw Object.assign(new Error(`codex_client_version_${source}_invalid`), { upstreamStatus: response.status });
  return parsed.raw;
}

export async function refreshCodexClientVersionCache({ store, fetchImpl = fetch, signal = undefined, nowMs = Date.now() } = {}) {
  const target = store;
  const attempts = [
    ['npm', NPM_CODEX_LATEST_URL],
    ['github', GITHUB_CODEX_LATEST_URL],
  ];
  let lastError = null;
  for (const [source, url] of attempts) {
    try {
      const version = await fetchCodexVersionFromUrl(url, { fetchImpl, signal, source });
      return writeCodexClientVersionCacheAsync(target, { currentVersion: version, source, lastCheckedAt: new Date(nowMs).toISOString(), lastError: null }, { nowMs });
    } catch (error) { lastError = error; }
  }
  return writeCodexClientVersionCacheAsync(target, { lastCheckedAt: new Date(nowMs).toISOString(), lastError: modelSettingsFailureDiagnostic(lastError, 'codex_client_version_refresh_failed') }, { nowMs });
}

export async function resolveCodexClientVersion({ store, nowMs = Date.now(), refresh = false, fetchImpl = fetch, signal = undefined } = {}) {
  const target = store;
  const cache = await readCodexClientVersionCacheAsync(target);
  if (!refresh || codexClientVersionCacheFresh(cache, nowMs)) return { version: codexClientVersionFromCache(cache), cache, refreshed: false };
  const next = await refreshCodexClientVersionCache({ store, fetchImpl, signal, nowMs });
  return { version: codexClientVersionFromCache(next), cache: next, refreshed: true };
}
