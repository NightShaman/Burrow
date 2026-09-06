import { listSessionRecords, readSessionEntries } from './session-store.mjs';
import { readRunEvidence } from './run-evidence.mjs';
import { listSubagentRecords, subagentVisibilitySummary } from './subagent-store.mjs';
import { summarizeTrace } from './trace-summary.mjs';
import { redactAndTruncateText } from './redaction.mjs';

const MAX_RUNS = 200;
const MAX_TIMELINE = 80;
const MAX_FAILURES = 12;

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function boundedInteger(value, fallback = 100, max = MAX_RUNS) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(max, Math.floor(number))) : fallback;
}
function statusFor({ receipt = null, evidence = null, answer = null } = {}) {
  if (!receipt) return answer ? 'unverified' : 'incomplete';
  const decision = text(receipt?.decision);
  if (['model_failed', 'incomplete', 'failed'].includes(decision)) return 'failed';
  if (failureEvidence(evidence).length || unresolvedEvidence(evidence).length) return 'warning';
  if (answer && /^\[model_error:/u.test(text(answer.content))) return 'failed';
  return 'completed';
}
function receiptFor(entries, runId) {
  return entries.filter((entry) => entry.type === 'receipt' && entry.runId === runId).at(-1)?.metadata?.receiptRef || null;
}
function answerFor(entries, runId) {
  return entries.filter((entry) => entry.type === 'message' && entry.role === 'assistant' && entry.runId === runId).at(-1) || null;
}
function requestFor(entries, runId) {
  return entries.filter((entry) => entry.type === 'message' && entry.role === 'user' && entry.runId === runId).at(-1) || null;
}
function activitiesFor(entries, runId) {
  return entries.filter((entry) => entry.visibility === 'activity' && entry.runId === runId)
    .map((entry) => ({ ts: entry.ts || null, summary: text(entry.content), toolActivity: entry.metadata?.toolActivity || null }));
}

function executionEntriesFor(entries, runId) {
  return entries.filter((entry) => entry.runId === runId && entry.metadata?.canonicalExecution === true
    && ['tool_call', 'tool_result'].includes(String(entry.type || '')));
}

const TOOL_DETAIL_LIMIT = 320;
function safeDetail(value) {
  const source = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value);
  const compact = redactAndTruncateText(source.replace(/\s+/gu, ' '), { maxChars: TOOL_DETAIL_LIMIT });
  return compact.text ? `${compact.text}${compact.truncated ? '…' : ''}` : '';
}
function resultForEntry(entry = {}) {
  if (entry.metadata?.normalizedResult && typeof entry.metadata.normalizedResult === 'object') return entry.metadata.normalizedResult;
  try {
    const parsed = JSON.parse(entry.content || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
function toolSummary(item = {}) {
  const result = item.result || {};
  const payload = item.payload || {};
  const args = item.arguments || {};
  const tool = text(result.tool) || text(item.tool) || text(payload.tool) || 'Tool';
  const failed = item.status === 'failed';
  const running = item.status === 'running';
  const state = failed ? 'failed' : running ? 'started' : 'completed';
  const command = safeDetail(result.command || args.command || payload.command);
  const cwd = safeDetail(result.cwd || args.cwd || payload.cwd);
  const exitCode = result.exitCode ?? payload.exitCode;
  const execution = result.execution && typeof result.execution === 'object' ? result.execution : {};
  const provider = safeDetail(result.provider || execution.providerId || payload.provider || payload.providerId);
  const target = safeDetail(execution.targetId || result.target?.root || args.target?.root || payload.targetId || payload.target?.root);
  const mcpName = safeDetail(result.mcpToolName || args.mcpToolName || args.toolName || payload.mcpToolName);
  if (tool === 'shell_exec' || command) {
    const lead = failed ? 'Command failed' : running ? 'Running command' : 'Ran command';
    return `${lead}${command ? `: ${command}` : ''}${cwd ? ` · cwd: ${cwd}` : ''}${exitCode !== undefined && exitCode !== null ? ` · exit: ${safeDetail(exitCode)}` : ''}${provider ? ` · provider: ${provider}` : ''}${target ? ` · target: ${target}` : ''}`;
  }
  if (tool === 'mcp_call') {
    const identity = [provider, mcpName].filter(Boolean).join('/');
    return `MCP${identity ? ` ${identity}` : ' call'} ${state}${target ? ` · target: ${target}` : ''}.`;
  }
  const filePath = safeDetail(result.filePath || result.path || args.filePath || args.path || payload.filePath);
  if (filePath) {
    const verb = tool === 'files_read' ? 'Read' : tool === 'files_edit' ? 'Edited' : tool === 'files_write' ? 'Wrote' : tool === 'files_patch' ? 'Patched' : tool === 'files_search' ? 'Searched' : tool === 'files_find' ? 'Found files in' : tool;
    return `${verb} ${filePath}${state === 'completed' ? '.' : ` (${state}).`}`;
  }
  return `${tool}${provider ? ` via ${provider}` : ''}${target ? ` on ${target}` : ''} ${state}.`;
}

function correlatedToolTimeline(executionEntries = [], trace = null) {
  const calls = new Set();
  const byId = new Map();
  let anonymous = 0;
  const obtain = (ids, source) => {
    const stableIds = (Array.isArray(ids) ? ids : [ids]).map(text).filter(Boolean);
    let call = stableIds.map((id) => byId.get(id)).find(Boolean);
    if (!call) {
      call = { id: stableIds[0] || null, sources: new Set(), status: 'running', ts: null, finishedAt: null, anonymous: stableIds.length ? null : `${source}-anonymous-${anonymous += 1}` };
      calls.add(call);
    }
    for (const id of stableIds) byId.set(id, call);
    return call;
  };
  for (const item of Array.isArray(trace?.toolActivity) ? trace.toolActivity : []) {
    const call = obtain([item.id, item.payload?.toolCallId], 'trace');
    call.sources.add('trace');
    call.tool = text(item.tool) || call.tool;
    call.payload = { ...(call.payload || {}), ...(item.payload || {}) };
    call.ts ||= item.startedAt || item.finishedAt || null;
    if (item.status !== 'running') {
      call.status = item.status === 'failed' ? 'failed' : 'completed';
      call.finishedAt = item.finishedAt || call.finishedAt;
    }
  }
  for (const entry of executionEntries) {
    if (entry.type === 'tool_call') {
      for (const raw of Array.isArray(entry.metadata?.toolCalls) ? entry.metadata.toolCalls : []) {
        const call = obtain(raw?.id, 'session-call');
        call.sources.add('session');
        call.tool = text(raw?.tool) || text(raw?.name) || call.tool;
        call.arguments = raw?.arguments && typeof raw.arguments === 'object' ? raw.arguments : {};
        call.ts ||= entry.ts || null;
      }
      continue;
    }
    const result = resultForEntry(entry);
    const call = obtain([entry.metadata?.callId, result.activityId, result.execution?.toolCallId], 'session-result');
    call.sources.add('session');
    call.result = result;
    call.tool = text(result.tool) || text(entry.metadata?.tool) || call.tool;
    call.status = (entry.metadata?.ok ?? result.ok) === false ? 'failed' : 'completed';
    call.finishedAt = entry.ts || call.finishedAt;
    call.ts ||= entry.ts || null;
  }
  return [...calls.values()].map((call) => ({
    kind: call.sources.has('session') ? (call.status === 'running' ? 'tool_call' : 'tool_result') : 'tool_trace',
    status: call.status === 'failed' ? 'failed' : call.status === 'running' ? 'warning' : 'ok',
    ts: call.finishedAt || call.ts || null,
    summary: toolSummary(call),
    evidence: call.sources.size > 1 ? 'session_execution+trace_receipt' : call.sources.has('session') ? 'session_execution' : 'trace_receipt',
    ...(call.id ? { callId: call.id } : {}),
  }));
}

function runBounds(entries, runId, trace = null) {
  const timestamps = [
    ...entries.filter((entry) => entry.runId === runId).map((entry) => text(entry.ts)),
    ...(Array.isArray(trace?.timeline) ? trace.timeline.map((entry) => text(entry.ts)) : []),
  ].filter(Boolean).sort();
  return { startedAt: timestamps[0] || null, lastActivityAt: timestamps.at(-1) || null };
}

function operatorToolSummary(item = {}) {
  const label = text(item.label) || 'Tool activity';
  const detail = text(item.detail);
  return detail ? `${label}: ${detail}` : label;
}

function receiptCommand(item = {}) {
  return (Array.isArray(item.sourceRefs) ? item.sourceRefs : [])
    .find((reference) => text(reference).startsWith('receipt:'))?.slice('receipt:'.length) || '';
}

function operatorFailureText(item = {}) {
  const value = text(item.text);
  const match = value.match(/^shell_exec:\s*(.*)$/iu);
  const command = receiptCommand(item);
  const detail = match ? text(match[1]) : value;
  const excerpt = detail.replace(/^(?:command )?failed[:.]?\s*/iu, '');
  return `Tool failed${command ? `: ${command}` : ''}${excerpt ? ` — ${excerpt}` : ''}`;
}

function operatorEvidenceText(item = {}, category = 'observation') {
  const value = text(item.text);
  const match = value.match(/^([a-z][a-z0-9_-]*):\s*(.*)$/iu);
  if (!match) return value;
  const tool = match[1].toLowerCase();
  const detail = text(match[2]);
  if (tool === 'shell_exec') {
    const command = receiptCommand(item);
    if (category === 'verification') {
      if (/^verification (?:passed|failed):/iu.test(detail)) return detail;
      if (item.status === 'failed') return `Verification failed${command ? `: ${command}` : ''}.`;
      return `Verification passed${command ? `: ${command}` : ''}.`;
    }
    if (item.status === 'failed') return `Command failed${command ? `: ${command}` : '.'}`;
    return `Command completed${command ? `: ${command}` : '.'}`;
  }
  const labels = {
    files_read: 'Read file', files_write: 'Wrote file', files_edit: 'Edited file', files_patch: 'Patched files',
    files_list: 'Listed files', files_find: 'Found files', files_search: 'Searched files', files_inspect: 'Inspected path',
    git_status: 'Checked repository status', git_diff: 'Reviewed changes',
    spawn_subagent: 'Subagent', mcp_call: 'MCP call',
  };
  const label = labels[tool] || tool.replace(/[-_]+/gu, ' ').replace(/\b\w/g, (part) => part.toUpperCase());
  if (!detail || /^(?:completed successfully|completed)$/iu.test(detail)) return `${label} completed.`;
  if (/^failed$/iu.test(detail)) return `${label} failed.`;
  return `${label}: ${detail}`;
}

function genericCompletionText(value) {
  return /^(?:command|run|tool)?\s*completed\.?$/iu.test(text(value));
}
function evidenceItems(evidence = {}) {
  return ['observations', 'changes', 'validations', 'unresolved'].flatMap((key) => Array.isArray(evidence?.[key]) ? evidence[key] : []);
}
function failureEvidence(evidence = {}) {
  return evidenceItems(evidence).filter((item) => item?.status === 'failed' || /^shell_exec:\s*(?:command )?failed/iu.test(text(item?.text))).slice(0, MAX_FAILURES);
}
function unresolvedEvidence(evidence = {}) {
  return (Array.isArray(evidence?.unresolved) ? evidence.unresolved : []).filter((item) => item?.status === 'unresolved' && !genericCompletionText(item?.text) && !/^shell_exec:\s*(?:command )?failed/iu.test(text(item?.text))).slice(0, MAX_FAILURES);
}
function nonFailure(items = []) { return (Array.isArray(items) ? items : []).filter((item) => item?.status !== 'failed'); }

function terminalSummary(receipt = null, status = 'completed') {
  if (status === 'unverified') return 'Run has an assistant response but no terminal runtime receipt; outcome is unverified.';
  if (status === 'incomplete') return 'Run ended without an assistant response or terminal runtime receipt; no outcome was recorded.';
  const decision = text(receipt?.decision);
  if (status === 'failed') return decision === 'model_failed' ? 'Run failed: the model did not complete.' : 'Run failed.';
  if (status === 'warning') return 'Run completed with unresolved issues.';
  if (decision === 'answered') return 'Run completed.';
  if (decision === 'routed') return 'Run completed without a model response.';
  return decision ? `Run completed: ${decision.replace(/[_-]+/gu, ' ')}.` : 'Run completed.';
}

function compressionOutcome(context) {
  const events = Array.isArray(context?.contextEvents) ? context.contextEvents : [];
  const candidate = context?.compression && typeof context.compression === 'object' ? context.compression : null;
  // A projected outcome is already derived data; do not mistake it for a raw
  // runtime receipt on a second projection pass.
  const legacy = candidate && ('compressed' in candidate || 'considered' in candidate || 'attempted' in candidate) ? candidate : null;
  const decisive = [...events].reverse().find((event) => event?.compression?.compressed || event?.compression?.attempted) || null;
  const source = legacy || decisive?.compression || null;
  const reason = text(source?.reason) || null;
  const attempted = Boolean(source?.considered || source?.attempted || source?.compressed);
  const compressed = Boolean(source?.compressed);
  const threshold = Number(context?.budget?.compressionThreshold);
  const thresholdPercent = Number.isFinite(threshold) && threshold > 0 ? Math.round(threshold * 100) : null;
  const before = events.find((event) => event?.compression?.compressed)?.estimatedTokens ?? null;
  const after = [...events].reverse().find((event) => event?.phase === 'final_model_request' || event?.phase === 'post_compression_rebuild')?.estimatedTokens ?? null;
  const beforeTokens = Number(before);
  const afterTokens = Number(after);
  const counts = legacy ? {
    summarizedTurnCount: Number.isFinite(Number(legacy.summarizedTurnCount)) ? Number(legacy.summarizedTurnCount) : null,
    retainedTurnCount: Number.isFinite(Number(legacy.retainedTurnCount)) ? Number(legacy.retainedTurnCount) : null,
  } : { summarizedTurnCount: null, retainedTurnCount: null };
  if (compressed) {
    const size = Number.isFinite(beforeTokens) && beforeTokens > 0 && Number.isFinite(afterTokens) && afterTokens > 0 ? ` ${beforeTokens.toLocaleString()} → ${afterTokens.toLocaleString()} tokens.` : '';
    const turns = counts.summarizedTurnCount === null ? '' : ` ${counts.summarizedTurnCount} earlier turn${counts.summarizedTurnCount === 1 ? '' : 's'} summarized.`;
    const thresholdText = thresholdPercent === null ? '' : ` Threshold: ${thresholdPercent}%.`;
    return { status: 'applied', label: 'Applied', detail: `Context was compressed.${size}${turns}${thresholdText}`, reason, source: legacy ? 'receipt' : 'context_event', ...counts };
  }
  if (reason === 'compression_failed') return { status: 'failed', label: 'Failed', detail: 'Compression was needed but failed.', reason, source: legacy ? 'receipt' : 'context_event', ...counts };
  if (attempted) {
    const thresholdText = thresholdPercent === null ? '' : ` Context was below the ${thresholdPercent}% threshold.`;
    return { status: 'not_needed', label: 'Not needed', detail: `Compression was not needed.${thresholdText}`, reason, source: legacy ? 'receipt' : 'context_event', ...counts };
  }
  return { status: 'not_recorded', label: 'Not recorded', detail: 'No compression decision was recorded for this older run.', reason: null, source: null, ...counts };
}
function effectiveCompression(context) {
  return compressionOutcome(context);
}
function contextSummary(context) {
  if (!context) return null;
  return compressionOutcome(context).detail;
}
function contextProof(receipt = null) {
  const source = receipt?.contextBuildReceipt;
  if (!source) return null;
  const compression = source.compression || null;
  const contextEvents = (Array.isArray(source.contextEvents) ? source.contextEvents : []).slice(-8).map((event) => ({
    phase: text(event?.phase) || 'unknown',
    estimatedTokens: Number.isFinite(Number(event?.estimatedTokens)) ? Number(event.estimatedTokens) : null,
    contextTokens: Number.isFinite(Number(event?.contextTokens)) ? Number(event.contextTokens) : null,
    usageRatio: Number.isFinite(Number(event?.usageRatio)) ? Number(event.usageRatio) : null,
    windowPressure: text(event?.windowPressure) || 'unknown',
    compressionThreshold: Number.isFinite(Number(event?.compressionThreshold)) ? Number(event.compressionThreshold) : null,
    compressionState: text(event?.compressionState) || 'unknown',
    compression: event?.compression && typeof event.compression === 'object' ? {
      attempted: Boolean(event.compression.attempted), compressed: Boolean(event.compression.compressed), reason: text(event.compression.reason) || null,
    } : null,
  }));
  const result = {
    budget: source.budget ? {
      estimatedTokens: Number(source.budget.estimatedTokens) || 0,
      contextWindow: Number(source.budget.contextWindow) || null,
      availableTokens: Number(source.budget.availableTokens) || null,
      pressure: text(source.budget.pressure) || null,
      compressionThreshold: Number(source.budget.compressionThreshold) || null,
      compressionState: text(source.budget.compressionState) || null,
    } : null,
    compression,
    contextEvents,
    // New uploads and prior reopenable references are different facts.
    // Preserve the aggregate for old clients, but make the distinction explicit.
    attachments: Array.isArray(source?.sources?.currentAttachmentManifest)
      ? source.sources.currentAttachmentManifest.length
      : (Array.isArray(source?.sources?.attachmentManifest) ? source.sources.attachmentManifest.length : (Number(source.attachments?.count) || 0)),
    attachmentManifest: Array.isArray(source?.sources?.attachmentManifest) ? source.sources.attachmentManifest : [],
    currentAttachmentManifest: Array.isArray(source?.sources?.currentAttachmentManifest) ? source.sources.currentAttachmentManifest : [],
    retainedAttachmentManifest: Array.isArray(source?.sources?.retainedAttachmentManifest) ? source.sources.retainedAttachmentManifest : [],
    summary: null,
  };
  result.compression = compressionOutcome({ ...result, compression });
  return result;
}
function childVerification(record = {}) {
  // Verification is a first-class child completion field. Archive deliberately
  // does not infer outcome from a prose summary; older records simply have no
  // structured verification outcome to render.
  const verification = record.result?.verification;
  if (!verification || typeof verification !== 'object') return null;
  if (!['passed', 'failed', 'failed_expected', 'not_run'].includes(verification.status)) return null;
  return {
    status: verification.status,
    expected: verification.status === 'failed_expected',
    check: text(verification.check) || null,
    observed: text(verification.observed) || null,
    actionRequired: Boolean(verification.actionRequired),
  };
}


function childProof(records = [], runId) {
  return records.filter((record) => record.owner?.parentRunId === runId).map((record) => {
    const visible = subagentVisibilitySummary(record);
    const verification = childVerification(record);
    return {
      id: visible.id, status: visible.status, phase: visible.phase, purpose: visible.purpose,
      label: visible.label, createdAt: visible.createdAt, completedAt: visible.final ? visible.updatedAt : null,
      model: visible.model || null, result: visible.result, verification, trace: visible.trace,
    };
  }).slice(0, 24);
}

function childTimelineSummary(child) {
  const name = child.label || child.id;
  const details = child.result ? ` — ${child.result.evidence} finding${child.result.evidence === 1 ? '' : 's'} · ${child.result.changedFiles} change${child.result.changedFiles === 1 ? '' : 's'}` : '';
  if (child.verification?.status === 'failed_expected') return `Subagent ${name} completed — verification failed as expected${details}`;
  if (child.verification?.status === 'failed') return `Subagent ${name} completed — verification failed${details}`;
  return `Subagent ${name}: ${child.status}${details}`;
}
function childVerificationEvidence(subagents = []) {
  return subagents.filter((child) => child.verification).map((child) => {
    const verification = child.verification;
    const outcome = verification.status === 'failed_expected' ? 'Verification failed as expected' : verification.status === 'failed' ? 'Verification failed' : verification.status === 'passed' ? 'Verification passed' : 'Verification not run';
    const parts = [outcome];
    if (verification.check) parts.push(`Check: ${verification.check}`);
    if (verification.observed) parts.push(`Observed: ${verification.observed}`);
    parts.push(verification.actionRequired ? 'Action required.' : 'No action required.');
    return {
      text: parts.join(' · '),
      status: verification.status === 'failed' ? 'failed' : verification.status === 'failed_expected' ? 'validated' : verification.status === 'passed' ? 'validated' : 'unknown',
      sourceRefs: [`subagent:${child.id}`],
    };
  });
}
function verificationEvidence(evidence = {}, subagents = []) {
  const recorded = nonFailure(evidence?.validations);
  return [...recorded.map((item) => ({ ...item, text: operatorEvidenceText(item, 'verification') })), ...childVerificationEvidence(subagents)];
}
function isLinkedChildObservation(item = {}, subagents = []) {
  return text(item.tool) === 'spawn_subagent' && subagents.some((child) => child.id === text(item.subagentId));
}
function observationEvidence(evidence = {}, subagents = []) {
  return nonFailure(evidence?.observations).filter((item) => !isLinkedChildObservation(item, subagents));
}
function contextEventSummary(event = {}) {
  const usage = Number.isFinite(Number(event.usageRatio)) ? `${Math.round(Number(event.usageRatio) * 100)}%` : 'unknown usage';
  const tokens = Number.isFinite(Number(event.estimatedTokens)) && Number.isFinite(Number(event.contextTokens))
    ? `${event.estimatedTokens} / ${event.contextTokens}` : null;
  const threshold = Number.isFinite(Number(event.compressionThreshold)) ? `threshold ${Math.round(Number(event.compressionThreshold) * 100)}%` : null;
  const outcome = event.compression?.compressed ? 'compression applied' : event.compression?.attempted ? `compression not applied${event.compression?.reason ? ` (${event.compression.reason.replace(/[_-]+/gu, ' ')})` : ''}` : 'compression not evaluated';
  return [event.phase.replace(/[_-]+/gu, ' '), tokens, usage, threshold, outcome].filter(Boolean).join(' · ');
}
function timelineFor({ receipt, answer, activities, executionEntries, trace, evidence, context, subagents, lastActivityAt = null }) {
  const timeline = [];
  timeline.push(...correlatedToolTimeline(executionEntries, trace));
  // Activity cards are a legacy aggregate. Canonical calls/results or trace
  // activities are more precise and must not be rendered a second time.
  if (!executionEntries.length && !(Array.isArray(trace?.toolActivity) && trace.toolActivity.length)) for (const activity of activities) {
    const items = Array.isArray(activity.toolActivity?.items) ? activity.toolActivity.items : [];
    if (items.length) {
      for (const item of items) timeline.push({ kind: 'tool_activity', status: item.status === 'error' ? 'failed' : item.status === 'pending' ? 'warning' : 'ok', ts: activity.ts, summary: operatorToolSummary(item), evidence: 'session_activity' });
    } else if (activity.summary) {
      timeline.push({ kind: 'tool_activity', status: activity.toolActivity?.status === 'warn' ? 'warning' : 'ok', ts: activity.ts, summary: activity.summary, evidence: 'session_activity' });
    }
  }
  for (const item of observationEvidence(evidence, subagents)) timeline.push({ kind: 'observation', status: item.status, ts: evidence.createdAt || null, summary: operatorEvidenceText(item, 'observation'), evidence: 'run_evidence' });
  for (const item of nonFailure(evidence?.changes)) timeline.push({ kind: 'change', status: item.status, ts: evidence.createdAt || null, summary: operatorEvidenceText(item, 'change'), evidence: 'run_evidence' });
  for (const item of verificationEvidence(evidence, subagents)) timeline.push({ kind: 'verification', status: item.status, ts: evidence?.createdAt || null, summary: item.text, evidence: item.sourceRefs?.[0]?.startsWith('subagent:') ? 'subagent_record' : 'run_evidence' });
  for (const item of failureEvidence(evidence)) timeline.push({ kind: 'failure', status: 'failed', ts: evidence.createdAt || null, summary: operatorFailureText(item), evidence: 'run_evidence' });
  for (const item of unresolvedEvidence(evidence)) timeline.push({ kind: 'unresolved', status: item.status, ts: evidence.createdAt || null, summary: operatorEvidenceText(item, 'unresolved'), evidence: 'run_evidence' });
  if (context) {
    const contextTs = answer?.ts || evidence?.createdAt || null;
    for (const event of context.contextEvents || []) timeline.push({
      kind: 'context', status: event.compression?.compressed ? 'ok' : event.compressionState === 'threshold_exceeded' ? 'warning' : 'ok',
      ts: contextTs, summary: contextEventSummary(event), evidence: 'runtime_receipt',
    });
    timeline.push({ kind: 'context', status: context.compression?.compressed ? 'ok' : context.budget?.pressure === 'blocked' ? 'warning' : 'ok', ts: contextTs, summary: context.summary || contextSummary(context), evidence: 'runtime_receipt' });
  }
  for (const child of subagents) timeline.push({ kind: 'subagent', status: child.verification?.status === 'failed' ? 'failed' : child.status === 'succeeded' ? 'ok' : child.status === 'failed' || child.status === 'timed_out' ? 'failed' : 'warning', ts: child.completedAt || child.createdAt || null, summary: childTimelineSummary(child), evidence: 'subagent_record' });
  const status = statusFor({ receipt, evidence, answer });
  if (receipt?.decision || ['unverified', 'incomplete'].includes(status)) timeline.push({ kind: 'terminal', status: ['unverified', 'incomplete'].includes(status) ? 'warning' : status, ts: answer?.ts || evidence?.createdAt || lastActivityAt, summary: terminalSummary(receipt, status), evidence: receipt ? 'runtime_receipt' : 'archive_inference' });
  return timeline.sort((left, right) => String(left.ts || '').localeCompare(String(right.ts || ''))).slice(-MAX_TIMELINE);
}

async function proofDetail({ agentId, agentName, sessionId, runId, entries, evidence, subagentRecords = [], traceRoot = null }) {
  const receipt = receiptFor(entries, runId);
  const answer = answerFor(entries, runId);
  const request = requestFor(entries, runId);
  const activities = activitiesFor(entries, runId);
  const executionEntries = executionEntriesFor(entries, runId);
  const trace = traceRoot ? await summarizeTrace({ rootDir: traceRoot, runId, includeToolOutput: false, includeRelatedWorkTrace: false }) : null;
  const bounds = runBounds(entries, runId, trace?.exists ? trace : null);
  const status = statusFor({ receipt, evidence, answer });
  const context = contextProof(receipt);
  if (context) context.summary = contextSummary(context);
  const subagents = childProof(subagentRecords, runId);
  const traceDir = receipt?.traceDir || answer?.traceDir || entries.find((entry) => entry.runId === runId && entry.traceDir)?.traceDir || null;
  return {
    id: runId,
    runId,
    agentId,
    agentName,
    sessionId,
    status,
    startedAt: bounds.startedAt || evidence?.createdAt || answer?.ts || null,
    completedAt: answer?.ts || evidence?.createdAt || null,
    lastActivityAt: bounds.lastActivityAt,
    objective: evidence?.objective || null,
    request: request?.content || null,
    finalAnswer: answer?.content || null,
    decision: receipt?.decision || null,
    route: receipt?.route || null,
    counts: {
      observations: observationEvidence(evidence, subagents).length,
      changes: nonFailure(evidence?.changes).length,
      verifications: verificationEvidence(evidence, subagents).length,
      failures: failureEvidence(evidence).length,
      unresolved: unresolvedEvidence(evidence).length,
      toolActivities: activities.reduce((total, item) => total + Number(item.toolActivity?.totalCalls || 0), 0),
      subagents: subagents.length,
    },
    evidence: {
      observations: observationEvidence(evidence, subagents).map((item) => ({ ...item, text: operatorEvidenceText(item, 'observation') })),
      changes: nonFailure(evidence?.changes).map((item) => ({ ...item, text: operatorEvidenceText(item, 'change') })),
      verifications: verificationEvidence(evidence, subagents),
      failures: failureEvidence(evidence).map((item) => ({ ...item, text: operatorFailureText(item) })),
      unresolved: unresolvedEvidence(evidence).map((item) => ({ ...item, text: operatorEvidenceText(item, 'unresolved') })),
    },
    context,
    subagents,
    timeline: timelineFor({ receipt, answer, activities, executionEntries, trace: trace?.exists ? trace : null, evidence, context, subagents, lastActivityAt: bounds.lastActivityAt }),
    references: {
      trace: traceDir ? { runId, url: `/api/traces/${encodeURIComponent(runId)}?sessionId=${encodeURIComponent(sessionId)}` } : null,
      sourceRefs: evidence?.sourceRefs || [],
    },
  };
}

async function recordsFor(rootDir, sessionId = null) {
  if (sessionId) return [{ id: sessionId }];
  return listSessionRecords({ rootDir, includeArchived: true, limit: 500 });
}

function traceRootFor({ traceRoot = null, resolveTraceRoot = null, sessionId } = {}) {
  return typeof resolveTraceRoot === 'function' ? resolveTraceRoot(sessionId) : traceRoot;
}

export function mergeArchiveRuns(runLists = [], limit = 100) {
  return runLists.flat()
    .sort((left, right) => String(right.completedAt || right.startedAt || '').localeCompare(String(left.completedAt || left.startedAt || '')))
    .slice(0, boundedInteger(limit));
}

export async function listArchiveRuns({ rootDir, dataRoot = null, traceRoot = null, resolveTraceRoot = null, agentId, agentName = null, sessionId = null, limit = 100 } = {}) {
  if (!rootDir || !agentId) throw new Error('archive_run_scope_required');
  const results = [];
  const subagentRecords = dataRoot ? await listSubagentRecords({ dataRoot, includeFinal: true, limit: 500 }) : [];
  for (const session of await recordsFor(rootDir, sessionId)) {
    const id = session.id;
    const [entries, evidence] = await Promise.all([
      readSessionEntries({ rootDir, sessionId: id, limit: 0, includeHistory: true }),
      readRunEvidence({ rootDir, sessionId: id, limit: MAX_RUNS }),
    ]);
    const byRun = new Map(evidence.map((item) => [item.runId, item]));
    // Tool calls, results, and activity events are already persisted before a
    // terminal receipt. A runtime restart must not hide that existing evidence.
    for (const entry of entries) if (entry.runId) if (!byRun.has(entry.runId)) byRun.set(entry.runId, null);
    const sessionTraceRoot = traceRootFor({ traceRoot, resolveTraceRoot, sessionId: id });
    for (const [runId, item] of byRun) results.push(await proofDetail({ agentId, agentName, sessionId: id, runId, entries, evidence: item, subagentRecords, traceRoot: sessionTraceRoot }));
  }
  return results.sort((left, right) => String(right.completedAt || right.startedAt || '').localeCompare(String(left.completedAt || left.startedAt || ''))).slice(0, boundedInteger(limit));
}

export async function readArchiveRun({ rootDir, dataRoot = null, traceRoot = null, resolveTraceRoot = null, agentId, agentName = null, runId } = {}) {
  if (!rootDir || !agentId || !runId) throw new Error('archive_run_target_required');
  const subagentRecords = dataRoot ? await listSubagentRecords({ dataRoot, includeFinal: true, limit: 500 }) : [];
  for (const session of await recordsFor(rootDir)) {
    const [entries, evidence] = await Promise.all([
      readSessionEntries({ rootDir, sessionId: session.id, limit: 0, includeHistory: true }),
      readRunEvidence({ rootDir, sessionId: session.id, limit: MAX_RUNS }),
    ]);
    const item = evidence.find((candidate) => candidate.runId === runId) || null;
    if (item || entries.some((entry) => entry.runId === runId)) return proofDetail({ agentId, agentName, sessionId: session.id, runId, entries, evidence: item, subagentRecords, traceRoot: traceRootFor({ traceRoot, resolveTraceRoot, sessionId: session.id }) });
  }
  return null;
}
