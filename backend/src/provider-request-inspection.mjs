import { promises as fs } from 'node:fs';
import path from 'node:path';

async function readJsonLines(filePath) {
  try {
    return (await fs.readFile(filePath, 'utf8')).split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function isInternalRequest(record) {
  const manifest = record?.payload?.providerMessageManifest || [];
  return manifest.length > 0 && manifest.every((message) => message?.source === 'internal-curation' || message?.source === 'internal-planner');
}

/**
 * Loads a persisted request body actually sent to a provider. Prefer `runId`
 * from the context meter: a later internal curation/planner request is not the
 * agent's running chat context and must not win `/context full` selection.
 */
export async function latestProviderRequest({ traceSessionRoot, sessionId = 'default', runId = null } = {}) {
  if (!traceSessionRoot) throw new Error('trace_session_root_required');
  let entries;
  try { entries = await fs.readdir(traceSessionRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const runs = (await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const runDir = path.join(traceSessionRoot, entry.name);
    try { return { runDir, name: entry.name, mtimeMs: (await fs.stat(runDir)).mtimeMs }; } catch { return null; }
  }))).filter(Boolean).sort((left, right) => (left.name === runId ? -1 : right.name === runId ? 1 : right.mtimeMs - left.mtimeMs));
  for (const run of runs) {
    if (runId && run.name !== runId) continue;
    const requests = (await readJsonLines(path.join(run.runDir, 'model.jsonl')))
      .filter((record) => record?.sessionId === sessionId && record?.payload?.stage === 'model-request' && !isInternalRequest(record))
      .reverse();
    for (const record of requests) {
      const artifactPath = record.payload?.providerRequestArtifact || null;
      if (!artifactPath) continue;
      try {
        const resolvedArtifact = path.resolve(artifactPath);
        const artifactsRoot = path.resolve(run.runDir, 'artifacts') + path.sep;
        if (!resolvedArtifact.startsWith(artifactsRoot)) continue;
        const body = JSON.parse(await fs.readFile(resolvedArtifact, 'utf8'));
        return { runId: record.runId, ts: record.ts, artifactPath: resolvedArtifact, payload: record.payload, body };
      } catch (error) {
        if (error?.code !== 'ENOENT' && error instanceof SyntaxError === false) throw error;
      }
    }
  }
  return null;
}
