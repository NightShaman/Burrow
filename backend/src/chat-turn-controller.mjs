import { randomUUID } from 'node:crypto';
import { loadRuntimeConfig, runAskChat } from './app-runtime.mjs';
import { buildChatSupportStatus } from './workbench-status.mjs';

// ChatTurnController owns one user-visible chat turn.
// HTTP/UI/CLI adapters should normalize transport details, then hand the turn here.
export async function runChatTurn(args = {}) {
  return runAskChat(args);
}

function compactRunIdPart(value = '') {
  return String(value || 'default').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'default';
}

export function createChatTurnRunId({ sessionId = 'default', prefix = 'ask' } = {}) {
  return `${compactRunIdPart(prefix)}-${compactRunIdPart(sessionId)}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

const TEXT_ATTACHMENT_CONTENT_CHARS = 200_000;
const IMAGE_ATTACHMENT_CONTENT_CHARS = 30_000_000;

function isImageAttachment(attachment = {}) {
  const type = String(attachment?.type || attachment?.mimeType || '').toLowerCase();
  const content = String(attachment?.content || '').toLowerCase();
  return type.startsWith('image/') || content.startsWith('data:image/');
}

function normalizeAttachment(attachment = {}) {
  const normalized = {
    name: String(attachment?.name || 'attachment').slice(0, 240),
    type: String(attachment?.type || attachment?.mimeType || 'application/octet-stream').slice(0, 160),
    size: Number.isFinite(Number(attachment?.size)) ? Number(attachment.size) : null,
    encoding: String(attachment?.encoding || 'utf8').slice(0, 40),
    content: String(attachment?.content || ''),
  };
  if (isImageAttachment(normalized)) {
    if (normalized.content.length > IMAGE_ATTACHMENT_CONTENT_CHARS) {
      const error = new Error('image_attachment_too_large');
      error.statusCode = 413;
      error.details = { name: normalized.name, maxContentChars: IMAGE_ATTACHMENT_CONTENT_CHARS };
      throw error;
    }
    return normalized;
  }
  return { ...normalized, content: normalized.content.slice(0, TEXT_ATTACHMENT_CONTENT_CHARS) };
}

function textFromMessagePart(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textFromMessagePart).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';

  const type = String(value.type || '').toLowerCase();
  if (type === 'image_url' || type === 'input_image' || value.image_url || value.input_image) return '';

  const direct = textFromMessagePart(value.text ?? value.message ?? value.content ?? value.output);
  if (direct) return direct;
  return '';
}

function normalizeMessageFromBody(body = {}, attachments = []) {
  const message = textFromMessagePart(body.message).trim();
  if (message) return message;
  return attachments.some(isImageAttachment) ? 'Please analyze the attached image.' : '';
}

export function chatTurnInputFromBody({ body = {}, rootDir, dataRoot, agentDataRoot, agentRuntime = null } = {}) {
  const sessionId = String(body.sessionId || 'default').trim() || 'default';
  const attachments = Array.isArray(body.attachments)
    ? body.attachments.map(normalizeAttachment).filter((attachment) => attachment.content || attachment.size !== null)
    : [];
  const message = normalizeMessageFromBody(body, attachments);
  if (!message) {
    const error = new Error('message_required');
    error.statusCode = 400;
    throw error;
  }
  return {
    rootDir,
    command: 'chat',
    sessionId,
    // Normal chat is not a workspace-selection protocol. Continuity scope is
    // a separate explicit operator-selected namespace; neither scope nor prose
    // selects a tool path, cwd, or execution target.
    workspaceRoot: null,
    target: null,
    message,
    runId: body.runId ? String(body.runId) : createChatTurnRunId({ sessionId }),
    noCallModel: body.noCallModel === true,
    args: {
      ...(body.noCallModel === true ? { no_call_model: true } : {}),
      ...(agentRuntime ? {} : (agentDataRoot ? { agent_data_root: agentDataRoot } : { data_root: dataRoot })),
      ...(body.reasoningEffort ? { model_reasoning_effort: String(body.reasoningEffort) } : {}),
      ...(body.temperature !== undefined ? { model_temperature: body.temperature } : {}),
      ...(body.model ? { model: String(body.model) } : {}),
      ...(body.modelConnectionId ? { model_connection_id: String(body.modelConnectionId) } : {}),
      ...(body.continuityScope ? { continuity_scope: String(body.continuityScope) } : body.workingProject ? { working_project: String(body.workingProject) } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(body.abortSignal ? { abort_signal: body.abortSignal } : {}),
    },
    json: true,
  };
}

export async function runChatTurnFromBody({ body = {}, rootDir, dataRoot, agentDataRoot, agentRuntime = null, resolveAgentRuntime = null, groupChannelContext = null, onTraceRecord = null, onModelTextDelta = null, onModelThoughtDelta = null, onModelContextUsage = null, registerNestedAgentRun = null } = {}) {
  const input = chatTurnInputFromBody({ body, rootDir, dataRoot, agentDataRoot, agentRuntime });
  return runChatTurn({ ...input, agentRuntime, resolveAgentRuntime, groupChannelContext, onTraceRecord, onModelTextDelta, onModelThoughtDelta, onModelContextUsage, registerNestedAgentRun });
}



export function chatTurnInputFromWorkbenchContinuation({ item, body = {}, rootDir, dataRoot, agentDataRoot, agentRuntime = null } = {}) {
  const id = item?.id;
  const sessionId = String(body.sessionId || item?.sessionId || 'default').trim() || 'default';
  const step = body.step || item?.allowedNextSteps?.[0] || 'inspect';
  return {
    rootDir,
    command: 'chat',
    sessionId,
    workspaceRoot: body.workspaceRoot ? String(body.workspaceRoot) : item?.workspaceRoot,
    target: body.target && typeof body.target === 'object' ? body.target : null,
    message: body.message ? String(body.message) : `Continue work item ${id}`,
    runId: body.runId ? String(body.runId) : createChatTurnRunId({ sessionId, prefix: 'continue' }),
    noCallModel: body.noCallModel === true,
    args: {
      ...(body.noCallModel === true ? { no_call_model: true } : {}),
      ...(agentRuntime ? {} : (agentDataRoot ? { agent_data_root: agentDataRoot } : { data_root: dataRoot })),
      ...(body.target && typeof body.target === 'object' ? { target: body.target } : {}),
      ...(body.reasoningEffort ? { model_reasoning_effort: String(body.reasoningEffort) } : {}),
      ...(body.temperature !== undefined ? { model_temperature: body.temperature } : {}),
      ...(body.model ? { model: String(body.model) } : {}),
      ...(body.modelConnectionId ? { model_connection_id: String(body.modelConnectionId) } : {}),
      continue_work: true,
      work_item_id: id,
      work_item_step: step,
      verify_command: body.verifyCommand ? String(body.verifyCommand) : undefined,
      ...(body.workerProfile ? { workerProfile: String(body.workerProfile) } : {}),
      ...(Array.isArray(body.replacements) ? { replacements: body.replacements } : {}),
      ...(Array.isArray(body.commands) ? { commands: body.commands.map(String) } : {}),
      ...(body.commandTimeoutMs ? { commandTimeoutMs: body.commandTimeoutMs } : {}),
      override: body.override === true,
    },
    json: true,
  };
}

export async function runChatTurnFromWorkbenchContinuation({ item, body = {}, rootDir, dataRoot, agentDataRoot, agentRuntime = null } = {}) {
  const input = chatTurnInputFromWorkbenchContinuation({ item, body, rootDir, dataRoot, agentDataRoot, agentRuntime });
  return runChatTurn({ ...input, agentRuntime });
}

export function chatTurnSummary(result) {
  const trace = result.traceDir ? { runId: result.runId, sessionId: result.sessionId || null, url: `/api/traces/${encodeURIComponent(result.runId)}` } : null;
  const workItem = result.backgroundWork?.itemId ? { id: result.backgroundWork.itemId, url: `/api/tasks/${encodeURIComponent(result.backgroundWork.itemId)}` } : null;
  const promptStats = result.prompt?.stats || null;
  return {
    decision: result.decision,
    intent: result.intent || null,
    routeKind: result.session?.kind || null,
    observedResultKind: result.observedResultKind || null,
    blockers: result.chatSupport?.blockers || result.workbenchStatus?.blockers || [],
    boundaryCount: result.chatSupport?.scope?.boundaries?.length ?? result.workbenchStatus?.boundaries?.length ?? 0,
    warnings: [...(result.memory?.warnings || []), ...(result.session?.warnings || [])],
    memory: result.memory || { ok: null, project: null, facts: 0, events: 0, warnings: [] },
    memoryStage: result.memoryStage || null,
    handoffCandidate: result.handoffCandidate || null,
    memoryWrite: result.memoryWrite || null,
    chatSupport: result.chatSupport || (result.workbenchStatus ? buildChatSupportStatus({
      decision: result.workbenchStatus.result || result.decision,
      session: { kind: result.workbenchStatus.kind },
      backgroundWork: result.workbenchStatus.backgroundWork,
      blockers: result.workbenchStatus.blockers || [],
      warnings: result.workbenchStatus.warnings || [],
      memory: result.workbenchStatus.memory,
      runId: result.runId,
      traceDir: result.traceDir,
    }) : null),
    workbenchStatus: result.workbenchStatus || null,
    backgroundWork: result.backgroundWork || null,
    trace,
    workItem,
    verification: result.verification ? { required: result.verification.required ?? false, ok: result.verification.ok ?? null, reason: result.verification.reason ?? null } : null,
    proposedActionCount: result.proposedActions?.length ?? 0,
    context: promptStats ? {
      totalChars: promptStats.totalChars ?? null,
      sections: promptStats.sections || [],
      conversationChars: promptStats.conversationChars ?? 0,
      priorConversationSummaryChars: promptStats.priorConversationSummaryChars ?? 0,
      supportMemoryChars: promptStats.supportMemoryChars ?? 0,
      rawRecentTurnCount: promptStats.conversation?.rawRecentTurnCount ?? 0,
      rawRecentChars: promptStats.conversation?.rawRecentChars ?? 0,
      priorSummaryTurnCount: promptStats.conversation?.priorSummaryTurnCount ?? 0,
      firstKeptEntryId: promptStats.conversation?.firstKeptEntryId ?? null,
      summarizedTurnCount: promptStats.conversation?.summarizedTurnCount ?? 0,
      excludedCounts: {
        event: promptStats.conversation?.excludedEventCount ?? 0,
        receipt: promptStats.conversation?.excludedReceiptCount ?? 0,
        debug: promptStats.conversation?.excludedDebugCount ?? 0,
      },
      memoryProvenance: result.memory?.provenance || null,
    } : null,
  };
}

export function chatTurnResponse(result, { ok = result?.ok } = {}) {
  return { ok, summary: chatTurnSummary(result), result };
}

// Stream consumers need a stable terminal result without inheriting the
// broad diagnostic payload from the legacy JSON response. This is deliberately
// limited to user-visible final state and receipt pointers; prompts, raw model
// data, tool evidence, and runtime internals remain out of the wire stream.
export function chatTurnProgressResponse(result, { ok = result?.ok } = {}) {
  return {
    ok,
    summary: chatTurnSummary(result),
    result: {
      decision: result?.decision || null,
      runId: result?.runId || null,
      sessionId: result?.sessionId || null,
      answerText: result?.answerText || null,
      blockers: result?.blockers || result?.chatSupport?.blockers || [],
      continuity: result?.continuity || null,
      verification: result?.verification ? {
        required: result.verification.required ?? false,
        ok: result.verification.ok ?? null,
        reason: result.verification.reason ?? null,
      } : null,
      completionEvidence: result?.completionEvidence || null,
    },
  };
}

export function chatTurnErrorResponse(error) {
  if (error?.statusCode && error.statusCode >= 400 && error.statusCode < 500) return { status: error.statusCode, body: { ok: false, error: error.message, ...(error.details ? { details: error.details } : {}) } };
  return null;
}

export { loadRuntimeConfig };
