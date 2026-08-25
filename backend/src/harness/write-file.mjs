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

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function byteLength(content, encoding) {
  return Buffer.byteLength(String(content ?? ''), encoding);
}

export async function writeFileEnvelope({
  filePath,
  content,
  workspaceRoot,
  encoding = 'utf8',
  overwrite = true,
  makeDirs = true,
  traceLogger,
  rootDir,
  runId,
  artifactPrefix,
} = {}) {
  if (!filePath || typeof filePath !== 'string') throw new Error('filePath is required');
  if (content === undefined || content === null) throw new Error('content is required');

  const startedAt = Date.now();
  const logger = traceLogger || createTraceLogger({ rootDir: await resolveRuntimeTraceRoot(rootDir || process.cwd()), runId });
  const resolvedPath = path.resolve(filePath);
  const resolvedWorkspaceRoot = workspaceRoot ? path.resolve(workspaceRoot) : null;
  const parentDir = path.dirname(resolvedPath);
  const prefix = safeName(artifactPrefix || `write-${fileHash(resolvedPath)}`);
  const started = await logger.toolStart?.({ tool: 'files_write', filePath: resolvedPath, workspaceRoot: resolvedWorkspaceRoot });
  const activityId = started?.payload?.activityId || null;

  async function fail(error, extra = {}) {
    const result = {
      tool: 'files_write',
      ok: false,
      filePath: resolvedPath,
      workspaceRoot: resolvedWorkspaceRoot,
      encoding,
      created: false,
      overwrote: false,
      bytesWritten: 0,
      error,
      durationMs: Date.now() - startedAt,
      artifacts: { beforePath: null, afterPath: null, resultPath: null },
      ...extra,
    };
    const resultPath = path.join(logger.traceDir, 'artifacts', `${prefix}-result.json`);
    result.artifacts.resultPath = resultPath;
    await fs.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
    await (logger.toolEnd || logger.tool)({ tool: 'files_write', ...(activityId ? { activityId } : {}), ok: false, filePath: resolvedPath, error, artifacts: result.artifacts });
    return result;
  }


  let existed = false;
  let beforeContent = '';
  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) return fail('target_not_a_file');
    existed = true;
    beforeContent = await fs.readFile(resolvedPath, encoding);
    if (!overwrite) return fail('target_exists_overwrite_false', { created: false, overwrote: false });
  } catch (error) {
    if (error?.code !== 'ENOENT') return fail(String(error?.message || error));
  }

  try {
    if (makeDirs) {
      await fs.mkdir(parentDir, { recursive: true });
    } else {
      await fs.access(parentDir);
    }

    const beforePath = existed ? await logger.artifact(`${prefix}-before.txt`, beforeContent, { encoding }) : null;
    await fs.writeFile(resolvedPath, String(content), encoding);
    const afterContent = await fs.readFile(resolvedPath, encoding);
    const afterPath = await logger.artifact(`${prefix}-after.txt`, afterContent, { encoding });

    const result = {
      tool: 'files_write',
      ok: true,
      filePath: resolvedPath,
      workspaceRoot: resolvedWorkspaceRoot,
      encoding,
      created: !existed,
      overwrote: existed,
      bytesWritten: byteLength(afterContent, encoding),
      error: null,
      durationMs: Date.now() - startedAt,
      artifacts: { beforePath, afterPath, resultPath: null },
    };
    const resultPath = path.join(logger.traceDir, 'artifacts', `${prefix}-result.json`);
    result.artifacts.resultPath = resultPath;
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
    await (logger.toolEnd || logger.tool)({
      tool: 'files_write',
      ...(activityId ? { activityId } : {}),
      ok: true,
      filePath: resolvedPath,
      created: result.created,
      overwrote: result.overwrote,
      bytesWritten: result.bytesWritten,
      durationMs: result.durationMs,
      artifacts: result.artifacts,
    });
    return result;
  } catch (error) {
    return fail(String(error?.message || error), { created: !existed, overwrote: existed });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootDir = process.argv[2] || process.cwd();
  const workspaceRoot = process.argv[3];
  const filePath = process.argv[4];
  const content = process.argv.slice(5).join(' ');
  const result = await writeFileEnvelope({ rootDir, runId: 'manual-write-smoke', workspaceRoot, filePath, content });
  console.log(JSON.stringify(result, null, 2));
}
