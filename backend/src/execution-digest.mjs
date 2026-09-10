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
  if (result.protection?.status === 'protected') return `${Number(result.protection.count) || 0} sensitive value${Number(result.protection.count) === 1 ? '' : 's'} protected`;
  if (result.protection?.status === 'withheld') return `sensitive response withheld${result.protection.reason ? ` (${result.protection.reason})` : ''}`;
  if (result.protection?.status === 'clear' && result.tool === 'mcp_call') return 'response declared clear';
  if (Array.isArray(result.changedFiles) && result.changedFiles.length) return `changed ${result.changedFiles.slice(0, 8).join(', ')}`;
  if (Array.isArray(result.touchedFiles) && result.touchedFiles.length) return `touched ${result.touchedFiles.slice(0, 8).join(', ')}`;
  const candidates = result.ok === false
    ? [result.error, result.stderr, result.summary, result.preview, result.stdout, result.content, result.reply?.error, result.reply?.content]
    : [result.error, result.summary, result.preview, result.content, result.stdout, result.stderr, result.reply?.content];
  for (const candidate of candidates) {
    const value = compactText(candidate, 480);
    if (value) return value;
  }
  if (typeof result.exists === 'boolean') return result.exists ? 'path exists' : 'path does not exist';
  if (Number.isFinite(Number(result.exitCode))) return `exit ${result.exitCode}`;
  if (Number.isFinite(Number(result.resultCount))) return `${result.resultCount} result${Number(result.resultCount) === 1 ? '' : 's'}`;
  return result.ok === false ? 'failed without a detailed error' : 'completed';
}

function executionOrigin(result = {}) {
  const execution = result.execution && typeof result.execution === 'object' ? result.execution : {};
  const origin = execution.kind === 'remote'
    ? `remote${execution.targetId ? `:${compactText(execution.targetId, 120)}` : ''}${execution.providerId ? ` via ${compactText(execution.providerId, 80)}` : ''}`
    : execution.kind === 'local' ? 'local' : '';
  const correlation = [
    execution.operationId ? `operation:${compactText(execution.operationId, 160)}` : '',
    execution.toolCallId ? `call:${compactText(execution.toolCallId, 160)}` : '',
    execution.parentRunId ? `parent:${compactText(execution.parentRunId, 160)}` : '',
  ];
  return [origin, ...correlation].filter(Boolean).join('; ');
}

function digestLine(result = {}) {
  const tool = compactText(result.tool || result.mcpToolName || 'tool', 120);
  const subject = resultSubject(result);
  const origin = executionOrigin(result);
  const status = result.ok === false ? 'failed' : result.ok === true ? 'ok' : 'completed';
  const finding = resultFinding(result);
  return `- ${tool}${subject ? ` (${subject})` : ''}${origin ? ` [${origin}]` : ''}: ${status}${finding ? ` — ${finding}` : ''}`;
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
  return result.verificationCheck === true;
}

function targetKey(result = {}) {
  return `${result.tool || result.mcpToolName || 'tool'}\u0000${result.execution?.kind || ''}:${result.execution?.providerId || ''}:${result.execution?.targetId || ''}\u0000${resultSubject(result) || 'default'}`;
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

  // Failures and explicit structured outcomes are consequences. Walk newest
  // first so a final failure cannot be displaced by older successful checks.
  for (let index = results.length - 1; index >= 0; index -= 1) if (results[index].ok === false) add(index);
  for (let index = results.length - 1; index >= 0; index -= 1) if (isOutcome(results[index])) add(index);
  for (let index = results.length - 1; index >= 0; index -= 1) if (isMutation(results[index])) add(index);

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

  return [...selected].map((index) => results[index]);
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
