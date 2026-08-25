import { recallPriorSessionEvidence } from './session-recall.mjs';
import { readRunEvidenceAcrossSessions, readRunEvidenceWithDiagnostics, renderRunEvidence, selectRunEvidence } from './run-evidence.mjs';

export async function prepareRuntimeSupportContext({ rootDir, sessionRoot, dataRoot, runtimeState, agentRuntime, resolvedSessionId, message, priorSession, continuityScope, explicitContinuityRequested, route, runtimeConfig, logger } = {}) {
  const sessionRecall = await recallPriorSessionEvidence({
    rootDir: agentRuntime?.agentWorkspaceRoot || sessionRoot,
    additionalRootDirs: [runtimeState.agentDataRoot || dataRoot].filter(Boolean),
    sessionId: resolvedSessionId,
    message,
    priorSession,
  });
  const runEvidenceRead = await readRunEvidenceWithDiagnostics({ rootDir: sessionRoot, sessionId: resolvedSessionId });
  const runEvidenceAcrossSessions = await readRunEvidenceAcrossSessions({ rootDir: sessionRoot, sessionId: resolvedSessionId });
  const runEvidenceSelection = selectRunEvidence(runEvidenceAcrossSessions.records, {
    message,
    sessionId: resolvedSessionId,
    continuityScope: explicitContinuityRequested ? continuityScope : null,
    allowCrossSession: true,
    targets: [],
    maxChars: runtimeConfig.contextConfig?.runEvidenceChars || 6_000,
  });
  const runEvidence = {
    ...runEvidenceSelection,
    text: renderRunEvidence(runEvidenceSelection.selected, { maxChars: runtimeConfig.contextConfig?.runEvidenceChars || 6_000 }),
  };
  await logger.event?.('run-evidence-selection', {
    sessionId: resolvedSessionId,
    rootDir: sessionRoot,
    entryCount: runEvidenceRead.diagnostics.entryCount,
    evidenceEntryCount: runEvidenceRead.diagnostics.evidenceEntryCount,
    retainedCount: runEvidenceAcrossSessions.diagnostics.retainedCount,
    deduplicatedCount: runEvidenceAcrossSessions.diagnostics.deduplicatedCount,
    sessionCount: runEvidenceAcrossSessions.diagnostics.sessionCount,
    crossSession: true,
    candidateCount: runEvidence.candidateCount,
    selectedCount: runEvidence.selected.length,
    omittedCount: runEvidence.omittedCount,
    chars: runEvidence.chars,
    reason: runEvidence.reason,
    selected: runEvidence.selectedDetails,
    omitted: runEvidence.omittedDetails.slice(0, 64),
  });
  return {
    sessionRecall,
    runEvidence,
    contextSupport: {
      selectedSkills: route.promptPlan.promptSkills.map((skill) => skill.id),
      sessionRecall,
      runEvidence,
    },
  };
}
