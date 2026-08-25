import { summarizeToolResults } from './runtime-result-shapes.mjs';

const DEFAULT_MAX_CHARS = 6_000;
const DEFAULT_MAX_ITEMS = 24;

function compactText(value, maxChars) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function resultSubject(result = {}) {
  return compactText(
    result.filePath || result.path || result.dirPath || result.command || result.mcpToolName || result.query || result.pattern || result.task?.title || result.id,
    240,
  );
}

function resultFinding(result = {}) {
  const candidates = [
    result.error,
    result.summary,
    result.preview,
    result.reason,
    result.stdout,
    result.stderr,
    result.reply?.content,
  ];
  for (const candidate of candidates) {
    const value = compactText(candidate, 480);
    if (value) return value;
  }
  if (Array.isArray(result.changedFiles) && result.changedFiles.length) return `changed ${result.changedFiles.slice(0, 8).join(', ')}`;
  if (Array.isArray(result.touchedFiles) && result.touchedFiles.length) return `touched ${result.touchedFiles.slice(0, 8).join(', ')}`;
  if (typeof result.exists === 'boolean') return result.exists ? 'path exists' : 'path does not exist';
  if (Number.isFinite(Number(result.exitCode))) return `exit ${result.exitCode}`;
  if (Number.isFinite(Number(result.resultCount))) return `${result.resultCount} result${Number(result.resultCount) === 1 ? '' : 's'}`;
  return result.ok === false ? 'failed without a detailed error' : 'completed';
}

function digestLine(result = {}) {
  const tool = compactText(result.tool || result.mcpToolName || 'tool', 120);
  const subject = resultSubject(result);
  const status = result.ok === false ? 'failed' : result.ok === true ? 'ok' : 'completed';
  const finding = resultFinding(result);
  return `- ${tool}${subject ? ` (${subject})` : ''}: ${status}${finding ? ` — ${finding}` : ''}`;
}

function isMutation(result = {}) {
  return Boolean(
    result.sideEffectsApplied
    || (Array.isArray(result.changedFiles) && result.changedFiles.length)
    || (Array.isArray(result.touchedFiles) && result.touchedFiles.length)
    || ['files_write', 'files_edit', 'files_patch'].includes(result.tool),
  );
}

function isOutcome(result = {}) {
  if (result.verificationCheck === true) return true;
  const command = String(result.command || '');
  return result.tool === 'shell_exec' && /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:check|test|lint|build)\b|\b(?:check|test|lint|build|verify|validate)\b|\bgit\s+(?:commit|push)\b|\b(?:deploy|release)\b/i.test(command);
}

function targetKey(result = {}) {
  return `${result.tool || result.mcpToolName || 'tool'}\u0000${resultSubject(result) || 'default'}`;
}

/**
 * Keep the semantic handoff biased toward consequences, not the first handful
 * of inspections. A late failed check, mutation, or deployment is more useful
 * to the next turn than an early directory listing. Raw tool protocol remains
 * trace/audit material.
 */
function selectDigestResults(results, limit) {
  const selected = new Set();
  const add = (index) => {
    if (selected.size < limit) selected.add(index);
  };

  // Preserve all material outcomes first, in run order within each class.
  for (let index = 0; index < results.length; index += 1) if (results[index].ok === false) add(index);
  for (let index = 0; index < results.length; index += 1) if (isMutation(results[index])) add(index);
  for (let index = 0; index < results.length; index += 1) if (isOutcome(results[index])) add(index);

  // For routine work, retain the most recent result for each tool/target pair.
  // Iterate backwards so repeated reads/searches do not evict their latest fact.
  const seenTargets = new Set();
  for (let index = results.length - 1; index >= 0 && selected.size < limit; index -= 1) {
    const key = targetKey(results[index]);
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    add(index);
  }

  // Fill remaining space from the end of the run, where final findings live.
  for (let index = results.length - 1; index >= 0 && selected.size < limit; index -= 1) add(index);

  return [...selected].sort((left, right) => left - right).map((index) => results[index]);
}

/**
 * A bounded semantic handoff for one tool-using run. Raw tool protocol and full
 * outputs remain trace/audit material; this is the only execution record that
 * returns to ordinary provider conversation on later turns.
 */
export function buildExecutionDigest({ toolResults = [], maxChars = DEFAULT_MAX_CHARS, maxItems = DEFAULT_MAX_ITEMS } = {}) {
  const results = summarizeToolResults(toolResults);
  if (!results.length) return null;
  const limit = Math.max(1, Number(maxItems) || DEFAULT_MAX_ITEMS);
  const selected = selectDigestResults(results, limit);
  const lines = selected.map(digestLine);
  if (results.length > selected.length) lines.push(`- ${results.length - selected.length} additional tool result${results.length - selected.length === 1 ? '' : 's'} omitted from this digest; raw execution history remains available in the session trace.`);
  const failures = results.filter((result) => result.ok === false).length;
  const header = `Execution digest for this completed run: ${results.length} tool call${results.length === 1 ? '' : 's'}; ${failures ? `${failures} failed` : 'all reported successful or completed'}.`;
  const text = [header, ...lines].join('\n');
  return compactText(text, Math.max(256, Number(maxChars) || DEFAULT_MAX_CHARS));
}
