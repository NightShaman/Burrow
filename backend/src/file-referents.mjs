import path from 'node:path';
import { resolveRemotePath } from './remote-execution-path.mjs';

export function resolveFileReferent(filePath, { workspaceRoot, remote } = {}) {
  if (remote) {
    try { return resolveRemotePath(filePath, workspaceRoot); }
    catch { return null; }
  }
  return path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot || process.cwd(), filePath);
}

const VALID_FILE_REFERENT_ROLES = new Set(['changed', 'created', 'read', 'mentioned', 'deleted']);
const DEFAULT_FILE_REFERENT_ROLE = 'mentioned';
const DEFAULT_FILE_REFERENT_SOURCE = 'unknown';

function normalizeRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  return VALID_FILE_REFERENT_ROLES.has(normalized) ? normalized : DEFAULT_FILE_REFERENT_ROLE;
}

function normalizeSource(source) {
  return String(source || DEFAULT_FILE_REFERENT_SOURCE).trim() || DEFAULT_FILE_REFERENT_SOURCE;
}

function isUnsafePath(filePath) {
  if (!filePath) return true;
  if (filePath.includes('\0')) return true;
  return false;
}

function normalizePathSeparators(filePath) {
  return String(filePath || '').replace(/\\+/g, '/');
}

function relativePathIfInsideWorkspace(filePath, workspaceRoot = null) {
  const raw = normalizePathSeparators(filePath).trim();
  if (!raw || isUnsafePath(raw)) return null;
  if (!path.isAbsolute(raw)) return raw.replace(/^\.\/+/, '');
  if (!workspaceRoot) return raw;

  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(raw);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative === '') return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return raw;
  return normalizePathSeparators(relative);
}

function compactFileReferent(value = {}, context = {}) {
  const filePath = value.path || value.filePath;
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  const normalizedPath = context.remote
    ? resolveFileReferent(filePath, context)
    : relativePathIfInsideWorkspace(filePath, context.workspaceRoot);
  if (!normalizedPath) return null;
  return {
    path: normalizedPath,
    role: normalizeRole(value.role),
    source: normalizeSource(value.source),
    ...(value.turnId ? { turnId: String(value.turnId) } : context.turnId ? { turnId: String(context.turnId) } : {}),
    ...(value.runId ? { runId: String(value.runId) } : context.runId ? { runId: String(context.runId) } : {}),
    ...(value.traceDir ? { traceDir: String(value.traceDir) } : context.traceDir ? { traceDir: String(context.traceDir) } : {}),
    ...(value.at ? { at: String(value.at) } : context.at ? { at: String(context.at) } : {}),
  };
}

export function normalizeRecentFileReferents(values = [], context = {}) {
  const seen = new Set();
  const referents = [];
  for (const value of values || []) {
    const referent = compactFileReferent(value, context);
    if (!referent) continue;
    const key = `${referent.path}\0${referent.role}\0${referent.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    referents.push(referent);
  }
  return referents;
}

export function withRecentFileReferents(metadata = {}, referents = [], context = {}) {
  const recentFiles = normalizeRecentFileReferents(referents, context);
  if (!recentFiles.length) return { ...(metadata || {}) };
  return {
    ...(metadata || {}),
    recentFiles,
  };
}

export function recentFileReferentsFromToolResults(toolResults = [], context = {}) {
  const candidates = [];
  for (const toolResult of toolResults || []) {
    if (!toolResult?.ok) continue;
    if (toolResult.tool === 'files_read') {
      if (toolResult.filePath) candidates.push({ path: toolResult.filePath, role: 'read', source: 'tool-result' });
      continue;
    }
    if (!['files_write', 'files_edit', 'files_patch'].includes(toolResult.tool)) continue;
    const role = toolResult.tool === 'files_write' && toolResult.created ? 'created' : 'changed';
    const touchedFiles = Array.isArray(toolResult.touchedFiles) && toolResult.touchedFiles.length
      ? toolResult.touchedFiles
      : Array.isArray(toolResult.changedFiles) && toolResult.changedFiles.length ? toolResult.changedFiles : [];
    if (touchedFiles.length) {
      for (const touchedPath of touchedFiles) {
        candidates.push({ path: touchedPath, role, source: 'tool-result' });
      }
      continue;
    }
    if (toolResult.filePath) {
      candidates.push({ path: toolResult.filePath, role, source: 'tool-result' });
    }
  }
  return normalizeRecentFileReferents(candidates, context);
}

function isReferentBearingTurn(entry = {}) {
  if (entry.type === 'receipt') return true;
  return entry.type === 'message'
    && ['assistant', 'user'].includes(String(entry.role || ''))
    && entry.visibility === 'chat'
    && entry.entersPrompt === true;
}

function firstByRole(referents = [], roles = []) {
  return referents.find((referent) => roles.includes(referent.role)) || null;
}

function uniqueByPath(referents = []) {
  const seen = new Set();
  const unique = [];
  for (const referent of referents) {
    if (seen.has(referent.path)) continue;
    seen.add(referent.path);
    unique.push(referent);
  }
  return unique;
}

export function recentFileReferentSummaryFromTurns(turns = [], { limit = 12, workspaceRoot = null, remote = false } = {}) {
  const isRemoteFileResult = (entry) => remote && entry.type === 'tool_result'
    && entry.metadata?.canonicalExecution === true
    && ['files_read', 'files_write', 'files_edit', 'files_patch'].includes(entry.metadata.tool)
    && entry.metadata.normalizedResult?.execution?.kind === 'remote';
  const eligibleTurns = (turns || []).filter(entry => isReferentBearingTurn(entry) || isRemoteFileResult(entry));
  const recentTurns = eligibleTurns.slice(Math.max(0, eligibleTurns.length - limit)).reverse();
  const referents = [];
  for (const turn of recentTurns) {
    const context = {
      workspaceRoot,
      remote,
      turnId: turn.id,
      runId: turn.runId,
      traceDir: turn.traceDir,
      at: turn.ts,
    };
    const recorded = turn.metadata?.recentFiles;
    const turnReferents = recorded || !isRemoteFileResult(turn)
      ? normalizeRecentFileReferents(recorded || [], context)
      : recentFileReferentsFromToolResults([turn.metadata.normalizedResult], { ...context, workspaceRoot: turn.metadata.normalizedResult.workspaceRoot });
    referents.push(...turnReferents);
  }
  const latestFirst = normalizeRecentFileReferents(referents, { workspaceRoot, remote });
  const targetCandidates = uniqueByPath(latestFirst.filter((referent) => ['changed', 'created'].includes(referent.role)));
  return {
    latestChangedFile: firstByRole(latestFirst, ['changed']),
    latestCreatedFile: firstByRole(latestFirst, ['created']),
    latestReadOrMentionedFiles: uniqueByPath(latestFirst.filter((referent) => ['read', 'mentioned'].includes(referent.role))),
    ambiguityCount: targetCandidates.length,
    recentFiles: latestFirst,
  };
}

export const __test__ = { relativePathIfInsideWorkspace, normalizeRole };
