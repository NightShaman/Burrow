import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSubagentRecord, findSubagentBySpawnRequestKey, updateSubagentStatus, subagentVisibilitySummary } from './subagent-store.mjs';
import { finishSubagentChildSession, startSubagentChildSession, subagentChildSessionId } from './subagent-session.mjs';
import { resolveExecutionTarget } from './execution-context.mjs';
import { executionPolicyAllowsCommit, executionPolicyAllowsMutation, normalizeExecutionPolicyInput } from './execution-policy.mjs';
import { runSubagentProcess } from './subagent-process-runner.mjs';
import { resolveSubagentTimeoutConfig } from './config.mjs';

function compactString(value) {
  return String(value || '').trim();
}

function compactText(value, maxChars) {
  const text = String(value || '');
  return text.length > maxChars ? `${text.slice(0, maxChars)}
[${text.length - maxChars} chars omitted]` : text;
}

const SALVAGED_EVIDENCE_BUDGET = 36_000;
const SALVAGED_EVIDENCE_SINGLE_TEXT = 4_000;

function compactSalvagedEvidence(result = {}) {
  const base = { tool: result.tool || 'unknown', ok: Boolean(result.ok), salvagedFromTrace: true };
  if (result.filePath) base.filePath = result.filePath;
  if (result.path) base.path = result.path;
  if (result.dirPath) base.dirPath = result.dirPath;
  if (result.command) base.command = compactText(result.command, 600);
  if (Number.isFinite(Number(result.exitCode))) base.exitCode = result.exitCode;
  if (result.error) base.error = compactText(result.error, 800);
  if (result.tool === 'files_read') {
    return { ...base, offsetBytes: Number(result.offsetBytes || 0), returnedBytes: Number(result.returnedBytes || 0), bytes: Number(result.bytes || 0), truncated: Boolean(result.truncated), content: compactText(result.content, SALVAGED_EVIDENCE_SINGLE_TEXT) };
  }
  if (result.tool === 'shell_exec' || result.tool === 'git_status' || result.tool === 'git_diff') {
    return { ...base, stdout: compactText(result.stdout, SALVAGED_EVIDENCE_SINGLE_TEXT), stderr: compactText(result.stderr, 1_200) };
  }
  if (result.tool === 'files_list') {
    return { ...base, entries: (result.entries || []).slice(0, 120).map((entry) => ({ path: entry?.path || null, type: entry?.type || null })), truncated: Boolean(result.truncated) };
  }
  if (result.tool === 'files_find') return { ...base, pattern: result.pattern || null, paths: (result.paths || []).slice(0, 160), truncated: Boolean(result.truncated) };
  if (result.tool === 'files_search') return { ...base, query: result.query || null, matches: (result.matches || []).slice(0, 120).map((match) => ({ filePath: match?.filePath || null, line: match?.line ?? null, text: compactText(match?.text, 500) })), truncated: Boolean(result.truncated) };
  if (result.tool === 'files_inspect') return { ...base, exists: typeof result.exists === 'boolean' ? result.exists : null, type: result.type || null, size: Number.isFinite(Number(result.size)) ? result.size : null };
  return base;
}

async function salvageEvidenceFromTrace(traceDir) {
  if (!traceDir) return [];
  const artifactsDir = path.join(traceDir, 'artifacts');
  let entries;
  try { entries = await fs.readdir(artifactsDir, { withFileTypes: true }); } catch { return []; }
  const evidence = [];
  let used = 0;
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('-result.json')).sort((a, b) => a.name.localeCompare(b.name))) {
    let parsed;
    try { parsed = JSON.parse(await fs.readFile(path.join(artifactsDir, entry.name), 'utf8')); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || !parsed.tool) continue;
    const compact = compactSalvagedEvidence(parsed);
    const chars = JSON.stringify(compact).length;
    if (used + chars > SALVAGED_EVIDENCE_BUDGET) {
      evidence.push({ tool: parsed.tool || 'unknown', ok: Boolean(parsed.ok), salvagedFromTrace: true, omitted: true, reason: 'subagent_timeout_salvage_budget' });
      break;
    }
    evidence.push(compact);
    used += chars;
  }
  return evidence;
}

function safeId(value) {
  return compactString(value).replace(/[^a-zA-Z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

function normalizeTaskForSpawnRequest(value) {
  return compactString(value).replace(/\s+/g, ' ');
}

function requestedTimeout(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

function resolveSubagentTimeout({ requested = null, policy = resolveSubagentTimeoutConfig() } = {}) {
  const source = requested === null ? 'runtime_default' : 'tool_request';
  const candidate = requested === null ? policy.defaultTimeoutMs : requested;
  const effectiveTimeoutMs = Math.min(policy.maxTimeoutMs, Math.max(policy.minTimeoutMs, candidate));
  return { requestedTimeoutMs: requested, effectiveTimeoutMs, timeoutSource: source, timeoutClamped: candidate !== effectiveTimeoutMs };
}


function spawnRequestIdentity({ parentSessionId, parentConversationId, parentRunId, targetRoot, capability, modelProfile, task, timeoutMs } = {}) {
  // Transparent deterministic identity from explicit request fields. This is
  // deliberately mechanical: it must not infer semantic task equivalence.
  return JSON.stringify({
    parentSessionId: compactString(parentSessionId) || 'default',
    parentConversationId: compactString(parentConversationId) || null,
    parentRunId: compactString(parentRunId) || null,
    targetRoot: compactString(targetRoot) || null,
    capability: compactString(capability) || 'spawn_subagent',
    modelProfile: compactString(modelProfile) || null,
    task: normalizeTaskForSpawnRequest(task),
    timeoutMs: requestedTimeout(timeoutMs),
  });
}

function reusedSubagentResult({ record, task, target, request } = {}) {
  const result = record?.result || {};
  const child = result.child || {};
  return {
    tool: 'spawn_subagent',
    ok: Boolean(result.ok),
    spawned: false,
    reused: true,
    id: record.id,
    task,
    label: record.label || null,
    requestedModelProfile: record.model?.requestedProfile || null,
    resolvedModelProfile: record.model?.resolvedProfile || null,
    resolvedModel: record.model?.resolvedModel || null,
    target,
    status: record.status,
    parentSessionId: record.owner?.sessionId || null,
    parentConversationId: record.owner?.conversationId || null,
    parentRunId: record.owner?.parentRunId || record.owner?.turnId || null,
    childSessionId: record.trace?.childSessionId || child.childSessionId || null,
    transcriptRef: child.transcriptRef || null,
    receiptRefs: child.receiptRefs || [],
    retention: child.retention || null,
    evidence: result.evidence || [],
    blockers: result.blockers || [],
    warnings: [...(result.warnings || []), 'subagent_exact_request_reused'],
    summary: result.summary || 'Reused existing subagent receipt.',
    spawnRequestKey: request.key,
    record: subagentVisibilitySummary(record),
    queued: null,
    running: null,
    childRun: null,
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function refineRepositoryTarget(target) {
  if (target?.kind !== 'filesystem' || !target.root) return { target, warnings: [] };
  const nestedRepo = path.join(target.root, 'repo');
  const parentHasRepoSignals = await pathExists(path.join(target.root, '.git')) || await pathExists(path.join(target.root, 'package.json'));
  const nestedHasRepoSignals = await pathExists(path.join(nestedRepo, '.git')) || await pathExists(path.join(nestedRepo, 'package.json'));
  if (!parentHasRepoSignals && nestedHasRepoSignals) {
    return { target: Object.freeze({ ...target, root: nestedRepo }), warnings: [`subagent_target_refined_to_nested_repo:${nestedRepo}`] };
  }
  return { target, warnings: [] };
}

function childFrom({ parentSessionId, parentConversationId, parentRunId, childSessionId, receiptRefs = [], dataRoot } = {}) {
  return {
    parentSessionId,
    parentConversationId,
    parentRunId,
    childSessionId,
    transcriptRef: { dataRoot, sessionId: childSessionId },
    receiptRefs,
    retention: { policy: 'runtime-retention', dataRoot },
  };
}

export async function executeSpawnSubagentTool({
  arguments: args = {},
  executionContext = null,
  rootDir = null,
  dataRoot = null,
  sessionId = null,
  conversationId = null,
  runId = null,
  traceLogger = null,
  modelConfig = null,
  executionPolicy: executionPolicyInput = null,
  subagentTimeoutConfig = null,
} = {}) {
  const activityId = compactString(args.activityId) || null;
  const timeout = resolveSubagentTimeout({ requested: requestedTimeout(args.timeoutMs), policy: subagentTimeoutConfig || resolveSubagentTimeoutConfig() });
  const task = compactString(args.task || args.purpose || args.reason);
  const blockers = [];
  if (!task) blockers.push('subagent_task_required');
  if (!dataRoot) blockers.push('subagent_data_root_required');
  if (!modelConfig) blockers.push('subagent_model_config_required');

  const requestedModel = compactString(args.model || args.modelId || args.model_id) || null;
  let childModelConfig = modelConfig;
  if (requestedModel && modelConfig?.resolveChildModel) {
    try { childModelConfig = await modelConfig.resolveChildModel(requestedModel); } catch { childModelConfig = null; blockers.push(`subagent_model_unavailable:${requestedModel}`); }
  } else if (requestedModel) blockers.push(`subagent_model_unavailable:${requestedModel}`);
  const requestedModelProfile = compactString(args.modelProfile || args.model_profile || args.profile) || null;
  const modelSelection = {
    requestedModel,
    requestedProfile: requestedModelProfile,
    resolvedProfile: requestedModelProfile,
    resolvedModel: childModelConfig?.model || null,
  };

  let target = null;
  let targetWarnings = [];
  if (!args.target || typeof args.target !== 'object') {
    blockers.push('invalid_target:target_required');
  } else {
    try {
      target = await resolveExecutionTarget(args.target, { filesystemBoundaries: executionContext?.filesystemBoundaries || [] });
      const refined = await refineRepositoryTarget(target);
      target = refined.target;
      targetWarnings = refined.warnings;
    } catch (error) {
      blockers.push(`invalid_target:${error?.message || String(error)}`);
    }
  }

  if (blockers.length) {
    const failed = {
      tool: 'spawn_subagent',
      ok: false,
      spawned: false,
      status: 'failed',
      task: task || null,
      target: target || null,
      requestedModel,
      requestedModelProfile: modelSelection.requestedProfile,
      availableModels: Array.isArray(modelConfig?.availableModels) ? modelConfig.availableModels.map((item) => item.id) : [],
      resolvedModelProfile: modelSelection.resolvedProfile,
      resolvedModel: modelSelection.resolvedModel,
      blockers,
      warnings: [],
      evidence: [],
      record: null,
    };
    if (activityId) await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'spawn_subagent', activityId, ok: false, status: failed.status, blockers });
    return failed;
  }

  const parentSessionId = sessionId || executionContext?.sessionId || 'default';
  const parentConversationId = conversationId || executionContext?.conversationId || null;
  const parentRunId = runId || traceLogger?.runId || null;
  const capability = compactString(args.capability || args.profile || 'spawn_subagent') || 'spawn_subagent';
  const label = compactString(args.label).slice(0, 80) || null;
  const spawnRequest = {
    parentSessionId,
    parentConversationId,
    parentRunId,
    targetRoot: target.root,
    capability,
    model: requestedModel,
    modelProfile: modelSelection.requestedProfile,
    task: normalizeTaskForSpawnRequest(task),
    timeoutMs: timeout.requestedTimeoutMs,
  };
  spawnRequest.key = spawnRequestIdentity(spawnRequest);
  const existing = await findSubagentBySpawnRequestKey({ dataRoot, key: spawnRequest.key });
  if (existing) {
    const reused = reusedSubagentResult({ record: existing, task, target, request: spawnRequest });
    await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'spawn_subagent', ...(activityId ? { activityId } : {}), ok: reused.ok, id: reused.id, childSessionId: reused.childSessionId, status: reused.status, reused: true, spawnRequestKey: spawnRequest.key, record: reused.record });
    return reused;
  }
  const id = safeId(args.id || `subagent-${Date.now()}`);
  const childSessionId = subagentChildSessionId(id);
  const owner = { sessionId: parentSessionId, conversationId: parentConversationId, turnId: parentRunId, parentRunId, requestedBy: 'model-tool' };
  const scope = { workspaceRoot: target.root, baseRoot: target.root, target };
  const executionPolicy = normalizeExecutionPolicyInput(executionPolicyInput);
  const mayMutate = executionPolicyAllowsMutation(executionPolicy);
  const permissions = {
    // Observability only: the child receives the normal runtime tool surface.
    // Structural target context does not narrow that surface.
    mayRead: true,
    mayWrite: mayMutate,
    mayExecute: true,
    mayNetwork: true,
    mayCommit: executionPolicyAllowsCommit(executionPolicy),
    allowedTools: ['shell_exec', 'files_list', 'files_find', 'files_inspect', 'files_search', 'git_status', 'git_diff', 'files_read', 'files_write', 'files_edit', 'files_patch', 'spawn_subagent'],
    toolSurface: 'normal-runtime-tools',
  };
  const traceDir = traceLogger?.traceDir ? path.join(traceLogger.traceDir, 'subagents', id) : null;

  const queued = await createSubagentRecord({
    dataRoot,
    id,
    owner,
    purpose: task,
    label,
    scope,
    permissions,
    status: 'queued',
    trace: { runId: id, childSessionId, traceDir },
    spawnRequest,
    model: modelSelection,
    provenance: ['spawn-subagent-tool', 'context:isolated'],
  });
  await startSubagentChildSession({ dataRoot, id, workerProfile: 'spawn_subagent', purpose: task, owner, trace: { runId: id, childSessionId, traceDir }, model: modelSelection });
  const running = await updateSubagentStatus({ dataRoot, id, status: 'running', phase: 'spawned', trace: { runId: id, childSessionId, traceDir }, provenance: { source: 'spawn-subagent-tool', reason: 'spawned' } });

  const childRun = await runSubagentProcess({
    args: { id, task, target, dataRoot, childSessionId, owner, modelConfig: childModelConfig, traceDir, executionPolicy },
    timeoutMs: timeout.effectiveTimeoutMs,
  });
  const childResult = childRun.result || { ok: false, summary: 'Subagent returned no result.', blockers: ['subagent_result_missing'], warnings: [], evidence: [], artifacts: [], changedFiles: [], memoryWrites: [], sideEffectsApplied: false };
  if (childRun.timedOut && !(childResult.evidence || []).length) {
    const salvagedEvidence = await salvageEvidenceFromTrace(traceDir);
    if (salvagedEvidence.length) {
      childResult.evidence = salvagedEvidence;
      childResult.warnings = [...(childResult.warnings || []), 'subagent_timeout_evidence_salvaged'];
    }
  }
  const status = childRun.ok && childResult.ok ? 'succeeded' : 'failed';
  const receiptRef = traceDir ? path.join(traceDir, 'receipt.json') : null;
  if (receiptRef) {
    await fs.mkdir(path.dirname(receiptRef), { recursive: true });
    await fs.writeFile(receiptRef, `${JSON.stringify({ id, parentSessionId, parentConversationId, parentRunId, childSessionId, status, target, model: modelSelection, timeout, spawned: Boolean(childRun.spawned), exitCode: childRun.exitCode ?? null, evidenceCount: childResult.evidence?.length || 0 }, null, 2)}\n`, 'utf8');
  }
  const child = childFrom({ parentSessionId, parentConversationId, parentRunId, childSessionId, receiptRefs: receiptRef ? [receiptRef] : [], dataRoot });
  const result = {
    ok: status === 'succeeded',
    summary: childResult.summary || (status === 'succeeded' ? 'Subagent completed.' : 'Subagent failed.'),
    blockers: childResult.blockers || [],
    warnings: [...targetWarnings, ...(childResult.warnings || [])],
    evidence: childResult.evidence || [],
    artifacts: [...(childResult.artifacts || []), ...(receiptRef ? [{ type: 'subagent-receipt', path: receiptRef }] : [])],
    changedFiles: childResult.changedFiles || [],
    memoryWrites: childResult.memoryWrites || [],
    sideEffectsApplied: Boolean(childResult.sideEffectsApplied),
    ...(childResult.verification ? { verification: childResult.verification } : {}),
    verificationTarget: childResult.verificationTarget || target.root,
    child,
  };
  const finished = await updateSubagentStatus({ dataRoot, id, status, phase: 'idle', trace: { runId: id, childSessionId, traceDir }, model: modelSelection, result, provenance: { source: 'spawn-subagent-tool', reason: status } });
  await finishSubagentChildSession({ dataRoot, sessionId: childSessionId, id, workerProfile: 'spawn_subagent', owner, trace: { runId: id, childSessionId, traceDir }, status, result, model: modelSelection });
  await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'spawn_subagent', ...(activityId ? { activityId } : {}), ok: result.ok, id, childSessionId, status, spawned: Boolean(childRun.spawned), exitCode: childRun.exitCode ?? null, spawnRequestKey: spawnRequest.key, record: subagentVisibilitySummary(finished.record) });

  return {
    tool: 'spawn_subagent',
    ok: result.ok,
    spawned: Boolean(childRun.spawned),
    reused: false,
    id,
    task,
    label,
    requestedModelProfile: modelSelection.requestedProfile,
    resolvedModelProfile: modelSelection.resolvedProfile,
    resolvedModel: modelSelection.resolvedModel,
    target,
    status,
    parentSessionId,
    parentConversationId,
    parentRunId,
    childSessionId,
    transcriptRef: child.transcriptRef,
    receiptRefs: child.receiptRefs,
    retention: child.retention,
    evidence: result.evidence,
    verificationTarget: result.verificationTarget,
    blockers: result.blockers,
    warnings: result.warnings,
    summary: result.summary,
    record: subagentVisibilitySummary(finished.record),
    queued,
    running: running.record,
    childRun: { exitCode: childRun.exitCode ?? null, timedOut: Boolean(childRun.timedOut), timedOutBy: childRun.timedOutBy || null, durationMs: childRun.durationMs || null, ...timeout },
    spawnRequestKey: spawnRequest.key,
  };
}

export const __subagentToolExecutor__ = Object.freeze({ childProcess: true, refineRepositoryTarget, normalizeTaskForSpawnRequest, requestedTimeout, resolveSubagentTimeout, spawnRequestIdentity, compactSalvagedEvidence, salvageEvidenceFromTrace });
