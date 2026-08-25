function unique(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function configuredHardBlockers(values = []) {
  return asArray(values).filter((value) => String(value || '').includes('hard_policy_block:user_configured_hard_block'));
}

function explicitControlsFrom(explicitControls = {}) {
  return { ...(explicitControls || {}) };
}

export function createExecutionPolicy({ explicitControls = {}, policyBlockers = [], policyWarnings = [] } = {}) {
  const controls = explicitControlsFrom(explicitControls);
  const commitRequested = ['factory', 'commit'].includes(String(controls.action || '').toLowerCase());
  const blockers = unique([
    ...configuredHardBlockers(policyBlockers),
  ]);
  const mayMutate = Boolean(blockers.length === 0);
  const mayCommit = Boolean(commitRequested && mayMutate);
  const capabilities = {
    readWorkspace: true,
    mutateWorkspace: mayMutate,
    commit: mayCommit,
  };
  return {
    capabilities,
    mayInspect: true,
    mayMutate,
    mayCommit,
    blockers,
    warnings: unique(policyWarnings),
  };
}

export function normalizeExecutionPolicyInput(input = null) {
  const candidate = input?.executionPolicy || input;
  const caps = candidate?.capabilities || {};
  return {
    capabilities: {
      readWorkspace: Boolean(caps.readWorkspace ?? candidate?.mayInspect ?? true),
      mutateWorkspace: Boolean(caps.mutateWorkspace ?? candidate?.mayMutate),
      commit: Boolean(caps.commit ?? candidate?.mayCommit),
    },
    mayInspect: Boolean(candidate?.mayInspect ?? caps.readWorkspace ?? true),
    mayMutate: Boolean(candidate?.mayMutate ?? caps.mutateWorkspace),
    mayCommit: Boolean(candidate?.mayCommit ?? caps.commit),
    blockers: unique(candidate?.blockers || []),
    warnings: unique(candidate?.warnings || []),
  };
}

export function executionPolicyAllowsMutation(input = null) {
  const policy = normalizeExecutionPolicyInput(input);
  return Boolean(policy.mayMutate || policy.capabilities.mutateWorkspace);
}

export function executionPolicyAllowsCommit(input = null) {
  const policy = normalizeExecutionPolicyInput(input);
  return Boolean(policy.mayCommit || policy.capabilities.commit);
}

export const __executionPolicy__ = Object.freeze({ configuredHardBlockers, normalizeExecutionPolicyInput });
