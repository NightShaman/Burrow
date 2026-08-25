import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_RETAINED_ITEMS = 12;
const MAX_RETAINED_BYTES = 64 * 1024;
export const READ_EVIDENCE_LIMITS = { maxItems: MAX_RETAINED_ITEMS, maxBytes: MAX_RETAINED_BYTES };

function text(value) { return String(value ?? ''); }
function unique(values = []) { return [...new Set(values.filter(Boolean))]; }

function headingsFromText(content = '') {
  return unique(text(content).split(/\r?\n/)
    .filter((line) => /^\s{0,3}#{1,6}\s+\S/.test(line))
    .map((line) => line.trim())
    .slice(0, 24));
}

function lineRange({ content = '', offsetBytes = 0 } = {}) {
  if (Number(offsetBytes || 0) !== 0) return null;
  const lines = text(content).split(/\r?\n/).length;
  return { start: 1, end: Math.max(1, lines) };
}

export function retainedReadEvidenceFromToolResults(toolResults = []) {
  const newestFirst = [];
  for (const result of [...(toolResults || [])].reverse()) {
    if (!result?.ok || result.tool !== 'files_read' || !result.filePath || typeof result.content !== 'string') continue;
    const excerpt = result.content;
    if (!excerpt) continue;
    newestFirst.push({
      path: path.resolve(result.filePath),
      version: {
        bytes: Number.isFinite(Number(result.bytes)) ? Number(result.bytes) : null,
        modifiedAt: result.modifiedAt || null,
        contentHash: result.contentHash || null,
      },
      range: { offsetBytes: Number(result.offsetBytes || 0), returnedBytes: Number(result.returnedBytes || Buffer.byteLength(result.content, result.encoding || 'utf8')), ...(lineRange(result) ? { lines: lineRange(result) } : {}) },
      truncated: Boolean(result.truncated || excerpt.length < result.content.length),
      headings: headingsFromText(excerpt),
      excerpt,
      observedAt: new Date().toISOString(),
    });
  }
  const seen = new Set();
  return newestFirst.filter((item) => {
    const key = `${item.path}\0${item.range.offsetBytes}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).reverse();
}

// New observations always win when the same file/range is read again.
export function mergeReadEvidence(newEvidence = [], existingEvidence = []) {
  const candidates = [...(newEvidence || []), ...(existingEvidence || [])];
  const seen = new Set();
  const retained = [];
  for (const item of candidates) {
    if (!item?.path || typeof item.excerpt !== 'string') continue;
    const key = `${item.path}\0${item.range?.offsetBytes || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Do not retain a partial or arbitrarily truncated excerpt: it would no
    // longer be an exact observation. Oversized entries remain available in
    // the current turn but are not promoted into session continuity.
    const next = [...retained, item];
    if (retained.length >= MAX_RETAINED_ITEMS || Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_RETAINED_BYTES) continue;
    retained.push(item);
  }
  return retained;
}

export async function validateReadEvidence(items = []) {
  const valid = [];
  for (const item of items || []) {
    if (!item?.path || !item.version) continue;
    try {
      const stat = await fs.stat(item.path);
      if (!stat.isFile()) continue;
      if (item.version.bytes !== null && Number(item.version.bytes) !== stat.size) continue;
      if (item.version.modifiedAt && new Date(item.version.modifiedAt).getTime() !== stat.mtime.getTime()) continue;
      valid.push(item);
    } catch { /* Missing/unreadable evidence is simply stale. */ }
  }
  return valid;
}
