import { randomUUID } from 'node:crypto';

export const SUBAGENT_CONTRACT_VERSION = 1;
export const SUBAGENT_KIND = 'subagent';

export const SUBAGENT_STATUSES = Object.freeze([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

export const FINAL_SUBAGENT_STATUSES = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

export const DEFAULT_SUBAGENT_PERMISSIONS = Object.freeze({
  mayRead: true,
  mayWrite: false,
  mayExecute: false,
  mayNetwork: false,
  mayCommit: false,
  allowedTools: Object.freeze(['files_read']),
});

const TRANSITIONS = Object.freeze({
  queued: Object.freeze(['running', 'cancelled']),
  running: Object.freeze(['succeeded', 'failed', 'cancelled', 'timed_out']),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
  timed_out: Object.freeze([]),
});

function compactString(value) {
  return String(value || '').trim();
}

function safeArray(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values]).filter(Boolean).map(String))];
}

function subagentId(value = null) {
  const raw = compactString(value);
  if (raw) {
    return raw
      .replace(/[^a-zA-Z0-9._:-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 160) || `dw_${randomUUID()}`;
  }
  return `dw_${randomUUID()}`;
}

function normalizeOwner(owner = {}) {
  return {
    sessionId: compactString(owner.sessionId) || 'default',
    conversationId: compactString(owner.conversationId) || null,
    turnId: compactString(owner.turnId) || null,
    parentRunId: compactString(owner.parentRunId) || null,
    requestedBy: compactString(owner.requestedBy) || 'user',
  };
}

function normalizeScope(scope = {}) {
  return {
    workspaceRoot: scope.workspaceRoot ? String(scope.workspaceRoot) : null,
    baseRoot: scope.baseRoot ? String(scope.baseRoot) : null,
    target: scope.target?.kind === 'filesystem' && compactString(scope.target.root) ? { kind: 'filesystem', root: String(scope.target.root) } : null,
    files: safeArray(scope.files),
    projects: safeArray(scope.projects),
    memoryProjects: safeArray(scope.memoryProjects),
  };
}

export function normalizeSubagentPermissions(permissions = {}) {
  const merged = { ...DEFAULT_SUBAGENT_PERMISSIONS, ...(permissions && typeof permissions === 'object' ? permissions : {}) };
  const allowedTools = safeArray(merged.allowedTools.length ? merged.allowedTools : DEFAULT_SUBAGENT_PERMISSIONS.allowedTools);
  const allowedReadPaths = safeArray(merged.allowedReadPaths);
  const allowedWritePaths = safeArray(merged.allowedWritePaths);
  return {
    mayRead: Boolean(merged.mayRead),
    mayWrite: Boolean(merged.mayWrite),
    mayExecute: Boolean(merged.mayExecute),
    mayNetwork: Boolean(merged.mayNetwork),
    mayCommit: Boolean(merged.mayCommit),
    allowedTools,
    ...(merged.toolSurface ? { toolSurface: String(merged.toolSurface) } : {}),
    ...(allowedReadPaths.length ? { allowedReadPaths } : {}),
    ...(allowedWritePaths.length ? { allowedWritePaths } : {}),
  };
}

function validatePermissions(permissions) {
  // First-class subagents record the normal runtime tool surface for
  // observability. Execution remains governed by the selected action and
  // runtime policy, not this legacy delegated-profile permission shape.
  if (permissions.toolSurface === 'normal-runtime-tools') return [];
  const blockers = [];
  if (permissions.mayCommit && !permissions.mayWrite) blockers.push('commit_requires_write_permission');
  if (!permissions.mayRead && permissions.allowedTools.includes('files_read')) blockers.push('read_file_tool_requires_read_permission');
  if (!permissions.mayWrite && permissions.allowedTools.some((tool) => ['files_write', 'files_patch'].includes(tool))) blockers.push('mutation_tool_requires_write_permission');
  if (!permissions.mayExecute && permissions.allowedTools.includes('shell_exec')) blockers.push('exec_tool_requires_execute_permission');
  return blockers;
}

function normalizeTrace(trace = {}) {
  return {
    runId: compactString(trace.runId) || null,
    traceDir: compactString(trace.traceDir) || null,
    childSessionId: compactString(trace.childSessionId) || null,
  };
}

function normalizeSpawnRequest(spawnRequest = null) {
  if (!spawnRequest || typeof spawnRequest !== 'object') return null;
  const key = compactString(spawnRequest.key);
  if (!key) return null;
  return {
    key,
    parentSessionId: compactString(spawnRequest.parentSessionId) || null,
    parentConversationId: compactString(spawnRequest.parentConversationId) || null,
    parentRunId: compactString(spawnRequest.parentRunId) || null,
    targetRoot: compactString(spawnRequest.targetRoot) || null,
    capability: compactString(spawnRequest.capability) || null,
    modelProfile: compactString(spawnRequest.modelProfile) || null,
    task: compactString(spawnRequest.task) || null,
  };
}

function normalizeModelSelection(model = null) {
  if (!model || typeof model !== 'object') return null;
  const requestedProfile = compactString(model.requestedProfile) || null;
  const resolvedProfile = compactString(model.resolvedProfile) || null;
  const resolvedModel = compactString(model.resolvedModel) || null;
  return requestedProfile || resolvedProfile || resolvedModel ? { requestedProfile, resolvedProfile, resolvedModel } : null;
}

function normalizeVerification(verification = null) {
  if (!verification || typeof verification !== 'object') return null;
  const status = compactString(verification.status);
  if (!['passed', 'failed', 'failed_expected', 'not_run'].includes(status)) return null;
  return {
    status,
    check: compactString(verification.check) || null,
    observed: compactString(verification.observed) || null,
    actionRequired: Boolean(verification.actionRequired),
  };
}

function normalizeResult(result = null) {
  if (!result || typeof result !== 'object') return null;
  const verification = normalizeVerification(result.verification);
  return {
    ok: Boolean(result.ok),
    summary: compactString(result.summary),
    blockers: safeArray(result.blockers),
    warnings: safeArray(result.warnings),
    evidence: Array.isArray(result.evidence) ? result.evidence : [],
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    changedFiles: safeArray(result.changedFiles),
    memoryWrites: Array.isArray(result.memoryWrites) ? result.memoryWrites : [],
    ...(verification ? { verification } : {}),
    ...(result.child && typeof result.child === 'object' ? { child: result.child } : {}),
    sideEffectsApplied: Boolean(result.sideEffectsApplied),
  };
}

export function createSubagentContract({
  id = null,
  owner = {},
  purpose,
  label = null,
  scope = {},
  permissions = {},
  status = 'queued',
  trace = {},
  spawnRequest = null,
  model = null,
  result = null,
  phase = null,
  provenance = [],
  createdAt = null,
  updatedAt = null,
} = {}) {
  const normalizedStatus = SUBAGENT_STATUSES.includes(status) ? status : 'queued';
  const normalizedPermissions = normalizeSubagentPermissions(permissions);
  const contract = {
    contractVersion: SUBAGENT_CONTRACT_VERSION,
    kind: SUBAGENT_KIND,
    id: subagentId(id),
    owner: normalizeOwner(owner),
    purpose: compactString(purpose),
    label: compactString(label).slice(0, 80) || null,
    scope: normalizeScope(scope),
    permissions: normalizedPermissions,
    status: normalizedStatus,
    phase: compactString(phase) || (normalizedStatus === 'running' ? 'thinking' : 'idle'),
    trace: normalizeTrace(trace),
    spawnRequest: normalizeSpawnRequest(spawnRequest),
    model: normalizeModelSelection(model),
    result: normalizeResult(result),
    provenance: Array.isArray(provenance) ? provenance : [],
    createdAt: createdAt || null,
    updatedAt: updatedAt || null,
  };
  assertSubagentContract(contract);
  return contract;
}

export function isFinalSubagentStatus(status) {
  return FINAL_SUBAGENT_STATUSES.includes(status);
}

export function subagentTransition({ current, next } = {}) {
  if (!SUBAGENT_STATUSES.includes(current)) return { ok: false, blockers: [`unknown_current_status:${current}`] };
  if (!SUBAGENT_STATUSES.includes(next)) return { ok: false, blockers: [`unknown_next_status:${next}`] };
  if (current === next) return { ok: true, blockers: [] };
  if (TRANSITIONS[current].includes(next)) return { ok: true, blockers: [] };
  if (isFinalSubagentStatus(current)) return { ok: false, blockers: ['subagent_final_status'] };
  return { ok: false, blockers: [`invalid_transition:${current}->${next}`] };
}

export function assertSubagentContract(contract) {
  if (contract?.kind !== SUBAGENT_KIND) throw new Error('delegated work contract requires kind="subagent"');
  if (contract.contractVersion !== SUBAGENT_CONTRACT_VERSION) throw new Error('unsupported delegated work contract version');
  if (!compactString(contract.id)) throw new Error('delegated work contract requires id');
  if (!compactString(contract.purpose)) throw new Error('delegated work contract requires purpose');
  if (!SUBAGENT_STATUSES.includes(contract.status)) throw new Error(`unknown delegated work status: ${contract.status}`);
  if (!contract.owner || typeof contract.owner !== 'object') throw new Error('delegated work contract requires owner');
  if (!compactString(contract.owner.sessionId)) throw new Error('delegated work contract requires owner.sessionId');
  if (!contract.scope || typeof contract.scope !== 'object') throw new Error('delegated work contract requires scope');
  if (!contract.permissions || typeof contract.permissions !== 'object') throw new Error('delegated work contract requires permissions');
  const permissionBlockers = validatePermissions(contract.permissions);
  if (permissionBlockers.length) throw new Error(`invalid delegated work permissions: ${permissionBlockers.join(',')}`);
  if (isFinalSubagentStatus(contract.status) && !contract.result) throw new Error('final delegated work status requires result');
  if (contract.result && typeof contract.result.summary !== 'string') throw new Error('delegated work result requires summary string');
  return true;
}

export const __subagentContract__ = Object.freeze({
  kind: SUBAGENT_KIND,
  statuses: SUBAGENT_STATUSES,
  finalStatuses: FINAL_SUBAGENT_STATUSES,
  defaultPermissions: DEFAULT_SUBAGENT_PERMISSIONS,
});
