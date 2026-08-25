import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveRuntimeTraceRoot } from '../config.mjs';
import { createTraceLogger } from '../trace-logger.mjs';
import { runExec } from './exec.mjs';

function safeName(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || randomUUID();
}

function patchHash(patch) {
  return createHash('sha256').update(String(patch || '')).digest('hex').slice(0, 12);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeRoot(root) {
  return root ? path.resolve(root) : null;
}

function commonParent(paths = []) {
  const resolved = paths.map((item) => path.resolve(item)).filter(Boolean);
  if (!resolved.length) return null;
  let current = path.dirname(resolved[0]);
  while (current !== path.dirname(current) && !resolved.every((item) => isInside(item, current))) current = path.dirname(current);
  return resolved.every((item) => isInside(item, current)) ? current : null;
}

async function nearestGitRoot(startPath) {
  let current = path.dirname(path.resolve(startPath));
  while (true) {
    try {
      await fs.access(path.join(current, '.git'));
      return current;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function resolvePatchBaseRoot({ patch, fallbackRoot }) {
  const absoluteTargets = touchedFilesFromPatch(patch).filter((item) => path.isAbsolute(item));
  if (!absoluteTargets.length) return fallbackRoot;
  const gitRoots = await Promise.all(absoluteTargets.map(nearestGitRoot));
  if (gitRoots.every(Boolean) && new Set(gitRoots).size === 1) return gitRoots[0];
  return commonParent(absoluteTargets) || fallbackRoot;
}

function stripDiffPrefix(file) {
  if (file === '/dev/null') return null;
  return file.replace(/^a\//, '').replace(/^b\//, '');
}

function unique(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

export function detectPatchDialect(patch = '') {
  const text = String(patch || '').trimStart();
  if (/^\*\*\* Begin Patch/m.test(text)) return 'structured_patch';
  if (/^(diff --git|---\s+\S+[\s\S]*^\+\+\+\s+\S+)/m.test(text)) return 'unified_diff';
  return 'unknown';
}

function touchedFilesFromUnifiedPatch(patch) {
  const files = new Set();
  for (const line of String(patch || '').split(/\r?\n/)) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      const raw = line.slice(4).trim().split(/\s+/)[0];
      const file = stripDiffPrefix(raw);
      if (file) files.add(file);
    }
  }
  return [...files];
}

function touchedFilesFromStructuredPatch(patch) {
  const files = new Set();
  for (const line of String(patch || '').split(/\r?\n/)) {
    const update = line.match(/^\*\*\* Update File:\s*(.+)$/);
    const add = line.match(/^\*\*\* Add File:\s*(.+)$/);
    const del = line.match(/^\*\*\* Delete File:\s*(.+)$/);
    const file = update?.[1] || add?.[1] || del?.[1] || null;
    if (file) files.add(path.isAbsolute(file) ? path.resolve(file) : stripDiffPrefix(file));
  }
  return [...files];
}

export function touchedFilesFromPatch(patch) {
  const dialect = detectPatchDialect(patch);
  if (dialect === 'structured_patch') return touchedFilesFromStructuredPatch(patch);
  return touchedFilesFromUnifiedPatch(patch);
}

export function classifyPatchFailure({ patch = '', error = '', exitCode = null } = {}) {
  const text = String(error || '');
  const patchText = String(patch || '');
  if (/No valid patches in input/i.test(text)) return 'patch_malformed';
  if (/No such file or directory|can't open patch/i.test(text)) return 'patch_io_failed';
  if (/patch does not apply|does not match|corrupt patch|malformed patch|context_mismatch/i.test(text)) return 'patch_context_mismatch';
  if (!patchText.trim()) return 'patch_empty';
  if (exitCode != null && Number(exitCode) !== 0) return 'git_apply_failed';
  return null;
}

function patchAnchorsByFile(patch = '') {
  const anchors = new Map();
  let currentFile = null;
  for (const line of String(patch || '').split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim().split(/\s+/)[0];
      currentFile = stripDiffPrefix(raw);
      if (currentFile) anchors.set(currentFile, anchors.get(currentFile) || []);
      continue;
    }
    if (!currentFile) continue;
    if (line.startsWith('--- ') || line.startsWith('@@') || line.startsWith('++')) continue;
    if (line.startsWith('-') || line.startsWith(' ')) {
      const anchor = line.slice(1);
      if (anchor.trim()) anchors.get(currentFile)?.push(anchor);
    }
  }
  return anchors;
}

function parseStructuredPatch(patch = '') {
  const operations = [];
  const errors = [];
  const lines = String(patch || '').split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const update = line.match(/^\*\*\* Update File:\s*(.+)$/);
    const add = line.match(/^\*\*\* Add File:\s*(.+)$/);
    const del = line.match(/^\*\*\* Delete File:\s*(.+)$/);
    if (update || add || del) {
      if (current) operations.push(current);
      current = { type: update ? 'update' : add ? 'add' : 'delete', file: (update?.[1] || add?.[1] || del?.[1] || '').trim(), lines: [] };
      continue;
    }
    if (/^\*\*\* (Begin Patch|End Patch)$/u.test(line)) continue;
    if (!current) continue;
    current.lines.push(line);
  }
  if (current) operations.push(current);
  if (!operations.length) errors.push('patch_no_operations');
  return { dialect: 'structured_patch', operations, errors };
}

function hunkBlockFromStructuredPatchLines(lines = []) {
  const oldLines = [];
  const newLines = [];
  for (const line of lines) {
    if (line.startsWith('***')) continue;
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith('+')) {
      newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith(' ')) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
      continue;
    }
    if (!line.trim()) {
      oldLines.push('');
      newLines.push('');
      continue;
    }
    oldLines.push(line);
    newLines.push(line);
  }
  return { oldBlock: oldLines.join('\n'), newBlock: newLines.join('\n') };
}

function hunkBlocksFromStructuredPatchLines(lines = []) {
  const hunks = [];
  let current = [];
  let sawHunkMarker = false;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current.length) hunks.push(hunkBlockFromStructuredPatchLines(current));
      current = [];
      sawHunkMarker = true;
      continue;
    }
    current.push(line);
  }
  if (current.length || !sawHunkMarker) hunks.push(hunkBlockFromStructuredPatchLines(current));
  return hunks;
}

function structuredPatchFilePath(rawPath = '', baseRoot = process.cwd()) {
  const value = String(rawPath || '').trim();
  if (!value) return null;
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseRoot, stripDiffPrefix(value) || value);
}

async function applyStructuredPatch({ patch, baseRoot, logger, prefix }) {
  const parsed = parseStructuredPatch(patch);
  if (parsed.errors.length) return { ok: false, error: parsed.errors.join(','), failureClass: 'patch_malformed', changedFiles: [], operationArtifacts: [] };
  const changedFiles = [];
  const operationArtifacts = [];

  for (const [index, operation] of parsed.operations.entries()) {
    const targetPath = structuredPatchFilePath(operation.file, baseRoot);
    if (!targetPath) return { ok: false, error: `patch_missing_file:${index}`, failureClass: 'patch_malformed', changedFiles, operationArtifacts };
    const relative = path.relative(baseRoot, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, error: `patch_target_outside_base:${operation.file}`, failureClass: 'patch_validation_failed', changedFiles, operationArtifacts };

    if (operation.type === 'delete') {
      const before = await fs.readFile(targetPath, 'utf8');
      const beforePath = await logger.artifact(`${prefix}-structured-${index}-before.txt`, before);
      await fs.unlink(targetPath);
      operationArtifacts.push({ beforePath });
      changedFiles.push(relative);
      continue;
    }

    if (operation.type === 'add') {
      const newBlock = hunkBlocksFromStructuredPatchLines(operation.lines).map((hunk) => hunk.newBlock).join('\n');
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, newBlock.endsWith('\n') ? newBlock : `${newBlock}\n`, 'utf8');
      const afterPath = await logger.artifact(`${prefix}-structured-${index}-after.txt`, await fs.readFile(targetPath, 'utf8'));
      operationArtifacts.push({ beforePath: null, afterPath });
      changedFiles.push(relative);
      continue;
    }

    const before = await fs.readFile(targetPath, 'utf8');
    let after = before;
    const hunks = hunkBlocksFromStructuredPatchLines(operation.lines);
    for (const [hunkIndex, { oldBlock, newBlock }] of hunks.entries()) {
      // A no-op hunk adds no evidence and must not make an otherwise valid
      // multi-hunk update fail because it cannot be found independently.
      if (oldBlock === newBlock) continue;
      if (!oldBlock) {
        return {
          ok: false,
          error: `patch_missing_context:${operation.file}:hunk-${hunkIndex + 1}`,
          failureClass: 'patch_malformed',
          changedFiles,
          operationArtifacts,
          failedOperationIndex: index,
          failedHunkIndex: hunkIndex,
        };
      }
      const indexOf = after.indexOf(oldBlock);
      if (indexOf < 0) {
        return {
          ok: false,
          error: `patch_context_mismatch:${operation.file}:hunk-${hunkIndex + 1}`,
          failureClass: 'patch_context_mismatch',
          changedFiles,
          operationArtifacts,
          failedOperationIndex: index,
          failedHunkIndex: hunkIndex,
        };
      }
      after = `${after.slice(0, indexOf)}${newBlock}${after.slice(indexOf + oldBlock.length)}`;
    }
    if (after === before) continue;
    const beforePath = await logger.artifact(`${prefix}-structured-${index}-before.txt`, before);
    await fs.writeFile(targetPath, after, 'utf8');
    const afterPath = await logger.artifact(`${prefix}-structured-${index}-after.txt`, after);
    operationArtifacts.push({ beforePath, afterPath });
    changedFiles.push(relative);
  }

  return { ok: true, error: null, failureClass: null, changedFiles: unique(changedFiles), operationArtifacts };
}

function observedContentByRelativeFile({ observedToolResults = [], baseRoot = null } = {}) {
  const observed = new Map();
  const resolvedBaseRoot = normalizeRoot(baseRoot || process.cwd());
  for (const result of observedToolResults || []) {
    if (!result?.ok || result.tool !== 'files_read' || !result.filePath || typeof result.content !== 'string') continue;
    const absolute = path.resolve(result.filePath);
    const relative = path.relative(resolvedBaseRoot, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    observed.set(relative, result.content);
  }
  return observed;
}

export function validatePatchObservedContext({ patch, observedToolResults = [], baseRoot = null } = {}) {
  const observed = observedContentByRelativeFile({ observedToolResults, baseRoot });
  if (!observed.size) return { ok: true, error: null, failureClass: null, files: [], missing: [] };
  const missing = [];
  if (detectPatchDialect(patch) === 'structured_patch') {
    const parsed = parseStructuredPatch(patch);
    for (const operation of parsed.operations.filter((item) => item.type === 'update')) {
      const targetPath = structuredPatchFilePath(operation.file, baseRoot || process.cwd());
      const file = targetPath ? path.relative(normalizeRoot(baseRoot || process.cwd()), targetPath) : operation.file;
      const content = observed.get(file);
      if (content == null) continue;
      for (const [hunkIndex, { oldBlock, newBlock }] of hunkBlocksFromStructuredPatchLines(operation.lines).entries()) {
        if (!oldBlock || oldBlock === newBlock || content.includes(oldBlock)) continue;
        missing.push({ file, hunkIndex, anchor: oldBlock });
      }
    }
    if (!missing.length) return { ok: true, error: null, failureClass: null, files: touchedFilesFromPatch(patch), missing: [] };
    const first = missing[0];
    return {
      ok: false,
      error: `patch_context_not_observed:${first.file}:hunk-${first.hunkIndex + 1}:${first.anchor.slice(0, 160)}`,
      failureClass: 'patch_context_not_observed',
      files: touchedFilesFromPatch(patch),
      missing,
    };
  }
  if (detectPatchDialect(patch) !== 'unified_diff') return { ok: true, error: null, failureClass: null, files: touchedFilesFromPatch(patch), missing: [] };
  const anchorsByFile = patchAnchorsByFile(patch);
  for (const [file, anchors] of anchorsByFile.entries()) {
    if (!observed.has(file)) continue;
    const content = observed.get(file) || '';
    for (const anchor of anchors) {
      if (!content.includes(anchor)) missing.push({ file, anchor });
    }
  }
  if (!missing.length) return { ok: true, error: null, failureClass: null, files: [...anchorsByFile.keys()], missing: [] };
  const first = missing[0];
  return {
    ok: false,
    error: `patch_context_not_observed:${first.file}:${first.anchor.slice(0, 160)}`,
    failureClass: 'patch_context_not_observed',
    files: [...anchorsByFile.keys()],
    missing,
  };
}

export function validatePatchWorkspace({ patch, workspaceRoot = null, baseRoot = null } = {}) {
  const resolvedBaseRoot = normalizeRoot(workspaceRoot || baseRoot || process.cwd());
  const files = touchedFilesFromPatch(patch);
  const warnings = [];

  for (const file of files) {
    if (path.isAbsolute(file)) {
      warnings.push(`patch_touches_absolute_path:${file}`);
      continue;
    }

    const resolved = path.resolve(resolvedBaseRoot, file);
    if (!isInside(resolved, resolvedBaseRoot)) {
      warnings.push(`patch_touches_outside_base_context:${file}`);
    }
  }

  return { ok: true, error: null, files, warnings, baseRoot: resolvedBaseRoot, workspaceRoot: normalizeRoot(workspaceRoot) };
}

async function writeResult(logger, prefix, result) {
  const resultPath = path.join(logger.traceDir, 'artifacts', `${prefix}-result.json`);
  result.artifacts.resultPath = resultPath;
  await fs.mkdir(path.dirname(resultPath), { recursive: true });
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  return resultPath;
}

export async function applyPatchEnvelope({
  patch,
  workspaceRoot = null,
  baseRoot = null,
  traceLogger,
  rootDir,
  runId,
  artifactPrefix,
  observedToolResults = [],
} = {}) {
  if (!patch || typeof patch !== 'string') throw new Error('patch is required');

  const startedAt = Date.now();
  const logger = traceLogger || createTraceLogger({ rootDir: await resolveRuntimeTraceRoot(rootDir || process.cwd()), runId });
  const requestedBaseRoot = normalizeRoot(workspaceRoot || baseRoot || rootDir || process.cwd());
  const resolvedWorkspaceRoot = normalizeRoot(workspaceRoot);
  const resolvedBaseRoot = await resolvePatchBaseRoot({ patch, fallbackRoot: requestedBaseRoot });
  const prefix = safeName(artifactPrefix || `patch-${patchHash(patch)}`);
  const dialect = detectPatchDialect(patch);
  const started = await logger.toolStart?.({ tool: 'files_patch', workspaceRoot: resolvedWorkspaceRoot, baseRoot: resolvedBaseRoot, dialect, touchedFiles: touchedFilesFromPatch(patch) });
  const activityId = started?.payload?.activityId || null;

  const patchPath = await logger.artifact(`${prefix}-input.patch`, patch);
  const validation = validatePatchWorkspace({ patch, workspaceRoot: resolvedWorkspaceRoot, baseRoot: resolvedBaseRoot });
  const observedContext = validatePatchObservedContext({ patch, observedToolResults, baseRoot: resolvedBaseRoot });

  const baseResult = {
    tool: 'files_patch',
    ok: false,
    workspaceRoot: resolvedWorkspaceRoot,
    baseRoot: resolvedBaseRoot,
    dialect,
    touchedFiles: validation.files,
    warnings: validation.warnings,
    observedContext,
    error: null,
    durationMs: 0,
    artifacts: {
      patchPath,
      beforeStatusPath: null,
      applyStdoutPath: null,
      applyStderrPath: null,
      afterStatusPath: null,
      afterDiffPath: null,
      resultPath: null,
    },
  };

  async function finish(result) {
    result.durationMs = Date.now() - startedAt;
    await writeResult(logger, prefix, result);
    await (logger.toolEnd || logger.tool)({
      tool: 'files_patch',
      ...(activityId ? { activityId } : {}),
      ok: result.ok,
      workspaceRoot: result.workspaceRoot,
      baseRoot: result.baseRoot,
      dialect: result.dialect,
      touchedFiles: result.touchedFiles,
      warnings: result.warnings,
      error: result.error,
      failureClass: result.failureClass || null,
      durationMs: result.durationMs,
      artifacts: result.artifacts,
    });
    return result;
  }

  if (!validation.ok) {
    return finish({ ...baseResult, error: validation.error, failureClass: 'patch_validation_failed' });
  }

  if (!observedContext.ok) {
    return finish({ ...baseResult, error: observedContext.error, failureClass: observedContext.failureClass });
  }

  if (dialect === 'unknown') {
    return finish({ ...baseResult, error: 'unsupported_patch_dialect', failureClass: 'unsupported_patch_dialect' });
  }

  const beforeStatus = await runExec({ command: 'git status --short', cwd: resolvedBaseRoot, traceLogger: logger, artifactPrefix: `${prefix}-before-status` });
  baseResult.artifacts.beforeStatusPath = beforeStatus.artifacts.stdoutPath;

  if (dialect === 'structured_patch') {
    const apply = await applyStructuredPatch({ patch, baseRoot: resolvedBaseRoot, logger, prefix });
    const afterStatus = await runExec({ command: 'git status --short', cwd: resolvedBaseRoot, traceLogger: logger, artifactPrefix: `${prefix}-after-status` });
    const afterDiff = await runExec({ command: 'git diff --', cwd: resolvedBaseRoot, traceLogger: logger, artifactPrefix: `${prefix}-after-diff` });
    baseResult.artifacts.afterStatusPath = afterStatus.artifacts.stdoutPath;
    baseResult.artifacts.afterDiffPath = afterDiff.artifacts.stdoutPath;
    return finish({
      ...baseResult,
      ok: apply.ok,
      error: apply.error,
      failureClass: apply.failureClass,
      touchedFiles: apply.changedFiles.length ? apply.changedFiles : baseResult.touchedFiles,
      operationArtifacts: apply.operationArtifacts,
    });
  }

  const apply = await runExec({ command: `git apply --whitespace=nowarn ${JSON.stringify(patchPath)}`, cwd: resolvedBaseRoot, traceLogger: logger, artifactPrefix: `${prefix}-git-apply` });
  baseResult.artifacts.applyStdoutPath = apply.artifacts.stdoutPath;
  baseResult.artifacts.applyStderrPath = apply.artifacts.stderrPath;

  const afterStatus = await runExec({ command: 'git status --short', cwd: resolvedBaseRoot, traceLogger: logger, artifactPrefix: `${prefix}-after-status` });
  const afterDiff = await runExec({ command: 'git diff --', cwd: resolvedBaseRoot, traceLogger: logger, artifactPrefix: `${prefix}-after-diff` });
  baseResult.artifacts.afterStatusPath = afterStatus.artifacts.stdoutPath;
  baseResult.artifacts.afterDiffPath = afterDiff.artifacts.stdoutPath;

  const error = apply.ok ? null : (apply.stderr || apply.error || 'git_apply_failed');
  return finish({
    ...baseResult,
    ok: apply.ok,
    error,
    failureClass: apply.ok ? null : classifyPatchFailure({ patch, error, exitCode: apply.exitCode }),
    gitApplyExitCode: apply.exitCode,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootDir = process.argv[2] || process.cwd();
  const workspaceRoot = process.argv[3] || null;
  const patchPath = process.argv[4];
  const patch = await fs.readFile(patchPath, 'utf8');
  const result = await applyPatchEnvelope({ rootDir, runId: 'manual-files_patch-smoke', workspaceRoot, patch });
  console.log(JSON.stringify(result, null, 2));
}
