import { normalizeRemotePathForMatching, resolveRemotePath } from './remote-execution-path.mjs';
// All configured regex/glob matching (including validation during evaluation)
// runs only in this disposable worker, using the same Node/V8 RegExp semantics.
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { validateExecutionBoundaries, emptyExecutionBoundaries } from './execution-boundaries.mjs';

function text(value) { return String(value || '').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function unique(values = []) { return [...new Set(asArray(values).filter(Boolean))]; }

function globToRegex(pattern, flags = '') {
  let source = '^';
  const input = text(pattern);
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '*') {
      if (input[index + 1] === '*') { source += '.*'; index += 1; }
      else source += '[^/]*';
    } else if ('\\^$+?.()|{}[]'.includes(char)) source += `\\${char}`;
    else source += char;
  }
  return new RegExp(`${source}$`, flags);
}

function resolveTarget(value, baseRoot, remote) {
  const raw = remote ? String(value || '') : text(value);
  if (!raw) return null;
  if (remote) {
    try { return normalizeRemotePathForMatching(resolveRemotePath(raw, baseRoot)); }
    catch { return null; }
  }
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(baseRoot || process.cwd(), raw);
}

function pathMatches(resolved, rule, remote, baseRoot) {
  if (!resolved) return false;
  const windows = (!remote && process.platform === 'win32') || (remote && /^(?:[a-z]:\/|\/\/)/i.test(resolved));
  const literal = remote && windows ? rule.pattern.replaceAll('\\', '/') : rule.pattern;
  const pattern = ['exact', 'prefix'].includes(rule.match)
    ? resolveTarget(rule.pattern, baseRoot, remote)
    : (remote ? normalizeRemotePathForMatching(rule.pattern) || literal : rule.pattern);
  if (!pattern) return false;
  const separator = remote ? '/' : path.sep;
  const comparisonTarget = windows ? resolved.toLowerCase() : resolved;
  const comparisonPattern = windows ? pattern.toLowerCase() : pattern;
  const flags = windows ? 'i' : '';
  if (rule.match === 'exact') return comparisonTarget === comparisonPattern;
  if (rule.match === 'prefix') return comparisonTarget === comparisonPattern || comparisonTarget.startsWith(comparisonPattern.endsWith(separator) ? comparisonPattern : `${comparisonPattern}${separator}`);
  if (rule.match === 'contains') return comparisonTarget.includes(windows ? literal.toLowerCase() : literal);
  if (rule.match === 'regex') return new RegExp(rule.pattern, flags).test(resolved);
  return globToRegex(literal, flags).test(resolved);
}

function commandMatches(command, rule) {
  const value = String(command || '');
  if (!value) return false;
  if (rule.match === 'exact') return value === rule.pattern;
  if (rule.match === 'prefix') return value.startsWith(rule.pattern);
  if (rule.match === 'contains') return value.includes(rule.pattern);
  if (rule.match === 'glob') return globToRegex(rule.pattern).test(value);
  return new RegExp(rule.pattern, 'i').test(value);
}

function blockerFor(rule) { return `blast_radius:hard_policy_block:user_configured_hard_block:${rule.id}`; }

function evaluateExecutionBoundaries({ boundaries = null, operation = null, command = '', paths = [], readScope = 'direct', baseRoot = null, remote = false } = {}) {
  const op = text(operation).toLowerCase();
  const checked = validateExecutionBoundaries(boundaries || emptyExecutionBoundaries());
  if (!checked.ok) return { ok: false, blockers: ['blast_radius:hard_policy_block:execution_boundary_evaluation_invalid'], matches: [], evaluation: { status: 'invalid', errors: checked.errors } };
  const rules = checked.boundaries.hardBlocks.filter((rule) => rule.enabled && rule.operations.includes(op));
  const matches = [];
  for (const rule of rules) {
    if (rule.type === 'command' && op === 'execute' && commandMatches(command, rule)) matches.push({ rule, target: String(command || '') });
    if (rule.type === 'path') {
      for (const item of asArray(paths)) {
        const target = resolveTarget(item, baseRoot, remote);
        if (pathMatches(target, rule, remote, baseRoot)) matches.push({ rule, target });
        else if (op === 'read' && readScope !== 'direct') {
          // Git can discover a repository above cwd; arbitrary patterns also
          // have no proven negative subtree intersection test.
          const protectedTarget = resolveTarget(rule.pattern, baseRoot, remote);
          const unresolved = readScope === 'repository' || !['exact', 'prefix'].includes(rule.match) || !target || !protectedTarget;
          const overlaps = !unresolved && pathMatches(protectedTarget, { ...rule, match: 'prefix', pattern: target }, remote, baseRoot);
          if (unresolved || overlaps) matches.push({ rule, target, scope: readScope,
            scopeResolution: unresolved ? 'unresolved' : 'descendant_overlap' });
        }
      }
    }
  }
  const uniqueMatches = [];
  const seen = new Set();
  for (const match of matches) {
    const key = `${match.rule.id}:${match.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueMatches.push(match);
  }
  return {
    ok: uniqueMatches.length === 0,
    blockers: unique(uniqueMatches.map(({ rule }) => blockerFor(rule))),
    matches: uniqueMatches.map(({ rule, target, scope, scopeResolution }) => ({ ...(scope ? { scope, scopeResolution } : {}), id: rule.id, type: rule.type, pattern: rule.pattern, match: rule.match, operations: rule.operations, operation: op, target, reason: rule.reason || null, blocker: blockerFor(rule) })),
  };
}

parentPort.postMessage(evaluateExecutionBoundaries(workerData));
parentPort.close();
