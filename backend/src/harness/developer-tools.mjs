import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTraceLogger } from '../trace-logger.mjs';
import { resolveRuntimeTraceRoot } from '../config.mjs';
import { runExec } from './exec.mjs';

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_MAX_FILE_BYTES = 512_000;

function safeName(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || randomUUID();
}

function hash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function resultFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function resolved(value, fallback) {
  const base = fallback || process.cwd();
  return value ? path.resolve(base, value) : path.resolve(base);
}

function bounded(value, fallback, ceiling) {
  // Native action normalization represents omitted optional bounds as null.
  // Null is numerically zero in JavaScript, so do not accidentally clamp an
  // omitted bound to one result/depth.
  const hasValue = value !== null && value !== undefined && String(value).trim() !== '';
  const parsed = hasValue && Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback;
  return Math.max(1, Math.min(parsed, ceiling));
}

function globPatternToRegExp(pattern = '*') {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') { source += '(?:.*/)?'; index += 2; } else { source += '.*'; index += 1; }
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += /[\\^$+?.()|{}\[\]]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(source);
}

async function toolContext({ tool, rootDir, runId, traceLogger, artifactPrefix, payload = {} }) {
  const logger = traceLogger || createTraceLogger({ rootDir: await resolveRuntimeTraceRoot(rootDir || process.cwd()), runId });
  const prefix = safeName(artifactPrefix || `${tool}-${hash(JSON.stringify(payload))}`);
  const started = await logger.toolStart?.({ tool, ...payload });
  return { logger, prefix, activityId: started?.payload?.activityId || null };
}

async function finish({ logger, tool, activityId, result }) {
  const resultPath = path.join(logger.traceDir, 'artifacts', `${safeName(`${tool}-${hash(JSON.stringify(result))}`)}-result.json`);
  await fs.mkdir(path.dirname(resultPath), { recursive: true });
  result.artifacts = { ...(result.artifacts || {}), resultPath };
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  await (logger.toolEnd || logger.tool)?.({ tool, ...(activityId ? { activityId } : {}), ok: result.ok, error: result.error || null, ...result.trace });
  delete result.trace;
  return result;
}

async function walk(root, { maxDepth = 4, maxEntries = DEFAULT_MAX_ENTRIES, includeHidden = false } = {}) {
  const entries = [];
  let truncated = false;
  const warnings = [];
  async function visit(dir, depth) {
    if (entries.length >= maxEntries) { truncated = true; return; }
    let children;
    try { children = await fs.readdir(dir, { withFileTypes: true }); } catch (error) {
      warnings.push(`unreadable_directory:${path.relative(root, dir) || '.'}:${error?.code || 'error'}`);
      return;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!includeHidden && (child.name.startsWith('.') || child.name === 'node_modules')) continue;
      if (entries.length >= maxEntries) { truncated = true; return; }
      const absolutePath = path.join(dir, child.name);
      const relativePath = path.relative(root, absolutePath) || '.';
      entries.push({ path: relativePath, type: child.isDirectory() ? 'directory' : child.isSymbolicLink() ? 'symlink' : child.isFile() ? 'file' : 'other' });
      if (child.isDirectory() && depth < maxDepth) await visit(absolutePath, depth + 1);
      if (truncated) return;
    }
  }
  await visit(root, 0);
  return { entries, truncated, warnings };
}

export async function listFilesEnvelope({ dirPath, workspaceRoot, maxDepth, maxEntries, includeHidden = false, traceLogger, rootDir, runId, artifactPrefix, reason = null } = {}) {
  const root = resolved(dirPath, workspaceRoot);
  const context = await toolContext({ tool: 'files_list', rootDir, runId, traceLogger, artifactPrefix, payload: { dirPath: root, reason } });
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error('not_a_directory');
    const listing = await walk(root, { maxDepth: bounded(maxDepth, 4, 16), maxEntries: bounded(maxEntries, DEFAULT_MAX_ENTRIES, 2_000), includeHidden: Boolean(includeHidden) });
    const contentPath = await context.logger.artifact(`${context.prefix}-listing.json`, JSON.stringify(listing.entries, null, 2));
    return finish({ logger: context.logger, tool: 'files_list', activityId: context.activityId, result: { tool: 'files_list', ok: true, dirPath: root, reason, entries: listing.entries, resultFingerprint: resultFingerprint({ entries: listing.entries, truncated: listing.truncated, warnings: listing.warnings }), truncated: listing.truncated, warnings: listing.warnings, error: null, artifacts: { contentPath }, trace: { dirPath: root, entries: listing.entries.length, truncated: listing.truncated, warnings: listing.warnings } } });
  } catch (error) {
    return finish({ logger: context.logger, tool: 'files_list', activityId: context.activityId, result: { tool: 'files_list', ok: false, dirPath: root, reason, entries: [], truncated: false, error: String(error?.message || error), artifacts: {}, trace: { dirPath: root } } });
  }
}

export async function globEnvelope({ pattern, dirPath, workspaceRoot, maxDepth, maxEntries, includeHidden = false, traceLogger, rootDir, runId, artifactPrefix, reason = null } = {}) {
  const root = resolved(dirPath, workspaceRoot);
  const context = await toolContext({ tool: 'files_find', rootDir, runId, traceLogger, artifactPrefix, payload: { dirPath: root, pattern, reason } });
  try {
    const matcher = globPatternToRegExp(String(pattern || '*'));
    const limit = bounded(maxEntries, DEFAULT_MAX_ENTRIES, 2_000);
    const listing = await walk(root, { maxDepth: bounded(maxDepth, 8, 24), maxEntries: bounded(maxEntries, DEFAULT_MAX_ENTRIES * 4, 4_000), includeHidden: Boolean(includeHidden) });
    const matchedEntries = listing.entries.filter((entry) => matcher.test(entry.path));
    const paths = matchedEntries.slice(0, limit).map((entry) => entry.path);
    const truncated = listing.truncated || matchedEntries.length > limit;
    const contentPath = await context.logger.artifact(`${context.prefix}-paths.json`, JSON.stringify(paths, null, 2));
    return finish({ logger: context.logger, tool: 'files_find', activityId: context.activityId, result: { tool: 'files_find', ok: true, dirPath: root, pattern: String(pattern || '*'), reason, paths, resultFingerprint: resultFingerprint({ paths, truncated, warnings: listing.warnings }), truncated, warnings: listing.warnings, error: null, artifacts: { contentPath }, trace: { dirPath: root, count: paths.length, truncated, warnings: listing.warnings } } });
  } catch (error) {
    return finish({ logger: context.logger, tool: 'files_find', activityId: context.activityId, result: { tool: 'files_find', ok: false, dirPath: root, pattern: String(pattern || '*'), reason, paths: [], truncated: false, error: String(error?.message || error), artifacts: {}, trace: { dirPath: root } } });
  }
}

export async function statPathEnvelope({ path: targetPath, workspaceRoot, traceLogger, rootDir, runId, artifactPrefix, reason = null } = {}) {
  const filePath = resolved(targetPath, workspaceRoot);
  const context = await toolContext({ tool: 'files_inspect', rootDir, runId, traceLogger, artifactPrefix, payload: { path: filePath, reason } });
  try {
    const stat = await fs.lstat(filePath);
    const statReceipt = { exists: true, type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other', size: stat.size, modifiedAt: stat.mtime.toISOString(), symlinkTarget: stat.isSymbolicLink() ? await fs.readlink(filePath) : null };
    const result = { tool: 'files_inspect', ok: true, path: filePath, reason, ...statReceipt, resultFingerprint: resultFingerprint(statReceipt), error: null, artifacts: {}, trace: { path: filePath } };
    return finish({ logger: context.logger, tool: 'files_inspect', activityId: context.activityId, result });
  } catch (error) {
    const missing = error?.code === 'ENOENT';
    const statReceipt = { exists: false, type: null, size: null, modifiedAt: null, symlinkTarget: null };
    return finish({ logger: context.logger, tool: 'files_inspect', activityId: context.activityId, result: { tool: 'files_inspect', ok: missing, path: filePath, reason, ...statReceipt, resultFingerprint: resultFingerprint(statReceipt), error: missing ? null : String(error?.message || error), artifacts: {}, trace: { path: filePath } } });
  }
}

export async function searchFilesEnvelope({ query, dirPath, workspaceRoot, maxDepth, maxMatches, traceLogger, rootDir, runId, artifactPrefix, reason = null } = {}) {
  const root = resolved(dirPath, workspaceRoot);
  const context = await toolContext({ tool: 'files_search', rootDir, runId, traceLogger, artifactPrefix, payload: { dirPath: root, query, reason } });
  const limit = bounded(maxMatches, DEFAULT_MAX_MATCHES, 1_000);
  try {
    if (!query) throw new Error('query_required');
    const listing = await walk(root, { maxDepth: bounded(maxDepth, 8, 24), maxEntries: 4_000 });
    const matches = [];
    let scannedBytes = 0;
    let scanTruncated = false;
    const maxScannedBytes = 8_000_000;
    for (const entry of listing.entries) {
      if (entry.type !== 'file' || matches.length >= limit) continue;
      const absolute = path.join(root, entry.path);
      let stat; try { stat = await fs.stat(absolute); } catch { continue; }
      if (stat.size > DEFAULT_MAX_FILE_BYTES) continue;
      if (scannedBytes + stat.size > maxScannedBytes) { scanTruncated = true; continue; }
      let content; try { content = await fs.readFile(absolute, 'utf8'); } catch { continue; }
      scannedBytes += stat.size;
      content.split(/\r?\n/).forEach((line, index) => { if (matches.length < limit && line.includes(String(query))) matches.push({ filePath: entry.path, line: index + 1, text: line.slice(0, 1_000) }); });
    }
    const contentPath = await context.logger.artifact(`${context.prefix}-matches.json`, JSON.stringify(matches, null, 2));
    const truncated = listing.truncated || scanTruncated || matches.length >= limit;
    return finish({ logger: context.logger, tool: 'files_search', activityId: context.activityId, result: { tool: 'files_search', ok: true, dirPath: root, query: String(query), reason, matches, resultFingerprint: resultFingerprint({ matches, truncated, warnings: listing.warnings }), truncated, warnings: listing.warnings, error: null, artifacts: { contentPath }, trace: { dirPath: root, matches: matches.length, scannedBytes, truncated, warnings: listing.warnings } } });
  } catch (error) {
    return finish({ logger: context.logger, tool: 'files_search', activityId: context.activityId, result: { tool: 'files_search', ok: false, dirPath: root, query: String(query || ''), reason, matches: [], truncated: false, error: String(error?.message || error), artifacts: {}, trace: { dirPath: root } } });
  }
}

export async function editFileEnvelope({ filePath, oldText, newText, workspaceRoot, traceLogger, rootDir, runId, artifactPrefix, reason = null } = {}) {
  const target = resolved(filePath, workspaceRoot);
  const context = await toolContext({ tool: 'files_edit', rootDir, runId, traceLogger, artifactPrefix, payload: { filePath: target, reason } });
  try {
    const before = await fs.readFile(target, 'utf8');
    const occurrences = oldText ? before.split(String(oldText)).length - 1 : 0;
    if (occurrences !== 1) throw new Error(occurrences ? 'old_text_not_unique' : 'old_text_not_found');
    const after = before.replace(String(oldText), String(newText));
    const beforePath = await context.logger.artifact(`${context.prefix}-before.txt`, before);
    await fs.writeFile(target, after, 'utf8');
    const afterPath = await context.logger.artifact(`${context.prefix}-after.txt`, after);
    return finish({ logger: context.logger, tool: 'files_edit', activityId: context.activityId, result: { tool: 'files_edit', ok: true, filePath: target, reason, replaced: 1, changedFiles: [target], resultFingerprint: resultFingerprint({ before: hash(before), after: hash(after) }), error: null, artifacts: { beforePath, afterPath }, trace: { filePath: target, replaced: 1 } } });
  } catch (error) {
    return finish({ logger: context.logger, tool: 'files_edit', activityId: context.activityId, result: { tool: 'files_edit', ok: false, filePath: target, reason, replaced: 0, changedFiles: [], error: String(error?.message || error), artifacts: {}, trace: { filePath: target } } });
  }
}

async function gitEnvelope({ tool, args, dirPath, workspaceRoot, traceLogger, rootDir, runId, artifactPrefix, reason, execute = runExec }) {
  const cwd = resolved(dirPath, workspaceRoot);
  const context = await toolContext({ tool, rootDir, runId, traceLogger, artifactPrefix, payload: { cwd, reason } });
  const result = await execute({ executable: 'git', args, cwd, traceLogger: context.logger, artifactPrefix: `${context.prefix}-shell_exec`, reason });
  return finish({ logger: context.logger, tool, activityId: context.activityId, result: { ...result, tool, dirPath: cwd, reason, resultFingerprint: resultFingerprint({ exitCode: result.exitCode, stdout: result.stdout || '', stderr: result.stderr || '' }), trace: { cwd, exitCode: result.exitCode } } });
}

export function gitStatusEnvelope(options = {}) { return gitEnvelope({ ...options, tool: 'git_status', args: ['status', '--short', '--branch'] }); }
export function gitDiffEnvelope(options = {}) { return gitEnvelope({ ...options, tool: 'git_diff', args: ['diff', '--no-ext-diff', '--'] }); }
