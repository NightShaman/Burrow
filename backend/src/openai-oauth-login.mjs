import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const OPENAI_OAUTH_PROVIDER = 'openai';
export const OPENAI_OAUTH_SOURCE = 'openai-oauth';
export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_CALLBACK_HOST = 'localhost';
const DEFAULT_CALLBACK_PORT = 1455;
const DEFAULT_CALLBACK_PATH = '/auth/callback';
const DEFAULT_SCOPE = 'openid profile email offline_access';
const DEFAULT_TTL_MS = 10 * 60_000;
const sessions = new Map();
const SESSION_RETENTION_GRACE_MS = 60_000;

function sessionExpired(session, nowMs = Date.now()) {
  return Date.parse(session?.expiresAt || '') + SESSION_RETENTION_GRACE_MS < nowMs;
}

function pruneSessions(nowMs = Date.now()) {
  for (const [id, session] of sessions) {
    if (!sessionExpired(session, nowMs)) continue;
    clearTimeout(session.timer);
    try { session.server?.close?.(); } catch {}
    if (session.child?.exitCode === null) session.child?.kill?.('SIGTERM');
    sessions.delete(id);
  }
}


function now() { return new Date().toISOString(); }
function normalize(value) { return String(value ?? '').trim(); }
function base64url(buffer) { return Buffer.from(buffer).toString('base64url'); }
function safeId() { return `openai-oauth-${Date.now()}-${randomUUID().slice(0, 8)}`; }
function sha256(value) { return createHash('sha256').update(value).digest(); }
function createVerifier() { return base64url(randomBytes(32)); }
function createChallenge(verifier) { return base64url(sha256(verifier)); }
function createState() { return randomBytes(16).toString('hex'); }

function decodeJwtPayload(token = '') {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try { const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); return parsed && typeof parsed === 'object' ? parsed : null; }
  catch { return null; }
}

export function openaiOAuthIdentity(accessToken = '') {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.['https://api.openai.com/auth'];
  const profile = payload?.['https://api.openai.com/profile'];
  return {
    ...(normalize(auth?.chatgpt_account_id) ? { accountId: normalize(auth.chatgpt_account_id) } : {}),
    ...(normalize(auth?.chatgpt_plan_type) ? { planType: normalize(auth.chatgpt_plan_type) } : {}),
    ...(normalize(profile?.email) ? { email: normalize(profile.email) } : {}),
  };
}

function callbackHost(env = process.env) {
  const host = normalize(env.BURROW_OPENAI_OAUTH_CALLBACK_HOST || env.OPENCLAW_OAUTH_CALLBACK_HOST || DEFAULT_CALLBACK_HOST);
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('openai_oauth_callback_host_invalid');
  return host;
}

function redirectUri({ host = callbackHost(), port = DEFAULT_CALLBACK_PORT, path = DEFAULT_CALLBACK_PATH } = {}) {
  const url = new URL(`http://${host === '::1' ? '[::1]' : host}:${Number(port) || DEFAULT_CALLBACK_PORT}`);
  url.pathname = path || DEFAULT_CALLBACK_PATH;
  return url.toString();
}

function parseAuthorizationInput(input = '') {
  const value = normalize(input);
  if (!value) throw new Error('openai_oauth_code_required');
  try {
    const url = new URL(value);
    const code = normalize(url.searchParams.get('code'));
    const state = normalize(url.searchParams.get('state'));
    if (!code) throw new Error('openai_oauth_code_required');
    return { code, state };
  } catch (error) {
    if (String(error?.message || error) === 'openai_oauth_code_required') throw error;
    return { code: value, state: '' };
  }
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    status: session.status,
    authorizationUrl: session.authorizationUrl,
    connectionId: session.connectionId || null,
    redirectUri: session.redirectUri,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    error: session.error || null,
    credential: session.credential ? { configured: true, type: 'oauth', provider: OPENAI_OAUTH_PROVIDER, source: OPENAI_OAUTH_SOURCE, expiresAt: session.credential.expiresAt, accountId: session.credential.accountId || null, email: session.credential.email || null } : null,
    connection: session.connection || null,
  };
}

function authPayloadFromTokenJson(json = {}, nowMs = Date.now()) {
  const accessToken = normalize(json.access_token || json.accessToken || json.access);
  const refreshToken = normalize(json.refresh_token || json.refreshToken || json.refresh);
  const expiresIn = Number(json.expires_in ?? json.expiresIn ?? 0);
  const expiresAt = Number(json.expires_at ?? json.expiresAt ?? json.expires) || (expiresIn > 0 ? nowMs + expiresIn * 1000 : 0);
  if (!accessToken) throw new Error('openai_oauth_access_token_required');
  if (!refreshToken) throw new Error('openai_oauth_refresh_token_required');
  if (!expiresAt) throw new Error('openai_oauth_expires_at_required');
  const identity = openaiOAuthIdentity(accessToken);
  return { type: 'oauth', provider: OPENAI_OAUTH_PROVIDER, source: OPENAI_OAUTH_SOURCE, accessToken, refreshToken, expiresAt, ...identity };
}

export async function exchangeOpenAiOAuthCode({ code, verifier, redirectUri: callbackRedirectUri, tokenUrl = OPENAI_OAUTH_TOKEN_URL, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  if (!normalize(code)) throw new Error('openai_oauth_code_required');
  if (!normalize(verifier)) throw new Error('openai_oauth_verifier_required');
  const response = await fetchImpl(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: OPENAI_OAUTH_CLIENT_ID, code: normalize(code), code_verifier: normalize(verifier), redirect_uri: normalize(callbackRedirectUri) || redirectUri() }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`openai_oauth_exchange_failed:${response.status}`);
  return authPayloadFromTokenJson(data, nowMs);
}

export async function refreshOpenAiOAuth(auth = {}, { tokenUrl = OPENAI_OAUTH_TOKEN_URL, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const refreshToken = normalize(auth.refreshToken || auth.refresh);
  if (!refreshToken) throw new Error('model_auth_refresh_token_required');
  const response = await fetchImpl(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: OPENAI_OAUTH_CLIENT_ID, refresh_token: refreshToken }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`model_auth_refresh_failed:${response.status}`);
  return { ...auth, ...authPayloadFromTokenJson(data, nowMs), provider: auth.provider || OPENAI_OAUTH_PROVIDER, source: auth.source || OPENAI_OAUTH_SOURCE };
}

async function completeSession(session, code, { persistAuth, fetchImpl = fetch, tokenUrl = OPENAI_OAUTH_TOKEN_URL, nowMs = Date.now() } = {}) {
  if (!session || !['waiting_for_callback', 'waiting_for_code', 'starting'].includes(session.status)) return session;
  session.status = 'exchanging'; session.updatedAt = now();
  try {
    const auth = await exchangeOpenAiOAuthCode({ code, verifier: session.verifier, redirectUri: session.redirectUri, tokenUrl, fetchImpl, nowMs });
    session.credential = auth;
    if (typeof persistAuth === 'function' && session.connectionId) session.connection = persistAuth(auth);
    session.status = 'authorized';
  } catch (error) {
    session.status = 'failed';
    session.error = String(error?.message || error);
  } finally {
    session.updatedAt = now();
    try { session.server?.close?.(); } catch {}
  }
  return session;
}

function startCallbackServer(session, options = {}) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== session.callbackPath) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
      const state = normalize(url.searchParams.get('state'));
      const code = normalize(url.searchParams.get('code'));
      if (state !== session.state) { res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }); res.end('<h1>OpenAI OAuth failed</h1><p>State mismatch.</p>'); return; }
      if (!code) { res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }); res.end('<h1>OpenAI OAuth failed</h1><p>Missing authorization code.</p>'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<h1>OpenAI OAuth complete</h1><p>You can close this window.</p>');
      void completeSession(session, code, options);
    });
    server.listen(session.callbackPort, session.callbackHost, () => resolve(server));
    server.on('error', () => resolve(null));
  });
}

export async function startOpenAiOAuthLogin({ connectionId = '', persistAuth, ttlMs = DEFAULT_TTL_MS, fetchImpl = fetch, tokenUrl = OPENAI_OAUTH_TOKEN_URL, callbackPort = DEFAULT_CALLBACK_PORT, callbackPath = DEFAULT_CALLBACK_PATH, host = callbackHost() } = {}) {
  pruneSessions();
  const id = safeId();
  const verifier = createVerifier();
  const state = createState();
  const challenge = createChallenge(verifier);
  const callbackRedirectUri = redirectUri({ host, port: callbackPort, path: callbackPath });
  const url = new URL(OPENAI_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OPENAI_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', callbackRedirectUri);
  url.searchParams.set('scope', DEFAULT_SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'burrow');
  const session = { id, connectionId: normalize(connectionId), status: 'starting', createdAt: now(), updatedAt: now(), expiresAt: new Date(Date.now() + Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS)).toISOString(), verifier, state, redirectUri: callbackRedirectUri, authorizationUrl: url.toString(), callbackHost: host, callbackPort, callbackPath, credential: null, connection: null, error: null, server: null };
  sessions.set(id, session);
  session.server = await startCallbackServer(session, { persistAuth, fetchImpl, tokenUrl });
  session.status = session.server ? 'waiting_for_callback' : 'waiting_for_code';
  session.updatedAt = now();
  const timer = setTimeout(() => cancelOpenAiOAuthLogin({ id, reason: 'expired' }), Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS));
  timer.unref?.();
  session.timer = timer;
  return publicSession(session);
}

export function getOpenAiOAuthLogin({ id } = {}) { pruneSessions(); return publicSession(sessions.get(String(id || ''))); }

export async function submitOpenAiOAuthCode({ id, input, persistAuth, fetchImpl = fetch, tokenUrl = OPENAI_OAUTH_TOKEN_URL } = {}) {
  pruneSessions();
  const session = sessions.get(String(id || ''));
  if (!session) return { ok: false, status: 404, error: 'openai_oauth_login_not_found' };
  if (!['waiting_for_callback', 'waiting_for_code', 'starting'].includes(session.status)) return { ok: false, status: 409, error: `openai_oauth_login_${session.status}` };
  const parsed = parseAuthorizationInput(input);
  if (parsed.state && parsed.state !== session.state) return { ok: false, status: 400, error: 'openai_oauth_state_mismatch' };
  await completeSession(session, parsed.code, { persistAuth, fetchImpl, tokenUrl });
  return { ok: session.status === 'authorized', status: session.status === 'authorized' ? 200 : 400, login: publicSession(session), ...(session.status === 'authorized' ? {} : { error: session.error || 'openai_oauth_exchange_failed' }) };
}

export async function cancelOpenAiOAuthLogin({ id, reason = 'cancelled' } = {}) {
  pruneSessions();
  const session = sessions.get(String(id || ''));
  if (!session) return { ok: false, status: 404, error: 'openai_oauth_login_not_found' };
  clearTimeout(session.timer);
  try { session.server?.close?.(); } catch {}
  if (!['authorized', 'failed'].includes(session.status)) { session.status = reason === 'expired' ? 'expired' : 'cancelled'; session.error = reason === 'expired' ? 'openai_oauth_login_expired' : null; session.updatedAt = now(); }
  return { ok: true, login: publicSession(session) };
}

export const __test__ = { sessions, parseAuthorizationInput, redirectUri, createChallenge, completeSession, pruneSessions };
