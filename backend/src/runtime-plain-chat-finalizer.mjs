import { appendRuntimeActivity, appendRuntimeSessionEntry, appendRuntimeSessionTurn } from './runtime-session-writer.mjs';
import { appendValidatedRuntimeReceipt, validateCompletedRuntimeInvariantsBeforeSideEffects, validateRuntimeInvariantsBeforeSideEffects } from './runtime-receipt-finalizer.mjs';
import { buildOutcome, skippedActionsFromChatToolLoop, summarizeToolResults } from './runtime-result-shapes.mjs';
import { boundedRedactedValue } from './redaction.mjs';
import { completionEvidence } from './completion-addendum.mjs';
import { deriveRunEvidence, persistRunEvidence } from './run-evidence.mjs';
import { buildExecutionDigest } from './execution-digest.mjs';

const PERSISTED_CHAT_LOOP_ITERATIONS = 96;

function compactPersistedToolCalls(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : []).slice(0, 32).map((call, index) => ({
    id: String(call?.id || `tool-call-${index}`).slice(0, 256),
    name: call?.name ? String(call.name).slice(0, 256) : null,
    arguments: boundedRedactedValue(call?.arguments || {}, {
      maxChars: 8_000,
      maxStringChars: 2_000,
      maxDepth: 6,
      maxItems: 24,
      maxKeys: 40,
    }),
  }));
}

export function compactChatToolLoop(loop = null) {
  if (!loop) return { enabled: false, iterations: [], tools: [] };
  return {
    enabled: Boolean(loop.enabled),
    iterations: (loop.iterations || []).slice(-PERSISTED_CHAT_LOOP_ITERATIONS).map((iteration) => ({
      iteration: iteration.iteration,
      toolCalls: compactPersistedToolCalls(iteration.toolCalls),
      executed: iteration.proposalExecution?.executed ?? 0,
      skipped: boundedRedactedValue(iteration.proposalExecution?.skipped || [], { maxChars: 8_000, maxStringChars: 1_000, maxDepth: 5, maxItems: 40, maxKeys: 30 }),
      tools: summarizeToolResults(iteration.proposalExecution?.toolResults || []),
    })),
    tools: summarizeToolResults(loop.toolResults || []),
    truncated: Boolean(loop.truncated),
    omittedIterations: Number(loop.omittedIterations || 0) + Math.max(0, (loop.iterations || []).length - PERSISTED_CHAT_LOOP_ITERATIONS),
  };
}

function activityLabel(result = {}) {
  const tool = String(result.tool || '').trim();
  const filePath = String(result.filePath || result.path || '').trim();
  const command = String(result.command || '').trim();
  if (tool === 'files_read' && filePath) return `Reading ${filePath.split('/').pop()}`;
  if ((tool === 'files_write' || tool === 'files_edit' || tool === 'files_patch') && filePath) return `Updating ${filePath.split('/').pop()}`;
  if (tool === 'files_list') return 'Listing files';
  if (tool === 'files_find') return 'Finding files';
  if (tool === 'files_inspect') return 'Checking path';
  if (tool === 'files_search') return 'Searching files';
  if (tool === 'git_status') return 'Checking repository';
  if (tool === 'git_diff') return 'Reviewing changes';
  if (tool === 'shell_exec' && /\bgit\s+diff\b/i.test(command)) return 'Reviewing changes';
  if (tool === 'shell_exec' && /\bgit\s+(?:status|log|branch)\b/i.test(command)) return 'Checking repository';
  if (tool === 'shell_exec' && /(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:check|test|lint|build)|\b(?:check|test|lint|build)\b/i.test(command)) return 'Running checks';
  if (tool === 'shell_exec' && /\b(?:ls|find|rg|grep)\b/i.test(command)) return 'Inspecting files';
  if (tool === 'shell_exec') return 'Running a task';
  if (tool === 'mcp_call') return result.mcpToolName ? `MCP ${result.mcpToolName}` : 'MCP call';
  if (tool === 'spawn_subagent') return result.label || result.summary || 'Running subagent';
  return tool.split(/[-_]/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ') || 'Working';
}

function activityDetail(result = {}) {
  return String(result.filePath || result.path || result.dirPath || result.command || result.error || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function activityGroupKey(result = {}) {
  const tool = String(result.tool || '').trim();
  const target = String(result.filePath || result.path || result.dirPath || result.cwd || result.command || result.mcpToolName || '').replace(/\s+/g, ' ').trim();
  return `${tool}|${target || activityDetail(result)}`;
}

function groupedActivityDetail(detail, count) {
  const compact = String(detail || '').slice(0, 160);
  if (count <= 1) return compact;
  const prefix = `${count} calls`;
  return compact ? `${prefix} · ${compact}` : prefix;
}

export function chatToolActivity(loop = null, runId = null) {
  const tools = summarizeToolResults(loop?.toolResults || []);
  const groups = new Map();
  for (const result of tools) {
    const label = activityLabel(result);
    const detail = activityDetail(result);
    const status = result.ok === false ? 'error' : result.ok === true ? 'ok' : 'pending';
    const key = activityGroupKey(result) || `${label}|${detail}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (status === 'error') existing.status = 'error';
      else if (status === 'pending' && existing.status !== 'error') existing.status = 'pending';
      if (!existing.detail && detail) existing.detail = detail;
      continue;
    }
    groups.set(key, { label, detail, status, count: 1 });
  }
  const items = [...groups.values()].map((group, index) => ({
    id: `activity-${index + 1}`,
    label: group.label,
    ...(groupedActivityDetail(group.detail, group.count) ? { detail: groupedActivityDetail(group.detail, group.count) } : {}),
    status: group.status,
    count: group.count,
  }));
  if (!items.length) return null;
  const failures = items.filter((item) => item.status === 'error').length;
  const totalCalls = items.reduce((sum, item) => sum + (item.count || 1), 0);
  const activityWord = items.length === 1 ? 'activity' : 'activities';
  const failureWord = failures === 1 ? 'activity' : 'activities';
  return {
    runId,
    status: failures ? 'warn' : 'ok',
    title: failures ? 'Finished with an issue' : 'Tool activity',
    summary: failures
      ? `${failures} ${failureWord} with issues across ${totalCalls} tool call${totalCalls === 1 ? '' : 's'}.`
      : `Used ${totalCalls} tool call${totalCalls === 1 ? '' : 's'} across ${items.length} ${activityWord}.`,
    totalCalls,
    items,
  };
}

export function enforcePlainChatTerminalIntegrity({ modelOk = false, answerText = '', chatToolLoop = null } = {}) {
  const rawAnswer = typeof answerText === 'string' ? answerText : String(answerText || '');
  if (!modelOk) return { decision: 'model_failed', answerText: rawAnswer, integrityViolation: null };
  const toolResultCount = Array.isArray(chatToolLoop?.toolResults) ? chatToolLoop.toolResults.length : 0;
  const iterationCount = Array.isArray(chatToolLoop?.iterations) ? chatToolLoop.iterations.length : 0;
  const usedTools = toolResultCount > 0 || iterationCount > 0;
  if (!usedTools || rawAnswer.trim()) return { decision: 'answered', answerText: rawAnswer, integrityViolation: null };
  const integrityViolation = {
    code: 'empty_answer_after_tool_use',
    severity: 'invalid',
    message: 'The model used tools but produced no final answer. Runtime will not mark the turn answered silently.',
    details: { toolResultCount, iterationCount },
  };
  return {
    decision: 'incomplete',
    answerText: 'I inspected with tools, but the model produced no final answer. I’m not claiming the work is complete.',
    integrityViolation,
  };
}

export async function appendChatToolLoopEntries({ sessionRoot, dataRoot = null, sessionId, logger, loop = null } = {}) {
  if (!loop?.iterations?.length) return;
  for (const iteration of loop.iterations.slice(-PERSISTED_CHAT_LOOP_ITERATIONS)) {
    const toolCalls = compactPersistedToolCalls(iteration.toolCalls);
    await appendRuntimeSessionEntry({
      sessionRoot,
      dataRoot,
      sessionId,
      type: 'tool_call',
      role: null,
      content: JSON.stringify({ type: 'toolCall', iteration: iteration.iteration, toolCalls }),
      runId: logger.runId,
      traceDir: logger.traceDir,
      visibility: 'debug',
      entersPrompt: false,
      metadata: { decision: 'chat_tool_call', canonicalExecution: true, iteration: iteration.iteration, toolCalls },
    });
    for (const result of iteration.proposalExecution?.toolResults || []) {
      const normalizedResult = summarizeToolResults([result])[0] || result;
      await appendRuntimeSessionEntry({
        sessionRoot,
        dataRoot,
        sessionId,
        type: 'tool_result',
        role: null,
        content: JSON.stringify(normalizedResult),
        runId: logger.runId,
        traceDir: logger.traceDir,
        visibility: 'debug',
        entersPrompt: false,
        metadata: { decision: 'chat_tool_result', canonicalExecution: true, iteration: iteration.iteration, tool: result.tool || null, callId: result.activityId || null, ok: result.ok ?? null, normalizedResult },
      });
    }
  }
  const digest = buildExecutionDigest({ toolResults: loop.toolResults || [] });
  if (digest) {
    await appendRuntimeSessionEntry({
      sessionRoot,
      dataRoot,
      sessionId,
      type: 'execution_digest',
      role: 'assistant',
      content: digest,
      runId: logger.runId,
      traceDir: logger.traceDir,
      visibility: 'debug',
      entersPrompt: true,
      metadata: { decision: 'chat_execution_digest', executionDigest: true, canonicalExecution: true, toolResultCount: loop.toolResults.length },
    });
  }
  const toolActivity = chatToolActivity(loop, logger.runId);
  if (toolActivity) {
    await appendRuntimeActivity({
      sessionRoot,
      dataRoot,
      sessionId,
      logger,
      content: toolActivity.summary,
      metadata: { decision: 'chat_tool_activity', toolActivity },
    });
  }
}

export async function finalizePlainChatRuntimeResult({
  sessionRoot,
  dataRoot,
  logger,
  command,
  message,
  sessionId,
  priorSession = null,
  route = null,
  selectedSkills = [],
  prompt = null,
  contextEngine = null,
  intent = null,
  session = null,
  workspaceRoot = null,
  backgroundWork = null,
  modelTurn = null,
  turnPlan = null,
  plannerObservability = null,
  routeDecision = null,
  canonicalTurnEnvelope = null,
  runtimeTurn = null,
  delegatedWork = null,
  structuredDelegatedWork = null,
  extraEyesReview = null,
  fileDeicticResolution = null,
  contextCompression = null,
  executionContext = null,
  subjectScope = null,
} = {}) {
  const { model, proposal, answerText, chatToolLoop, contextUsage } = modelTurn || {};
  validateRuntimeInvariantsBeforeSideEffects({ runtimeTurn, canonicalTurnEnvelope, chatToolLoop });

  const acceptanceChecklist = { required: false, status: 'not_required', complete: false, requirements: [], evidence: { mutationCount: 0, diffMutationEvidenceCount: 0, validationReceiptCount: 0 } };
  const terminalIntegrity = model
    ? enforcePlainChatTerminalIntegrity({ modelOk: Boolean(model.ok), answerText, chatToolLoop })
    : { decision: 'routed', answerText: null, integrityViolation: null };
  const decision = terminalIntegrity.decision;
  const completion = completionEvidence({ toolResults: chatToolLoop?.toolResults || [], decision });
  // Completion evidence is structured runtime metadata. It must not become
  // assistant transcript content; the transcript is the user-visible answer.
  const finalAnswerText = terminalIntegrity.answerText;
  const compactLoop = compactChatToolLoop(chatToolLoop);
  await appendChatToolLoopEntries({ sessionRoot, dataRoot, sessionId, logger, loop: chatToolLoop });
  let assistantTurn = null;
  if (finalAnswerText !== null && model?.ok) {
    assistantTurn = await appendRuntimeSessionTurn({
      sessionRoot,
      sessionId,
      role: 'assistant',
      content: finalAnswerText,
      runId: logger.runId,
      traceDir: logger.traceDir,
      metadata: { ...(subjectScope ? { subjectScope } : {}), decision, proposedActions: proposal?.actions?.length ?? 0, chatToolLoop: compactLoop, acceptanceChecklist, ...(terminalIntegrity.integrityViolation ? { terminalIntegrity: terminalIntegrity.integrityViolation } : {}) },
    });
  }
  if (model && !model.ok) {
    await appendRuntimeSessionTurn({
      sessionRoot,
      sessionId,
      role: 'assistant',
      content: `[model_error: ${model.error || 'model failed'}]`,
      runId: logger.runId,
      traceDir: logger.traceDir,
      metadata: { ...(subjectScope ? { subjectScope } : {}), decision: 'model_failed', error: model.error || null },
    });
  }
  const outcome = buildOutcome({
    decision,
    sessionId,
    session,
    backgroundWork,
    proposal,

    model,
    chatToolLoop,
  });
  const runEvidence = deriveRunEvidence({
    agentId: executionContext?.agentId || session?.agentId || null,
    sessionId,
    runId: logger.runId,
    traceDir: logger.traceDir,
    objective: message,
    answerText: finalAnswerText,
    toolResults: chatToolLoop?.toolResults || [],
    completionEvidence: completion,
    outcome,
    continuityScope: session?.continuityScope || executionContext?.continuityScope || null,
    targets: session?.targets || executionContext?.targets || [],
  });
  await persistRunEvidence({ rootDir: sessionRoot, sessionId, record: runEvidence });

  const actionRoute = session.actionRoute ?? { kind: session.kind, route: session.kind, reason: session.reason ?? null };
  const observedResultKind = decision === 'answered' ? 'answer' : null;
  const workbenchStatus = null;

  const result = {
    ok: model ? Boolean(model.ok) : true,
    mode: 'ask',
    command,
    decision,
    runId: logger.runId,
    dataRoot,
    traceDir: logger.traceDir,
    selectedSkills,
    intent,
    route,
    prompt,
    contextEngine,
    sessionId,
    sessionContext: { sessionId: priorSession?.sessionId, priorTurns: priorSession?.turnCount },
    session,
    observedResultKind,
    workbenchStatus,
    chatSupport: null,
    debug: {
      actionRoute,
      observedResultKind,
      fileDeicticResolution,

      outcome,
      turnPlan,
      plannerObservability,
      routeDecision,
      runtimeTurn,
      canonicalTurnEnvelope,
      delegatedWork,
      structuredDelegatedWork,
      extraEyesReview,
      chatToolLoop: compactLoop,
      contextCompression,
      acceptanceChecklist,
    },
    backgroundWork,
    answerText: finalAnswerText,
    assistantTurn,
    proposedActions: proposal?.actions ?? [],
    proposal,
    chatToolLoop: compactLoop,
    acceptanceChecklist,
    proposalExecution: { executed: chatToolLoop?.toolResults?.length ?? 0, skipped: skippedActionsFromChatToolLoop(chatToolLoop), tools: summarizeToolResults(chatToolLoop?.toolResults || []) },
    modelUsage: model?.usage ?? null,
    completionEvidence: completion,
    model,
    outcome,
  };

  await appendValidatedRuntimeReceipt({
    sessionRoot,
    dataRoot,
    sessionId,
    logger,
    receiptInput: { decision: result.decision, backgroundWork, prompt, contextUsage, outcome, turnPlan, plannerObservability, routeDecision, canonicalTurnEnvelope, runtimeTurn, executionContext, acceptanceChecklist, terminalIntegrity: terminalIntegrity.integrityViolation, delegatedWork: structuredDelegatedWork || (extraEyesReview ? { ...delegatedWork, extraEyesReview } : delegatedWork), completionEvidence: completion },
    invariantInput: { runtimeTurn, canonicalTurnEnvelope, chatToolLoop },
    subjectScope,
  });

  await logger.router({ stage: 'ask-result', ok: result.ok, decision: result.decision, session, backgroundWork, turnPlan, plannerObservability, routeDecision, canonicalTurnEnvelope, runtimeTurn, acceptanceChecklist, delegatedWork, structuredDelegatedWork, answerChars: finalAnswerText?.length ?? 0, proposedActions: result.proposedActions.length });
  return result;
}
