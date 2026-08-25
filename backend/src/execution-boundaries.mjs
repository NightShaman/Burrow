import path from 'node:path';
import { getSettingsMeta, openSettingsDatabase, setSettingsMeta, settingsDatabasePath } from './settings-database.mjs';

export const EXECUTION_BOUNDARIES_META_KEY = 'execution_boundaries';
export const BOUNDARY_OPERATIONS = Object.freeze(['read', 'write', 'delete', 'execute', 'delegate']);
export const BOUNDARY_TYPES = Object.freeze(['path', 'command']);
export const BOUNDARY_MATCHES = Object.freeze(['exact', 'prefix', 'glob', 'regex', 'contains']);

const OPERATION_SET = new Set(BOUNDARY_OPERATIONS);
const TYPE_SET = new Set(BOUNDARY_TYPES);
const MATCH_SET = new Set(BOUNDARY_MATCHES);

function text(value) { return String(value || '').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function unique(values = []) { return [...new Set(asArray(values).filter(Boolean))]; }
function safeId(value) { return text(value).replace(/[^a-zA-Z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120); }

export function emptyExecutionBoundaries() { return { version: 1, hardBlocks: [] }; }

function normalizeRule(rule = {}, index = 0, errors = []) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    errors.push(`hardBlocks.${index}_must_be_object`);
    return null;
  }
  const id = safeId(rule.id || rule.name);
  const type = text(rule.type).toLowerCase();
  const pattern = text(rule.pattern);
  const match = text(rule.match || (type === 'command' ? 'regex' : 'glob')).toLowerCase();
  const operations = unique(asArray(rule.operations).map((item) => text(item).toLowerCase()).filter(Boolean));
  if (!id) errors.push(`hardBlocks.${index}.id_required`);
  if (!TYPE_SET.has(type)) errors.push(`hardBlocks.${index}.type_invalid`);
  if (!pattern) errors.push(`hardBlocks.${index}.pattern_required`);
  if (!MATCH_SET.has(match)) errors.push(`hardBlocks.${index}.match_invalid`);
  if (!operations.length) errors.push(`hardBlocks.${index}.operations_required`);
  for (const op of operations) if (!OPERATION_SET.has(op)) errors.push(`hardBlocks.${index}.operations_invalid:${op}`);
  if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') errors.push(`hardBlocks.${index}.enabled_must_be_boolean`);
  if (rule.reason !== undefined && rule.reason !== null && typeof rule.reason !== 'string') errors.push(`hardBlocks.${index}.reason_must_be_string`);
  if (match === 'regex' && pattern) {
    try { new RegExp(pattern); } catch { errors.push(`hardBlocks.${index}.pattern_regex_invalid`); }
  }
  if (!id || !TYPE_SET.has(type) || !pattern || !MATCH_SET.has(match) || !operations.length || operations.some((op) => !OPERATION_SET.has(op))) return null;
  return {
    id,
    enabled: rule.enabled !== false,
    type,
    pattern,
    match,
    operations,
    ...(text(rule.reason) ? { reason: text(rule.reason) } : {}),
  };
}

export function validateExecutionBoundaries(input = {}) {
  const source = input?.boundaries && typeof input.boundaries === 'object' ? input.boundaries : input;
  const errors = [];
  const rawRules = source?.hardBlocks ?? [];
  if (!Array.isArray(rawRules)) return { ok: false, errors: ['hardBlocks_must_be_array'], boundaries: emptyExecutionBoundaries() };
  const seen = new Set();
  const hardBlocks = [];
  rawRules.forEach((rule, index) => {
    const normalized = normalizeRule(rule, index, errors);
    if (!normalized) return;
    if (seen.has(normalized.id)) {
      errors.push(`hardBlocks.${index}.id_duplicate`);
      return;
    }
    seen.add(normalized.id);
    hardBlocks.push(normalized);
  });
  return { ok: errors.length === 0, errors, boundaries: { version: 1, hardBlocks } };
}

export function readExecutionBoundaries({ databasePath = null } = {}) {
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try {
    const stored = getSettingsMeta(db, EXECUTION_BOUNDARIES_META_KEY);
    const checked = validateExecutionBoundaries(stored || emptyExecutionBoundaries());
    return checked.ok ? checked.boundaries : emptyExecutionBoundaries();
  } finally { db.close(); }
}

export function saveExecutionBoundaries(input = {}, { databasePath = null } = {}) {
  const checked = validateExecutionBoundaries(input);
  if (!checked.ok) return { ok: false, status: 400, errors: checked.errors, boundaries: checked.boundaries };
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try {
    setSettingsMeta(db, EXECUTION_BOUNDARIES_META_KEY, checked.boundaries);
    return { ok: true, boundaries: checked.boundaries, validation: { ok: true, errors: [] } };
  } finally { db.close(); }
}

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

export function evaluateExecutionBoundaries({ boundaries = null, operation = null, command = '', paths = [], baseRoot = null } = {}) {
  const op = text(operation).toLowerCase();
  const checked = validateExecutionBoundaries(boundaries || emptyExecutionBoundaries());
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

export function executionBoundaryStatus(boundaries = null) {
  const checked = validateExecutionBoundaries(boundaries || emptyExecutionBoundaries());
  const hardBlocks = checked.boundaries.hardBlocks;
  return { enabled: hardBlocks.some((rule) => rule.enabled), hardBlockCount: hardBlocks.length, enabledHardBlockCount: hardBlocks.filter((rule) => rule.enabled).length, hardBlocks };
}

export const __executionBoundaries = Object.freeze({ globToRegex, pathMatches, commandMatches, blockerFor });
