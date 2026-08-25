function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values = []) {
  return [...new Set(asArray(values).filter(Boolean))];
}

function capabilitiesFromExecutionPolicy(executionPolicy = {}) {
  const caps = executionPolicy?.capabilities || {};
  return {
    mayInspect: Boolean(executionPolicy?.mayInspect ?? caps.readWorkspace),
    mayMutate: Boolean(executionPolicy?.mayMutate ?? caps.mutateWorkspace),
    mayCommit: Boolean(executionPolicy?.mayCommit ?? caps.commit),
    readWorkspace: Boolean(caps.readWorkspace ?? executionPolicy?.mayInspect),
    mutateWorkspace: Boolean(caps.mutateWorkspace ?? executionPolicy?.mayMutate),
    commit: Boolean(caps.commit ?? executionPolicy?.mayCommit),
  };
}

function blockerKind({ blockers = [], routeReview = null } = {}) {
  if (routeReview?.state === 'hard_policy_block' || blockers.some((item) => String(item).includes('hard_policy_block'))) return 'hard_policy_block';
  if (blockers.some((item) => String(item).includes('unclear_scope'))) return 'runtime_blocker';
  if (blockers.length) return 'runtime_blocker';
  return null;
}

function toolActivityFrom({ workResult = null, chatToolLoop = null, proposedActions = [], outcome = null } = {}) {
  const workProposed = workResult?.proposedActions?.length ?? 0;
  const outcomeProposed = outcome?.execution?.proposedActions ?? 0;
  const plainProposed = asArray(proposedActions).length;
  const workExecuted = workResult?.proposalExecution?.executed ?? 0;
  const outcomeExecuted = outcome?.execution?.executedActions ?? 0;
  const chatExecuted = asArray(chatToolLoop?.toolResults).length;
  return {
    proposed: workProposed || outcomeProposed || plainProposed,
    executed: workExecuted || outcomeExecuted || chatExecuted,
    chatToolLoopEnabled: chatToolLoop?.enabled ?? null,
  };
}

function interpretation({ kind = null, toolActivity, decision = null } = {}) {
  if (kind === 'hard_policy_block') return 'blocked_by_hard_policy';
  if (kind === 'unclear_scope') return 'blocked_by_unclear_scope';
  if (kind) return 'blocked_by_runtime';
  if (toolActivity.proposed === 0 && toolActivity.executed === 0 && ['answered', 'routed'].includes(decision)) return 'not_blocked_no_tool_call';
  return 'not_blocked';
}

function explanationFor({ interpretation: value, routeReview = null, blockers = [], toolActivity } = {}) {
  if (value === 'blocked_by_hard_policy') return `Runtime hard-blocked this turn: ${blockers[0] || routeReview?.hardPolicyReason || 'hard policy block'}.`;
  if (value === 'blocked_by_unclear_scope') return routeReview?.question
    ? `Runtime blocked on unclear scope/target and asked: ${routeReview.question}`
    : 'Runtime blocked on unclear scope/target.';
  if (value === 'blocked_by_runtime') return `Runtime blocked this turn: ${blockers.join(', ')}.`;
  if (value === 'not_blocked_no_tool_call') return 'Receipts show no runtime blocker; the model did not propose or execute a tool call.';
  return `Receipts show no runtime blocker; proposed=${toolActivity.proposed} executed=${toolActivity.executed}.`;
}

export function createExecutionPolicyEvidence({
  decision = null,
  routeReview = null,
  routeDecision = null,
  runtimeTurn = null,
  blockers = [],
  workResult = null,
  chatToolLoop = null,
  proposedActions = [],
  outcome = null,
} = {}) {
  const combinedBlockers = unique([
    ...asArray(blockers),
    ...asArray(routeReview?.blockers),
    ...asArray(routeDecision?.blockers),
    ...asArray(runtimeTurn?.executionPolicy?.blockers),
    ...asArray(workResult?.blockers),
  ]);
  const kind = blockerKind({ blockers: combinedBlockers, routeReview });
  const toolActivity = toolActivityFrom({ workResult, chatToolLoop, proposedActions, outcome });
  const interpreted = interpretation({ kind, toolActivity, decision });
  const capabilities = capabilitiesFromExecutionPolicy(runtimeTurn?.executionPolicy || {});

  return {
    version: 1,
    decision: decision || null,
    interpretation: interpreted,
    blocked: Boolean(kind),
    blockerKind: kind,
    blockers: combinedBlockers,
    routeReview: routeReview ? {
      state: routeReview.state || null,
      boundary: routeReview.boundary || null,
      question: routeReview.question || null,
      hardPolicyReason: routeReview.hardPolicyReason || null,
    } : null,
    routeDecision: routeDecision ? {
      source: routeDecision.source || null,
      confidence: routeDecision.confidence || null,
      action: routeDecision.action || null,
      reason: routeDecision.reason || null,
    } : null,
    executionPolicy: capabilities,
    toolActivity,
    explanation: explanationFor({ interpretation: interpreted, routeReview, blockers: combinedBlockers, toolActivity }),
  };
}

export const __executionPolicyEvidence__ = Object.freeze({ capabilitiesFromExecutionPolicy });
