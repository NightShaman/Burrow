import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCredentialAuthPayload, detectClaudeCliCredential } from './claude-cli-credentials.mjs';

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_CAPTURE_BYTES = 64 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 3_000;
const LOGIN_URL_RE = /https:\/\/[^\s]+/;
const CODE_PROMPT_RE = /Paste code here if prompted\s*>/i;
const sessions = new Map();
const SESSION_RETENTION_GRACE_MS = 60_000;

function sessionExpired(session, nowMs = Date.now()) {
  return Date.parse(session?.expiresAt || '') + SESSION_RETENTION_GRACE_MS < nowMs;
}

function cleanupSessionScratch(session) {
  const target = session?.sessionDir || session?.homeDir;
  if (!target) return;
  fs.rm(target, { recursive: true, force: true }).catch(() => {});
}

function pruneSessions(nowMs = Date.now()) {
  for (const [id, session] of sessions) {
    if (!sessionExpired(session, nowMs)) continue;
    clearTimeout(session.timer);
    try { session.server?.close?.(); } catch {}
    if (session.child?.exitCode === null) session.child?.kill?.('SIGTERM');
    cleanupSessionScratch(session);
    sessions.delete(id);
  }
}


function now() { return new Date().toISOString(); }
function safeId() { return `claude-login-${Date.now()}-${randomUUID().slice(0, 8)}`; }
function appendTail(state, chunk, limit = DEFAULT_CAPTURE_BYTES) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  state.originalBytes += buffer.length;
  state.chunks.push(buffer);
  state.capturedBytes += buffer.length;
  while (state.capturedBytes > limit && state.chunks.length) {
    const overflow = state.capturedBytes - limit;
    const first = state.chunks[0];
    if (first.length <= overflow) { state.chunks.shift(); state.capturedBytes -= first.length; }
    else { state.chunks[0] = first.subarray(overflow); state.capturedBytes -= overflow; }
  }
}
function rendered(state) { return Buffer.concat(state.chunks).toString('utf8'); }
function redactedLoginText(text = '') { return String(text || '').replace(/(code=)[^&\s]+/g, '$1[redacted]').replace(/(code_challenge=)[^&\s]+/g, '$1[redacted]').replace(/(state=)[^&\s]+/g, '$1[redacted]'); }


function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForReady(session, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || DEFAULT_READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (session.verificationUrl || ['failed', 'authorized', 'cancelled', 'expired'].includes(session.status)) break;
    await sleep(20);
  }
  return session;
}

async function fileExecutable(filePath) {
  try { await fs.access(filePath, fs.constants?.X_OK ?? 1); return true; } catch { return false; }
}

async function resolveClaudeBin(value = null) {
  const explicit = String(value || process.env.BURROW_CLAUDE_BIN || '').trim();
  if (explicit) return explicit;
  const releaseLocal = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', 'claude');
  for (const candidate of [releaseLocal, '/home/openclaw/.npm-global/bin/claude', '/usr/local/bin/claude', '/opt/homebrew/bin/claude', '/usr/bin/claude']) {
    if (await fileExecutable(candidate)) return candidate;
  }
  return 'claude';
}

function integrationRoot({ runtimeRoot } = {}) {
  const root = runtimeRoot || process.env.BURROW_RUNTIME_ROOT || process.cwd();
  return path.join(path.resolve(root), 'integrations', 'claude-code-auth');
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    status: session.status,
    verificationUrl: session.verificationUrl || null,
    prompt: session.prompt || null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    exitCode: session.exitCode ?? null,
    signal: session.signal ?? null,
    error: session.error || null,
    credential: session.credential || null,
    connection: session.connection || null,
  };
}

async function cleanupSessionScratchAwait(session) {
  const target = session?.sessionDir || session?.homeDir;
  if (!target) return;
  try { await fs.rm(target, { recursive: true, force: true }); } catch {}
}

function settle(session, patch = {}) {
  Object.assign(session, patch, { updatedAt: now() });
  return session;
}

export async function startClaudeCodeLogin({ runtimeRoot, claudeBin = null, ttlMs = DEFAULT_TTL_MS, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  pruneSessions();
  const id = safeId();
  const root = integrationRoot({ runtimeRoot });
  const sessionDir = path.join(root, 'sessions', id);
  const homeDir = path.join(sessionDir, 'home');
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 });
  const session = {
    id, status: 'starting', createdAt: now(), updatedAt: now(), expiresAt: new Date(Date.now() + Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS)).toISOString(),
    root, sessionDir, homeDir, verificationUrl: null, prompt: null, stdout: { chunks: [], originalBytes: 0, capturedBytes: 0 }, stderr: { chunks: [], originalBytes: 0, capturedBytes: 0 },
    child: null, exitCode: null, signal: null, error: null, credential: null, connection: null,
  };
  const resolvedClaudeBin = await resolveClaudeBin(claudeBin);
  session.claudeBin = resolvedClaudeBin;
  const child = spawnImpl(resolvedClaudeBin, ['auth', 'login', '--claudeai'], { env: { ...process.env, HOME: homeDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  session.child = child;
  sessions.set(id, session);
  const timer = setTimeout(() => cancelClaudeCodeLogin({ id, reason: 'expired' }), Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS));
  timer.unref?.();
  session.timer = timer;
  const onData = (streamName, chunk) => {
    appendTail(session[streamName], chunk);
    const combined = `${rendered(session.stdout)}\n${rendered(session.stderr)}`;
    const url = combined.match(LOGIN_URL_RE)?.[0] || null;
    if (url && !session.verificationUrl) session.verificationUrl = url;
    if (CODE_PROMPT_RE.test(combined) || url) {
      session.prompt = 'Paste code here if prompted';
      if (session.status === 'starting') session.status = 'waiting_for_code';
    }
    session.updatedAt = now();
  };
  child.stdout.on('data', (chunk) => onData('stdout', chunk));
  child.stderr.on('data', (chunk) => onData('stderr', chunk));
  child.once('error', (error) => {
    clearTimeout(timer);
    settle(session, { status: 'failed', error: String(error?.message || error) });
    cleanupSessionScratch(session);
  });
  child.once('close', async (code, signal) => {
    clearTimeout(timer);
    session.exitCode = code;
    session.signal = signal;
    const credential = detectClaudeCliCredential({ homeDir, allowKeychainPrompt: false });
    if (code === 0 && credential.ok) settle(session, { status: 'authorized', credential });
    else if (!['cancelled', 'expired', 'failed'].includes(session.status)) {
      settle(session, { status: 'failed', error: code === 0 ? 'claude_code_credentials_not_found' : `claude_auth_exit_${code ?? signal ?? 'unknown'}` });
      cleanupSessionScratch(session);
    }
  });
  await waitForReady(session, readyTimeoutMs);
  return publicSession(session);
}

export function getClaudeCodeLogin({ id } = {}) {
  pruneSessions();
  const session = sessions.get(String(id || ''));
  return publicSession(session);
}

export function submitClaudeCodeLoginCode({ id, code } = {}) {
  pruneSessions();
  const session = sessions.get(String(id || ''));
  if (!session) return { ok: false, status: 404, error: 'claude_code_login_not_found' };
  if (!['starting', 'waiting_for_code'].includes(session.status)) return { ok: false, status: 409, error: `claude_code_login_${session.status}` };
  const value = String(code || '').trim();
  if (!value) return { ok: false, status: 400, error: 'claude_code_login_code_required' };
  session.child?.stdin?.write(`${value}\n`);
  settle(session, { status: 'code_submitted' });
  return { ok: true, login: publicSession(session) };
}

export async function cancelClaudeCodeLogin({ id, reason = 'cancelled' } = {}) {
  pruneSessions();
  const session = sessions.get(String(id || ''));
  if (!session) return { ok: false, status: 404, error: 'claude_code_login_not_found' };
  if (['authorized', 'failed', 'cancelled', 'expired'].includes(session.status)) return { ok: true, login: publicSession(session) };
  clearTimeout(session.timer);
  settle(session, { status: reason === 'expired' ? 'expired' : 'cancelled', error: reason === 'expired' ? 'claude_code_login_expired' : null });
  session.child?.kill?.('SIGTERM');
  setTimeout(() => { if (session.child?.exitCode === null) session.child?.kill?.('SIGKILL'); }, 1000).unref?.();
  await cleanupSessionScratchAwait(session);
  return { ok: true, login: publicSession(session) };
}

export async function importClaudeCodeLoginCredential({ id, persistAuth } = {}) {
  pruneSessions();
  const session = sessions.get(String(id || ''));
  if (!session) return { ok: false, status: 404, error: 'claude_code_login_not_found' };
  if (session.status !== 'authorized') return { ok: false, status: 409, error: `claude_code_login_${session.status}` };
  if (typeof persistAuth !== 'function') return { ok: false, status: 500, error: 'claude_code_login_persist_unavailable' };
  const auth = claudeCredentialAuthPayload({ homeDir: session.homeDir, allowKeychainPrompt: false });
  const connection = persistAuth({ ...auth, source: 'claude-code-login' });
  settle(session, { status: 'imported', connection, credential: detectClaudeCliCredential({ homeDir: session.homeDir, allowKeychainPrompt: false }) });
  await cleanupSessionScratchAwait(session);
  return { ok: true, login: publicSession(session), connection };
}

export const __test__ = { redactedLoginText, integrationRoot, resolveClaudeBin, sessions, waitForReady, pruneSessions };
