import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createModelAdapter } from './model-adapter.mjs';
import { actionFromNativeToolCall, nativeToolSchemas } from './action-proposal.mjs';
import { reviewProposalActions } from './action-safety.mjs';
import { executeReviewedProposalActions } from './proposal-executor.mjs';
import { createExecutionContext } from './execution-context.mjs';
import { executionPolicyAllowsMutation, normalizeExecutionPolicyInput } from './execution-policy.mjs';
import { appendSessionActivity, appendSessionEntry, appendSessionTurn, writeSessionMetadata } from './session-store.mjs';
import { updateSubagentStatus } from './subagent-store.mjs';
import { normalizeProviderMessages } from './provider-messages.mjs';
import { prepareNativeToolContinuation } from './native-continuation-preparation.mjs';
import { summarizeToolResults } from './runtime-result-shapes.mjs';
import { boundedRedactedValue } from './redaction.mjs';
import { chatToolActivity } from './runtime-plain-chat-finalizer.mjs';

function compactString(value) {
  return String(value || '').trim();
}

// Memory search belongs to the parent runtime's configured memory boundary.
// Children receive only compact parent evidence; they do not inherit credentials
// or get an accidental cross-project retrieval surface.

function subagentFinishToolSchema() {
  return {
    type: 'function',
    function: {
      name: 'finish_subagent',
      description: 'Terminal subagent completion signal. Use exactly once when no more tools are needed. The runtime only treats this structured tool call as child completion.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['completed', 'incomplete', 'failed'] },
          summary: { type: 'string' },
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
  const tools = nativeToolSchemas();
  return includeFinish ? [...tools, subagentFinishToolSchema()] : tools;
}


function childPrompt({ task, target }) {
  return [
    'You are an isolated child agent. Inspect independently and return concise findings for the parent.',
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

async function appendChildToolRound({ rootDir, sessionId, runId, traceDir, iteration, toolCalls = [], toolResults = [], activitySequence }) {
  const compactCalls = compactChildToolCalls(toolCalls);
  if (compactCalls.length) {
    await appendSessionEntry({
      rootDir, sessionId, type: 'tool_call', role: null,
      content: JSON.stringify({ type: 'toolCall', iteration, toolCalls: compactCalls }),
      runId, traceDir, visibility: 'debug', entersPrompt: false,
      metadata: { decision: 'chat_tool_call', canonicalExecution: true, subagentExecution: true, iteration, toolCalls: compactCalls },
    });
  }
  for (const result of toolResults) {
    const normalizedResult = summarizeToolResults([result])[0] || result;
    await appendSessionEntry({
      rootDir, sessionId, type: 'tool_result', role: null, content: JSON.stringify(normalizedResult),
      runId, traceDir, visibility: 'debug', entersPrompt: false,
      metadata: { decision: 'chat_tool_result', canonicalExecution: true, subagentExecution: true, iteration, tool: result.tool || null, callId: result.activityId || null, ok: result.ok ?? null, normalizedResult },
    });
  }
  const toolActivity = chatToolActivity({ toolResults }, runId);
  if (!toolActivity) return activitySequence;
  const sequence = activitySequence + 1;
  await appendSessionActivity({
    rootDir, sessionId, runId, traceDir, sequence, content: toolActivity.summary,
    metadata: { decision: 'chat_tool_activity', subagentExecution: true, toolActivity },
  });
  return sequence;
}

async function runSubagentToolCalls({ toolCalls = [], target, dataRoot, childSessionId, conversationId = null, traceLogger = null, executionPolicy: executionPolicyInput = null, modelConfig = null, observedToolResults = [] } = {}) {
  const executionPolicy = normalizeExecutionPolicyInput(executionPolicyInput);
  const proposal = proposalFromNativeToolCalls(toolCalls);
  const reviews = reviewProposalActions({ actions: proposal.actions, workspaceRoot: target.root });
  const executionContext = createExecutionContext({ sessionId: childSessionId, conversationId, workspaceRoot: target.root, dataRoot, cacheRoot: traceLogger?.traceDir || null });
  const execution = await executeReviewedProposalActions({
    actions: proposal.actions, reviews: reviews.reviews, workspaceRoot: target.root, rootDir: target.root,
    dataRoot, sessionId: childSessionId, traceLogger, executionPolicy, modelConfig,
    allowMutations: executionPolicyAllowsMutation(executionPolicy),
    observedToolResults, executionContext,
  });
  return { results: execution.toolResults, skipped: execution.skipped };
}

function continuationToolCallsForTruncatedEvidence(toolResults = [], continuationCounts = new Map()) {
  const calls = [];
  const observedOffsets = new Set(toolResults
    .filter((result) => result?.ok && result.filePath)
    .map((result) => `${result.filePath}:${Math.max(0, Number(result.offsetBytes || 0))}`));
  const observedOffsetList = toolResults
    .filter((result) => result?.ok && result.filePath)
    .map((result) => ({ filePath: result.filePath, offsetBytes: Math.max(0, Number(result.offsetBytes || 0)) }));
  for (const result of toolResults) {
    if (!result?.ok || !result.truncated || !result.filePath) continue;
    const offsetBytes = Math.max(0, Number(result.offsetBytes || 0) + Number(result.returnedBytes || 0));
    if (!Number.isFinite(offsetBytes) || offsetBytes >= Number(result.bytes || 0)) continue;
    const key = `${result.filePath}:${offsetBytes}`;
    const laterRangeAlreadyObserved = observedOffsetList.some((observed) => observed.filePath === result.filePath && observed.offsetBytes > Number(result.offsetBytes || 0));
    if (laterRangeAlreadyObserved || observedOffsets.has(key) || continuationCounts.has(key)) continue;
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
  const base = { tool: result.tool || 'unknown', ok: Boolean(result.ok) };
  if (result.tool === 'files_read') return {
    ...base,
    filePath: result.filePath || null,
    offsetBytes: Number(result.offsetBytes || 0),
    returnedBytes: Number(result.returnedBytes || 0),
    bytes: Number(result.bytes || 0),
    truncated: Boolean(result.truncated),
    content: compactText(result.content, CHILD_EVIDENCE_SINGLE_EXCERPT_CHARS),
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
  if (result.tool === 'files_edit') return {
    ...base, filePath: result.filePath || null, changedFiles: (result.changedFiles || []).slice(0, 20),
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

function subagentResult({ ok, summary, blockers = [], warnings = [], verification = null, toolResults = [], target = null } = {}) {
  return {
    ok: Boolean(ok),
    summary: compactText(summary, 12_000) || (ok ? 'Subagent completed.' : 'Subagent failed.'),
    blockers: blockers.slice(0, 20),
    warnings: warnings.slice(0, 20),
    // Full raw tool output is preserved in the child trace artifacts. The IPC
    // result and delegated record deliberately carry bounded evidence only.
    evidence: compactEvidenceForHandoff(toolResults),
    artifacts: [],
    changedFiles: [],
    memoryWrites: [],
    ...(verification ? { verification } : {}),
    sideEffectsApplied: false,
    verificationTarget: target?.root || null,
  };
}

function choiceText(choice = {}) {
  return typeof choice?.text === 'string' ? choice.text : '';
}

function choiceToolCalls(choice = {}) {
  return Array.isArray(choice?.toolCalls) ? choice.toolCalls : [];
}

function subagentEmptyFinalResult({ toolResults = [], target = null, reason = 'subagent_empty_final_response', summary = 'Subagent gathered evidence but produced no final report.' } = {}) {
  return subagentResult({
    ok: false,
    summary,
    blockers: [reason],
    toolResults,
    target,
  });
}

function subagentTerminalMissingResult({ toolResults = [], target = null, text = '' } = {}) {
  const summary = compactString(text) || 'Subagent did not emit a structured terminal completion signal.';
  return subagentResult({ ok: false, summary, blockers: ['subagent_terminal_signal_missing'], toolResults, target });
}

function terminalResultFromToolCalls(toolCalls = [], { toolResults = [], target = null } = {}) {
  const call = toolCalls.find((item) => item?.name === 'finish_subagent');
  if (!call) return null;
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
  if (!summary) return subagentResult({ ok: false, summary: 'Subagent terminal signal omitted summary.', blockers: ['subagent_terminal_summary_required'], warnings, verification, toolResults, target });
  if (status === 'completed') return subagentResult({ ok: true, summary, blockers, warnings, verification, toolResults, target });
  return subagentResult({ ok: false, summary, blockers: blockers.length ? blockers : [`subagent_${status || 'incomplete'}`], warnings, verification, toolResults, target });
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
    'Evidence ledger (all executed evidence references; a missing full excerpt is not missing evidence):',
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
} = {}) {
  const blockers = [];
  if (!id) blockers.push('subagent_id_required');
  if (!compactString(task)) blockers.push('subagent_task_required');
  if (!target?.root) blockers.push('subagent_target_required');
  if (!dataRoot) blockers.push('subagent_data_root_required');
  if (!childSessionId) blockers.push('subagent_child_session_required');
  if (!modelConfig) blockers.push('subagent_model_config_required');
  if (blockers.length) {
    return { ok: false, summary: 'Subagent child did not run.', blockers, warnings: [], evidence: [], artifacts: [], changedFiles: [], memoryWrites: [], sideEffectsApplied: false };
  }

  await progress?.({ type: 'subagent-progress', phase: 'started', id });
  await updateSubagentStatus({ dataRoot, id, status: 'running', phase: 'model-loop', provenance: { source: 'spawn-subagent-child', reason: 'started' } });
  const prompt = childPrompt({ task, target });
  await appendSessionTurn({ rootDir: dataRoot, sessionId: childSessionId, role: 'user', content: prompt, runId: id, traceDir, metadata: { kind: 'subagent-task', parentSessionId: owner.sessionId || null, parentConversationId: owner.conversationId || null, parentRunId: owner.parentRunId || null } });

  const modelTrace = traceDir ? {
    traceDir,
    model: async (payload) => {
      const file = path.join(traceDir, 'model-events.jsonl');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(payload)}\n`, 'utf8');
    },
    tool: async () => {},
    artifact: async (name, content) => {
      const file = path.join(traceDir, 'artifacts', String(name || 'artifact').replace(/[^a-zA-Z0-9._-]+/g, '-'));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(content || ''), 'utf8');
      return file;
    },
  } : null;
  const adapter = createModelAdapter({ config: modelConfig });
  const messages = normalizeProviderMessages([{ role: 'system', content: 'Internal subagent task. This isolated child request is not parent conversation history.' }, { role: 'user', content: prompt }]);
  await progress?.({ type: 'subagent-progress', phase: 'model-request', id });
  const first = await adapter.complete({ messages, tools: subagentToolSchemas(), traceLogger: modelTrace });
  await progress?.({ type: 'subagent-progress', phase: 'model-response', id });
  if (!first.ok) {
    const result = { ok: false, summary: 'Subagent model call failed.', blockers: [`subagent_model_failed:${first.error || first.status}`], warnings: [], evidence: [], artifacts: [], changedFiles: [], memoryWrites: [], sideEffectsApplied: false };
    await updateSubagentStatus({ dataRoot, id, status: 'failed', phase: 'idle', result, provenance: { source: 'spawn-subagent-child', reason: 'model_failed' } });
    return result;
  }

  const firstToolCalls = choiceToolCalls(first.choice);
  const firstText = choiceText(first.choice);
  // Tool requests are persisted as canonical structured activity, not fake assistant text.
  if (compactString(firstText)) await appendSessionTurn({ rootDir: dataRoot, sessionId: childSessionId, role: 'assistant', content: firstText, runId: id, traceDir, metadata: { kind: 'subagent-model-response', toolCallCount: firstToolCalls.length } });

  let lastText = firstText;
  let activitySequence = 0;
  const toolResults = [];
  let current = first;
  let terminalResult = terminalResultFromToolCalls(firstToolCalls, { toolResults, target });
  const maxToolRounds = 6;
  const forcedContinuations = new Map();
  for (let round = 0; round < maxToolRounds && !terminalResult; round += 1) {
    let toolCalls = choiceToolCalls(current.choice);
    terminalResult = terminalResultFromToolCalls(toolCalls, { toolResults, target });
    if (terminalResult) break;
    if (!toolCalls.length) {
      const forced = round < maxToolRounds - 1 ? continuationToolCallsForTruncatedEvidence(toolResults, forcedContinuations) : [];
      if (!forced.length) break;
      toolCalls = forced;
    }
    await progress?.({ type: 'subagent-progress', phase: 'tool-request', id, toolCallCount: toolCalls.length });
    const batch = await runSubagentToolCalls({ toolCalls, target, dataRoot, childSessionId, conversationId: owner.conversationId || null, traceLogger: modelTrace, executionPolicy: executionPolicyInput, modelConfig, observedToolResults: toolResults });
    await progress?.({ type: 'subagent-progress', phase: 'tool-result', id, resultCount: batch.results.length });
    toolResults.push(...batch.results);
    activitySequence = await appendChildToolRound({
      rootDir: dataRoot, sessionId: childSessionId, runId: id, traceDir, iteration: round + 1,
      toolCalls, toolResults: batch.results, activitySequence,
    });
    const allowMoreTools = round < maxToolRounds - 1;
    const nativeContinuation = Boolean(current.choice?.toolCalls?.length && typeof adapter.continueWithToolResults === 'function');
    await progress?.({ type: 'subagent-progress', phase: 'model-request', id });
    const continuationTools = allowMoreTools ? subagentToolSchemas() : null;
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
      next = nativeContinuation
        ? await adapter.continueWithToolResults({
            previousModel: current,
            baseMessages: messages,
            toolCalls,
            toolResults: batch.results,
            preparedMessages: preparedContinuation.messages,
            ...(continuationTools ? { tools: continuationTools, toolChoice: 'auto' } : {}),
            traceLogger: modelTrace,
          })
        : await adapter.complete({
            messages: normalizeProviderMessages([
              ...messages,
              { role: 'user', content: followupPromptWithEvidence({ prompt, toolResults, latestResults: batch.results, allowMoreTools }) },
            ]),
            ...(continuationTools ? { tools: continuationTools, toolChoice: 'auto' } : {}),
            traceLogger: modelTrace,
          });
    } catch (error) {
      const result = subagentResult({
        ok: false,
        summary: 'Subagent follow-up model call failed.',
        blockers: [`subagent_model_failed:${error?.message || String(error)}`],
        toolResults,
        target,
      });
      await updateSubagentStatus({ dataRoot, id, status: 'failed', phase: 'idle', result, provenance: { source: 'spawn-subagent-child', reason: 'model_continuation_threw' } });
      return result;
    }
    await progress?.({ type: 'subagent-progress', phase: 'model-response', id });
    if (nativeContinuation && Array.isArray(next?.nativeTranscript)) messages.splice(0, messages.length, ...next.nativeTranscript);
    if (!next.ok) {
      const result = subagentResult({ ok: false, summary: 'Subagent follow-up model call failed.', blockers: [`subagent_model_failed:${next.error || next.status}`], toolResults, target });
      await updateSubagentStatus({ dataRoot, id, status: 'failed', phase: 'idle', result, provenance: { source: 'spawn-subagent-child', reason: 'model_failed_after_tools' } });
      return result;
    }
    current = next;
    const nextToolCalls = choiceToolCalls(next.choice);
    terminalResult = terminalResultFromToolCalls(nextToolCalls, { toolResults, target });
    const nextText = choiceText(next.choice);
    if (compactString(nextText)) lastText = nextText;
    if (compactString(nextText)) await appendSessionTurn({ rootDir: dataRoot, sessionId: childSessionId, role: 'assistant', content: nextText, runId: id, traceDir, metadata: { kind: nextToolCalls.length ? 'subagent-model-response' : 'subagent-final-response', evidenceCount: toolResults.length, toolCallCount: nextToolCalls.length } });
  }

  if (terminalResult) {
    const status = terminalResult.ok ? 'succeeded' : 'failed';
    await updateSubagentStatus({ dataRoot, id, status, phase: 'idle', result: terminalResult, provenance: { source: 'spawn-subagent-child', reason: terminalResult.ok ? 'terminal_completed' : 'terminal_not_completed' } });
    await writeSessionMetadata({ rootDir: dataRoot, sessionId: childSessionId, extra: { sessionKind: 'subagent', parentSessionId: owner.sessionId || null, parentConversationId: owner.conversationId || null, parentRunId: owner.parentRunId || null, parentChild: true, subagentId: id, subagentStatus: status, subagentOk: terminalResult.ok, workerProfile: 'spawn_subagent' } });
    return terminalResult;
  }

  if (choiceToolCalls(current.choice).length) {
    const result = subagentEmptyFinalResult({ toolResults, target, reason: 'subagent_tool_round_limit_reached' });
    await updateSubagentStatus({ dataRoot, id, status: 'failed', phase: 'idle', result, provenance: { source: 'spawn-subagent-child', reason: 'tool_round_limit_reached' } });
    await writeSessionMetadata({ rootDir: dataRoot, sessionId: childSessionId, extra: { sessionKind: 'subagent', parentSessionId: owner.sessionId || null, parentConversationId: owner.conversationId || null, parentRunId: owner.parentRunId || null, parentChild: true, subagentId: id, subagentStatus: 'failed', subagentOk: false, workerProfile: 'spawn_subagent' } });
    return result;
  }

  await progress?.({ type: 'subagent-progress', phase: 'terminal-request', id });
  const synthesis = await adapter.complete({
    messages: normalizeProviderMessages([
      ...messages,
      { role: 'user', content: finalSynthesisPrompt({ prompt, toolResults }) },
    ]),
    tools: [subagentFinishToolSchema()],
    toolChoice: 'auto',
    traceLogger: modelTrace,
  });
  await progress?.({ type: 'subagent-progress', phase: 'terminal-response', id });
  if (!synthesis.ok) {
    const result = subagentResult({ ok: false, summary: 'Subagent final synthesis model call failed.', blockers: [`subagent_model_failed:${synthesis.error || synthesis.status}`], toolResults, target });
    await updateSubagentStatus({ dataRoot, id, status: 'failed', phase: 'idle', result, provenance: { source: 'spawn-subagent-child', reason: 'final_synthesis_failed' } });
    await writeSessionMetadata({ rootDir: dataRoot, sessionId: childSessionId, extra: { sessionKind: 'subagent', parentSessionId: owner.sessionId || null, parentConversationId: owner.conversationId || null, parentRunId: owner.parentRunId || null, parentChild: true, subagentId: id, subagentStatus: 'failed', subagentOk: false, workerProfile: 'spawn_subagent' } });
    return result;
  }
  const synthesisText = choiceText(synthesis.choice);
  if (compactString(synthesisText)) lastText = synthesisText;
  const synthesisToolCalls = choiceToolCalls(synthesis.choice);
  terminalResult = terminalResultFromToolCalls(synthesisToolCalls, { toolResults, target });
  await appendSessionTurn({ rootDir: dataRoot, sessionId: childSessionId, role: 'assistant', content: synthesisText || (synthesisToolCalls.length ? '[terminal signal]' : '[missing terminal signal]'), runId: id, traceDir, metadata: { kind: 'subagent-final-response', evidenceCount: toolResults.length, toolCallCount: synthesisToolCalls.length, finalSynthesis: true } });

  if (terminalResult) {
    const status = terminalResult.ok ? 'succeeded' : 'failed';
    await updateSubagentStatus({ dataRoot, id, status, phase: 'idle', result: terminalResult, provenance: { source: 'spawn-subagent-child', reason: terminalResult.ok ? 'terminal_completed' : 'terminal_not_completed' } });
    await writeSessionMetadata({ rootDir: dataRoot, sessionId: childSessionId, extra: { sessionKind: 'subagent', parentSessionId: owner.sessionId || null, parentConversationId: owner.conversationId || null, parentRunId: owner.parentRunId || null, parentChild: true, subagentId: id, subagentStatus: status, subagentOk: terminalResult.ok, workerProfile: 'spawn_subagent' } });
    return terminalResult;
  }

  const result = subagentTerminalMissingResult({ toolResults, target, text: lastText });
  await updateSubagentStatus({ dataRoot, id, status: 'failed', phase: 'idle', result, provenance: { source: 'spawn-subagent-child', reason: 'terminal_signal_missing' } });
  await writeSessionMetadata({ rootDir: dataRoot, sessionId: childSessionId, extra: { sessionKind: 'subagent', parentSessionId: owner.sessionId || null, parentConversationId: owner.conversationId || null, parentRunId: owner.parentRunId || null, parentChild: true, subagentId: id, subagentStatus: 'failed', subagentOk: false, workerProfile: 'spawn_subagent' } });
  return result;


}

export const __subagentWorkerRunner__ = Object.freeze({ childPrompt, proposalFromNativeToolCalls, boundedEvidenceLedger, compactEvidenceItem, compactEvidenceForHandoff, followupPromptWithEvidence, finalSynthesisPrompt, terminalResultFromToolCalls, subagentEmptyFinalResult, subagentTerminalMissingResult });
