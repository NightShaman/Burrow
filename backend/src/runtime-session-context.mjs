import { readSessionMetadata, readSessionPendingActions } from './session-store.mjs';
import { conversationAuthority } from './conversation-authority.mjs';
import { turnWorkspaceFacts } from './turn-workspace-facts.mjs';
import { applyWorkingContextEvents, verifiedEventsFromTurnInput, workingContextFromSession } from './working-context.mjs';
import { loadWorkingContinuityAsync, normalizeContinuityScope, projectHandoffsIntoWorkingContinuity } from './working-memory-continuity.mjs';
import { validateReadEvidence } from './read-evidence.mjs';
import { readSessionReadEvidence } from './read-evidence-store.mjs';

export async function prepareRuntimeSessionContext({ sessionRoot, resolvedSessionId, runtimeState, normalizedArgs, workspaceRoot, resolvedTarget, message, explicitWorkspaceFiles = [], interruptedRun = null, stores = null } = {}) {
  if (!stores?.conversations || !stores?.continuity || !stores?.workingMemory || !stores?.tasks) throw new Error('runtime_stores_required');
  const authority = conversationAuthority({ store: stores.conversations, agentId: runtimeState.agentId || 'hatchet', rootDir: sessionRoot });
  // Planning consumes no transcript prose. It receives only durable session
  // identity/metadata, while pending actions are resolved from their explicit
  // work-item and turn contracts rather than an arbitrary transcript tail.
  const metadata = await authority.metadata(resolvedSessionId);
  const pendingActions = await authority.pendingActions(resolvedSessionId);
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
    ? await stores.continuity.list({ agentId: runtimeState.agentId || 'hatchet', limit: 1 })
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
    ? await validateReadEvidence(await readSessionReadEvidence({ rootDir: sessionRoot, sessionId: resolvedSessionId, conversationStore:stores?.conversations, agentId:runtimeState.agentId }))
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
    continuity: await loadWorkingContinuityAsync({ store: stores.workingMemory, agentId: runtimeState.agentId || null, continuityScope }),
    handoffs: continuityHandoffs,
    agentId: runtimeState.agentId || null,
    continuityScope,
  });
  let activeProject = null;
  try {
    activeProject = await stores.tasks.getConversationProject({ agentId: runtimeState.agentId, sessionId: resolvedSessionId });
  } catch { activeProject = null; }
  const ambientWorkingContext = { ...initialWorkingContext, ...(interruptedRun ? { interruptedRun } : {}), ...(activeProject ? { activeProject } : {}), continuity: workingContinuity, continuityScopeSource: generatedContinuityScope ? 'runtime_generated' : 'session_persisted' };
  let dreamPreload = null;
  try {
    dreamPreload = await stores.workingMemory.getDreamPreload({ agentId: runtimeState.agentId, project: continuityScope }) || await stores.workingMemory.getDreamPreload({ agentId: runtimeState.agentId, project: 'global' });
  } catch { dreamPreload = null; }
  return { priorSession, conversationId, resolvedWorkingRoot, continuityHandoffs, compatibilityScope, continuityScope, generatedContinuityScope, verifiedSubjectScope, deicticFiles, workspaceFiles, initialWorkingContext, ambientWorkingContext, dreamPreload };
}
