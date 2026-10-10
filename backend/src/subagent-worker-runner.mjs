import { CHAT_TOOL_RESULT_HISTORY_LIMIT, CHAT_TOOL_CALL_HISTORY_LIMIT, compactToolCalls, exactRepeatVerdict, fingerprint, normalizedToolOutcome, appendBoundedChatHistory } from './tool-loop-detection.mjs';
import { accumulateToolConsequences } from './runtime-result-shapes.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createModelAdapter } from './model-adapter.mjs';
import { actionFromNativeToolCall, nativeToolSchemas } from './action-proposal.mjs';
import { reviewProposalActions } from './action-safety.mjs';
import { executeReviewedProposalActions } from './proposal-executor.mjs';
import { createExecutionContext } from './execution-context.mjs';
import { executionPolicyAllowsMutation, normalizeExecutionPolicyInput } from './execution-policy.mjs';
import { conversationAuthority } from './conversation-authority.mjs';
import { updateSubagentStatus } from './subagent-store.mjs';
import { normalizeProviderMessages } from './provider-messages.mjs';
import { prepareNativeToolContinuation } from './native-continuation-preparation.mjs';
import { changedPathsFromToolResults, summarizeToolResults } from './runtime-result-shapes.mjs';
import { boundedRedactedValue } from './redaction.mjs';
import { chatToolActivity } from './runtime-plain-chat-finalizer.mjs';

function compactString(value) {
  return String(value || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function subagentLiveActivity({ kind, phase, status = 'running', label = null, sequence = 0, startedAt = null, completedAt = null, tool = null, model = null, error = null, counts = null, heartbeatAt = null } = {}) {
  const actualAt = nowIso();
  return {
    kind: compactString(kind) || 'activity',
    status,
    phase: compactString(phase) || null,
    label: compactString(label) || null,
    sequence,
    startedAt: startedAt || actualAt,
    completedAt,
    lastActualActivityAt: actualAt,
    heartbeatAt,
    tool: compactString(tool) || null,
    model: compactString(model) || null,
    error: compactString(error).slice(0, 500) || null,
    counts,
  };
}

// Memory search belongs to the parent runtime's configured memory boundary.
// Children receive only compact parent evidence; they do not inherit credentials
// or get an accidental cross-project retrieval surface.

function subagentFinishToolSchema() {
  return {
    type: 'function',
    function: {
      name: 'finish_subagent',
      description: 'Terminal minion completion signal. Use exactly once when no more tools are needed. The runtime only treats this structured tool call as child completion.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['completed', 'incomplete', 'failed'] },
          summary: { type: 'string', description: 'Readable final Markdown report for the parent and child transcript. Preserve paragraphs, lists, code, and headings where useful; do not compress the report into one paragraph.' },
          blockers: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          verification: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', enum: ['passed', 'failed', 'failed_expected', 'not_run'] },
              check: { type: 'string' },
              observed: { type: 'string' },
              actionRequired: { type: 'boolean' },
            },
            required: ['status'],
          },
        },
        required: ['status', 'summary'],
      },
    },
  };
}

function subagentToolSchemas({ includeFinish = true } = {}) {
  // Isolated child processes do not own the server Forge dispatcher.
  const tools = nativeToolSchemas({ includeForge: false });
  return includeFinish ? [...tools, subagentFinishToolSchema()] : tools;
}


function childPrompt({ task, target }) {
  return [
    'You are an isolated child agent. Inspect independently and return concise, readable Markdown findings for the parent. Use paragraphs and lists where useful, not a compressed wall of text. Put your final report in finish_subagent.summary; do not duplicate it in accompanying assistant text.',
    `Working directory: ${target.root}`,
    'The structural target establishes working context, cwd, lineage, and evidence provenance. It is not a tool permission cage.',
    'Use the normal runtime tool surface when useful. Runtime validates selected actions and rejects only malformed input or configured hard blocks.',
    'Use direct tool evidence. For large/truncated files, inspect later ranges before root-cause conclusions.',
    'Do not claim you inspected files unless tool evidence supports it.',
    'In your final report, identify this target root and distinguish executed evidence (for example git status/diff or build output) from conclusions. Do not validate a different repository or branch by implication.',
    'If you check a condition, finish with structured verification: status passed, failed, failed_expected, or not_run; check; observed; and actionRequired. A deliberate probe failure is failed_expected with actionRequired false.',
    '',
    `Task: ${task}`,
  ].join('\n');
}

function proposalFromNativeToolCalls(toolCalls = [], fallbackText = '') {
  const actions = toolCalls.map(actionFromNativeToolCall);
  return { actions, answerText: fallbackText };
}

function compactChildToolCalls(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : []).slice(0, 32).map((call, index) => ({
    id: String(call?.id || `tool-call-${index}`).slice(0, 256),
    name: call?.name ? String(call.name).slice(0, 256) : null,
    arguments: boundedRedactedValue(call?.arguments || {}, { maxChars: 8_000, maxStringChars: 2_000, maxDepth: 6, maxItems: 24, maxKeys: 40 }),
  }));
}

async function appendChildToolRound({ authority, rootDir, sessionId, runId, traceDir, iteration, toolCalls = [], toolResults = [], activitySequence }) {
  const compactCalls = compactChildToolCalls(toolCalls);
  if (compactCalls.length) {
    await authority.append({
      sessionId, type: 'tool_call', role: null,
      content: JSON.stringify({ type: 'toolCall', iteration, toolCalls: compactCalls }),
      runId, traceDir, visibility: 'debug', entersPrompt: false,
      metadata: { decision: 'chat_tool_call', canonicalExecution: true, subagentExecution: true, iteration, toolCalls: compactCalls },
    });
  }
  for (const result of toolResults) {
    const normalizedResult = summarizeToolResults([result])[0] || result;
    await authority.append({
      sessionId, type: 'tool_result', role: null, content: JSON.stringify(normalizedResult),
      runId, traceDir, visibility: 'debug', entersPrompt: false,
      metadata: { decision: 'chat_tool_result', canonicalExecution: true, subagentExecution: true, iteration, tool: result.tool || null, callId: result.activityId || null, ok: result.ok ?? null, normalizedResult },
    });
  }
  const toolActivity = chatToolActivity({ toolResults }, runId);
  if (!toolActivity) return activitySequence;
  const sequence = activitySequence + 1;
  await authority.append({
    sessionId, runId, traceDir, type: 'event', visibility: 'activity', entersPrompt: false, role: null, content: toolActivity.summary,
    metadata: { decision: 'chat_tool_activity', subagentExecution: true, toolActivity, activitySequence: sequence },
  });
  return sequence;
}

async function runSubagentToolCalls({ toolCalls = [], target, dataRoot, childSessionId, conversationId = null, traceLogger = null, executionPolicy: executionPolicyInput = null, modelConfig = null, observedToolResults = [], parentExecutionContext = null, signal = null } = {}) {
  const executionPolicy = normalizeExecutionPolicyInput(executionPolicyInput);
  toolCalls = toolCalls.map((call, index) => ({ ...call, id: call.id || `tool-call-${index}` }));
  const proposal = proposalFromNativeToolCalls(toolCalls);
  const reviews = reviewProposalActions({ actions: proposal.actions, workspaceRoot: target.root, executionContext: parentExecutionContext });
  const executionContext = createExecutionContext({
    conversationStore: parentExecutionContext?.conversationStore || parentExecutionContext?.stores?.conversations,
    stores: parentExecutionContext?.stores,
    agentId: parentExecutionContext?.agentId,
    executionBoundaries: parentExecutionContext?.executionBoundaries || null,
    abortSignal: signal,
    sessionId: childSessionId, conversationId, workspaceRoot: target.root, target, dataRoot, cacheRoot: traceLogger?.traceDir || null,
    executionEnvironment: parentExecutionContext?.executionEnvironment?.kind === 'remote' ? parentExecutionContext.executionEnvironment : null,
    processExecutionTarget: parentExecutionContext?.processExecutionTarget?.kind === 'remote' ? parentExecutionContext.processExecutionTarget : (parentExecutionContext?.executionEnvironment?.kind === 'remote' ? parentExecutionContext.executionEnvironment : null),
    processExecutionController: (parentExecutionContext?.processExecutionTarget?.kind === 'remote' || parentExecutionContext?.executionEnvironment?.kind === 'remote') ? parentExecutionContext?.processExecutionController || null : null,
    processExecutionRouter: (parentExecutionContext?.processExecutionTarget?.kind === 'remote' || parentExecutionContext?.executionEnvironment?.kind === 'remote') ? parentExecutionContext?.processExecutionRouter || null : null,
    parentRunId: parentExecutionContext?.parentRunId || traceLogger?.runId || null,
  });
  const execution = await executeReviewedProposalActions({
    actions: proposal.actions, reviews: reviews.reviews, workspaceRoot: target.root, rootDir: target.root,
    dataRoot, sessionId: childSessionId, traceLogger, executionPolicy, modelConfig,
    allowMutations: executionPolicyAllowsMutation(executionPolicy),
    observedToolResults, executionContext, abortSignal: signal,
  });
  const resultsByCallId = new Map((execution.nativeToolResults || execution.toolResults).map((result, index) => {
    const compact = execution.toolResults[index] || {};
    // Execution receipts are deliberately compact, but the immediate provider
    // continuation must receive the original selected evidence (for example a
    // loaded skill body). Pair by immutable call ID; positional overlay was both
    // lossy and unsafe after executor deduplication.
    return [result.toolCallId, { ...compact, ...result, toolCallId: result.toolCallId }];
  }));
  const results = toolCalls.map((call, index) => {
    const executed = resultsByCallId.get(call.id);
    if (executed) return executed;
    const skipped = execution.skipped.find(item => item.index === index);
    const review = reviews.reviews.find(item => item.index === index);
    const status = skipped?.status || review?.status || 'not_executed';
    return { tool: call.name || null, toolCallId: call.id, ok: false, status,
      error: status === 'cancelled' ? 'cancelled' : (skipped?.blockers || review?.blockers || ['tool_call_not_executed']).join(', ') };
  });
  return { results, skipped: execution.skipped };
}

function applyFinalProviderDelivery({ toolCalls = [], toolResults = [], messages = [] } = {}) {
  const byCallId = new Map((toolCalls || []).map((call, index) => [String(call?.id || `tool-call-${index}`), toolResults[index]]));
  for (const message of messages || []) {
    if (message?.role !== 'tool' || !message.tool_call_id) continue;
    const result = byCallId.get(String(message.tool_call_id));
    if (!result || result.tool !== 'files_read') continue;
    let receipt;
    try { receipt = JSON.parse(String(message.content || '{}')); } catch { continue; }
    const projected = receipt?.content;
    const deliveredText = typeof projected === 'string' ? projected : (projected && typeof projected.text === 'string' ? projected.text : '');
    const returnedBytes = Buffer.byteLength(deliveredText, result.encoding || 'utf8');
    const rawReturnedBytes = Number(result.returnedBytes ?? Buffer.byteLength(String(result.content || ''), result.encoding || 'utf8'));
    const offsetBytes = Number(result.offsetBytes || 0);
    result.delivery = {
      returnedBytes,
      truncated: returnedBytes < rawReturnedBytes || Boolean(result.truncated),
      nextOffsetBytes: offsetBytes + returnedBytes,
    };
  }
}

function continuationToolCallsForTruncatedEvidence(toolResults = [], continuationCounts = new Map()) {
  const calls = [];
  const deliveredRanges = toolResults.filter(result => result?.ok && result.tool === 'files_read' && result.filePath)
    .map(result => ({ filePath: result.filePath, start: Number(result.offsetBytes || 0),
      end: Number(result.offsetBytes || 0) + Number(result.delivery?.returnedBytes ?? result.returnedBytes ?? 0) }));
  for (const result of toolResults) {
    if (!result?.ok || !(result.delivery?.truncated ?? result.truncated) || !result.filePath) continue;
    let offsetBytes = Math.max(0, Number(result.delivery?.nextOffsetBytes ?? (Number(result.offsetBytes || 0) + Number(result.returnedBytes || 0))));
    if (!Number.isFinite(offsetBytes) || offsetBytes >= Number(result.bytes || 0)) continue;
    // Only contiguous delivered bytes close a gap; a disjoint later read does not.
    let previous;
    do {
      previous = offsetBytes;
      for (const range of deliveredRanges) {
        if (range.filePath === result.filePath && range.start <= offsetBytes && range.end > offsetBytes) offsetBytes = range.end;
      }
    } while (previous !== offsetBytes);
    if (offsetBytes >= Number(result.bytes || 0)) continue;
    const key = `${result.filePath}:${offsetBytes}`;
    if (continuationCounts.has(key)) continue;
    continuationCounts.set(key, true);
    calls.push({ name: 'files_read', arguments: { filePath: result.filePath, offsetBytes, maxBytes: 32_000 }, forcedContinuation: true });
    if (calls.length >= 2) break;
  }
  return calls;
}

const CHILD_EVIDENCE_LEDGER_CHAR_BUDGET = 24_000;
const CHILD_EVIDENCE_EXCERPT_CHAR_BUDGET = 36_000;
const CHILD_EVIDENCE_SINGLE_EXCERPT_CHARS = 6_000;

function compactText(value, maxChars) {
  const text = String(value || '');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[${text.length - maxChars} chars omitted]` : text;
}

function evidenceLabel(result = {}, index) {
  const status = result.ok ? 'ok' : 'failed';
  if (result.tool === 'files_read') return `#${index} files_read ${status} ${result.filePath || 'unknown'} bytes ${result.offsetBytes || 0}-${Number(result.offsetBytes || 0) + Number(result.returnedBytes || 0)}${result.truncated ? ' (truncated)' : ''}`;
  if (result.tool === 'shell_exec') return `#${index} shell_exec ${status} ${compactText(result.command, 240)}`;
  if (result.tool === 'files_list') return `#${index} files_list ${status} ${result.dirPath || 'unknown'} entries=${result.entries?.length ?? 0}${result.truncated ? ' truncated' : ''}`;
  if (result.tool === 'files_find') return `#${index} files_find ${status} ${result.dirPath || 'unknown'} pattern=${result.pattern || '*'} paths=${result.paths?.length ?? 0}${result.truncated ? ' truncated' : ''}`;
  if (result.tool === 'files_inspect') return `#${index} files_inspect ${status} ${result.path || 'unknown'} exists=${result.exists ?? 'unknown'}`;
  if (result.tool === 'files_search') return `#${index} files_search ${status} ${result.dirPath || 'unknown'} query=${JSON.stringify(result.query || '')} matches=${result.matches?.length ?? 0}${result.truncated ? ' truncated' : ''}`;
  if (result.tool === 'git_status' || result.tool === 'git_diff') return `#${index} ${result.tool} ${status} ${result.dirPath || 'unknown'} exit=${result.exitCode ?? 'unknown'}`;
  if (result.tool === 'files_edit') return `#${index} files_edit ${status} ${result.filePath || 'unknown'} changed=${(result.changedFiles || []).length}`;
  if (result.tool === 'spawn_subagent') return `#${index} spawn_subagent ${status} ${result.id || 'unknown'}: ${compactText(result.summary, 320)}`;
  return `#${index} ${result.tool || 'tool'} ${status}`;
}

function compactEvidenceItem(result = {}) {
  const base = { tool: result.tool || 'unknown', ok: Boolean(result.ok), sideEffectsApplied: result.sideEffectsApplied };
  if (result.tool === 'files_read') return {
    ...base,
    filePath: result.filePath || null,
    offsetBytes: Number(result.offsetBytes || 0),
    returnedBytes: Number(result.returnedBytes || 0),
    bytes: Number(result.bytes || 0),
    truncated: Boolean(result.truncated),
    content: compactText(result.content, CHILD_EVIDENCE_SINGLE_EXCERPT_CHARS),
    delivery: result.delivery || { returnedBytes: Buffer.byteLength(String(result.content || "").slice(0, CHILD_EVIDENCE_SINGLE_EXCERPT_CHARS)), truncated: Boolean(result.truncated) || String(result.content || "").length > CHILD_EVIDENCE_SINGLE_EXCERPT_CHARS, nextOffsetBytes: Number(result.offsetBytes || 0) + Buffer.byteLength(String(result.content || "").slice(0, CHILD_EVIDENCE_SINGLE_EXCERPT_CHARS)) },
    error: compactText(result.error, 800) || null,
    warnings: (result.warnings || []).slice(0, 8),
  };
  if (result.tool === 'shell_exec') return {
    ...base,
    command: compactText(result.command, 800),
    exitCode: result.exitCode ?? null,
    stdout: compactText(result.stdout, CHILD_EVIDENCE_SINGLE_EXCERPT_CHARS),
    stderr: compactText(result.stderr, 1_200),
    stdoutTruncated: Boolean(result.stdoutTruncated),
    error: compactText(result.error, 800) || null,
  };
  if (result.tool === 'files_list') return {
    ...base, dirPath: result.dirPath || null,
    entries: (result.entries || []).slice(0, 200).map((entry) => ({ path: entry?.path || null, type: entry?.type || null })),
    truncated: Boolean(result.truncated), resultFingerprint: result.resultFingerprint || null,
    warnings: (result.warnings || []).slice(0, 8), error: compactText(result.error, 800) || null,
  };
  if (result.tool === 'files_find') return {
    ...base, dirPath: result.dirPath || null, pattern: result.pattern || null,
    paths: (result.paths || []).slice(0, 200), truncated: Boolean(result.truncated), resultFingerprint: result.resultFingerprint || null,
    warnings: (result.warnings || []).slice(0, 8), error: compactText(result.error, 800) || null,
  };
  if (result.tool === 'files_inspect') return {
    ...base, path: result.path || null, exists: typeof result.exists === 'boolean' ? result.exists : null,
    type: result.type || null, size: Number.isFinite(Number(result.size)) ? Number(result.size) : null,
    modifiedAt: result.modifiedAt || null, resultFingerprint: result.resultFingerprint || null, error: compactText(result.error, 800) || null,
  };
  if (result.tool === 'files_search') return {
    ...base, dirPath: result.dirPath || null, query: compactText(result.query, 1_000),
    matches: (result.matches || []).slice(0, 200).map((match) => ({ filePath: match?.filePath || null, line: match?.line ?? null, text: compactText(match?.text, 500) })),
    truncated: Boolean(result.truncated), resultFingerprint: result.resultFingerprint || null,
    warnings: (result.warnings || []).slice(0, 8), error: compactText(result.error, 800) || null,
  };
  if (result.tool === 'git_status' || result.tool === 'git_diff') return {
    ...base, dirPath: result.dirPath || null, command: compactText(result.command, 800), exitCode: result.exitCode ?? null,
    stdout: compactText(result.stdout, CHILD_EVIDENCE_SINGLE_EXCERPT_CHARS), stderr: compactText(result.stderr, 1_200),
    resultFingerprint: result.resultFingerprint || null, error: compactText(result.error, 800) || null,
  };
  if (['files_write', 'files_edit', 'files_patch'].includes(result.tool)) return {
    ...base, filePath: result.filePath || null, touchedFiles: (result.touchedFiles || []).slice(0, 20), changedFiles: (result.changedFiles || []).slice(0, 20),
    beforeHash: result.beforeHash || null, afterHash: result.afterHash || null, resultFingerprint: result.resultFingerprint || null,
    error: compactText(result.error, 800) || null,
  };
  if (result.tool === 'spawn_subagent') return {
    ...base,
    id: result.id || null,
    status: result.status || null,
    summary: compactText(result.summary, CHILD_EVIDENCE_SINGLE_EXCERPT_CHARS),
    blockers: (result.blockers || []).slice(0, 8),
    warnings: (result.warnings || []).slice(0, 8),
    evidenceCount: Array.isArray(result.evidence) ? result.evidence.length : 0,
  };
  return { ...base, error: compactText(result.error, 800) || null };
}

function boundedEvidenceLedger(toolResults = []) {
  const lines = [];
  let used = 0;
  for (const [index, result] of toolResults.entries()) {
    const line = evidenceLabel(result, index + 1);
    if (used + line.length + 1 > CHILD_EVIDENCE_LEDGER_CHAR_BUDGET) {
      lines.push(`[${toolResults.length - index} later evidence references omitted by ledger budget]`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

function boundedEvidenceExcerpts(results = []) {
  const excerpts = [];
  let used = 0;
  for (const result of results) {
    const text = JSON.stringify(compactEvidenceItem(result), null, 2);
    if (used + text.length > CHILD_EVIDENCE_EXCERPT_CHAR_BUDGET) {
      excerpts.push('[later current-round evidence omitted by prompt budget; inspect the artifact or request a narrower read]');
      break;
    }
    excerpts.push(text);
    used += text.length;
  }
  return excerpts.join('\n');
}

function compactEvidenceForHandoff(toolResults = []) {
  const retained = [];
  let used = 0;
  for (const result of toolResults) {
    const compact = compactEvidenceItem(result);
    const chars = JSON.stringify(compact).length;
    if (used + chars > CHILD_EVIDENCE_EXCERPT_CHAR_BUDGET) {
      retained.push({ tool: result?.tool || 'unknown', ok: Boolean(result?.ok), omitted: true, reason: 'subagent_handoff_evidence_budget' });
      break;
    }
    retained.push(compact);
    used += chars;
  }
  return retained;
}

function retainChildResults(history, results, { limit = CHAT_TOOL_RESULT_HISTORY_LIMIT } = {}) {
  history.consequences = accumulateToolConsequences(history.consequences, results);
  history.allArtifacts ||= new Set();
  history.allMemoryWrites ||= new Set();
  for (const result of results) {
    for (const item of (Array.isArray(result.artifacts) ? result.artifacts : (result.artifacts ? [result.artifacts] : []))) history.allArtifacts.add(item);
    if (result.ok) for (const item of (Array.isArray(result.memoryWrites) ? result.memoryWrites : [])) history.allMemoryWrites.add(item);
    if ((result.sideEffectsApplied === true || (result.ok && ['files_write', 'files_edit', 'files_patch'].includes(result.tool)))) history.sideEffectsApplied = true;
    else if (result.ok && !['files_read', 'files_list', 'files_find', 'files_search', 'files_inspect', 'git_status', 'git_diff'].includes(result.tool) && result.sideEffectsApplied !== false && history.sideEffectsApplied !== true) history.sideEffectsApplied = null;
    const receipt = compactEvidenceItem(result);
    if (result.tool === 'files_read') receipt.content = String(result.content || '').slice(0, CHILD_EVIDENCE_SINGLE_EXCERPT_CHARS);
    if (result.tool === 'files_read') receipt.delivery = result.delivery || { returnedBytes: result.returnedBytes || 0, truncated: Boolean(result.truncated) || String(result.content || '').length > CHILD_EVIDENCE_SINGLE_EXCERPT_CHARS, nextOffsetBytes: Number(result.offsetBytes || 0) + Number(result.returnedBytes || 0) };
    appendBoundedChatHistory(history, receipt, Math.max(1, Number(limit) || CHAT_TOOL_RESULT_HISTORY_LIMIT), 'omittedToolResults');
  }
}

function subagentResult({ ok, summary, outcome = null, blockers = [], warnings = [], verification = null, toolResults = [], target = null } = {}) {
  return {
    ok: Boolean(ok),
    ...(outcome ? { outcome } : {}),
    summary: compactText(summary, 12_000) || (ok ? 'Minion completed.' : 'Minion failed.'),
    blockers: blockers.slice(0, 20),
    warnings: warnings.slice(0, 20),
    // Full raw tool output is preserved in the child trace artifacts. The IPC
    // result and delegated record deliberately carry bounded evidence only.
    evidence: compactEvidenceForHandoff(toolResults),
    artifacts: toolResults.allArtifacts ? [...toolResults.allArtifacts] : toolResults.flatMap(result => result.artifacts || []),
    changedFiles: toolResults.consequences?.changedFiles || changedPathsFromToolResults(toolResults),
    memoryWrites: toolResults.allMemoryWrites ? [...toolResults.allMemoryWrites] : toolResults.flatMap(result => result.ok ? (result.memoryWrites || []) : []),
    ...(toolResults.consequences ? { consequences: toolResults.consequences, omittedToolResults: toolResults.omittedToolResults || 0 } : {}),
    ...(verification ? { verification } : {}),
    sideEffectsApplied: toolResults.consequences ? (toolResults.sideEffectsApplied ?? (toolResults.sideEffectsApplied === null ? null : false)) : toolResults.some(result => (result.sideEffectsApplied === true || (result.ok && ['files_write', 'files_edit', 'files_patch'].includes(result.tool)))) ? true
      : toolResults.some(result => result.ok && !['files_read', 'files_list', 'files_find', 'files_search', 'files_inspect', 'git_status', 'git_diff'].includes(result.tool) && result.sideEffectsApplied !== false) ? null : false,
    verificationTarget: target?.root || null,
  };
}

function choiceText(choice = {}) {
  return typeof choice?.text === 'string' ? choice.text : '';
}

function choiceToolCalls(choice = {}) {
  return Array.isArray(choice?.toolCalls) ? choice.toolCalls : [];
}

function subagentEmptyFinalResult({ toolResults = [], target = null, reason = 'subagent_empty_final_response', summary = 'Minion gathered evidence but produced no final report.' } = {}) {
  return subagentResult({
    ok: false,
    summary,
    blockers: [reason],
    toolResults,
    target,
  });
}

function subagentTerminalMissingResult({ toolResults = [], target = null, text = '' } = {}) {
  const summary = compactString(text) || 'Minion did not emit a structured terminal completion signal.';
  return subagentResult({ ok: false, summary, blockers: ['subagent_terminal_signal_missing'], toolResults, target });
}

function terminalResultFromToolCalls(toolCalls = [], { toolResults = [], target = null } = {}) {
  const call = toolCalls.find((item) => item?.name === 'finish_subagent');
  if (!call) return null;
  if (toolCalls.length !== 1) return subagentResult({ ok: false, summary: 'Mixed terminal batch rejected; requested actions were not executed.', blockers: ['subagent_terminal_must_be_sole_call'], toolResults, target });
  const args = call.arguments || {};
  const status = compactString(args.status || 'completed');
  const summary = compactString(args.summary);
  const blockers = Array.isArray(args.blockers) ? args.blockers.map(compactString).filter(Boolean) : [];
  const warnings = Array.isArray(args.warnings) ? args.warnings.map(compactString).filter(Boolean) : [];
  const verification = args.verification && typeof args.verification === 'object' ? {
    status: compactString(args.verification.status),
    check: compactString(args.verification.check) || null,
    observed: compactString(args.verification.observed) || null,
    actionRequired: Boolean(args.verification.actionRequired),
  } : null;
  if (!summary) return subagentResult({ ok: false, summary: 'Minion terminal signal omitted summary.', blockers: ['subagent_terminal_summary_required'], warnings, verification, toolResults, target });
  if (status === 'completed') return subagentResult({ ok: true, summary, outcome: status, blockers, warnings, verification, toolResults, target });
  return subagentResult({ ok: false, summary, outcome: status, blockers: blockers.length ? blockers : [`subagent_${status || 'incomplete'}`], warnings, verification, toolResults, target });
}

function finalSynthesisPrompt({ prompt, toolResults = [] } = {}) {
  return [
    followupPromptWithEvidence({ prompt, toolResults, latestResults: [], allowMoreTools: false }),
    '',
    'TERMINAL CONTRACT:',
    'No more inspection tools are available in this child run.',
    'Call finish_subagent exactly once with structured status and summary. Text alone is not a completion signal.',
    'Use status "completed" for a completed report, "incomplete" when evidence is insufficient, or "failed" for a blocker.',
    'When your task checks a condition, include verification as structured data: status passed, failed, failed_expected, or not_run; include check, observed, and actionRequired. A deliberately absent fixture is failed_expected with actionRequired false.',
  ].join('\n');
}

function followupPromptWithEvidence({ prompt, toolResults = [], latestResults = [], allowMoreTools = false } = {}) {
  return [
    prompt,
    '',
    'Evidence ledger (retained executed evidence references; full output remains in child trace artifacts):',
    toolResults.omittedToolResults ? `${toolResults.omittedToolResults} older receipts omitted from the retained window; all-run consequences remain aggregated.` : null,
    boundedEvidenceLedger(toolResults) || '(no evidence)',
    '',
    'Current-round compact tool evidence JSON:',
    boundedEvidenceExcerpts(latestResults) || '(no new tool evidence)',
    '',
    allowMoreTools
      ? 'If the evidence is truncated before the relevant code, call files_read again with offsetBytes/maxBytes. Otherwise answer using only the evidence above.'
      : 'Using only the evidence above, answer the parent task concisely. If the evidence is insufficient or truncated before the relevant code, say so instead of guessing.',
  ].join('\n');
}

export async function runSpawnSubagentChild({
  id,
  task,
  target,
  dataRoot,
  childSessionId,
  owner = {},
  modelConfig = null,
  traceDir = null,
  executionPolicy: executionPolicyInput = null,
  progress = null,
  parentExecutionContext = null,
  signal = parentExecutionContext?.abortSignal || null,
} = {}) {
  const conversationStore = parentExecutionContext?.conversationStore || parentExecutionContext?.stores?.conversations;
  if (!conversationStore) throw new Error('conversation_store_required');
  const agentId = owner?.agentId;
  if (typeof agentId !== 'string' || !agentId.trim()) throw new Error('agent_id_required');
  if (parentExecutionContext?.agentId && parentExecutionContext.agentId !== agentId) throw new Error('subagent_owner_agent_mismatch');
  parentExecutionContext = { ...parentExecutionContext, conversationStore, agentId };
  const authority = conversationAuthority({ store: conversationStore, agentId: parentExecutionContext.agentId });
  const blockers = [];
  if (!id) blockers.push('subagent_id_required');
  if (!compactString(task)) blockers.push('subagent_task_required');
  if (!target?.root) blockers.push('subagent_target_required');
  if (!dataRoot) blockers.push('subagent_data_root_required');
  if (!childSessionId) blockers.push('subagent_child_session_required');
  if (!modelConfig) blockers.push('subagent_model_config_required');
  if (blockers.length) {
    return { ok: false, summary: 'Minion child did not run.', blockers, warnings: [], evidence: [], artifacts: [], changedFiles: [], memoryWrites: [], sideEffectsApplied: false };
  }

  let liveActivitySequence = 0;
  const recordLiveActivity = async (activity, provenanceReason = activity?.phase || activity?.kind || 'activity') => {
    liveActivitySequence += 1;
    await updateSubagentStatus({
      dataRoot,
      id,
      status: 'running',
      phase: activity?.phase || 'model-loop',
      activity: subagentLiveActivity({ ...activity, sequence: liveActivitySequence }),
      provenance: { source: 'spawn-subagent-child', reason: provenanceReason },
    });
  };

  await progress?.({ type: 'subagent-progress', phase: 'started', id });
  await recordLiveActivity({ kind: 'run', phase: 'model-loop', label: 'Subagent started' }, 'started');
  const prompt = childPrompt({ task, target });
  await authority.append({ sessionId: childSessionId, type: 'event', content: prompt, visibility: 'debug', entersPrompt: false, runId: id, traceDir, metadata: { kind: 'subagent-runtime-context', parentSessionId: owner.sessionId || null, parentConversationId: owner.conversationId || null, parentRunId: owner.parentRunId || null } });

  const childTraceDir = traceDir || path.join(dataRoot, 'subagents', id, 'trace');
  const modelTrace = {
    traceDir: childTraceDir,
    model: async (payload) => {
      const file = path.join(childTraceDir, 'model-events.jsonl');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(payload)}\n`, 'utf8');
    },
    tool: async () => {},
    artifact: async (name, content) => {
      const file = path.join(childTraceDir, 'artifacts', String(name || 'artifact').replace(/[^a-zA-Z0-9._-]+/g, '-'));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(content || ''), 'utf8');
      return file;
    },
  };
  const adapter = createModelAdapter({ config: modelConfig });
  const messages = normalizeProviderMessages([{ role: 'system', content: 'Internal subagent task. This isolated child request is not parent conversation history.' }, { role: 'user', content: prompt }]);
  await progress?.({ type: 'subagent-progress', phase: 'model-request', id });
  await recordLiveActivity({ kind: 'model', phase: 'model-request', label: 'Waiting for model response', model: modelConfig?.model || null }, 'model_request');
  const first = await adapter.complete({ messages, tools: subagentToolSchemas(), traceLogger: modelTrace, signal });
  await progress?.({ type: 'subagent-progress', phase: 'model-response', id });
  await recordLiveActivity({ kind: 'model', phase: 'model-response', label: first.ok ? 'Model response received' : 'Model response failed', status: first.ok ? 'completed' : 'error', model: modelConfig?.model || null, error: first.ok ? null : (first.error || first.status) }, first.ok ? 'model_response' : 'model_error');
  if (!first.ok) {
    const result = { ok: false, summary: 'Minion model call failed.', blockers: [`subagent_model_failed:${first.error || first.status}`], warnings: [], evidence: [], artifacts: [], changedFiles: [], memoryWrites: [], sideEffectsApplied: false };
    await updateSubagentStatus({ dataRoot, id, status: 'failed', phase: 'idle', result, activity: subagentLiveActivity({ kind: 'terminal', phase: 'idle', status: 'error', label: 'Subagent failed', completedAt: nowIso(), error: result.blockers?.[0] || null }), provenance: { source: 'spawn-subagent-child', reason: 'model_failed' } });
    return result;
  }

  const firstToolCalls = choiceToolCalls(first.choice);
  const firstText = choiceText(first.choice);
  // Tool requests are persisted as canonical structured activity, not fake assistant text.
  if (compactString(firstText)) await authority.appendTurn({ visibility: terminalResultFromToolCalls(firstToolCalls) ? 'debug' : 'chat', entersPrompt: !terminalResultFromToolCalls(firstToolCalls), sessionId: childSessionId, role: 'assistant', content: firstText, runId: id, traceDir, metadata: { kind: 'subagent-model-response', toolCallCount: firstToolCalls.length } });

  let lastText = firstText;
  let activitySequence = 0;
  const toolResults = [];
  const completedCalls = [];
  let current = first;
  let terminalResult = terminalResultFromToolCalls(firstToolCalls, { toolResults, target });
  const forcedContinuations = new Map();
  for (let round = 0; !terminalResult; round += 1) {
    let toolCalls = choiceToolCalls(current.choice);
    terminalResult = terminalResultFromToolCalls(toolCalls, { toolResults, target });
    if (terminalResult) break;
    if (!toolCalls.length) {
      const forced = continuationToolCallsForTruncatedEvidence(toolResults, forcedContinuations);
      if (!forced.length) break;
      toolCalls = forced;
    }
    signal?.throwIfAborted();
    const repeat = exactRepeatVerdict(toolCalls, completedCalls, modelConfig || {});
    if (repeat?.action === 'block') {
      terminalResult = subagentResult({ ok: false, summary: 'Minion stopped repeated unchanged tool calls; work may be incomplete.', blockers: ['subagent_repeated_no_progress'], toolResults, target });
      break;
    }
    await progress?.({ type: 'subagent-progress', phase: 'tool-request', id, toolCallCount: toolCalls.length });
    await recordLiveActivity({ kind: 'tool', phase: 'tool-request', label: `Starting ${toolCalls.length} tool${toolCalls.length === 1 ? '' : 's'}`, tool: toolCalls[0]?.name || null, counts: { toolCalls: toolCalls.length } }, 'tool_request');
    const batch = await runSubagentToolCalls({ toolCalls, target, dataRoot, childSessionId, conversationId: owner.conversationId || null, traceLogger: modelTrace, executionPolicy: executionPolicyInput, modelConfig, observedToolResults: toolResults, parentExecutionContext, signal });
    const batchOk = batch.results.every((result) => result?.ok !== false);
    await progress?.({ type: 'subagent-progress', phase: 'tool-result', id, resultCount: batch.results.length });
    await recordLiveActivity({ kind: 'tool', phase: 'tool-result', label: `Finished ${batch.results.length} tool result${batch.results.length === 1 ? '' : 's'}`, status: batchOk ? 'completed' : 'error', tool: batch.results[0]?.tool || toolCalls[0]?.name || null, error: batchOk ? null : (batch.results.find((result) => result?.ok === false)?.error || 'tool_failed'), counts: { toolResults: batch.results.length } }, batchOk ? 'tool_result' : 'tool_error');
    retainChildResults(toolResults, batch.results, { limit: modelConfig?.toolResultHistoryLimit });
    compactToolCalls(toolCalls).forEach((call, index) => {
      if (batch.results[index]) appendBoundedChatHistory(completedCalls, { callFingerprint: call.callFingerprint, outcomeFingerprint: fingerprint(normalizedToolOutcome(batch.results[index])) }, CHAT_TOOL_CALL_HISTORY_LIMIT, 'omittedCompletedToolCalls');
    });
    activitySequence = await appendChildToolRound({
      authority, sessionId: childSessionId, runId: id, traceDir, iteration: round + 1,
      toolCalls, toolResults: batch.results, activitySequence,
    });
    const allowMoreTools = true;
    const nativeContinuation = Boolean(current.choice?.toolCalls?.length && typeof adapter.continueWithToolResults === 'function');
    await progress?.({ type: 'subagent-progress', phase: 'model-request', id });
    await recordLiveActivity({ kind: 'model', phase: 'model-request', label: 'Waiting for model continuation', model: modelConfig?.model || null }, 'model_request');
    const continuationTools = subagentToolSchemas();
    let next;
    try {
      const preparedContinuation = nativeContinuation
        ? prepareNativeToolContinuation({
            baseMessages: messages,
            toolCalls,
            toolResults: batch.results,
            modelConfig,
            tools: continuationTools,
          })
        : null;
      if (preparedContinuation) applyFinalProviderDelivery({ toolCalls, toolResults: batch.results, messages: preparedContinuation.messages });
      next = nativeContinuation
        ? await adapter.continueWithToolResults({
            previousModel: current,
            baseMessages: messages,
            toolCalls,
            toolResults: batch.results,
            preparedMessages: preparedContinuation.messages,
            ...(continuationTools ? { tools: continuationTools, toolChoice: 'auto' } : {}),
            traceLogger: modelTrace,
            signal,
          })
        : await adapter.complete({
            messages: normalizeProviderMessages([
              ...messages,
              { role: 'user', content: followupPromptWithEvidence({ prompt, toolResults, latestResults: batch.results, allowMoreTools }) },
            ]),
            ...(continuationTools ? { tools: continuationTools, toolChoice: 'auto' } : {}),
            traceLogger: modelTrace,
            signal,
          });
    } catch (error) {
      const result = subagentResult({
        ok: false,
        summary: 'Minion follow-up model call failed.',
        blockers: [`subagent_model_failed:${error?.message || String(error)}`],
        toolResults,
        target,
      });
      await updateSubagentStatus({ dataRoot, id, status: 'failed', phase: 'idle', result, activity: subagentLiveActivity({ kind: 'terminal', phase: 'idle', status: 'error', label: 'Subagent failed', completedAt: nowIso(), error: result.blockers?.[0] || null }), provenance: { source: 'spawn-subagent-child', reason: 'model_continuation_threw' } });
      return result;
    }
    // Native serialization records the bytes actually delivered on raw results.
    // Copy that metadata back without retaining their large payloads.
    for (let index = 0; index < batch.results.length; index++) {
      const retained = toolResults[toolResults.length - batch.results.length + index];
      if (retained && batch.results[index]?.delivery) retained.delivery = { ...batch.results[index].delivery };
    }
    await progress?.({ type: 'subagent-progress', phase: 'model-response', id });
    await recordLiveActivity({ kind: 'model', phase: 'model-response', label: next.ok ? 'Model continuation received' : 'Model continuation failed', status: next.ok ? 'completed' : 'error', model: modelConfig?.model || null, error: next.ok ? null : (next.error || next.status) }, next.ok ? 'model_response' : 'model_error');
    if (nativeContinuation && Array.isArray(next?.nativeTranscript)) messages.splice(0, messages.length, ...next.nativeTranscript);
    // A completed but empty continuation cannot finish a child. Give the
    // existing structured-terminal synthesis path one chance; transport and
    // incomplete/provider failures remain fatal.
    if (!next.ok && next.error === 'model_response_empty') break;
    if (!next.ok) {
      const result = subagentResult({ ok: false, summary: 'Minion follow-up model call failed.', blockers: [`subagent_model_failed:${next.error || next.status}`], toolResults, target });
      await updateSubagentStatus({ dataRoot, id, status: 'failed', phase: 'idle', result, activity: subagentLiveActivity({ kind: 'terminal', phase: 'idle', status: 'error', label: 'Subagent failed', completedAt: nowIso(), error: result.blockers?.[0] || null }), provenance: { source: 'spawn-subagent-child', reason: 'model_failed_after_tools' } });
      return result;
    }
    current = next;
    const nextToolCalls = choiceToolCalls(next.choice);
    terminalResult = terminalResultFromToolCalls(nextToolCalls, { toolResults, target });
    const nextText = choiceText(next.choice);
    if (compactString(nextText)) lastText = nextText;
    if (compactString(nextText)) await authority.appendTurn({ visibility: terminalResult ? 'debug' : 'chat', entersPrompt: !terminalResult, sessionId: childSessionId, role: 'assistant', content: nextText, runId: id, traceDir, metadata: { kind: nextToolCalls.length ? 'subagent-model-response' : 'subagent-final-response', evidenceCount: toolResults.length, toolCallCount: nextToolCalls.length } });
  }

  if (terminalResult) {
    const status = terminalResult.ok ? 'succeeded' : 'failed';
    await updateSubagentStatus({ dataRoot, id, status, phase: 'idle', result: terminalResult, activity: subagentLiveActivity({ kind: 'terminal', phase: 'idle', status: terminalResult.ok ? 'completed' : 'error', label: terminalResult.ok ? 'Subagent completed' : 'Subagent failed', completedAt: nowIso(), counts: { evidence: terminalResult.evidence?.length || 0 } }), provenance: { source: 'spawn-subagent-child', reason: terminalResult.ok ? 'terminal_completed' : 'terminal_not_completed' } });
    await conversationStore.updateMetadata({ agentId, sessionId: childSessionId, update: old => ({ ...old, sessionKind: 'subagent', parentSessionId: owner.sessionId || null, parentConversationId: owner.conversationId || null, parentRunId: owner.parentRunId || null, parentChild: true, subagentId: id, subagentStatus: status, subagentOk: terminalResult.ok, workerProfile: 'spawn_subagent' }) });
    return terminalResult;
  }

  await progress?.({ type: 'subagent-progress', phase: 'terminal-request', id });
  await recordLiveActivity({ kind: 'model', phase: 'terminal-request', label: 'Waiting for terminal summary', model: modelConfig?.model || null }, 'terminal_request');
  const synthesis = await adapter.complete({
    messages: normalizeProviderMessages([
      ...messages,
      { role: 'user', content: finalSynthesisPrompt({ prompt, toolResults }) },
    ]),
    tools: [subagentFinishToolSchema()],
    toolChoice: 'auto',
    traceLogger: modelTrace,
    signal,
  });
  await progress?.({ type: 'subagent-progress', phase: 'terminal-response', id });
  await recordLiveActivity({ kind: 'model', phase: 'terminal-response', label: synthesis.ok ? 'Terminal summary received' : 'Terminal summary failed', status: synthesis.ok ? 'completed' : 'error', model: modelConfig?.model || null, error: synthesis.ok ? null : (synthesis.error || synthesis.status) }, synthesis.ok ? 'terminal_response' : 'terminal_error');
  if (!synthesis.ok && synthesis.error !== 'model_response_empty') {
    const result = subagentResult({ ok: false, summary: 'Minion final synthesis model call failed.', blockers: [`subagent_model_failed:${synthesis.error || synthesis.status}`], toolResults, target });
    await updateSubagentStatus({ dataRoot, id, status: 'failed', phase: 'idle', result, activity: subagentLiveActivity({ kind: 'terminal', phase: 'idle', status: 'error', label: 'Subagent failed', completedAt: nowIso(), error: result.blockers?.[0] || null }), provenance: { source: 'spawn-subagent-child', reason: 'final_synthesis_failed' } });
    await conversationStore.updateMetadata({ agentId, sessionId: childSessionId, update: old => ({ ...old, sessionKind: 'subagent', parentSessionId: owner.sessionId || null, parentConversationId: owner.conversationId || null, parentRunId: owner.parentRunId || null, parentChild: true, subagentId: id, subagentStatus: 'failed', subagentOk: false, workerProfile: 'spawn_subagent' }) });
    return result;
  }
  const synthesisText = choiceText(synthesis.choice);
  if (compactString(synthesisText)) lastText = synthesisText;
  const synthesisToolCalls = choiceToolCalls(synthesis.choice);
  terminalResult = terminalResultFromToolCalls(synthesisToolCalls, { toolResults, target });
  if (compactString(synthesisText) || !terminalResult) await authority.appendTurn({ visibility: terminalResult ? 'debug' : 'chat', entersPrompt: !terminalResult, sessionId: childSessionId, role: 'assistant', content: synthesisText || (synthesisToolCalls.length ? '[terminal signal]' : '[missing terminal signal]'), runId: id, traceDir, metadata: { kind: 'subagent-final-response', evidenceCount: toolResults.length, toolCallCount: synthesisToolCalls.length, finalSynthesis: true } });

  if (terminalResult) {
    const status = terminalResult.ok ? 'succeeded' : 'failed';
    await updateSubagentStatus({ dataRoot, id, status, phase: 'idle', result: terminalResult, activity: subagentLiveActivity({ kind: 'terminal', phase: 'idle', status: terminalResult.ok ? 'completed' : 'error', label: terminalResult.ok ? 'Subagent completed' : 'Subagent failed', completedAt: nowIso(), counts: { evidence: terminalResult.evidence?.length || 0 } }), provenance: { source: 'spawn-subagent-child', reason: terminalResult.ok ? 'terminal_completed' : 'terminal_not_completed' } });
    await conversationStore.updateMetadata({ agentId, sessionId: childSessionId, update: old => ({ ...old, sessionKind: 'subagent', parentSessionId: owner.sessionId || null, parentConversationId: owner.conversationId || null, parentRunId: owner.parentRunId || null, parentChild: true, subagentId: id, subagentStatus: status, subagentOk: terminalResult.ok, workerProfile: 'spawn_subagent' }) });
    return terminalResult;
  }

  const result = subagentTerminalMissingResult({ toolResults, target, text: lastText });
  await updateSubagentStatus({ dataRoot, id, status: 'failed', phase: 'idle', result, activity: subagentLiveActivity({ kind: 'terminal', phase: 'idle', status: 'error', label: 'Subagent failed', completedAt: nowIso(), error: result.blockers?.[0] || null }), provenance: { source: 'spawn-subagent-child', reason: 'terminal_signal_missing' } });
  await conversationStore.updateMetadata({ agentId, sessionId: childSessionId, update: old => ({ ...old, sessionKind: 'subagent', parentSessionId: owner.sessionId || null, parentConversationId: owner.conversationId || null, parentRunId: owner.parentRunId || null, parentChild: true, subagentId: id, subagentStatus: 'failed', subagentOk: false, workerProfile: 'spawn_subagent' }) });
  return result;


}

export const __subagentWorkerRunner__ = Object.freeze({ retainChildResults, subagentResult, continuationToolCallsForTruncatedEvidence, applyFinalProviderDelivery, runSubagentToolCalls, childPrompt, proposalFromNativeToolCalls, boundedEvidenceLedger, compactEvidenceItem, compactEvidenceForHandoff, followupPromptWithEvidence, finalSynthesisPrompt, terminalResultFromToolCalls, subagentEmptyFinalResult, subagentTerminalMissingResult });
