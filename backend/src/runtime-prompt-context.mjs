import { appendRuntimeProviderTurn } from './runtime-session-writer.mjs';
import { buildContextForTurn, prepareContextForTurn } from './context-builder.mjs';
import { plainChatKernel } from './plain-chat-kernel.mjs';
import os from 'node:os';
import { isIP } from 'node:net';

// Provider-reported metadata is untrusted descriptive data, not routing authority.
function safeLabel(value, max = 80) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f<>`#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function runtimeHostContext(executionContext = {}) {
  const selected = executionContext?.executionEnvironment && typeof executionContext.executionEnvironment === 'object'
    ? executionContext.executionEnvironment : { kind: 'local' };
  let selectedHost = 'local';
  if (selected.kind === 'remote') selectedHost = safeLabel(selected.targetId) || 'unknown';
  else if (selected.kind === 'unresolved') selectedHost = `${safeLabel(selected.targetId) || 'unknown'} (unresolved)`;
  const context = { agentHost: safeLabel(os.hostname()), selectedHost };
  if (selected.kind !== 'remote' || typeof executionContext?.processExecutionController?.describeHost !== 'function') return context;
  let timer;
  try {
    const metadata = await Promise.race([
      Promise.resolve().then(() => executionContext.processExecutionController.describeHost(selected.targetId)),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 1_200); timer.unref?.(); }),
    ]);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || typeof metadata.hostname !== 'string' || typeof metadata.platform !== 'string'
      || !Array.isArray(metadata.addresses)) return context;
    const observed = typeof metadata.observedAt === 'string' ? Date.parse(metadata.observedAt) : NaN;
    const age = Date.now() - observed;
    // Do not promote stale or implausibly future-dated data into the current host context.
    if (!Number.isFinite(age) || age < -60_000 || age > 120_000) return context;
    const addresses = Array.isArray(metadata.addresses) ? metadata.addresses.slice(0, 8).flatMap(entry => {
      if (!entry || typeof entry !== 'object' || typeof entry.address !== 'string') return [];
      const family = isIP(entry.address);
      if (!family || entry.family !== `IPv${family}`) return [];
      return [{ interface: safeLabel(entry.interface, 40) || 'unknown',
        interfaceKind: ['lan-candidate', 'container', 'vpn', 'unknown'].includes(entry.interfaceKind) ? entry.interfaceKind : 'unknown',
        family: entry.family, address: entry.address }];
    }) : [];
    context.hostMetadata = { hostname: safeLabel(metadata.hostname), platform: safeLabel(metadata.platform),
      addresses, observedAt: new Date(observed).toISOString() };
  } catch { /* Older or offline gateways do not block prompt construction. */ }
  finally { clearTimeout(timer); }
  return context;
}

export async function prepareRuntimePromptContext({ rootDir, sessionRoot, resolvedSessionId, preparedContext, runtimeState, runtimeConfig, agentRuntime, stores = null, route, ambientWorkingContext, structuredSubagents, extraEyesReview, dreamPreload, childEvidence, sessionRecall, runEvidence, albdruckRecall, groupChannelContext, promptAttachments, attachmentManifest, modelTask, logger, modelConfig, executionContext, temporalContext = null, signal = null } = {}) {
  signal?.throwIfAborted();
  const groupSupport = groupChannelContext?.channelId && Array.isArray(groupChannelContext.turns) ? { groupChannel: groupChannelContext } : {};
  const hostContext = await runtimeHostContext(executionContext);
  signal?.throwIfAborted();
  const contextBuild = await buildContextForTurn({
    rootDir,
    dataRoot: sessionRoot,
    sessionId: resolvedSessionId,
    preparedContext,
    contextOptions: { stores, agentId: runtimeState.agentId },
    kernel: plainChatKernel({ agentName: agentRuntime?.agent?.name || agentRuntime?.agentId || runtimeState.agentId }),
    selectedSkills: route.promptPlan.selectedSkills,
    promptSkills: route.promptPlan.promptSkills,
    availableSkills: route.skills.catalog,
    supportContext: { subagents: structuredSubagents, extraEyesReview, workingContext: ambientWorkingContext, runtimeHost: hostContext, temporalContext, uiTarget: agentRuntime?.contextConfig?.uiTarget || agentRuntime?.agent?.contextConfig?.uiTarget || null, dreamPreload, childEvidence, sessionRecall, runEvidence, albdruckRecall, ...groupSupport },
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
    promptPressure: { signal, stores, agentId: runtimeState.agentId, rootDir: sessionRoot, dataRoot: sessionRoot, agentRuntime, contextConfig: runtimeConfig.contextConfig, support: { selectedSkills: route.promptPlan.promptSkills.map((skill) => skill.id), sessionRecall, runEvidence }, logger, agentWorkspaceRoot: runtimeState.agentWorkspaceRoot, agentDataRoot: runtimeState.agentDataRoot, cacheRoot: runtimeState.cacheRoot, tools: executionContext.toolSchemas },
  });
  signal?.throwIfAborted();
  const turnContext = contextBuild.turnContext;
  const conversationContext = contextBuild.conversationContext;
  const prompt = contextBuild.prompt;
  // Persist the exact selected provider turn after vision/fallback projection,
  // before dispatch. Separate content storage avoids diagnostic metadata caps.
  prompt.persistProviderTurn = async (messages) => {
    await appendRuntimeProviderTurn({ messages, stores, agentId: runtimeState.agentId,
      sessionId: resolvedSessionId, runId: logger.runId, traceDir: logger.traceDir });
  };
  const finalPromptInspection = contextBuild.budget;
  const contextCompression = { initial: preparedContext.compressionResult, promptPressure: { ...contextBuild.promptPressureCompression, finalPromptInspection }, preCompressionInspection: preparedContext.preCompressionInspection };
  return { ...contextBuild, turnContext, conversationContext, prompt, finalPromptInspection, contextCompression };
}
