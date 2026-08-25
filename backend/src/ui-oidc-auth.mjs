import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'burrow_oidc_session';
const STATE_COOKIE_NAME = 'burrow_oidc_state';
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;
const discoveryCache = new Map();
const DISCOVERY_SUCCESS_CACHE_MS = 5 * 60_000;
const DISCOVERY_FAILURE_CACHE_MS = 30_000;

function base64url(buffer) { return Buffer.from(buffer).toString('base64url'); }
function jsonBase64(value) { return base64url(JSON.stringify(value)); }
function parseJsonBase64(value) { return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8')); }
function text(value) { return String(value ?? '').trim(); }

export function oidcSecureCookies(runtime = null) {
  // Direct HTTP localhost development must opt out deliberately. Never infer
  // browser-facing transport from forwarded headers.
  return runtime?.ui?.oidc?.insecureCookies !== true;
}
function cookieOptions({ maxAge = null, httpOnly = true, secure = true } = {}) {
  return [`Path=/`, httpOnly ? 'HttpOnly' : '', secure ? 'Secure' : '', 'SameSite=Lax', maxAge === null ? '' : `Max-Age=${Math.max(0, Math.floor(maxAge))}`].filter(Boolean).join('; ');
}
export function oidcCookieClearHeader(runtime = null) { return `${STATE_COOKIE_NAME}=; ${cookieOptions({ maxAge: 0, secure: oidcSecureCookies(runtime) })}`; }

export function parseCookies(header = '') {
  const out = new Map();
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return out;
}

function sign(payload, secret) {
  return base64url(createHmac('sha256', secret).update(payload).digest());
}

export function signSessionCookie(session, secret) {
  const payload = jsonBase64(session);
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionCookie(value, secret, nowMs = Date.now()) {
  const [payload, signature] = String(value || '').split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const session = parseJsonBase64(payload);
  if (!session?.subject || !session?.expiresAt || Date.parse(session.expiresAt) <= nowMs) return null;
  return session;
}

export function sessionSecret(runtime) {
  const secret = runtime?.ui?.oidc?.clientSecret || process.env.BURROW_SETTINGS_KEY;
  if (!secret) throw new Error('oidc_session_secret_required');
  return secret;
}

export function clearOidcCookies(res, runtime = null) {
  res.setHeader('set-cookie', [
    `${COOKIE_NAME}=; ${cookieOptions({ maxAge: 0, secure: oidcSecureCookies(runtime) })}`,
    `${STATE_COOKIE_NAME}=; ${cookieOptions({ maxAge: 0, secure: oidcSecureCookies(runtime) })}`,
  ]);
}

export function oidcSessionFromRequest(req, runtime) {
  const cookies = parseCookies(req.headers.cookie || '');
  const cookie = cookies.get(COOKIE_NAME);
  if (!cookie) return null;
  return verifySessionCookie(cookie, sessionSecret(runtime));
}

export function sendOidcSessionCookie(res, session, runtime) {
  res.setHeader('set-cookie', `${COOKIE_NAME}=${encodeURIComponent(signSessionCookie(session, sessionSecret(runtime)))}; ${cookieOptions({ maxAge: DEFAULT_TTL_SECONDS, secure: oidcSecureCookies(runtime) })}`);
}

export async function oidcDiscovery(issuer) {
  const normalized = text(issuer).replace(/\/+$/, '');
  if (!normalized) throw new Error('oidc_issuer_required');
  const cached = discoveryCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.error) throw new Error(cached.error);
    return cached.value;
  }
  try {
    const response = await fetch(`${normalized}/.well-known/openid-configuration`);
    if (!response.ok) throw new Error(`oidc_discovery_failed:${response.status}`);
    const value = await response.json();
    discoveryCache.set(normalized, { value, expiresAt: Date.now() + DISCOVERY_SUCCESS_CACHE_MS });
    return value;
  } catch (error) {
    const message = String(error?.message || error);
    discoveryCache.set(normalized, { error: message, expiresAt: Date.now() + DISCOVERY_FAILURE_CACHE_MS });
    throw new Error(message);
  }
}

export async function oidcLoginUrl(runtime, origin) {
  const oidc = runtime.ui.oidc || {};
  const discovery = await oidcDiscovery(oidc.issuer);
  const state = base64url(randomBytes(24));
  const nonce = base64url(randomBytes(24));
  const redirectUri = oidc.redirectUri || `${origin}/auth/oidc/callback`;
  const params = new URLSearchParams({
    client_id: oidc.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: (oidc.scopes?.length ? oidc.scopes : ['openid', 'email', 'profile']).join(' '),
    state,
    nonce,
  });
  return { url: `${discovery.authorization_endpoint}?${params}`, state, nonce, redirectUri };
}

function safeReturnTo(value = '/') {
  const path = text(value) || '/';
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) return '/';
  return path;
}

export function setOidcStateCookie(res, state, nonce, returnTo = '/', runtime = null) {
  res.setHeader('set-cookie', `${STATE_COOKIE_NAME}=${encodeURIComponent(jsonBase64({ state, nonce, returnTo: safeReturnTo(returnTo), createdAt: new Date().toISOString() }))}; ${cookieOptions({ maxAge: 600, secure: oidcSecureCookies(runtime) })}`);
}

export const __test__ = { discoveryCache, cookieName: COOKIE_NAME };

export async function completeOidcCallback(req, url, runtime, origin) {
  const oidc = runtime.ui.oidc || {};
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new Error('oidc_callback_missing_code_or_state');
  const cookies = parseCookies(req.headers.cookie || '');
  const saved = parseJsonBase64(cookies.get(STATE_COOKIE_NAME));
  if (!saved?.state || saved.state !== state || !saved?.nonce) throw new Error('oidc_state_invalid');
  const discovery = await oidcDiscovery(oidc.issuer);
  const redirectUri = oidc.redirectUri || `${origin}/auth/oidc/callback`;
  const basic = Buffer.from(`${oidc.clientId}:${oidc.clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const tokenResponse = await fetch(discovery.token_endpoint, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!tokenResponse.ok) throw new Error(`oidc_token_exchange_failed:${tokenResponse.status}`);
  const tokens = await tokenResponse.json();
  if (!tokens.id_token) throw new Error('oidc_id_token_missing');
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  const verified = await jwtVerify(tokens.id_token, jwks, { issuer: text(oidc.issuer).replace(/\/+$/, ''), audience: oidc.clientId });
  if (verified.payload.nonce !== saved.nonce) throw new Error('oidc_nonce_invalid');
  const email = text(verified.payload.email).toLowerCase();
  const allowedEmails = (oidc.allowedEmails || []).map((item) => text(item).toLowerCase()).filter(Boolean);
  const allowedDomains = (oidc.allowedDomains || []).map((item) => text(item).toLowerCase()).filter(Boolean);
  if (allowedEmails.length && !allowedEmails.includes(email)) throw new Error('oidc_email_not_allowed');
  const domain = email.includes('@') ? email.split('@').pop() : '';
  if (allowedDomains.length && !allowedDomains.includes(domain)) throw new Error('oidc_domain_not_allowed');
  const expiresAt = new Date(Math.min((verified.payload.exp || 0) * 1000 || Date.now() + DEFAULT_TTL_SECONDS * 1000, Date.now() + DEFAULT_TTL_SECONDS * 1000)).toISOString();
  return { subject: text(verified.payload.sub), email, name: text(verified.payload.name || verified.payload.preferred_username || email), expiresAt, returnTo: safeReturnTo(saved.returnTo) };
}

export const OIDC_COOKIE_NAME = COOKIE_NAME;
