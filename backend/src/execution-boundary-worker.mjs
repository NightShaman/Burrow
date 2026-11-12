// All configured regex/glob matching (including validation during evaluation)
// runs only in this disposable worker, using the same Node/V8 RegExp semantics.
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { validateExecutionBoundaries, emptyExecutionBoundaries } from './execution-boundaries.mjs';

function text(value) { return String(value || '').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function unique(values = []) { return [...new Set(asArray(values).filter(Boolean))]; }

function globToRegex(pattern) {
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
  return new RegExp(`${source}$`);
}

function resolveTarget(value, baseRoot = null) {
  const raw = text(value);
  if (!raw) return null;
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(baseRoot || process.cwd(), raw);
}

function pathMatches(value, rule, { baseRoot = null } = {}) {
  const resolved = resolveTarget(value, baseRoot);
  if (!resolved) return false;
  const pattern = path.isAbsolute(rule.pattern) ? path.resolve(rule.pattern) : rule.pattern;
  if (rule.match === 'exact') return resolved === pattern;
  if (rule.match === 'prefix') return resolved === pattern || resolved.startsWith(pattern.endsWith(path.sep) ? pattern : `${pattern}${path.sep}`);
  if (rule.match === 'contains') return resolved.includes(rule.pattern);
  if (rule.match === 'regex') return new RegExp(rule.pattern).test(resolved);
  return globToRegex(rule.pattern).test(resolved);
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

function evaluateExecutionBoundaries({ boundaries = null, operation = null, command = '', paths = [], baseRoot = null } = {}) {
  const op = text(operation).toLowerCase();
  const checked = validateExecutionBoundaries(boundaries || emptyExecutionBoundaries());
  if (!checked.ok) return { ok: false, blockers: ['blast_radius:hard_policy_block:execution_boundary_evaluation_invalid'], matches: [], evaluation: { status: 'invalid', errors: checked.errors } };
  const rules = checked.boundaries.hardBlocks.filter((rule) => rule.enabled && rule.operations.includes(op));
  const matches = [];
  for (const rule of rules) {
    if (rule.type === 'command' && op === 'execute' && commandMatches(command, rule)) matches.push({ rule, target: String(command || '') });
    if (rule.type === 'path') {
      for (const item of asArray(paths)) if (pathMatches(item, rule, { baseRoot })) matches.push({ rule, target: resolveTarget(item, baseRoot) });
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
    matches: uniqueMatches.map(({ rule, target }) => ({ id: rule.id, type: rule.type, pattern: rule.pattern, match: rule.match, operations: rule.operations, operation: op, target, reason: rule.reason || null, blocker: blockerFor(rule) })),
  };
}

parentPort.postMessage(evaluateExecutionBoundaries(workerData));
parentPort.close();
