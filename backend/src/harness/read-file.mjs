import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveRuntimeTraceRoot } from '../config.mjs';
import { createTraceLogger } from '../trace-logger.mjs';

function safeName(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || randomUUID();
}

function fileHash(filePath) {
  return createHash('sha256').update(String(filePath || '')).digest('hex').slice(0, 12);
}

function normalizeRoot(root) {
  return root ? path.resolve(root) : null;
}

export async function readFileEnvelope({
  filePath,
  workspaceRoot,
  encoding = 'utf8',
  maxBytes = 512_000,
  offsetBytes = 0,
  traceLogger,
  rootDir,
  runId,
  artifactPrefix,
  reason = null,
} = {}) {
  if (!filePath || typeof filePath !== 'string') throw new Error('filePath is required');
  const startedAt = Date.now();
  const logger = traceLogger || createTraceLogger({ rootDir: await resolveRuntimeTraceRoot(rootDir || process.cwd()), runId });
  const resolvedPath = path.resolve(filePath);
  const resolvedWorkspaceRoot = normalizeRoot(workspaceRoot);
  const prefix = safeName(artifactPrefix || `read-${fileHash(resolvedPath)}`);
  const started = await logger.toolStart?.({ tool: 'files_read', filePath: resolvedPath, workspaceRoot: resolvedWorkspaceRoot, reason: typeof reason === 'string' ? reason.slice(0, 500) : null });
  const activityId = started?.payload?.activityId || null;

  const warnings = [];

  let handle;
  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) throw new Error('not_a_file');
    const offset = Math.max(0, Number.isFinite(Number(offsetBytes)) ? Math.floor(Number(offsetBytes)) : 0);
    const requestedMaxBytes = Math.max(0, Number.isFinite(Number(maxBytes)) ? Math.floor(Number(maxBytes)) : 512_000);
    const available = Math.max(0, stat.size - offset);
    const size = Math.min(available, requestedMaxBytes);
    const truncated = offset + size < stat.size;
    handle = await fs.open(resolvedPath, 'r');
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, offset);
    const content = buffer.toString(encoding);
    // Observation state only: this does not confer authority or direct the agent.
    const contentHash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const contentPath = await logger.artifact(`${prefix}-content.txt`, content, { encoding });

    const result = {
      tool: 'files_read',
      ok: true,
      filePath: resolvedPath,
      reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
      workspaceRoot: resolvedWorkspaceRoot,
      encoding,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      offsetBytes: offset,
      returnedBytes: Buffer.byteLength(content, encoding),
      contentHash,
      truncated,
      nextOffsetBytes: truncated ? offset + Buffer.byteLength(content, encoding) : null,
      content,
      error: null,
      warnings,
      durationMs: Date.now() - startedAt,
      artifacts: { contentPath, resultPath: null },
    };
    const resultPath = path.join(logger.traceDir, 'artifacts', `${prefix}-result.json`);
    result.artifacts.resultPath = resultPath;
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
    await (logger.toolEnd || logger.tool)({
      tool: 'files_read',
      ...(activityId ? { activityId } : {}),
      ok: true,
      filePath: resolvedPath,
      reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
      bytes: result.bytes,
      modifiedAt: result.modifiedAt,
      offsetBytes: result.offsetBytes,
      returnedBytes: result.returnedBytes,
      contentHash: result.contentHash,
      truncated,
      durationMs: result.durationMs,
      artifacts: result.artifacts,
      warnings,
    });
    return result;
  } catch (error) {
    const result = {
      tool: 'files_read',
      ok: false,
      filePath: resolvedPath,
      reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
      workspaceRoot: resolvedWorkspaceRoot,
      encoding,
      bytes: 0,
      offsetBytes: Math.max(0, Number.isFinite(Number(offsetBytes)) ? Math.floor(Number(offsetBytes)) : 0),
      returnedBytes: 0,
      contentHash: null,
      truncated: false,
      content: '',
      error: String(error?.message || error),
      warnings,
      durationMs: Date.now() - startedAt,
      artifacts: { contentPath: null, resultPath: null },
    };
    const resultPath = path.join(logger.traceDir, 'artifacts', `${prefix}-result.json`);
    result.artifacts.resultPath = resultPath;
    await fs.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
    await (logger.toolEnd || logger.tool)({ tool: 'files_read', ...(activityId ? { activityId } : {}), ok: false, filePath: resolvedPath, error: result.error, artifacts: result.artifacts });
    return result;
  } finally {
    if (handle) await handle.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootDir = process.argv[2] || process.cwd();
  const filePath = process.argv[3];
  const result = await readFileEnvelope({ rootDir, runId: 'manual-read-smoke', filePath });
  console.log(JSON.stringify(result, null, 2));
}
