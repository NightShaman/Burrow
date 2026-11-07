import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { postgresTransactionContext, withPostgresTransaction } from './postgres-foundation.mjs';

export const BASIC_SESSION_COOKIE = 'hc_basic_session';

export function normalizeUiAuthRecord(record = {}) {
  const mode = String(record.mode || 'none').trim().toLowerCase();
  const allowedModes = new Set(['none', 'trusted-proxy', 'basic', 'oidc']);
  if (!allowedModes.has(mode)) throw new Error('ui_auth_mode_invalid');
  const trustedProxy = record.trustedProxy && typeof record.trustedProxy === 'object' ? record.trustedProxy : {};
  const basic = record.basic && typeof record.basic === 'object' ? record.basic : {};
  const sessionTtlSeconds = Math.max(60, Math.floor(Number(basic.sessionTtlSeconds ?? 12 * 60 * 60) || 12 * 60 * 60));
  return {
    mode,
    trustedProxy: {
      allowedProxies: (Array.isArray(trustedProxy.allowedProxies) ? trustedProxy.allowedProxies : [])
        .map((value) => String(value || '').trim()).filter(Boolean),
      userHeader: String(trustedProxy.userHeader || 'x-forwarded-user').trim().toLowerCase() || 'x-forwarded-user',
    },
    basic: {
      username: String(basic.username || '').trim(),
      passwordHash: String(basic.passwordHash || '').trim(),
      sessionTtlSeconds,
      insecureCookies: basic.insecureCookies === true,
    },
    oidc: {
      issuer: String(record.oidc?.issuer || '').trim(),
      clientId: String(record.oidc?.clientId || '').trim(),
      clientSecret: String(record.oidc?.clientSecret || '').trim(),
      clientSecretConfigured: Boolean(record.oidc?.clientSecretConfigured),
      redirectUri: String(record.oidc?.redirectUri || '').trim(),
      scopes: (Array.isArray(record.oidc?.scopes) ? record.oidc.scopes : ['openid', 'email', 'profile']).map((value) => String(value || '').trim()).filter(Boolean),
      allowedEmails: (Array.isArray(record.oidc?.allowedEmails) ? record.oidc.allowedEmails : []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean),
      allowedDomains: (Array.isArray(record.oidc?.allowedDomains) ? record.oidc.allowedDomains : []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean),
    },
  };
}

export function safeUiAuthSettings(record = {}) {
  const normalized = normalizeUiAuthRecord(record);
  return {
    mode: normalized.mode,
    trustedProxy: normalized.trustedProxy,
    basic: {
      username: normalized.basic.username,
      passwordConfigured: Boolean(normalized.basic.passwordHash),
      sessionTtlSeconds: normalized.basic.sessionTtlSeconds,
      insecureCookies: normalized.basic.insecureCookies,
    },
    oidc: {
      issuer: normalized.oidc.issuer,
      clientId: normalized.oidc.clientId,
      clientSecretConfigured: Boolean(normalized.oidc.clientSecret || normalized.oidc.clientSecretConfigured),
      redirectUri: normalized.oidc.redirectUri,
      scopes: normalized.oidc.scopes,
      allowedEmails: normalized.oidc.allowedEmails,
      allowedDomains: normalized.oidc.allowedDomains,
    },
  };
}

export function hashBasicPassword(password) {
  const salt = randomBytes(16);
  return `scrypt:16384:${salt.toString('base64url')}:${scryptSync(String(password || ''), salt, 32, { N: 16384 }).toString('base64url')}`;
}

export function planUiAuthSettings(body, existing) {
    const mode = String(body.mode || existing.mode || 'none').trim().toLowerCase();
    if (!['none', 'trusted-proxy', 'basic', 'oidc'].includes(mode)) return { ok: false, status: 400, error: 'ui_auth_mode_invalid' };
    const trustedProxyInput = body.trustedProxy && typeof body.trustedProxy === 'object' ? body.trustedProxy : {};
    const basicInput = body.basic && typeof body.basic === 'object' ? body.basic : {};
    const oidcInput = body.oidc && typeof body.oidc === 'object' ? body.oidc : {};
    const next = normalizeUiAuthRecord({
      mode,
      trustedProxy: {
        allowedProxies: Array.isArray(trustedProxyInput.allowedProxies) ? trustedProxyInput.allowedProxies : existing.trustedProxy.allowedProxies,
        userHeader: trustedProxyInput.userHeader ?? existing.trustedProxy.userHeader,
      },
      basic: {
        username: basicInput.username ?? existing.basic.username,
        passwordHash: basicInput.password !== undefined ? hashBasicPassword(basicInput.password) : existing.basic.passwordHash,
        sessionTtlSeconds: basicInput.sessionTtlSeconds ?? existing.basic.sessionTtlSeconds,
        insecureCookies: basicInput.insecureCookies ?? existing.basic.insecureCookies,
      },
      oidc: {
        issuer: oidcInput.issuer ?? existing.oidc.issuer,
        clientId: oidcInput.clientId ?? existing.oidc.clientId,
        clientSecret: oidcInput.clientSecret !== undefined ? oidcInput.clientSecret : '',
        clientSecretConfigured: existing.oidc.clientSecretConfigured,
        redirectUri: oidcInput.redirectUri ?? existing.oidc.redirectUri,
        scopes: Array.isArray(oidcInput.scopes) ? oidcInput.scopes : existing.oidc.scopes,
        allowedEmails: Array.isArray(oidcInput.allowedEmails) ? oidcInput.allowedEmails : existing.oidc.allowedEmails,
        allowedDomains: Array.isArray(oidcInput.allowedDomains) ? oidcInput.allowedDomains : existing.oidc.allowedDomains,
      },
    });
    if (next.mode === 'trusted-proxy' && !next.trustedProxy.allowedProxies.length) return { ok: false, status: 400, error: 'trusted_proxy_allowed_proxies_required' };
    if (next.mode === 'basic' && (!next.basic.username || !next.basic.passwordHash)) return { ok: false, status: 400, error: 'basic_username_password_required' };
    const replacementSecret = oidcInput.clientSecret !== undefined && String(oidcInput.clientSecret || '').trim() ? String(oidcInput.clientSecret) : null;
    next.oidc.clientSecretConfigured = Boolean(next.oidc.clientSecretConfigured || replacementSecret);
    if (next.mode === 'oidc' && (!next.oidc.issuer || !next.oidc.clientId || !next.oidc.clientSecretConfigured)) return { ok: false, status: 400, error: 'oidc_issuer_client_secret_required' };
    return { ok: true, next, replacementSecret };
}

export function createUiAuthService({ metadataStore, uiAuthSecretStore, runtimeConfig }) {
async function readUiAuthRecord() {
  const record = normalizeUiAuthRecord(await metadataStore().get('ui_auth') || {});
  record.oidc.clientSecretConfigured = Boolean(record.oidc.clientSecretConfigured || await uiAuthSecretStore().has('oidcClientSecret'));
  return record;
}

async function uiAuthSettings() {
  const runtime = await runtimeConfig();
  return { ok: true, auth: safeUiAuthSettings(await readUiAuthRecord()), effective: { mode: runtime.ui.authMode, enabled: runtime.ui.authEnabled, source: runtime.ui.authSource } };
}

async function saveUiAuthSettings(body = {}) {
  try {
    const plan = planUiAuthSettings(body, await readUiAuthRecord());
    if (!plan.ok) return plan;
    const { next, replacementSecret } = plan;
    const stored = normalizeUiAuthRecord(next);
    stored.oidc.clientSecret = '';
    stored.oidc.clientSecretConfigured = next.oidc.clientSecretConfigured;
    const metadata = metadataStore();
    const secrets = uiAuthSecretStore();
    await withPostgresTransaction(metadata.pool, async (client) => {
      const pool = postgresTransactionContext(client);
      // Borrow one context without losing store configuration or injected failures.
      const transactionalMetadata = Object.assign(Object.create(Object.getPrototypeOf(metadata)), metadata, { pool });
      const transactionalSecrets = Object.assign(Object.create(Object.getPrototypeOf(secrets)), secrets, { pool });
      if (replacementSecret) await transactionalSecrets.set('oidcClientSecret', replacementSecret);
      await transactionalMetadata.set('ui_auth', stored);
    });
    const runtime = await runtimeConfig();
    return { ok: true, auth: safeUiAuthSettings(next), effective: { mode: runtime.ui.authMode, enabled: runtime.ui.authEnabled, source: runtime.ui.authSource } };
  } catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; }
}

  return { readUiAuthRecord, uiAuthSettings, saveUiAuthSettings };
}

export function basicCredentials(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.toLowerCase().startsWith('basic ')) return null;
  const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

export function parseCookieHeader(header = '') {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return cookies;
}

function basicSessionSignature(payload, passwordHash) {
  return createHmac('sha256', `burrow-basic-session:${String(passwordHash || '')}`).update(payload).digest('base64url');
}

export function signBasicSession({ username, passwordHash, ttlSeconds }) {
  const expiresAt = Date.now() + Math.max(60, Number(ttlSeconds) || 0) * 1000;
  const payload = Buffer.from(JSON.stringify({ username, expiresAt }), 'utf8').toString('base64url');
  return `${payload}.${basicSessionSignature(payload, passwordHash)}`;
}

export function verifyBasicSessionCookie(value, auth, nowMs = Date.now()) {
  const [payload, signature] = String(value || '').split('.');
  if (!payload || !signature || !auth?.basic?.passwordHash || !auth.basic.username) return null;
  const expected = basicSessionSignature(payload, auth.basic.passwordHash);
  const actual = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length || !timingSafeEqual(actual, expectedBuffer)) return null;
  let decoded = null;
  try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (decoded?.username !== auth.basic.username) return null;
  if (!Number.isFinite(Number(decoded.expiresAt)) || Number(decoded.expiresAt) <= nowMs) return null;
  return { username: decoded.username, expiresAt: new Date(Number(decoded.expiresAt)).toISOString() };
}

export function setBasicSessionCookie(res, auth) {
  const ttlSeconds = Math.max(60, Number(auth.basic?.sessionTtlSeconds) || 12 * 60 * 60);
  const cookie = signBasicSession({ username: auth.basic.username, passwordHash: auth.basic.passwordHash, ttlSeconds });
  res.setHeader('set-cookie', `${BASIC_SESSION_COOKIE}=${encodeURIComponent(cookie)}; HttpOnly;${auth.basic?.insecureCookies === true ? '' : ' Secure;'} SameSite=Lax; Path=/; Max-Age=${ttlSeconds}`);
}

export function verifyScryptPassword(password, encoded) {
  const parts = String(encoded || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost < 2 ** 12 || cost > 2 ** 20) return false;
  const salt = Buffer.from(parts[2], 'base64url');
  const expected = Buffer.from(parts[3], 'base64url');
  if (!salt.length || !expected.length) return false;
  const actual = scryptSync(String(password || ''), salt, expected.length, { N: cost });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
