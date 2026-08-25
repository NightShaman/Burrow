import path from 'node:path';

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
  const normalizedPath = relativePathIfInsideWorkspace(value.path || value.filePath, context.workspaceRoot);
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
    if (!['files_write', 'files_patch'].includes(toolResult.tool)) continue;
    const role = toolResult.tool === 'files_write' && toolResult.created ? 'created' : 'changed';
    if (Array.isArray(toolResult.touchedFiles) && toolResult.touchedFiles.length) {
      for (const touchedPath of toolResult.touchedFiles) {
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

export function recentFileReferentSummaryFromTurns(turns = [], { limit = 12, workspaceRoot = null } = {}) {
  const recentTurns = (turns || []).slice(Math.max(0, (turns || []).length - limit)).reverse();
  const referents = [];
  for (const turn of recentTurns) {
    if (!isReferentBearingTurn(turn)) continue;
    const turnReferents = normalizeRecentFileReferents(turn.metadata?.recentFiles || [], {
      workspaceRoot,
      turnId: turn.id,
      runId: turn.runId,
      traceDir: turn.traceDir,
      at: turn.ts,
    });
    referents.push(...turnReferents);
  }
  const latestFirst = normalizeRecentFileReferents(referents, { workspaceRoot });
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
