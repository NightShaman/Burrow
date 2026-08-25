import path from 'node:path';

function mutatingAction(action) {
  return ['write', 'edit', 'patch', 'files_patch', 'delete'].includes(String(action || '').toLowerCase());
}

function unique(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeRoot(root = null) {
  return root ? path.resolve(root) : null;
}

function normalizeEvidencePath(filePath = '', { normalizationRoot = null, baseRoot = null } = {}) {
  const raw = String(filePath || '').trim();
  if (!raw) return null;
  const root = normalizeRoot(normalizationRoot || baseRoot || process.cwd());
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  if (normalizationRoot) {
    const normalizedRoot = normalizeRoot(normalizationRoot);
    const relative = path.relative(normalizedRoot, absolute);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  }
  if (!path.isAbsolute(raw)) return raw;
  return absolute;
}

function artifactPathsFromResult(result = {}) {
  const artifacts = result.artifacts || {};
  return Object.entries(artifacts)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([name, path]) => ({ tool: result.tool || 'unknown', name, path }));
}

function resultIsMutationResult(result = {}) {
  return Boolean(['files_write', 'files_patch'].includes(result.tool));
}

function resultIsArtifactEvidence(result = {}) {
  return Boolean(result.ok && resultIsMutationResult(result));
}

function checkLikeCommand(command) {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) return false;
  const segments = normalized
    .split(/\s*(?:&&|;)\s*/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.some((segment) => [
    /^npm\s+(run\s+)?(check|test|smoke)/u,
    /^node\s+--check\b/u,
    /^node\s+--test\b/u,
    /^test\s+-[efsd]\b/u,
    /^git\s+diff\s+--check\b/u,
  ].some((pattern) => pattern.test(segment)));
}

function resultIsCheckEvidence(result = {}) {
  return Boolean(result.ok && result.tool === 'shell_exec' && (result.verificationCheck || checkLikeCommand(result.command)));
}

function resultIsFailedCheck(result = {}) {
  return Boolean(!result.ok && result.tool === 'shell_exec' && (result.verificationCheck || checkLikeCommand(result.command)));
}

function mutationTargetsFromResult(result = {}, scope = {}) {
  if (!resultIsMutationResult(result)) return [];
  if (result.tool === 'files_write') return [normalizeEvidencePath(result.filePath, scope)].filter(Boolean);
  if (result.tool === 'files_patch') {
    return unique((result.touchedFiles || []).map((file) => normalizeEvidencePath(file, { ...scope, baseRoot: result.baseRoot || scope.baseRoot })));
  }
  return [];
}

function observedTargetsFromResult(result = {}, scope = {}) {
  if (result?.tool === 'files_read' && result.filePath) return [normalizeEvidencePath(result.filePath, scope)].filter(Boolean);
  if (resultIsMutationResult(result)) return mutationTargetsFromResult(result, scope);
  return [];
}

export function evidenceFromToolResults(toolResults = [], { normalizationRoot = null, baseRoot = null } = {}) {
  const artifacts = [];
  const checks = [];
  const failedChecks = [];
  const scope = { normalizationRoot, baseRoot };

  for (const result of toolResults || []) {
    if (resultIsArtifactEvidence(result)) artifacts.push(...artifactPathsFromResult(result));
    if (resultIsCheckEvidence(result)) {
      checks.push({
        name: result.command || result.tool || 'shell_exec',
        ok: true,
        tool: result.tool || 'shell_exec',
        exitCode: result.exitCode ?? null,
        artifacts: artifactPathsFromResult(result),
      });
    }
    if (resultIsFailedCheck(result)) {
      failedChecks.push({
        name: result.command || result.tool || 'shell_exec',
        ok: false,
        tool: result.tool || 'shell_exec',
        exitCode: result.exitCode ?? null,
        artifacts: artifactPathsFromResult(result),
      });
    }
  }

  const mutationToolResults = (toolResults || []).filter((result) => resultIsMutationResult(result));
  const failedMutationTargets = unique(mutationToolResults
    .filter((result) => !result?.ok)
    .flatMap((result) => mutationTargetsFromResult(result, scope)));
  const allMutationTargets = unique(mutationToolResults.flatMap((result) => mutationTargetsFromResult(result, scope)));
  const changedFiles = unique(mutationToolResults
    .filter((result) => result?.ok)
    .flatMap((result) => mutationTargetsFromResult(result, scope)));
  const requestedTargets = failedMutationTargets.length ? failedMutationTargets : allMutationTargets;
  const observedTargets = unique((toolResults || []).flatMap((result) => observedTargetsFromResult(result, scope)));
  const requestedSet = new Set(requestedTargets);
  const supportingChanges = changedFiles.filter((file) => !requestedSet.has(file));
  const verificationLevel = failedChecks.length ? 'failed_check' : checks.length ? 'check' : changedFiles.length ? 'mutation_artifact' : 'none';

  return {
    artifacts,
    checks,
    failedChecks,
    mutationToolResultCount: mutationToolResults.length,
    receipt: {
      requestedTargets,
      observedTargets,
      changedFiles,
      supportingChanges,
      verificationLevel,
    },
  };
}

export function normalizeVerificationEvidence({ artifacts = [], checks = [], toolResults = [], normalizationRoot = null, baseRoot = null } = {}) {
  const toolEvidence = evidenceFromToolResults(toolResults, { normalizationRoot, baseRoot });
  return {
    artifacts: [...artifacts, ...toolEvidence.artifacts],
    checks: [...checks, ...toolEvidence.checks],
    failedChecks: [...toolEvidence.failedChecks],
    mutationToolResultCount: toolEvidence.mutationToolResultCount,
    receipt: toolEvidence.receipt,
  };
}

export function evaluateVerification({ mode, action, model, artifacts = [], checks = [], toolResults = [], verificationEvidence, normalizationRoot = null, baseRoot = null } = {}) {
  const evidence = verificationEvidence || normalizeVerificationEvidence({ artifacts, checks, toolResults, normalizationRoot, baseRoot });
  const resolvedArtifacts = evidence.artifacts || [];
  const resolvedChecks = evidence.checks || [];
  const failedChecks = evidence.failedChecks || [];
  const receipt = evidence.receipt || { requestedTargets: [], observedTargets: [], changedFiles: [], supportingChanges: [], verificationLevel: 'none' };
  const hasMutationToolResult = (evidence.mutationToolResultCount || 0) > 0;
  const required = mode === 'model' && (mutatingAction(action) || hasMutationToolResult);

  if (!required) {
    return {
      required: false,
      ok: true,
      reason: 'not_required',
      requiredEvidence: [],
      evidence: { artifacts: resolvedArtifacts.length, checks: resolvedChecks.length, receipt },
    };
  }

  const hasArtifact = resolvedArtifacts.length > 0;
  const hasPassingCheck = resolvedChecks.some((check) => check?.ok === true);
  const hasFailedCheck = failedChecks.length > 0;
  const requestedSet = new Set(receipt.requestedTargets || []);
  const targetMatched = !requestedSet.size || (receipt.changedFiles || []).some((file) => requestedSet.has(file));
  const ok = Boolean(model?.ok && hasArtifact && hasPassingCheck && !hasFailedCheck && targetMatched);
  const reason = ok
    ? 'verified'
    : hasFailedCheck
      ? 'verification_check_failed'
      : hasArtifact && hasPassingCheck && !targetMatched
        ? 'target_file_unchanged'
        : 'model_answer_without_artifact_or_check';

  return {
    required: true,
    ok,
    reason,
    requiredEvidence: ['target_mutation', 'diff_or_tool_artifact', 'passing_check'],
    evidence: {
      artifacts: resolvedArtifacts.length,
      checks: resolvedChecks.length,
      ...(failedChecks.length ? { failedChecks: failedChecks.length } : {}),
      receipt,
    },
  };
}

export const __test__ = { mutatingAction, artifactPathsFromResult, checkLikeCommand, resultIsMutationResult, resultIsArtifactEvidence, resultIsCheckEvidence, resultIsFailedCheck, mutationTargetsFromResult, normalizeEvidencePath };
