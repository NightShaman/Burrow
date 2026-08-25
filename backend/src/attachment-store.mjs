import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentRegistryStore } from './agent-registry.mjs';

export const ATTACHMENT_RETENTION_DAYS = 30;
const MAX_NAME_LENGTH = 160;

function text(value) { return String(value ?? '').trim(); }
function safeName(value, fallback = 'attachment') {
  const base = path.basename(text(value) || fallback).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME_LENGTH);
  return base || fallback;
}
function dataBytes(content) {
  const value = String(content || '');
  if (!value.startsWith('data:')) return Buffer.from(value, 'utf8');
  const comma = value.indexOf(',');
  if (comma < 0) return Buffer.from(value, 'utf8');
  const header = value.slice(0, comma).toLowerCase();
  const payload = value.slice(comma + 1);
  return header.includes(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
}
function attachmentRoot(agentWorkspaceRoot) { return path.resolve(agentWorkspaceRoot, 'artifacts', 'attachments'); }
function contained(root, candidate) { const relative = path.relative(root, candidate); return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); }
async function resolveRegularFileWithoutSymlinks(root, filePath) {
  const parts = path.relative(root, filePath).split(path.sep);
  let current = root;
  try {
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return null;
      if (index < parts.length - 1 && !stat.isDirectory()) return null;
      if (index === parts.length - 1) return stat.isFile() ? { filePath, stat } : null;
    }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)) return null;
    throw error;
  }
  return null;
}

export async function listSessionAttachments({ agentWorkspaceRoot, sessionTurns = [], sessionId = null, limit = 200 } = {}) {
  if (!agentWorkspaceRoot) throw new Error('attachment_workspace_required');
  const root = path.resolve(agentWorkspaceRoot);
  const seen = new Set();
  const attachments = [];
  for (const turn of sessionTurns) for (const item of turn?.metadata?.attachments || []) {
    const artifactPath = text(item?.artifactPath);
    if (!artifactPath || seen.has(artifactPath)) continue;
    const filePath = path.resolve(root, artifactPath);
    if (!contained(root, filePath) || !filePath.startsWith(`${attachmentRoot(root)}${path.sep}`)) continue;
    seen.add(artifactPath);
    const resolved = await resolveRegularFileWithoutSymlinks(root, filePath);
    if (!resolved) continue;
    const { stat } = resolved;
    attachments.push({ id: artifactPath, name: safeName(item.name), type: text(item.type || item.mimeType) || 'application/octet-stream', size: stat.size, storedAt: item.storedAt || stat.mtime.toISOString(), sessionId: sessionId || turn.sessionId || null, artifactPath });
  }
  return attachments.slice(-Math.max(1, Math.min(Number(limit) || 200, 500)));
}

export async function resolveAttachmentArtifact({ agentWorkspaceRoot, artifactPath } = {}) {
  if (!agentWorkspaceRoot || !artifactPath) return null;
  const root = path.resolve(agentWorkspaceRoot);
  const filePath = path.resolve(root, String(artifactPath));
  if (!contained(root, filePath) || !filePath.startsWith(`${attachmentRoot(root)}${path.sep}`)) return null;
  return resolveRegularFileWithoutSymlinks(root, filePath);
}

export async function deleteAttachmentArtifact({ agentWorkspaceRoot, artifactPath } = {}) {
  const resolved = await resolveAttachmentArtifact({ agentWorkspaceRoot, artifactPath });
  if (!resolved) return { ok: false, error: 'attachment_not_found' };
  await fs.rm(resolved.filePath, { force: true });
  return { ok: true, artifactPath };
}

export async function cleanupExpiredAttachments({ agentWorkspaceRoot, now = new Date(), retentionDays = ATTACHMENT_RETENTION_DAYS } = {}) {
  if (!agentWorkspaceRoot) throw new Error('attachment_workspace_required');
  const root = attachmentRoot(agentWorkspaceRoot);
  const cutoff = new Date(now).getTime() - Number(retentionDays) * 86400000;
  let entries = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return { root, deleted: [] }; throw error; }
  const deleted = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const filePath = path.join(root, entry.name);
    const stat = await fs.stat(filePath);
    if (stat.mtimeMs > cutoff) continue;
    await fs.rm(filePath, { force: true });
    deleted.push(path.relative(agentWorkspaceRoot, filePath));
  }
  return { root, deleted };
}

/** Persist current-turn attachment bytes into the owning agent's artifact workspace. */
export async function cleanupAgentAttachments({ databasePath = null, resolveAgentWorkspaceRoot, now = new Date() } = {}) {
  if (typeof resolveAgentWorkspaceRoot !== 'function') throw new Error('attachment_workspace_resolver_required');
  const agents = new AgentRegistryStore({ databasePath });
  try {
    const results = await Promise.all(agents.list({ includeDisabled: true }).map(async (agent) => {
      const agentWorkspaceRoot = await resolveAgentWorkspaceRoot(agent.id);
      if (!agentWorkspaceRoot) return { agentId: agent.id, deleted: [], skipped: true };
      const result = await cleanupExpiredAttachments({ agentWorkspaceRoot, now });
      return { agentId: agent.id, deleted: result.deleted, skipped: false };
    }));
    return { ok: true, retentionDays: ATTACHMENT_RETENTION_DAYS, agents: results, deleted: results.flatMap((result) => result.deleted.map((artifactPath) => ({ agentId: result.agentId, artifactPath }))) };
  } finally { agents.close(); }
}

export function createAttachmentCleanupScheduler({ databasePath = null, resolveAgentWorkspaceRoot, intervalMs = 24 * 60 * 60 * 1_000, clock = () => new Date() } = {}) {
  let timer = null;
  const tick = () => cleanupAgentAttachments({ databasePath, resolveAgentWorkspaceRoot, now: clock() });
  return {
    start() { if (!timer) { timer = setInterval(() => { void tick(); }, intervalMs); timer.unref?.(); } return tick(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
  };
}

export async function persistChatAttachments({ agentWorkspaceRoot, attachments = [], now = new Date() } = {}) {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  if (!agentWorkspaceRoot) throw new Error('attachment_workspace_required');
  const root = attachmentRoot(agentWorkspaceRoot);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await cleanupExpiredAttachments({ agentWorkspaceRoot, now });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const persisted = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index] || {};
    if (!String(attachment.content || '')) continue;
    const filename = `${stamp}-${index + 1}-${safeName(attachment.name)}`;
    const filePath = path.resolve(root, filename);
    if (!contained(root, filePath)) throw new Error('attachment_path_invalid');
    const bytes = dataBytes(attachment.content);
    await fs.writeFile(filePath, bytes, { mode: 0o600 });
    persisted.push({
      ...attachment,
      artifactPath: path.relative(agentWorkspaceRoot, filePath),
      storedAt: new Date(now).toISOString(),
      size: Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : bytes.length,
    });
  }
  return persisted;
}
