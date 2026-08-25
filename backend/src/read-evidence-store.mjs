import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mergeReadEvidence } from './read-evidence.mjs';

function safeId(value) { return String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'default'; }
function evidencePath(rootDir, sessionId) { return path.join(path.resolve(rootDir), 'sessions', safeId(sessionId), 'read-evidence.json'); }

// ReadEvidence is active-session evidence, deliberately separate from bounded
// session metadata. Its merge path bounds persistence; prompt assembly applies
// the additional per-request injection budget.
export async function writeSessionReadEvidence({ rootDir, sessionId, evidence = [] } = {}) {
  if (!rootDir || !sessionId) return [];
  const retained = mergeReadEvidence(evidence, []);
  const filePath = evidencePath(rootDir, sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(retained)}\n`, 'utf8');
  return retained;
}

export async function readSessionReadEvidence({ rootDir, sessionId } = {}) {
  if (!rootDir || !sessionId) return [];
  try {
    const parsed = JSON.parse(await fs.readFile(evidencePath(rootDir, sessionId), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) return []; throw error; }
}
