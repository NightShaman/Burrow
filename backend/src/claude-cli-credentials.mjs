import fs from 'node:fs';
import path from 'node:path';
import { execSync as defaultExecSync } from 'node:child_process';

const CLAUDE_CREDENTIALS_RELATIVE_PATH = '.claude/.credentials.json';
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

function homeDir(options = {}) {
  return options.homeDir || process.env.HOME || process.env.USERPROFILE || '';
}

export function claudeCredentialsPath(options = {}) {
  return path.join(homeDir(options), CLAUDE_CREDENTIALS_RELATIVE_PATH);
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function normalizeOauth(raw, { source = 'claude-code-file' } = {}) {
  const oauth = raw?.claudeAiOauth && typeof raw.claudeAiOauth === 'object' ? raw.claudeAiOauth : raw;
  if (!oauth || typeof oauth !== 'object') return null;
  const accessToken = String(oauth.accessToken || oauth.access || oauth.token || '').trim();
  const refreshToken = String(oauth.refreshToken || oauth.refresh || '').trim();
  const expiresAt = Number(oauth.expiresAt || oauth.expires || 0);
  if (!accessToken || !Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  return {
    type: refreshToken ? 'oauth' : 'token',
    provider: 'anthropic',
    source,
    accessToken,
    refreshToken: refreshToken || undefined,
    expiresAt,
  };
}

function readClaudeFileCredential(options = {}) {
  const filePath = claudeCredentialsPath(options);
  try {
    const raw = parseJson(fs.readFileSync(filePath, 'utf8'));
    return normalizeOauth(raw, { source: 'claude-code-file' });
  } catch {
    return null;
  }
}

function readClaudeKeychainCredential(options = {}) {
  if ((options.platform || process.platform) !== 'darwin' || options.allowKeychainPrompt === false) return null;
  const execSync = options.execSync || defaultExecSync;
  try {
    const result = execSync(`security find-generic-password -s "${CLAUDE_KEYCHAIN_SERVICE}" -w`, {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return normalizeOauth(parseJson(String(result).trim()), { source: 'claude-code-keychain' });
  } catch {
    return null;
  }
}

export function readClaudeCliCredential(options = {}) {
  return readClaudeKeychainCredential(options) || readClaudeFileCredential(options);
}

function credentialStatus(credential, nowMs = Date.now()) {
  if (!credential) return 'missing';
  if (credential.expiresAt <= nowMs) return 'expired';
  if (credential.expiresAt <= nowMs + 60_000) return 'expiring';
  return 'fresh';
}

export function detectClaudeCliCredential(options = {}) {
  const credential = readClaudeCliCredential(options);
  const filePath = claudeCredentialsPath(options);
  const fileExists = fs.existsSync(filePath);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  return {
    ok: Boolean(credential),
    provider: 'anthropic',
    source: credential?.source || (fileExists ? 'claude-code-file' : null),
    credentialPath: fileExists ? filePath : null,
    type: credential?.type || null,
    status: credentialStatus(credential, nowMs),
    hasAccessToken: Boolean(credential?.accessToken),
    hasRefreshToken: Boolean(credential?.refreshToken),
    expiresAt: credential?.expiresAt || null,
  };
}

export function claudeCredentialAuthPayload(options = {}) {
  const credential = readClaudeCliCredential(options);
  if (!credential) throw new Error('claude_cli_credentials_not_found');
  if (credential.type !== 'oauth' || !credential.refreshToken) throw new Error('claude_cli_refresh_token_required');
  return {
    type: 'oauth',
    provider: 'anthropic',
    source: credential.source || 'claude-code-import',
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAt: credential.expiresAt,
  };
}
