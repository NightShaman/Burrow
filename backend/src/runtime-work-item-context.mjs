import { compactTrackedWorkItem, explicitContinueRequested, resolveWorkItemForTurn } from './work-item-service.mjs';

export async function prepareRuntimeWorkItemContext({ dataRoot, legacyDataRoot, compatibilityObserver, resolvedSessionId, resolvedRunId, normalizedArgs, resolvedWorkingRoot, route, session } = {}) {
  const workItemState = await resolveWorkItemForTurn({
    dataRoot,
    legacyDataRoot,
    compatibilityObserver,
    sessionId: resolvedSessionId,
    runId: resolvedRunId,
    args: { ...normalizedArgs, message: normalizedArgs.message },
    workspaceRoot: resolvedWorkingRoot,
    route,
    session,
  });
  const { shouldAutoTrack, requestedItemId, explicitContinue, activeWorkItem, trackedWorkItem, trackedWorkCreated } = workItemState;
  const trackedBackgroundWork = compactTrackedWorkItem({ item: trackedWorkItem, created: trackedWorkCreated });
  const intent = activeWorkItem && explicitContinueRequested(normalizedArgs)
    ? { intent: 'continue', confidence: 1, reason: 'explicit_continue_control' }
    : { intent: 'chat', confidence: 1, reason: 'model_owned_chat' };
  return { ...workItemState, shouldAutoTrack, requestedItemId, explicitContinue, activeWorkItem, trackedWorkItem, trackedWorkCreated, trackedBackgroundWork, intent };
}
