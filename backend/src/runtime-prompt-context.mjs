import { buildContextForTurn, prepareContextForTurn } from './context-builder.mjs';
import { plainChatKernel } from './plain-chat-kernel.mjs';
import os from 'node:os';

function runtimeHostContext(executionEnvironment = null) {
  const selected = executionEnvironment && typeof executionEnvironment === 'object'
    ? executionEnvironment : { kind: 'local' };
  let selectedHost = 'local';
  if (selected.kind === 'remote') selectedHost = String(selected.targetId || '').trim() || 'unknown';
  else if (selected.kind === 'unresolved') selectedHost = `${String(selected.targetId || '').trim() || 'unknown'} (unresolved)`;
  return { agentHost: os.hostname(), selectedHost };
}

export async function prepareRuntimePromptContext({ rootDir, sessionRoot, resolvedSessionId, preparedContext, runtimeState, runtimeConfig, agentRuntime, route, ambientWorkingContext, structuredSubagents, extraEyesReview, dreamPreload, childEvidence, sessionRecall, runEvidence, groupChannelContext, promptAttachments, attachmentManifest, modelTask, logger, modelConfig, executionContext } = {}) {
  const groupSupport = groupChannelContext?.channelId && Array.isArray(groupChannelContext.turns) ? { groupChannel: groupChannelContext } : {};
  const contextBuild = await buildContextForTurn({
    rootDir,
    dataRoot: sessionRoot,
    sessionId: resolvedSessionId,
    preparedContext,
    kernel: plainChatKernel({ agentName: agentRuntime?.agent?.name || agentRuntime?.agentId || runtimeState.agentId }),
    selectedSkills: route.promptPlan.selectedSkills,
    promptSkills: route.promptPlan.promptSkills,
    availableSkills: route.skills.catalog,
    supportContext: { subagents: structuredSubagents, extraEyesReview, workingContext: ambientWorkingContext, runtimeHost: runtimeHostContext(executionContext.executionEnvironment), uiTarget: agentRuntime?.contextConfig?.uiTarget || agentRuntime?.agent?.contextConfig?.uiTarget || null, dreamPreload, childEvidence, sessionRecall, runEvidence, ...groupSupport },
    modelProfile: null,
    task: modelTask,
    attachments: promptAttachments,
    attachmentManifest,
    attachmentArtifactRoot: runtimeState.agentWorkspaceRoot,
    outputMode: 'plain',
    traceLogger: logger,
    limits: { rawRecentChars: preparedContext.turnContext?.limits?.rawRecentChars, recentDialogueChars: preparedContext.turnContext?.limits?.rawRecentChars, priorSummaryChars: preparedContext.turnContext?.limits?.priorSummaryChars },
    modelConfig,
    tools: executionContext.toolSchemas,
    promptPressure: { rootDir: sessionRoot, dataRoot: sessionRoot, agentRuntime, contextConfig: runtimeConfig.contextConfig, support: { selectedSkills: route.promptPlan.promptSkills.map((skill) => skill.id), sessionRecall, runEvidence }, logger, agentWorkspaceRoot: runtimeState.agentWorkspaceRoot, agentDataRoot: runtimeState.agentDataRoot, cacheRoot: runtimeState.cacheRoot, tools: executionContext.toolSchemas },
  });
  const turnContext = contextBuild.turnContext;
  const conversationContext = contextBuild.conversationContext;
  const prompt = contextBuild.prompt;
  const finalPromptInspection = contextBuild.budget;
  const contextCompression = { initial: preparedContext.compressionResult, promptPressure: { ...contextBuild.promptPressureCompression, finalPromptInspection }, preCompressionInspection: preparedContext.preCompressionInspection };
  return { ...contextBuild, turnContext, conversationContext, prompt, finalPromptInspection, contextCompression };
}
