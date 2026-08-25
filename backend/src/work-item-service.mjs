import { createWorkItem, findActiveWorkItem, readWorkItem, workItemEligibility } from './work-item-store.mjs';

export function requestedWorkItemId(args = {}) {
  return args.work_item_id || args.workItemId || args.task_id || args.taskId || null;
}

export function explicitContinueRequested(args = {}) {
  return Boolean(args.continue_work || args.continueWork || args.workbench_continue || args.workbenchContinue);
}

export function requestedWorkItemStep(args = {}) {
  return args.work_item_step || args.workItemStep || args.step || null;
}

function nextWorkItemStep(item, args = {}) {
  const requested = requestedWorkItemStep(args);
  if (requested) return requested;
  const allowed = item?.allowedNextSteps || [];
  if (allowed.includes('propose')) return 'propose';
  if (allowed.includes('verify') && (args.verify_command || args.verifyCommand)) return 'verify';
  if (allowed.includes('verify')) return 'verify';
  if (allowed.includes('factory')) return 'factory';
  return allowed[0] || 'inspect';
}

function normalizedWorkItemKind(item = {}) {
  const allowed = new Set(['answer', 'inspect', 'plan', 'mutate', 'factory']);
  return allowed.has(item?.kind) ? item.kind : null;
}

export function compactTrackedWorkItem({ item, created = false, step = null, result = null } = {}) {
  if (!item) return null;
  return {
    created: Boolean(created),
    attached: !created,
    continued: false,
    itemId: item.id,
    status: item.status || 'new',
    kind: normalizedWorkItemKind(item),
    step,
    workspaceRoot: item.workspaceRoot || null,
    blockers: result?.blockers || result?.result?.blockers || [],
    allowedNextSteps: item.allowedNextSteps || [],
    stepResult: result ? {
      ok: result.ok ?? null,
      decision: result.decision || result.result?.decision || null,
      runId: result.runId || result.result?.runId || null,
      traceDir: result.traceDir || result.result?.traceDir || null,
    } : null,
  };
}

export function shouldAutoTrackWorkItem({ session, route, workspaceRoot } = {}) {
  if (!workspaceRoot) return false;
  if (!['inspect', 'plan'].includes(session?.kind)) return false;
  return route?.action?.review?.state === 'clear_in_scope';
}

export function buildContinuationPlan({ item, requestedItemId = null, sessionId = null, args = {}, workspaceFiles = [] } = {}) {
  if (!item) {
    return {
      ok: false,
      item: null,
      itemId: requestedItemId,
      step: requestedWorkItemStep(args),
      workspaceRoot: null,
      targetFiles: workspaceFiles || [],
      blockers: ['work_item_not_found'],
      eligibility: { ok: false, blockers: ['work_item_not_found'], allowedNextSteps: [] },
    };
  }
  const blockers = [];
  if (item.sessionId && sessionId && item.sessionId !== sessionId && args.allow_cross_session_work_item !== true) blockers.push('work_item_session_mismatch');
  const step = nextWorkItemStep(item, args);
  const eligibility = blockers.length
    ? { ok: false, step, blockers, allowedNextSteps: item.allowedNextSteps || [] }
    : workItemEligibility(item, step, { override: args.override === true });
  return {
    ok: Boolean(eligibility.ok),
    item,
    itemId: item.id,
    step,
    workspaceRoot: item.workspaceRoot || null,
    targetFiles: [...new Set([...(item.files || item.targetFiles || []), ...(workspaceFiles || [])])],
    blockers: eligibility.blockers || [],
    eligibility,
  };
}

export async function resolveWorkItemForTurn({ dataRoot, legacyDataRoot, compatibilityObserver, sessionId, runId, args = {}, workspaceRoot = null, route = null, session = null } = {}) {
  const shouldAutoTrack = shouldAutoTrackWorkItem({ session, route, workspaceRoot });
  const requestedItemId = requestedWorkItemId(args);
  const explicitContinue = explicitContinueRequested(args);
  const candidate = explicitContinue
    ? (requestedItemId
      ? await readWorkItem({ dataRoot, legacyDataRoot, compatibilityObserver, sessionId, runId, id: requestedItemId })
      : await findActiveWorkItem({ dataRoot, sessionId, workspaceRoot: null }))
    : (shouldAutoTrack ? await findActiveWorkItem({ dataRoot, sessionId, workspaceRoot }) : null);
  const activeWorkItem = explicitContinue ? candidate : null;
  let trackedWorkItem = shouldAutoTrack ? candidate : null;
  let trackedWorkCreated = false;
  if (shouldAutoTrack && !trackedWorkItem) {
    trackedWorkItem = await createWorkItem({ dataRoot, message: args.message, workspaceRoot, sessionId, kind: session?.kind });
    trackedWorkCreated = true;
  }
  return { shouldAutoTrack, requestedItemId, explicitContinue, activeWorkItem, trackedWorkItem, trackedWorkCreated };
}
