import { readSessionMetadata, readSessionPendingActions } from './session-store.mjs';
import { listContinuityHandoffs } from './continuity-handoff-store.mjs';
import { turnWorkspaceFacts } from './turn-workspace-facts.mjs';
import { applyWorkingContextEvents, verifiedEventsFromTurnInput, workingContextFromSession } from './working-context.mjs';
import { loadWorkingContinuity, normalizeContinuityScope, projectHandoffsIntoWorkingContinuity } from './working-memory-continuity.mjs';
import { validateReadEvidence } from './read-evidence.mjs';
import { readSessionReadEvidence } from './read-evidence-store.mjs';
import { WorkingMemoryStore } from './working-memory-store.mjs';

export async function prepareRuntimeSessionContext({ sessionRoot, resolvedSessionId, runtimeState, normalizedArgs, workspaceRoot, resolvedTarget, message, explicitWorkspaceFiles = [], interruptedRun = null } = {}) {
  // Planning consumes no transcript prose. It receives only durable session
  // identity/metadata, while pending actions are resolved from their explicit
  // work-item and turn contracts rather than an arbitrary transcript tail.
  const metadata = await readSessionMetadata({ rootDir: sessionRoot, sessionId: resolvedSessionId });
  const pendingActions = await readSessionPendingActions({ rootDir: sessionRoot, sessionId: resolvedSessionId });
  const priorSession = {
    sessionId: resolvedSessionId,
    turnCount: Number(metadata?.turnCount || 0),
    turns: pendingActions.map((action) => ({ id: action.turnId, role: action.role, metadata: { pendingAction: action } })),
    summary: '',
    metadata: metadata || {},
  };
  const conversationId = priorSession.metadata?.conversationId || null;
  const isFreshConversation = !(priorSession?.turnCount > 0);
  const continuityHandoffs = isFreshConversation
    ? listContinuityHandoffs({ dataRoot: runtimeState.agentDataRoot, agentId: runtimeState.agentId || 'hatchet', limit: 1 })
    : [];
  const workspaceResolution = turnWorkspaceFacts({
    configuredWorkspaceRoot: runtimeState.agentWorkspaceRoot || runtimeState.workspaceRoot,
    requestedWorkspaceRoot: workspaceRoot ?? normalizedArgs.workspace_root ?? null,
  });
  const resolvedWorkingRoot = resolvedTarget?.root || workspaceRoot || normalizedArgs.workspace_root || runtimeState.agentWorkspaceRoot || runtimeState.workspaceRoot || null;
  const priorWorkingContext = workingContextFromSession(priorSession);
  // ReadEvidence is an active-session aid, not ambient new-session memory. A
  // fresh session without an interrupted run must begin from its actual
  // conversation/handoff state, never arbitrary prior file excerpts.
  const validReadEvidence = (!isFreshConversation || interruptedRun)
    ? await validateReadEvidence(await readSessionReadEvidence({ rootDir: sessionRoot, sessionId: resolvedSessionId }))
    : [];
  const compatibilityScope = normalizeContinuityScope(normalizedArgs.continuity_scope ?? normalizedArgs.continuityScope ?? normalizedArgs.working_project ?? normalizedArgs.workingProject);
  const continuityScope = normalizeContinuityScope(priorWorkingContext.continuityScope) || compatibilityScope || `conversation:${conversationId || resolvedSessionId}`;
  const generatedContinuityScope = !normalizeContinuityScope(priorWorkingContext.continuityScope) && !compatibilityScope;
  const verifiedSubjectScope = null;
  const initialWorkingContext = applyWorkingContextEvents({ ...priorWorkingContext, readEvidence: validReadEvidence, continuityScope }, await verifiedEventsFromTurnInput({
    message,
    workspaceResolution: resolvedTarget ? { workspaceRoot: resolvedTarget.root, resolved: true, reason: 'explicit_turn_target' } : workspaceResolution,
  }));
  const deicticFiles = { files: explicitWorkspaceFiles, summary: null, applied: false, ambiguous: false, question: null };
  const workspaceFiles = deicticFiles.files.length ? deicticFiles.files : explicitWorkspaceFiles;
  const workingContinuity = projectHandoffsIntoWorkingContinuity({
    continuity: loadWorkingContinuity({ databasePath: runtimeState.settingsDatabasePath || null, agentId: runtimeState.agentId || null, continuityScope }),
    handoffs: continuityHandoffs,
    agentId: runtimeState.agentId || null,
    continuityScope,
  });
  const ambientWorkingContext = { ...initialWorkingContext, ...(interruptedRun ? { interruptedRun } : {}), continuity: workingContinuity, continuityScopeSource: generatedContinuityScope ? 'runtime_generated' : 'session_persisted' };
  let dreamPreload = null;
  try {
    const store = new WorkingMemoryStore(runtimeState.settingsDatabasePath ? { databasePath: runtimeState.settingsDatabasePath } : {});
    try { dreamPreload = store.getDreamPreload({ agentId: runtimeState.agentId, project: continuityScope }) || store.getDreamPreload({ agentId: runtimeState.agentId, project: 'global' }); }
    finally { store.close(); }
  } catch { dreamPreload = null; }
  return { priorSession, conversationId, resolvedWorkingRoot, continuityHandoffs, compatibilityScope, continuityScope, generatedContinuityScope, verifiedSubjectScope, deicticFiles, workspaceFiles, initialWorkingContext, ambientWorkingContext, dreamPreload };
}
