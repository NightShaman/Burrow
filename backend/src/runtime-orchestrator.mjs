import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { actionFromNativeToolCall, nativeToolSchemas, parseActionProposal } from './action-proposal.mjs';
import { reviewProposalActions } from './action-safety.mjs';
import { createModelAdapter } from './model-adapter.mjs';
import { executeReviewedProposalActions } from './proposal-executor.mjs';
import { evaluateVerification, normalizeVerificationEvidence } from './verification.mjs';
import { runExec } from './harness/exec.mjs';
import { readFileEnvelope } from './harness/read-file.mjs';
import { createRuntimeTurnResult, assertRuntimeTurnContract } from './chat-runtime-contracts.mjs';
import { normalizeExecutionPolicyInput } from './execution-policy.mjs';
import { compactToolReceipts, summarizeToolResults } from './runtime-result-shapes.mjs';
import { inspectRuntimeObject, runtimeHeapStage } from './runtime-heap-diagnostics.mjs';
import { normalizeProviderMessages } from './provider-messages.mjs';
import { serializeContinuationEvidence } from './continuation-evidence.mjs';
import { prepareNativeToolContinuation } from './native-continuation-preparation.mjs';

const DEFAULT_INSPECTION_FILES = [
  'package.json',
  'README.md',
  'scripts/burrow-ui.mjs',
  'tests/ui-server.test.mjs',
  'src/app-runtime.mjs',
  'src/prompt-assembler.mjs',
];

const UI_INSPECTION_HINT = /\b(ui|interface|screen|page|frontend|front-end|html|css|style|layout|visual|rendered|browser)\b/i;
const UI_SOURCE_HINT = /(?:scripts\/burrow-ui\.mjs|tests\/ui-server\.test\.mjs|src\/chat-turn-controller\.mjs)/i;

function isUiInspectionRequest(message = '') {
  return UI_INSPECTION_HINT.test(String(message || ''));
}

function hasTargetedUiEvidence(toolResults = []) {
  return toolResults.some((result) => {
    if (!result?.ok) return false;
    if (result.tool === 'files_read' && UI_SOURCE_HINT.test(String(result.filePath || ''))) return true;
    if (result.tool === 'shell_exec') {
      const command = String(result.command || '');
      const stdout = String(result.stdout || '');
      const outputLooksLikeUiSource = /(<html|<main|conversation-pane|sessionTranscript|function page\(|createServer\()/i.test(stdout);
      return UI_SOURCE_HINT.test(command) && outputLooksLikeUiSource;
    }
    return false;
  });
}

function targetedUiInspectionMissingFallback({ message = '', toolResults = [] } = {}) {
  if (!isUiInspectionRequest(message)) return null;
  if (hasTargetedUiEvidence(toolResults)) return null;
  if (!hasExecutedInspectionEvidence(toolResults)) return null;
  return 'I inspected the available local context, but I did not find targeted UI source evidence. I should not claim the project only exposes README.md/package.json as fact; the workspace root may be wrong or the UI source is outside the inspected root.';
}

function isMutationToolResult(result = {}) {
  return Boolean(result?.ok && ['files_write', 'files_patch'].includes(result.tool));
}

export function shouldFollowReadOnlyInspection({ mode, ok, model, proposalExecution } = {}) {
  if (!ok || mode !== 'model' || !model?.ok) return false;
  const toolResults = proposalExecution?.toolResults || [];
  if (!toolResults.some((result) => result?.ok && ['files_read', 'shell_exec'].includes(result.tool))) return false;
  if (toolResults.some(isMutationToolResult)) return false;
  return true;
}

const READ_FILE_EVIDENCE_CHARS = 32000;

function readCoverageLines(result = {}) {
  if (!result?.ok) return [];
  // A filesystem read and a model-delivered excerpt are different facts. Never
  // claim the model saw a complete range when prompt compaction withheld it.
  const offsetBytes = Number(result.offsetBytes || 0);
  const rawReturnedBytes = result.returnedBytes ?? Buffer.byteLength(String(result.content || ''), result.encoding || 'utf8');
  const deliveredBytes = result.delivery?.returnedBytes ?? rawReturnedBytes;
  const totalBytes = result.bytes ?? rawReturnedBytes;
  const truncated = Boolean(result.delivery?.truncated ?? result.truncated ?? rawReturnedBytes < totalBytes);
  const nextOffsetBytes = result.delivery?.nextOffsetBytes ?? result.nextOffsetBytes ?? offsetBytes + deliveredBytes;
  const rawComplete = offsetBytes + rawReturnedBytes >= totalBytes;
  return [
    `Delivered coverage: bytes ${offsetBytes}-${offsetBytes + deliveredBytes} of ${totalBytes}${truncated ? ' (partial)' : ' (complete)'}`,
    rawComplete && truncated ? `The tool read the full range, but this continuation only includes a bounded excerpt.` : null,
    truncated ? `Partial result: continue with files_read using offsetBytes: ${nextOffsetBytes} to read bytes ${nextOffsetBytes}-${totalBytes}. Do not reread the same range unless you have a specific reason.` : null,
  ].filter(Boolean);
}

function summarizeInspectionResult(result = {}, { readChars = READ_FILE_EVIDENCE_CHARS, execStdoutChars = 12000, execStderrChars = 4000 } = {}) {
  if (result.tool === 'files_read') {
    return [
      `Tool: files_read`,
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Path: ${result.filePath || 'unknown'}`,
      ...readCoverageLines(result),
      result.ok ? `Content${result.truncated || String(result.content || '').length > readChars ? ` (first ${readChars} chars)` : ''}:\n${String(result.content || '').slice(0, readChars)}` : `Error: ${result.error || 'read failed'}`,
    ].join('\n');
  }
  if (result.tool === 'memory_working_search') {
    const results = (result.results || []).slice(0, 8).map((item) => [
      `[${item.kind || 'memory'}] ${item.title || item.id || 'untitled'}`,
      item.project ? `Project: ${item.project}` : null,
      item.content ? `Content:\n${String(item.content).slice(0, 4000)}` : null,
      item.sourceRef ? `Source: ${item.sourceRef}` : (item.sourceRefs?.length ? `Sources: ${item.sourceRefs.join(', ')}` : null),
    ].filter(Boolean).join('\n')).join('\n---\n');
    return [
      `Tool: ${result.tool}`,
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Query: ${result.query || ''}`,
      result.project ? `Project: ${result.project}` : null,
      result.requestedProject ? `Requested project: ${result.requestedProject}` : null,
      `Results: ${result.resultCount ?? (result.results || []).length}`,
      results || '(no matching memory rows)',
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'memory_rolling_search') {
    const results = (result.results || []).slice(0, 8).map((item) => [
      `[warm] ${item.title || item.id || 'untitled'}`,
      item.project ? `Project: ${item.project}` : null,
      item.summary ? `Summary:\n${String(item.summary).slice(0, 4000)}` : null,
      `Recency: last seen ${item.lastSeen || 'unknown'}; recurrence ${item.recurrence || 0}`,
      item.evidence ? `Evidence: ${item.evidence}` : null,
      item.recentRefs?.length ? `Recent refs: ${item.recentRefs.join(', ')}` : null,
    ].filter(Boolean).join('\n')).join('\n---\n');
    return [
      `Tool: ${result.tool}`,
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Query: ${result.query || ''}`,
      result.project ? `Project: ${result.project}` : null,
      `Results: ${result.resultCount ?? (result.results || []).length}`,
      results || '(no matching warm continuity cards; this absence is not evidence that profile identity, role, persona, current user intent, or current-task context is missing)',
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'agent_send_message') {
    return [
      'Tool: agent_send_message',
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Recipient: ${result.recipientAgentId || 'unknown'}`,
      `Mode: ${result.messageMode || 'deliver'}`,
      result.reply?.ok ? `Recipient reply:\n${String(result.reply.content || '').slice(0, 12000) || '(reply persisted but content unavailable)'}` : null,
      result.reply?.error ? `Reply error: ${result.reply.error}` : null,
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'memory_working_write') {
    return [
      `Tool: ${result.tool}`,
      `OK: ${result.ok ? 'true' : 'false'}`,
      result.record?.id ? `Record: ${result.record.id}` : null,
      result.memoryId ? `Memory: ${result.memoryId}` : null,
      result.project ? `Project: ${result.project}` : null,
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'files_list') {
    const entries = (result.entries || []).slice(0, 200).map((entry) => `${entry.type === 'directory' ? 'dir' : 'file'} ${entry.path || 'unknown'}`).join('\n');
    return [
      'Tool: files_list',
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Directory: ${result.dirPath || 'unknown'}`,
      `Entries returned: ${(result.entries || []).length}${result.truncated ? ' (truncated)' : ''}`,
      result.resultFingerprint ? `Observed state: ${result.resultFingerprint}` : null,
      entries ? `Entries:\n${entries}` : '(no entries returned)',
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'files_find') {
    const paths = (result.paths || []).slice(0, 200).join('\n');
    return [
      'Tool: files_find',
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Directory: ${result.dirPath || 'unknown'}`,
      `Pattern: ${result.pattern || '*'}`,
      `Paths returned: ${(result.paths || []).length}${result.truncated ? ' (truncated)' : ''}`,
      result.resultFingerprint ? `Observed state: ${result.resultFingerprint}` : null,
      paths ? `Paths:\n${paths}` : '(no paths returned)',
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'files_inspect') {
    return [
      'Tool: files_inspect',
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Path: ${result.path || 'unknown'}`,
      `Exists: ${result.exists === true ? 'true' : 'false'}`,
      result.type ? `Type: ${result.type}` : null,
      result.size == null ? null : `Size: ${result.size}`,
      result.modifiedAt ? `Modified: ${result.modifiedAt}` : null,
      result.resultFingerprint ? `Observed state: ${result.resultFingerprint}` : null,
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'files_search') {
    const matches = (result.matches || []).slice(0, 200).map((match) => `${match.filePath || 'unknown'}:${match.line ?? '?'}: ${match.text || ''}`).join('\n');
    return [
      'Tool: files_search',
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Directory: ${result.dirPath || 'unknown'}`,
      `Query: ${result.query || ''}`,
      `Matches returned: ${(result.matches || []).length}${result.truncated ? ' (truncated)' : ''}`,
      result.resultFingerprint ? `Observed state: ${result.resultFingerprint}` : null,
      matches ? `Matches:\n${matches}` : '(no matches returned)',
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'git_status' || result.tool === 'git_diff') {
    const stdout = String(result.stdout || '');
    return [
      `Tool: ${result.tool}`,
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Directory: ${result.dirPath || result.cwd || 'unknown'}`,
      `Exit code: ${result.exitCode ?? 'unknown'}`,
      result.resultFingerprint ? `Observed state: ${result.resultFingerprint}` : null,
      `Output:\n${stdout || '(no output)'}`,
      result.stderr ? `Stderr:\n${String(result.stderr || '')}` : null,
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'shell_exec') {
    const stdout = String(result.stdout || '');
    const originalChars = Number(result.stdoutOriginalChars) || stdout.length;
    const deliveredChars = Math.min(stdout.length, execStdoutChars);
    return [
      `Tool: shell_exec`,
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Command: ${result.command || 'unknown'}`,
      `Exit code: ${result.exitCode ?? 'unknown'}`,
      `Stdout delivery: first ${deliveredChars} of ${originalChars} chars${deliveredChars < originalChars ? ' (remainder omitted from this continuation prompt)' : ''}`,
      `Stdout:\n${stdout.slice(0, execStdoutChars)}`,
      result.stderr ? `Stderr:\n${String(result.stderr || '').slice(0, execStderrChars)}` : null,
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'spawn_subagent') {
    const evidence = (result.evidence || []).slice(0, 8).map((item) => {
      if (item?.tool === 'files_read') {
        const returnedBytes = item.returnedBytes ?? Buffer.byteLength(String(item.content || ''), item.encoding || 'utf8');
        const totalBytes = item.bytes ?? returnedBytes;
        return [
          'Evidence tool: files_read',
          `Path: ${item.filePath || 'unknown'}`,
          `Coverage: bytes ${item.offsetBytes || 0}-${(item.offsetBytes || 0) + returnedBytes} of ${totalBytes}${item.truncated ? ' (truncated)' : ''}`,
          item.error ? `Error: ${item.error}` : null,
          item.ok ? `Content excerpt:\n${String(item.content || '').slice(0, 6000)}` : null,
        ].filter(Boolean).join('\n');
      }
      if (item?.tool === 'files_list') {
        return [
          'Evidence tool: files_list',
          `Dir: ${item.dirPath || '.'}`,
          `Files:\n${(item.files || []).slice(0, 200).join('\n')}`,
          item.truncated ? 'List truncated: true' : null,
        ].filter(Boolean).join('\n');
      }
      return JSON.stringify(item).slice(0, 6000);
    }).join('\n---\n');
    return [
      'Tool: spawn_subagent',
      `OK: ${result.ok ? 'true' : 'false'}`,
      `ID: ${result.id || 'unknown'}`,
      `Status: ${result.status || 'unknown'}`,
      result.target?.root ? `Target root: ${result.target.root}` : null,
      result.childSessionId ? `Child session: ${result.childSessionId}` : null,
      result.summary ? `Subagent findings:\n${String(result.summary).slice(0, 6000)}` : null,
      result.blockers?.length ? `Blockers: ${result.blockers.join(', ')}` : null,
      result.warnings?.length ? `Warnings: ${result.warnings.join(', ')}` : null,
      evidence ? `Evidence:\n${evidence}` : null,
    ].filter(Boolean).join('\n');
  }
  return '';
}

export function inspectionResultSummary(toolResults = [], options = {}) {
  return (toolResults || [])
    .map((result) => summarizeInspectionResult(result, options))
    .filter(Boolean)
    .join('\n\n---\n\n');
}

// Tool artifacts retain full output. Follow-up prompts must not: resending every
// large read/exec result on every tool call can grow a chat loop until V8 dies.
// But recency is not evidence authority: keep compact references to the whole
// observed tool chain, and spend the bulky excerpt budget on material evidence
// rather than blindly dropping anything older than N newer calls.
// Tool calls are not limited by count. A long investigation is legitimate as
// long as each round adds material evidence. Retained receipts and rendered
// prompt evidence have byte budgets. Repeated observations are recorded as
// facts for the agent and operator; they are not instructions or tool gates.
const CHAT_TOOL_HISTORY_LIMIT = 64;
const CHAT_TOOL_RESULT_HISTORY_LIMIT = 256;
const CHAT_TOOL_CALL_HISTORY_LIMIT = 256;
const CHAT_TOOL_SEMANTIC_HISTORY_LIMIT = 256;
const CHAT_TOOL_SINGLE_EXCERPT_CHARS = 6_000;
function materialEvidenceKeys(results = []) {
  const keys = [];
  for (const result of results || []) {
    if (!result) continue;
    if (result.tool === 'spawn_subagent' && result.id) {
      // A generated child id is not evidence. Exact subagent request identity
      // is; repeated requests must not reset the no-progress fuse.
      const identity = result.tool === 'spawn_subagent'
        ? (result.spawnRequestKey || result.id)
        : result.id;
      keys.push(`delegated:${result.tool}:${identity}:${result.status || (result.ok ? 'succeeded' : 'failed')}`);
      continue;
    }
    if (result.tool === 'files_read') {
      keys.push(`read:${result.filePath || ''}:${result.offsetBytes || 0}:${result.returnedBytes ?? result.coverage?.returnedBytes ?? 0}:${result.bytes ?? result.coverage?.bytes ?? 0}:${result.contentHash || ''}`);
      continue;
    }
    if (result.tool === 'shell_exec') {
      keys.push(`shell_exec:${String(result.command || '').slice(0, 500)}:${result.exitCode ?? 'unknown'}:${String(result.stdout || '').slice(0, 500)}:${String(result.stderr || '').slice(0, 200)}`);
      continue;
    }
    if (['files_list', 'files_find', 'files_inspect', 'files_search', 'git_status', 'git_diff'].includes(result.tool)) {
      keys.push(`${result.tool}:${result.dirPath || result.path || ''}:${result.query || result.pattern || ''}:${result.resultFingerprint || ''}:${result.ok ? 'ok' : 'failed'}`);
      continue;
    }
    keys.push(`${result.tool || 'tool'}:${result.id || result.filePath || result.command || ''}:${result.status || (result.ok ? 'ok' : 'failed')}`);
  }
  return keys;
}

function recordMaterialProgress(seen, results = []) {
  let added = 0;
  for (const key of materialEvidenceKeys(results)) {
    if (seen.has(key)) continue;
    seen.add(key);
    added += 1;
  }
  return added;
}

// Tool-call arguments originate with providers. They are data, not trusted
// runtime objects: do not retain or serialize an arbitrary graph merely to
// generate a receipt, a prompt summary, or a repeat-detection fingerprint.
const TOOL_ARGUMENT_RECEIPT_CHARS = 12_000;
const TOOL_ARGUMENT_RECEIPT_DEPTH = 12;
const TOOL_ARGUMENT_RECEIPT_ITEMS = 64;
const TOOL_ARGUMENT_RECEIPT_KEYS = 64;
const TOOL_ARGUMENT_RECEIPT_NODES = 256;
const TOOL_ARGUMENT_RECEIPT_STRING_CHARS = 1_024;

function boundedToolArgumentValue(value, {
  maxChars = TOOL_ARGUMENT_RECEIPT_CHARS,
  maxDepth = TOOL_ARGUMENT_RECEIPT_DEPTH,
  maxItems = TOOL_ARGUMENT_RECEIPT_ITEMS,
  maxKeys = TOOL_ARGUMENT_RECEIPT_KEYS,
  maxNodes = TOOL_ARGUMENT_RECEIPT_NODES,
  maxStringChars = TOOL_ARGUMENT_RECEIPT_STRING_CHARS,
} = {}) {
  const seen = new WeakSet();
  const state = { remaining: Math.max(128, Number(maxChars) || TOOL_ARGUMENT_RECEIPT_CHARS), nodes: 0 };
  const truncated = () => '[tool arguments truncated]';
  const text = (input) => {
    const raw = String(input);
    const limit = Math.max(0, Math.min(maxStringChars, state.remaining));
    state.remaining -= Math.min(raw.length, limit);
    return raw.length > limit ? `${raw.slice(0, limit)}… [${raw.length - limit} chars omitted]` : raw;
  };
  const visit = (input, depth = 0) => {
    if (input === null || input === undefined || typeof input === 'boolean' || typeof input === 'number') return input;
    if (typeof input === 'string') return text(input);
    if (typeof input === 'bigint') return `${input}n`;
    if (typeof input === 'symbol' || typeof input === 'function') return `[${typeof input} omitted]`;
    if (depth >= maxDepth || state.nodes >= maxNodes || state.remaining <= 0) return truncated();
    if (seen.has(input)) return '[circular tool arguments omitted]';
    seen.add(input);
    state.nodes += 1;
    if (Array.isArray(input)) {
      const output = [];
      const count = Math.min(input.length, maxItems);
      for (let index = 0; index < count && state.remaining > 0; index += 1) {
        try { output.push(visit(input[index], depth + 1)); } catch { output.push('[tool argument item unreadable]'); }
      }
      if (input.length > count) output.push(`[${input.length - count} items omitted]`);
      return output;
    }
    const output = {};
    try {
      // Collect only the bounded key prefix, then order it so fingerprints do
      // not depend on provider property insertion order. This avoids the
      // whole-object Object.keys/Object.entries allocation.
      const keys = [];
      let omitted = false;
      for (const key in input) {
        if (!Object.hasOwn(input, key)) continue;
        if (keys.length >= maxKeys) { omitted = true; break; }
        keys.push(key);
      }
      for (const key of keys.sort()) {
        if (state.remaining <= 0) { omitted = true; break; }
        const safeKey = text(key);
        try { output[safeKey] = visit(input[key], depth + 1); } catch { output[safeKey] = '[tool argument value unreadable]'; }
      }
      if (omitted) output.__truncated = '[tool argument keys omitted]';
    } catch {
      return '[tool argument object unreadable]';
    }
    return output;
  };
  return visit(value);
}

function stableJson(value) {
  // The bounded clone also makes this deterministic serializer cycle-safe.
  const bounded = boundedToolArgumentValue(value);
  const serialize = (input) => {
    if (Array.isArray(input)) return `[${input.map(serialize).join(',')}]`;
    if (input && typeof input === 'object') return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${serialize(input[key])}`).join(',')}}`;
    return JSON.stringify(input);
  };
  return serialize(bounded) ?? 'null';
}

function toolPlanFingerprint(toolCalls = []) {
  return fingerprint(compactToolCalls(toolCalls).map((call) => ({ name: call.name, arguments: call.arguments })));
}

function fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16);
}

function repeatedToolCallObservations(toolCalls = [], priorIterations = []) {
  const prior = (priorIterations || []).flatMap((entry) => entry.toolCalls || []);
  return compactToolCalls(toolCalls).map((call) => {
    const callFingerprint = fingerprint({ name: call.name, arguments: call.arguments });
    const priorCount = prior.filter((entry) => fingerprint({ name: entry.name, arguments: entry.arguments }) === callFingerprint).length;
    return { tool: call.name, fingerprint: callFingerprint, repeatCount: priorCount + 1, reason: typeof call.arguments?.reason === 'string' ? call.arguments.reason.slice(0, 500) : null };
  });
}

function normalizedToolOutcome(result = {}) {
  return {
    ok: Boolean(result.ok),
    tool: result.tool || null,
    filePath: result.filePath || null,
    path: result.path || null,
    dirPath: result.dirPath || null,
    pattern: result.pattern || null,
    query: result.query || null,
    contentHash: result.contentHash || null,
    resultFingerprint: result.resultFingerprint || null,
    exists: typeof result.exists === 'boolean' ? result.exists : null,
    offsetBytes: result.offsetBytes ?? null,
    returnedBytes: result.returnedBytes ?? null,
    bytes: result.bytes ?? null,
    truncated: Boolean(result.truncated),
    content: typeof result.content === 'string' ? result.content : null,
    command: result.command || null,
    exitCode: result.exitCode ?? null,
    stdout: typeof result.stdout === 'string' ? result.stdout : null,
    stderr: typeof result.stderr === 'string' ? result.stderr : null,
    error: result.error || null,
    status: result.status || null,
  };
}

function runtimeObservationFacts(toolResults = []) {
  const facts = new Map();
  for (const result of toolResults) {
    if (!result?.ok) continue;
    if (result.tool === 'files_read') {
      const start = Number(result.offsetBytes || 0);
      const returned = Number(result.returnedBytes || 0);
      const total = Number(result.bytes ?? returned);
      const coverage = `${start}-${start + returned} of ${total}`;
      const state = result.contentHash ? `; observed state ${result.contentHash}` : '';
      facts.set(`read:${result.filePath}:${coverage}:${result.contentHash || ''}`, `files_read ${result.filePath || 'unknown'}: observed bytes ${coverage}${result.truncated ? ' (partial)' : ' (complete)'}${state}.`);
      continue;
    }
    if (['files_list', 'files_find', 'files_inspect', 'files_search', 'git_status', 'git_diff'].includes(result.tool)) {
      const subject = result.dirPath || result.path || 'unknown';
      const state = result.resultFingerprint ? `; observed state ${result.resultFingerprint}` : '';
      facts.set(`${result.tool}:${subject}:${result.resultFingerprint || ''}`, `${result.tool} ${subject}: completed${state}.`);
    }
  }
  return [...facts.values()].slice(-16);
}

function canonicalInspectionKey(call = {}) {
  const args = call.arguments || {};
  if (call.name === 'files_read') return `files_read:${args.filePath || ''}:${args.offsetBytes || 0}:${args.maxBytes || ''}`;
  if (call.name === 'files_inspect') return `files_inspect:${args.path || ''}`;
  if (call.name === 'git_status' || call.name === 'git_diff') return `${call.name}:${args.dirPath || ''}`;
  if (call.name !== 'shell_exec') return null;
  const command = String(args.command || '').trim();
  const inspection = /^(?:cat|sed\s+-n|head|tail|grep|rg|ls|find|pwd|git\s+(?:status|diff))\b/i;
  if (!inspection.test(command)) return null;
  // Reasons and presentation/range flags are intentionally excluded. This is
  // observational telemetry: it recognizes repeated inspection of the same
  // target, but never blocks a tool call or changes approval behavior.
  const target = command.match(/(?:^|\s)(?:['"]?)([^\s'"]+\.(?:[cm]?[jt]sx?|css|json|md|html|ya?ml))['"]?\s*$/i)?.[1] || command.replace(/\s+/g, ' ');
  return `shell_exec-inspect:${target}`;
}

function semanticInspectionObservations(toolCalls = [], history = new Map()) {
  return compactToolCalls(toolCalls).map((call) => {
    const key = canonicalInspectionKey(call);
    if (!key) return null;
    const count = (history.get(key) || 0) + 1;
    appendBoundedMapEntry(history, key, count, CHAT_TOOL_SEMANTIC_HISTORY_LIMIT);
    return { tool: call.name, key, count };
  }).filter(Boolean);
}

function exactRepeatVerdict(toolCalls = [], history = [], { loopWarningThreshold = 2, loopBlockThreshold = 3 } = {}) {
  for (const call of compactToolCalls(toolCalls)) {
    const callFingerprint = fingerprint({ name: call.name, arguments: call.arguments });
    let streak = 0;
    let outcomeFingerprint = null;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (entry.callFingerprint !== callFingerprint) break;
      if (outcomeFingerprint === null) outcomeFingerprint = entry.outcomeFingerprint;
      if (entry.outcomeFingerprint !== outcomeFingerprint) break;
      streak += 1;
    }
    const attemptedCount = streak + 1;
    if (streak && attemptedCount >= loopBlockThreshold) return { action: 'block', tool: call.name, callFingerprint, outcomeFingerprint, repeatedCompletedCalls: streak, attemptedCount, arguments: call.arguments };
    if (streak && attemptedCount >= loopWarningThreshold) return { action: 'warn', tool: call.name, callFingerprint, outcomeFingerprint, repeatedCompletedCalls: streak, attemptedCount, arguments: call.arguments };
  }
  return null;
}

function loopReceiptText(verdict, { terminal = false } = {}) {
  const state = terminal ? 'Runtime stopped further tool execution' : 'Runtime warning — repeated no-progress tool pattern detected';
  return [
    state,
    `Detector: identical_tool_call_and_result`,
    `Tool: ${verdict.tool}`,
    `Repeated completed calls with identical arguments and result: ${verdict.repeatedCompletedCalls}`,
    `Attempted call count: ${verdict.attemptedCount}`,
    terminal
      ? 'This was a runtime decision, not a tool failure, user cancellation, or a failure by you. The requested work may be incomplete. Explain what was completed and this exact blocker honestly.'
      : 'Tools remain available. Change strategy or use the partial-read continuation hint; do not repeat this exact call unless the underlying result should change.',
  ].join('\n');
}

async function logChatToolLoopHeapStage(traceLogger, stage, objects) {
  // The live OOM happens after routing. Keep this bounded and non-serializing so
  // the diagnostic identifies loop-state growth without creating it.
  await traceLogger?.event?.('runtime-heap-stage', runtimeHeapStage(stage, objects));
}

function compactPromptEvidenceResult(result = {}) {
  // Never retain a shallow copy of a tool result here. Some results carry
  // nested delegated records/evidence that survive shallow trimming and get
  // re-serialized on every continuation.
  const compact = {
    tool: result.tool || null,
    ok: Boolean(result.ok),
    id: result.id || null,
    status: result.status || null,
    filePath: result.filePath || null,
    path: result.path || null,
    dirPath: result.dirPath || null,
    pattern: result.pattern || null,
    contentHash: result.contentHash || null,
    resultFingerprint: result.resultFingerprint || null,
    exists: typeof result.exists === 'boolean' ? result.exists : null,
    type: result.type || null,
    size: result.size ?? null,
    modifiedAt: result.modifiedAt || null,
    offsetBytes: result.offsetBytes ?? null,
    returnedBytes: result.returnedBytes ?? null,
    bytes: result.bytes ?? null,
    truncated: Boolean(result.truncated),
    command: typeof result.command === 'string' ? result.command.slice(0, 800) : null,
    exitCode: result.exitCode ?? null,
    reason: typeof result.reason === 'string' ? result.reason.slice(0, 500) : null,
    stdoutOriginalChars: Number.isFinite(Number(result.stdoutOriginalChars)) ? Number(result.stdoutOriginalChars) : null,
    error: typeof result.error === 'string' ? result.error.slice(0, 800) : null,
    warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 8) : [],
  };
  if (typeof result.content === 'string') {
    compact.content = result.content.slice(0, CHAT_TOOL_SINGLE_EXCERPT_CHARS);
    if (result.tool === 'files_read') {
      const deliveredBytes = Buffer.byteLength(compact.content, result.encoding || 'utf8');
      const rawReturnedBytes = result.returnedBytes ?? Buffer.byteLength(result.content, result.encoding || 'utf8');
      const offsetBytes = Number(result.offsetBytes || 0);
      compact.delivery = {
        returnedBytes: deliveredBytes,
        truncated: deliveredBytes < rawReturnedBytes || Boolean(result.truncated),
        nextOffsetBytes: offsetBytes + deliveredBytes,
      };
    }
  }
  if (typeof result.stdout === 'string') compact.stdout = result.stdout.slice(0, 4_000);
  if (typeof result.stderr === 'string') compact.stderr = result.stderr.slice(0, 1_200);
  if (typeof result.summary === 'string') compact.summary = result.summary.slice(0, 4_000);
  if (typeof result.query === 'string') compact.query = result.query.slice(0, 1_000);
  if (typeof result.project === 'string') compact.project = result.project.slice(0, 500);
  if (Array.isArray(result.entries)) compact.entries = result.entries.slice(0, 20).map((item) => ({ path: item?.path || null, type: item?.type || null }));
  if (Array.isArray(result.paths)) compact.paths = result.paths.slice(0, 20);
  if (Array.isArray(result.matches)) compact.matches = result.matches.slice(0, 20).map((item) => ({ filePath: item?.filePath || null, line: item?.line ?? null, text: typeof item?.text === 'string' ? item.text.slice(0, 500) : null }));
  if (typeof result.requestedProject === 'string') compact.requestedProject = result.requestedProject.slice(0, 500);
  if (Number.isFinite(Number(result.resultCount))) compact.resultCount = Number(result.resultCount);
  if (Array.isArray(result.results)) {
    compact.results = result.results.slice(0, 8).map((item) => ({
      kind: item?.kind || null,
      id: item?.id || null,
      project: item?.project || null,
      title: typeof item?.title === 'string' ? item.title.slice(0, 500) : null,
      content: typeof item?.content === 'string' ? item.content.slice(0, CHAT_TOOL_SINGLE_EXCERPT_CHARS) : null,
      sourceRef: item?.sourceRef || null,
    }));
  }
  if (Array.isArray(result.tasks)) compact.tasks = result.tasks.slice(0, 12).map((task) => ({
    id: task?.id || null, projectId: task?.projectId || null,
    title: typeof task?.title === 'string' ? task.title.slice(0, 500) : null,
    description: typeof task?.description === 'string' ? task.description.slice(0, CHAT_TOOL_SINGLE_EXCERPT_CHARS) : null,
    status: task?.status || null, priority: task?.priority || null,
    assignedAgentId: task?.assignedAgentId || null, updatedAt: task?.updatedAt || null,
  }));
  if (result.task && typeof result.task === 'object') compact.task = {
    id: result.task.id || null, projectId: result.task.projectId || null,
    title: typeof result.task.title === 'string' ? result.task.title.slice(0, 500) : null,
    status: result.task.status || null, priority: result.task.priority || null,
    assignedAgentId: result.task.assignedAgentId || null, updatedAt: result.task.updatedAt || null,
  };
  return compact;
}

function appendBoundedChatHistory(history, entry, limit, omittedKey) {
  history.push(entry);
  if (history.length <= limit) return;
  history.shift();
  history[omittedKey] = (history[omittedKey] || 0) + 1;
}

function appendBoundedMapEntry(history, key, value, limit) {
  if (!history.has(key) && history.size >= limit) history.delete(history.keys().next().value);
  history.set(key, value);
}


export function hasExecutedInspectionEvidence(toolResults = []) {
  return toolResults.some((result) => result?.ok && (result.tool === 'files_read' || result.tool === 'shell_exec'));
}

export function hasExecutedReadFileEvidence(toolResults = []) {
  return toolResults.some((result) => result?.ok && result.tool === 'files_read');
}

function normalizeCanonicalInspectionPath(filePath = '') {
  const value = String(filePath || '').trim();
  if (!value || !path.isAbsolute(value)) return null;
  return path.resolve(value);
}

function canonicalInspectionTargets(inspectionTargets = []) {
  return [...new Set((inspectionTargets || []).map(normalizeCanonicalInspectionPath).filter(Boolean))];
}

function hasTargetedFileEvidence(toolResults = [], target = '') {
  const normalizedTarget = normalizeCanonicalInspectionPath(target);
  if (!normalizedTarget) return false;
  return toolResults.some((result) => {
    if (!result?.ok) return false;
    if (result.tool !== 'files_read') return false;
    return normalizeCanonicalInspectionPath(result.filePath) === normalizedTarget;
  });
}

function invalidInspectionTargets(inspectionTargets = []) {
  return [...new Set((inspectionTargets || [])
    .map((target) => String(target || '').trim())
    .filter((target) => target && !normalizeCanonicalInspectionPath(target)))];
}

function missingInspectionTargets(toolResults = [], inspectionTargets = []) {
  return [
    ...invalidInspectionTargets(inspectionTargets),
    ...canonicalInspectionTargets(inspectionTargets).filter((target) => !hasTargetedFileEvidence(toolResults, target)),
  ];
}

export function shouldForceInspectionEvidence({ inspectionRequired = false, inspectionTargets = [], proposalExecution, message = '' } = {}) {
  if (!inspectionRequired) return false;
  const toolResults = proposalExecution?.toolResults || [];
  if (isUiInspectionRequest(message) && !hasTargetedUiEvidence(toolResults)) return true;
  if (missingInspectionTargets(toolResults, inspectionTargets).length) return true;
  return !hasExecutedInspectionEvidence(toolResults);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function defaultInspectionFileList(workspaceRoot) {
  if (!workspaceRoot) return [];
  const selected = [];
  for (const file of DEFAULT_INSPECTION_FILES) {
    if (await pathExists(path.join(workspaceRoot, file))) selected.push(file);
  }
  return selected;
}

export async function runDefaultReadOnlyInspection({ workspaceRoot, rootDir, dataRoot = null, traceLogger, inspectionTargets = [] } = {}) {
  if (!workspaceRoot) return [];
  const workspaceBoundary = workspaceRoot || rootDir || process.cwd();
  const files = await defaultInspectionFileList(workspaceRoot);
  const targetFiles = canonicalInspectionTargets(inspectionTargets);
  const defaultFiles = files.slice(0, 8).map((filePath) => path.join(workspaceRoot, filePath));
  const readFiles = [...new Set([...targetFiles, ...defaultFiles])];
  const results = [];
  const runtimeOwnedPaths = ['traces', 'sessions', 'work-items', 'handoffs', 'memory', 'profile', 'skills', 'tools', 'artifacts', 'workbench-verify', 'cache', 'node_modules', '.git', 'coverage', 'dist', 'build', '.cache', 'tmp'];
  if (dataRoot) {
    const relativeDataRoot = path.relative(path.resolve(workspaceRoot), path.resolve(dataRoot)).split(path.sep).join('/');
    if (relativeDataRoot && !relativeDataRoot.startsWith('../') && relativeDataRoot !== '..' && !path.isAbsolute(relativeDataRoot)) {
      runtimeOwnedPaths.push(relativeDataRoot);
    }
  }
  const prunePaths = [...new Set(runtimeOwnedPaths)].map((name) => `-path './${name}'`).join(' -o ');
  const listingCommand = `find . -maxdepth 3 \\( ${prunePaths} \\) -prune -o -type f -print | sed 's#^./##' | sort | head -120`;
  results.push(await runExec({ command: listingCommand, cwd: workspaceRoot, traceLogger, artifactPrefix: 'default-inspection-list' }));
  for (const filePath of readFiles) {
    results.push(await readFileEnvelope({
      filePath,
      workspaceRoot: workspaceBoundary,
      traceLogger,
      artifactPrefix: `default-inspection-read-${path.relative(workspaceRoot, filePath).replace(/[^a-z0-9_.-]+/gi, '-')}`,
    }));
  }
  return results;
}

export function pendingInspectionFallback({ proposal, proposalExecution } = {}) {
  if (!proposal?.actions?.length) return null;
  if ((proposalExecution?.executed || 0) > 0) return null;
  const skipped = proposalExecution?.skipped || [];
  const readOnlySkipped = skipped.filter((item) => item.tool === 'files_read' || item.tool === 'shell_exec');
  if (!readOnlySkipped.length) return null;
  const answer = String(proposal.answerText || '').trim();
  const pendingOnly = /^inspect(?:ing)?\b/i.test(answer) || /^check(?:ing)?\b/i.test(answer) || /^read(?:ing)?\b/i.test(answer);
  if (!pendingOnly) return null;
  const reasons = readOnlySkipped.map((item) => `${item.tool}:${item.status || 'skipped'}`).join(', ');
  return `I did not inspect the local context. The proposed read-only action was not executed (${reasons}).`;
}

function mutationOnlyToolSchemas() {
  return nativeToolSchemas({ includeMutations: true })
    .filter((tool) => ['files_write', 'files_patch'].includes(tool.function?.name));
}

function execOnlyToolSchemas() {
  return nativeToolSchemas({ includeMutations: false })
    .filter((tool) => tool.function?.name === 'shell_exec');
}

function proposalHasMutationAction(proposal = null) {
  return (proposal?.actions || []).some((action) => ['files_write', 'files_patch'].includes(action.tool));
}

function hasMutationToolResult(toolResults = []) {
  return (toolResults || []).some((result) => ['files_write', 'files_patch'].includes(String(result?.tool || '')));
}

function failedMutationToolResult(toolResults = []) {
  return (toolResults || []).find((result) => result?.ok === false && ['files_write', 'files_patch'].includes(String(result?.tool || ''))) || null;
}

function hasFailedMutationToolResult(toolResults = []) {
  return Boolean(failedMutationToolResult(toolResults));
}

const MUTATION_REPAIR_MAX_ATTEMPTS = 5;

function mutationFailureSummary(result = {}) {
  if (!result) return 'unknown mutation failure';
  return [
    `Tool: ${result.tool || 'mutation'}`,
    `OK: ${result.ok ? 'true' : 'false'}`,
    result.filePath ? `Path: ${result.filePath}` : null,
    result.touchedFiles?.length ? `Touched files: ${result.touchedFiles.join(', ')}` : null,
    result.failureClass ? `Failure class: ${result.failureClass}` : null,
    result.gitApplyExitCode != null ? `git apply exit code: ${result.gitApplyExitCode}` : null,
    result.error ? `Error:\n${String(result.error).slice(0, 4000)}` : null,
  ].filter(Boolean).join('\n');
}

function structuredFollowupInput({ prompt, content }) {
  const messages = Array.isArray(prompt?.modelMessages) && prompt.modelMessages.length
    ? normalizeProviderMessages([...prompt.modelMessages, { role: 'user', content }])
    : null;
  return messages ? { messages } : { prompt: content };
}

function continuationPrompt({ prompt, message, toolResults, modelConfig, contextThreshold, tools, instructions, label = 'Executed continuation evidence:' }) {
  const buildPrompt = (evidence = '') => [prompt.text, '', ...instructions, '', 'User request:', message, '', label, evidence || '(no executed continuation evidence)'].join('\n');
  const evidence = serializeContinuationEvidence({ toolResults, modelConfig, contextThreshold, tools, buildPrompt });
  return buildPrompt(evidence);
}

export async function completeMutationAfterInspection({ adapter, prompt, message, toolResults, modelConfig, contextThreshold, traceLogger }) {
  const followupPrompt = continuationPrompt({ prompt, message, toolResults, modelConfig, contextThreshold, tools: nativeToolSchemas(), instructions: [
    'The user explicitly asked for a fix/change. Read-only inspection was only preflight, not completion.',
    'Use the executed inspection evidence below. If the change is safe and inside scope, call files_write or files_patch now. If you cannot safely patch, report the specific blocker. Do not ask the user to paste files and do not stop at analysis.',
  ], label: 'Executed inspection results:' });
  return adapter.complete({ ...structuredFollowupInput({ prompt, content: followupPrompt }), tools: nativeToolSchemas(), toolChoice: 'auto', traceLogger });
}

export async function completeMutationRepairAfterNoAction({ adapter, prompt, message, toolResults, modelConfig, contextThreshold, traceLogger }) {
  const repairPrompt = continuationPrompt({ prompt, message, toolResults, modelConfig, contextThreshold, tools: mutationOnlyToolSchemas(), instructions: [
    'Mutation is required and inspection already succeeded. Prose is not a valid completion for this turn.',
    'You must call files_write or files_patch now. Those are the only available tools.',
    'If you cannot safely make a change, do not answer in prose; emit no tool call and the runtime will fail clearly.',
  ], label: 'Executed inspection results:' });
  return adapter.complete({ ...structuredFollowupInput({ prompt, content: repairPrompt }), tools: mutationOnlyToolSchemas(), toolChoice: 'auto', traceLogger });
}

export async function completeMutationRepairAfterToolFailure({ adapter, prompt, message, inspectionToolResults, failedMutationResult, modelConfig, contextThreshold, traceLogger, attempt = 1 }) {
  if (!failedMutationResult) return null;
  const repairPrompt = continuationPrompt({ prompt, message, toolResults: [...inspectionToolResults, failedMutationResult], modelConfig, contextThreshold, tools: mutationOnlyToolSchemas(), instructions: [
    `Repair attempt: ${attempt}`,
    'Mutation is still required. The previous mutation tool call failed mechanically; this is retryable.',
    'Regenerate the change and call files_write or files_patch now. Those are the only available tools.',
    'If files_patch failed because the patch was malformed or empty, produce a valid unified diff or use files_write with complete file content.',
  ], label: 'Executed continuation evidence:' });
  return adapter.complete({ ...structuredFollowupInput({ prompt, content: repairPrompt }), tools: mutationOnlyToolSchemas(), toolChoice: 'auto', traceLogger });
}

export async function completeVerificationAfterMutation({ adapter, prompt, message, toolResults, modelConfig, contextThreshold, traceLogger }) {
  const verificationPrompt = continuationPrompt({ prompt, message, toolResults, modelConfig, contextThreshold, tools: execOnlyToolSchemas(), instructions: [
    'A file mutation succeeded, but verification is still missing. Continue; do not stop at the changed file.',
    'Run an appropriate local verification command now using exec. Use the project evidence and package scripts when available.',
    'Only shell_exec is available. If no verification command can be run, emit no tool call and the runtime will fail clearly.',
  ], label: 'Executed continuation evidence:' });
  return adapter.complete({ ...structuredFollowupInput({ prompt, content: verificationPrompt }), tools: execOnlyToolSchemas(), toolChoice: 'auto', traceLogger });
}

function proposalFromNativeToolCalls(toolCalls = [], fallbackText = '', executionContext = null) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return null;
  const actions = toolCalls.map((call, index) => actionFromNativeToolCall(call, index));
  const errors = actions.flatMap((action) => action.errors.map((message) => `action_${action.index}:${message}`));
  return {
    ok: errors.length === 0,
    format: 'native-tools',
    answerText: fallbackText || '',
    actions,
    errors,
    raw: { toolCalls },
  };
}

export async function runProposalLoop({
  ok = true,
  mode = 'dry-run',
  prompt,
  message,
  workspaceRoot = null,
  rootDir,
  dataRoot = null,
  sessionId = null,
  conversationId = null,
  authorityDecision = null,
  executionPolicy: executionPolicyInput = null,
  modelConfig = null,
  contextThreshold = null,
  modelAdapter = null,
  traceLogger = null,
  executeProposals = false,
  allowReviewRequiredProposals = false,
  readOnlyInspectionFollowup = false,
  requireInspectionEvidence = false,
  requiresMutation = false,
  initialToolResults = [],
  inspectionTargets = [],
  executionContext = null,
} = {}) {
  const executionPolicy = normalizeExecutionPolicyInput(executionPolicyInput || authorityDecision);
  let model = null;
  let adapter = null;
  // Every model turn sees the normal surface. Runtime policy and action validation,
  // rather than schema pruning, decide whether a selected action can execute.
  const tools = executionContext?.toolSchemas || nativeToolSchemas();
  // Tests and embedded callers may supply an already-configured adapter. They
  // must not be gated on a separately supplied modelConfig; production adapter
  // construction still requires an explicit selected model.
  if (ok && mode === 'model' && (modelAdapter || modelConfig?.model)) {
    adapter = modelAdapter || createModelAdapter({ config: modelConfig });
    model = await adapter.complete({ ...(Array.isArray(prompt.modelMessages) && prompt.modelMessages.length ? { messages: normalizeProviderMessages(prompt.modelMessages) } : { prompt: prompt.text }), tools, toolChoice: 'auto', traceLogger });
  }

  const resolvedToolResults = [...initialToolResults];
  let proposal = proposalFromNativeToolCalls(model?.choice?.toolCalls, model?.choice?.text ?? '', executionContext) || (model ? parseActionProposal(model.choice?.text ?? '') : null);
  let proposalReview = reviewProposalActions({ actions: proposal?.actions ?? [], workspaceRoot, executionContext });
  let proposalExecution = executeProposals && proposal
    ? await executeReviewedProposalActions({
        actions: proposal.actions,
        reviews: proposalReview.reviews,
        workspaceRoot,
        rootDir,
        dataRoot,
        sessionId,
        conversationId,
        executionPolicy,
        modelConfig,
        executionContext,
        traceLogger,
        allowReviewRequired: allowReviewRequiredProposals,
        observedToolResults: resolvedToolResults,
        })
    : { executed: 0, skipped: [], toolResults: [] };
  resolvedToolResults.push(...proposalExecution.toolResults);

  if (executeProposals && shouldForceInspectionEvidence({ inspectionRequired: requireInspectionEvidence, inspectionTargets, proposalExecution, message })) {
    const defaultInspectionResults = compactToolReceipts(await runDefaultReadOnlyInspection({ workspaceRoot, rootDir, dataRoot, traceLogger, inspectionTargets }));
    proposalExecution = {
      executed: proposalExecution.executed + defaultInspectionResults.length,
      skipped: proposalExecution.skipped,
      toolResults: [...proposalExecution.toolResults, ...defaultInspectionResults],
      defaultInspection: true,
    };
    resolvedToolResults.push(...defaultInspectionResults);
  }

  const missingTargetsAfterInspection = missingInspectionTargets(proposalExecution.toolResults, inspectionTargets);
  const missingTargetFallback = missingTargetsAfterInspection.length
    ? `I could not inspect the exact requested file target${missingTargetsAfterInspection.length === 1 ? '' : 's'}: ${missingTargetsAfterInspection.join(', ')}. I should not answer from unrelated file evidence.`
    : null;

  if (!missingTargetFallback && requiresMutation && adapter && hasExecutedInspectionEvidence(proposalExecution.toolResults) && shouldFollowReadOnlyInspection({ mode, ok, model, proposalExecution })) {
    const preflightToolResults = proposalExecution.toolResults;
    const mutationFollowup = await completeMutationAfterInspection({ adapter, prompt, message, toolResults: preflightToolResults, modelConfig, contextThreshold, traceLogger });
    let mutationProposal = proposalFromNativeToolCalls(mutationFollowup?.choice?.toolCalls, mutationFollowup?.choice?.text ?? '', executionContext) || (mutationFollowup ? parseActionProposal(mutationFollowup.choice?.text ?? '') : null);
    let mutationReview = reviewProposalActions({ actions: mutationProposal?.actions ?? [], workspaceRoot, executionContext });
    let mutationExecution = executeProposals && mutationProposal
      ? await executeReviewedProposalActions({
          actions: mutationProposal.actions,
          reviews: mutationReview.reviews,
          workspaceRoot,
          rootDir,
          dataRoot,
          sessionId,
          executionPolicy,
          modelConfig,
          executionContext,
          traceLogger,
          allowReviewRequired: allowReviewRequiredProposals,
          observedToolResults: [...resolvedToolResults, ...proposalExecution.toolResults],
            })
      : { executed: 0, skipped: [], toolResults: [] };
    let mutationRepair = null;
    let mutationRepairFailed = false;
    let mutationRepairToolFailed = false;
    if (executeProposals && !hasExecutedMutationEvidence(mutationExecution.toolResults)) {
      let repairExecutionTotal = { executed: 0, skipped: [], toolResults: [] };
      let lastRepairProposal = null;
      let lastRepairReview = null;
      let lastFailure = failedMutationToolResult(mutationExecution.toolResults);
      const mutationRepairHistory = [];
      let mutationRepairProviderFailed = false;
      for (let attempt = 0; attempt < MUTATION_REPAIR_MAX_ATTEMPTS && !hasExecutedMutationEvidence(repairExecutionTotal.toolResults); attempt += 1) {
        const repairAttempt = attempt + 1;
        const repair = lastFailure
          ? await completeMutationRepairAfterToolFailure({
              adapter,
              prompt,
              message,
              inspectionToolResults: preflightToolResults,
              failedMutationResult: lastFailure,
              modelConfig,
              contextThreshold,
              traceLogger,
              attempt: repairAttempt,
            })
          : await completeMutationRepairAfterNoAction({ adapter, prompt, message, toolResults: preflightToolResults, modelConfig, contextThreshold, traceLogger });
        mutationRepair = repair || mutationRepair;
        if (repair && !repair.ok) {
          mutationRepairProviderFailed = true;
          mutationRepairHistory.push({ attempt: repairAttempt, status: 'provider_failed', failureClass: lastFailure?.failureClass || null, tool: lastFailure?.tool || null, error: repair.error || 'model_failed' });
          break;
        }
        const repairProposal = proposalFromNativeToolCalls(repair?.choice?.toolCalls, repair?.choice?.text ?? '', executionContext) || (repair ? parseActionProposal(repair.choice?.text ?? '') : null);
        const repairReview = reviewProposalActions({ actions: repairProposal?.actions ?? [], workspaceRoot, executionContext });
        const repairExecution = executeProposals && repairProposal
          ? await executeReviewedProposalActions({
              actions: repairProposal.actions,
              reviews: repairReview.reviews,
              workspaceRoot,
              rootDir,
              dataRoot,
              sessionId,
              executionPolicy,
              modelConfig,
                    executionContext,
              traceLogger,
              allowReviewRequired: allowReviewRequiredProposals,
              observedToolResults: [...resolvedToolResults, ...proposalExecution.toolResults, ...mutationExecution.toolResults, ...repairExecutionTotal.toolResults],
                    })
          : { executed: 0, skipped: [], toolResults: [] };

        const failedRepairMutation = failedMutationToolResult(repairExecution.toolResults);
        repairExecutionTotal = {
          executed: repairExecutionTotal.executed + repairExecution.executed,
          skipped: [...(repairExecutionTotal.skipped || []), ...(repairExecution.skipped || [])],
          toolResults: [...repairExecutionTotal.toolResults, ...repairExecution.toolResults],
        };
        mutationRepairHistory.push({
          attempt: repairAttempt,
          status: hasExecutedMutationEvidence(repairExecution.toolResults) ? 'mutation_succeeded' : failedRepairMutation ? 'mutation_tool_failed' : 'no_mutation_action',
          tool: failedRepairMutation?.tool || (proposalHasMutationAction(repairProposal) ? 'mutation' : null),
          failureClass: failedRepairMutation?.failureClass || null,
          error: failedRepairMutation?.error ? String(failedRepairMutation.error).slice(0, 500) : null,
        });
        lastRepairProposal = repairProposal || lastRepairProposal;
        lastRepairReview = repairReview || lastRepairReview;

        if (hasExecutedMutationEvidence(repairExecution.toolResults)) break;
        if (!proposalHasMutationAction(repairProposal) && !hasMutationToolResult(repairExecution.toolResults)) break;

        const nextFailure = failedMutationToolResult(repairExecution.toolResults);
        if (!nextFailure) break;
        lastFailure = nextFailure;
      }

      mutationRepairFailed = !proposalHasMutationAction(lastRepairProposal) && !hasMutationToolResult(repairExecutionTotal.toolResults);
      mutationRepairToolFailed = !hasExecutedMutationEvidence(repairExecutionTotal.toolResults) && (hasFailedMutationToolResult(repairExecutionTotal.toolResults) || mutationRepairProviderFailed);
      mutationProposal = lastRepairProposal || mutationProposal;
      mutationReview = lastRepairReview || mutationReview;
      mutationExecution = {
        executed: mutationExecution.executed + repairExecutionTotal.executed,
        skipped: [...(mutationExecution.skipped || []), ...(repairExecutionTotal.skipped || [])],
        toolResults: [...mutationExecution.toolResults, ...repairExecutionTotal.toolResults],
        mutationRepairHistory,
        mutationRepairProviderFailed,
      };
    }
    proposal = mutationProposal || proposal;
    proposalReview = mutationReview;
    proposalExecution = {
      executed: proposalExecution.executed + mutationExecution.executed,
      skipped: [...(proposalExecution.skipped || []), ...(mutationExecution.skipped || [])],
      toolResults: [...proposalExecution.toolResults, ...mutationExecution.toolResults],
      defaultInspection: proposalExecution.defaultInspection,
      mutationFollowup: true,
      mutationRepair: Boolean(mutationRepair),
      mutationRepairFailed,
      mutationRepairToolFailed,
      mutationRepairProviderFailed: Boolean(mutationExecution.mutationRepairProviderFailed),
      mutationRepairHistory: mutationExecution.mutationRepairHistory || [],
      preflightToolResults,
    };
    resolvedToolResults.push(...mutationExecution.toolResults);
    model = mutationRepair || mutationFollowup || model;
  }

  let inspectionFollowup = null;
  const missingUiEvidenceFallback = targetedUiInspectionMissingFallback({ message, toolResults: proposalExecution.toolResults });
  if (missingTargetFallback) {
    proposal = { ok: true, format: 'plain-text', answerText: missingTargetFallback, actions: [], errors: [], raw: null };
  } else if (missingUiEvidenceFallback) {
    proposal = { ok: true, format: 'plain-text', answerText: missingUiEvidenceFallback, actions: [], errors: [], raw: null };
  } else if (readOnlyInspectionFollowup && shouldFollowReadOnlyInspection({ mode, ok, model, proposalExecution })) {
    let iterations = 0;
    let inspectionNoProgress = false;
    const observedEvidence = new Set();
    recordMaterialProgress(observedEvidence, proposalExecution.toolResults);
    while (inspectionFollowup?.ok !== false && !inspectionNoProgress) {
      iterations += 1;
      const followupPrompt = executedToolResultPrompt({
        basePrompt: prompt.text,
        message,
        toolResults: proposalExecution.toolResults,
        iteration: iterations,
        modelConfig,
        contextThreshold,
      });
      // Continuing inspection keeps the normal full surface; action review and
      // execution policy, not a narrowed tool list, decide what may execute.
      const continuationTools = executionContext?.toolSchemas || nativeToolSchemas();
      inspectionFollowup = await adapter.complete({ ...structuredFollowupInput({ prompt, content: followupPrompt }), tools: continuationTools, toolChoice: 'auto', traceLogger });
      if (!inspectionFollowup?.ok) break;
      const followupProposal = proposalFromNativeToolCalls(inspectionFollowup.choice?.toolCalls, inspectionFollowup.choice?.text ?? '', executionContext) || parseActionProposal(inspectionFollowup.choice?.text ?? '');
      if (!followupProposal?.actions?.length) {
        model = { ...inspectionFollowup, inspectionFollowup: true, initialModel: model };
        proposal = followupProposal;
        break;
      }
      const followupReview = reviewProposalActions({ actions: followupProposal.actions, workspaceRoot, executionContext });
      const followupExecution = executeProposals
        ? await executeReviewedProposalActions({
            actions: followupProposal.actions,
            reviews: followupReview.reviews,
            workspaceRoot,
            rootDir,
            dataRoot,
            sessionId,
            conversationId,
            executionPolicy,
            modelConfig,
                executionContext,
            traceLogger,
            allowReviewRequired: allowReviewRequiredProposals,
            observedToolResults: [...resolvedToolResults, ...proposalExecution.toolResults],
                })
        : { executed: 0, skipped: [], toolResults: [] };
      proposalExecution = {
        ...proposalExecution,
        executed: proposalExecution.executed + followupExecution.executed,
        skipped: [...proposalExecution.skipped, ...followupExecution.skipped],
        toolResults: [...proposalExecution.toolResults, ...followupExecution.toolResults],
        inspectionContinuation: true,
      };
      resolvedToolResults.push(...followupExecution.toolResults);
      // Terminal observations (for example a completed child reported again
      // through status-only tools) add no evidence. Synthesize now rather
      // than treating polling as another continuation opportunity.
      inspectionNoProgress = recordMaterialProgress(observedEvidence, followupExecution.toolResults) === 0;
      proposal = followupProposal;
      proposalReview = followupReview;
      model = inspectionFollowup;
    }
    if (inspectionNoProgress && inspectionFollowup?.ok && inspectionFollowup.choice?.toolCalls?.length) {
      const finalPrompt = finalAnswerAfterToolLoopPrompt({
        basePrompt: prompt.text,
        message,
        toolResults: proposalExecution.toolResults,
        skipped: proposalExecution.skipped,
        modelConfig,
        contextThreshold,
      });
      const finalModel = await adapter.complete({ ...structuredFollowupInput({ prompt, content: finalPrompt }), traceLogger });
      if (finalModel?.ok) {
        const finalProposal = proposalFromNativeToolCalls(finalModel.choice?.toolCalls, finalModel.choice?.text ?? '', executionContext) || parseActionProposal(finalModel.choice?.text ?? '');
        model = { ...finalModel, inspectionFollowup: true, inspectionNoProgress: true, initialModel: model };
        proposal = finalProposal?.actions?.length
          ? { ok: true, format: 'plain-text', answerText: finalModel.choice?.text || 'I collected the available evidence but could not safely complete the final synthesis.', actions: [], errors: [], raw: null }
          : finalProposal;
      } else {
        proposal = { ok: true, format: 'plain-text', answerText: `I collected the available inspection evidence, but the final synthesis failed: ${finalModel?.error || 'model error'}.`, actions: [], errors: [], raw: null };
      }
    } else if (inspectionFollowup && !inspectionFollowup.ok) {
      proposal = { ok: true, format: 'plain-text', answerText: `I inspected the requested local context, but the follow-up answer failed: ${inspectionFollowup.error || 'model error'}.`, actions: [], errors: [], raw: null };
    }
  } else {
    const fallback = pendingInspectionFallback({ proposal, proposalExecution });
    if (fallback) {
      proposal = { ok: true, format: 'plain-text', answerText: fallback, actions: [], errors: [], raw: null };
    }
  }

  return { model, proposal, proposalReview, proposalExecution, toolResults: resolvedToolResults, inspectionFollowup };
}

export async function runVerificationGate({
  ok = true,
  mode = 'dry-run',
  action = 'plan',
  model = null,
  artifacts = [],
  checks = [],
  toolResults = [],
  verifyCommand = null,
  verifyCwd = null,
  workspaceRoot = null,
  rootDir = null,
  traceLogger = null,
} = {}) {
  const resolvedToolResults = [...toolResults];
  if (ok && mode === 'model' && verifyCommand) {
    const verifyReview = reviewProposalActions({ actions: [{ index: 0, tool: 'shell_exec', command: verifyCommand, errors: [] }], workspaceRoot }).reviews[0];
    if (verifyReview.status !== 'allowed') {
      resolvedToolResults.push({ tool: 'shell_exec', ok: false, command: verifyCommand, verificationCheck: true, error: `verify_command_not_allowed:${verifyReview.status}`, safetyReview: verifyReview });
    } else {
      const verifyResult = await runExec({
        command: verifyCommand,
        cwd: verifyCwd || workspaceRoot || rootDir,
        traceLogger,
        artifactPrefix: 'verify-command',
      });
      resolvedToolResults.push(...compactToolReceipts([{ ...verifyResult, verificationCheck: true }]));
    }
  }

  const normalizationRoot = workspaceRoot || rootDir;
  const verificationEvidence = normalizeVerificationEvidence({ artifacts, checks, toolResults: resolvedToolResults, normalizationRoot, baseRoot: rootDir });
  const verification = evaluateVerification({ mode, action, model, verificationEvidence, normalizationRoot, baseRoot: rootDir });
  const modelOk = model?.ok ?? true;
  const verificationOk = verification.ok;
  const decision = !ok
    ? 'blocked'
    : mode !== 'model'
      ? 'ready'
      : !modelOk
        ? 'model_failed'
        : !verificationOk
          ? 'verification_failed'
          : 'answered';

  return {
    toolResults: resolvedToolResults,
    verification,
    modelOk,
    verificationOk,
    decision,
  };
}

function authorizedCommitPathsFromToolResults(toolResults = [], workspaceRoot = null) {
  if (!workspaceRoot) return [];
  const root = path.resolve(workspaceRoot);
  const paths = new Set();
  for (const result of toolResults || []) {
    if (!result?.ok) continue;
    if (result.tool === 'files_write' && result.filePath) paths.add(path.relative(root, path.resolve(result.filePath)));
    if (result.tool === 'files_patch') {
      for (const file of result.touchedFiles || []) {
        const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(result.baseRoot || root, file);
        paths.add(path.relative(root, resolved));
      }
    }
  }
  return [...paths].filter((file) => file && !file.startsWith('..') && !path.isAbsolute(file));
}

function changedPathsFromGitStatus(stdout = '') {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((file) => file.split(' -> ').pop());
}

export async function runCommitGate({
  commitChanges = false,
  ok = true,
  mode = 'dry-run',
  modelOk = true,
  verificationOk = true,
  workspaceRoot = null,
  rootDir = null,
  message = '',
  commitMessage = null,
  toolResults = [],
  traceLogger = null,
} = {}) {
  let commit = null;
  if (commitChanges && ok && mode === 'model' && modelOk && verificationOk) {
    if (!workspaceRoot) {
      commit = { ok: false, skipped: true, reason: 'git_context_required' };
    } else {
      const status = await runExec({
        command: 'git status --short',
        cwd: workspaceRoot,
        traceLogger,
        artifactPrefix: 'commit-status-before',
      });
      const authorizedPaths = authorizedCommitPathsFromToolResults(toolResults, workspaceRoot);
      const changedPaths = changedPathsFromGitStatus(status.stdout);
      const unauthorizedPaths = changedPaths.filter((file) => !authorizedPaths.includes(file));
      if (!status.stdout.trim()) {
        commit = { ok: true, skipped: true, reason: 'no_changes', status, authorizedPaths };
      } else if (!authorizedPaths.length) {
        commit = { ok: false, skipped: true, reason: 'no_authorized_commit_paths', status, authorizedPaths, unauthorizedPaths: changedPaths };
      } else if (unauthorizedPaths.length) {
        commit = { ok: false, skipped: true, reason: 'unauthorized_dirty_paths', status, authorizedPaths, unauthorizedPaths };
      } else {
        const add = await runExec({
          command: `git add -- ${authorizedPaths.map((file) => JSON.stringify(file)).join(' ')}`,
          cwd: workspaceRoot,
          traceLogger,
          artifactPrefix: 'commit-git-add',
        });
        const resolvedCommitMessage = commitMessage || `Burrow verified changes: ${String(message || 'model run').slice(0, 80)}`;
        const commitResult = add.ok ? await runExec({
          command: `git commit -m ${JSON.stringify(resolvedCommitMessage)}`,
          cwd: workspaceRoot,
          env: {
            GIT_AUTHOR_NAME: 'Burrow',
            GIT_AUTHOR_EMAIL: 'burrow@example.invalid',
            GIT_COMMITTER_NAME: 'Burrow',
            GIT_COMMITTER_EMAIL: 'burrow@example.invalid',
          },
          traceLogger,
          artifactPrefix: 'commit-git-commit',
        }) : null;
        commit = { ok: Boolean(add.ok && commitResult?.ok), skipped: false, reason: add.ok ? null : 'git_add_failed', status, add, commit: commitResult, authorizedPaths };
      }
    }
  } else if (commitChanges) {
    commit = { ok: false, skipped: true, reason: verificationOk ? 'not_committable' : 'verification_failed' };
  }

  return {
    commit,
    commitOk: commitChanges ? Boolean(commit?.ok) : true,
    decisionOverride: commitChanges && !commit?.ok ? 'commit_failed' : null,
  };
}

export async function runRuntimeTurn({
  runtimeTurn,
  branch = 'plain-model',
  plainModelTurn = {},
  workLoopTurn = {},
} = {}) {
  assertRuntimeTurnContract(runtimeTurn);
  if (branch === 'work-loop') {
    const result = await runWorkLoopTurn(workLoopTurn);
    return { ...result, branch, runtimeTurn };
  }
  if (branch !== 'plain-model') throw new Error(`unsupported runtime turn branch: ${branch}`);
  const result = await runPlainModelTurn(plainModelTurn);
  return { ...result, branch, runtimeTurn };
}


function hasNativeToolCalls(model = null) {
  return Boolean(model?.ok && Array.isArray(model.choice?.toolCalls) && model.choice.toolCalls.length);
}

function compactToolCalls(toolCalls = []) {
  return (toolCalls || []).map((call, index) => ({
    id: String(call?.id || `tool-call-${index}`).slice(0, 256),
    name: call?.name ? String(call.name).slice(0, 256) : null,
    // This is a receipt projection only. The original provider calls remain
    // available to the executor for this iteration; no tool is rejected or
    // skipped because its retained representation was compacted.
    arguments: boundedToolArgumentValue(call?.arguments || {}),
  }));
}

function compactSkippedToolActions(skipped = []) {
  return (skipped || []).map((item) => ({
    index: item.index ?? null,
    tool: item.tool || null,
    status: item.status || 'not_executed',
  }));
}

function compactLoopProposal(proposal = null) {
  if (!proposal) return null;
  return {
    ok: Boolean(proposal.ok),
    format: proposal.format || null,
    answerText: typeof proposal.answerText === 'string' ? proposal.answerText.slice(0, 4_000) : '',
    actions: (proposal.actions || []).slice(0, 32).map((action) => boundedToolArgumentValue(action)),
    errors: (proposal.errors || []).slice(0, 32).map((error) => String(error).slice(0, 1_000)),
  };
}

function compactLoopProposalReview(proposalReview = null) {
  if (!proposalReview) return null;
  return {
    ok: Boolean(proposalReview.ok),
    counts: boundedToolArgumentValue(proposalReview.counts || {}),
    reviews: (proposalReview.reviews || []).slice(0, 32).map((review) => ({
      index: review?.index ?? null,
      tool: review?.tool || null,
      status: review?.status || null,
      risk: (review?.risk || []).slice(0, 16).map((item) => String(item).slice(0, 256)),
      blockers: (review?.blockers || []).slice(0, 16).map((item) => String(item).slice(0, 1_000)),
      warnings: (review?.warnings || []).slice(0, 16).map((item) => String(item).slice(0, 1_000)),
    })),
  };
}

function ownershipMetrics(value) {
  return inspectRuntimeObject(value, { nodeBudget: 5_000, estimatedCharBudget: 2_000_000, stringSampleChars: 8_000 });
}

function skippedToolSummary(skipped = []) {
  const compact = compactSkippedToolActions(skipped);
  if (!compact.length) return '';
  return compact.map((item) => `- NOT EXECUTED: ${item.tool || 'tool'}${item.index === null ? '' : ` #${item.index}`} (${item.status})`).join('\n');
}

function allSkippedChatTools(chatToolLoop = {}) {
  return chatToolLoop.skipped || (chatToolLoop.iterations || []).flatMap((iteration) => iteration.proposalExecution?.skipped || []);
}

function skippedMutationOrUnverifiedExec(skipped = []) {
  return (skipped || []).filter((item) => ['files_write', 'files_patch'].includes(String(item.tool || '')));
}

function hasExecutedMutationEvidence(toolResults = []) {
  return (toolResults || []).some((result) => result?.ok === true && ['files_write', 'files_patch'].includes(String(result.tool || '')));
}

function mutationNotExecutedAnswer({ skipped = [], toolResults = [] } = {}) {
  const skippedMutations = skippedMutationOrUnverifiedExec(skipped);
  if (!skippedMutations.length || hasExecutedMutationEvidence(toolResults)) return null;
  const skippedText = skippedToolSummary(skippedMutations);
  const readOnlyCount = (toolResults || []).filter((result) => result?.ok === true && result?.tool === 'files_read').length;
  return [
    'I did not edit the file.',
    'A mutation tool call was requested but was NOT EXECUTED. Inspect the recorded skipped-tool receipt for its structural or configured hard-block reason.',
    skippedText,
    readOnlyCount ? `I only executed ${readOnlyCount} read-only inspection tool${readOnlyCount === 1 ? '' : 's'}.` : null,
  ].filter(Boolean).join('\n\n');
}

function executedToolResultPrompt({ basePrompt = '', message = '', toolResults = [], skipped = [], toolCalls = [], iteration = 1, runtimeNotice = null, modelConfig = null, contextThreshold = null } = {}) {
  const callSummary = compactToolCalls(toolCalls).map((call) => `${call.name} ${stableJson(call.arguments)}`).join('\n');
  const skippedSummary = skippedToolSummary(skipped);
  const buildPrompt = (evidence = '') => [
    basePrompt, '',
    'A bounded chat tool loop is in progress. The tools offered to you are executable. Infer capability from the offered tool surface and actual receipts only.',
    'Use the executed tool results below as local evidence. If more local action is required, call one of the available tools. Otherwise answer the user directly now.',
    runtimeNotice ? `\n${runtimeNotice}` : null,
    'Do not invent filesystem facts. Do not describe JSON command blobs as if they were executed.',
    'User request:', message, '', `Executed chat tool iteration ${iteration}:`, callSummary || '(no call summary)', '',
    'Executed tool results:', evidence || '(no executed continuation evidence)', '',
    'Skipped / not executed tool calls:', skippedSummary || '(none)', '',
    'Truth constraint: never describe a skipped tool call as completed. If a requested edit/write/append/change was skipped or lacks executed mutation evidence, say the file was NOT edited.',
  ].filter(Boolean).join('\n');
  const evidence = serializeContinuationEvidence({ toolResults, modelConfig, contextThreshold, tools: nativeToolSchemas(), buildPrompt });
  return buildPrompt(evidence);
}

function finalAnswerAfterToolLoopPrompt({ basePrompt = '', message = '', toolResults = [], skipped = [], runtimeNotice = null, modelConfig = null, contextThreshold = null } = {}) {
  const skippedSummary = skippedToolSummary(skipped);
  const buildPrompt = (evidence = '') => [
    basePrompt, '',
    'The bounded chat tool loop has ended. Answer the user directly using only the executed tool evidence below and the conversation context.',
    runtimeNotice || null,
    'If the evidence is insufficient, say exactly what is missing. Do not ask the user to paste files that you already tried to inspect.',
    'Never describe skipped tool calls as completed. If a requested edit/write/append/change was skipped or lacks executed mutation evidence, say the file was NOT edited.',
    '', 'User request:', message, '', 'Executed tool evidence:', evidence || '(no executed continuation evidence)', '',
    'Skipped / not executed tool calls:', skippedSummary || '(none)',
  ].filter(Boolean).join('\n');
  const evidence = serializeContinuationEvidence({ toolResults, modelConfig, contextThreshold, buildPrompt });
  return buildPrompt(evidence);
}

async function executeChatToolCalls({ model, workspaceRoot = null, rootDir = null, dataRoot = null, sessionId = null, conversationId = null, iteration = 0, traceLogger = null, executionPolicy = null, modelConfig = null, executionContext = null, abortSignal = null } = {}) {
  const proposal = proposalFromNativeToolCalls(model?.choice?.toolCalls, model?.choice?.text ?? '', executionContext);
  const proposalReview = reviewProposalActions({ actions: proposal?.actions ?? [], workspaceRoot, executionContext });
  const proposalExecution = proposal
    ? await executeReviewedProposalActions({
        actions: proposal.actions,
        reviews: proposalReview.reviews,
        workspaceRoot,
        rootDir,
        dataRoot,
        sessionId,
        conversationId,
        executionPolicy,
        modelConfig,
        executionContext,
        traceLogger,
        artifactPrefix: `chat-${iteration}`,
        allowReviewRequired: false,
        observedToolResults: [],
          abortSignal,
      })
    : { executed: 0, skipped: [], toolResults: [] };
  const resultsByAllowedAction = new Map();
  let resultIndex = 0;
  for (const action of proposal?.actions || []) {
    const review = proposalReview.reviews.find((item) => item.index === action.index);
    if (review?.status === 'allowed') resultsByAllowedAction.set(action.index, (proposalExecution.nativeToolResults || proposalExecution.toolResults)[resultIndex++] || null);
  }
  // Provider-native transcripts require one output for every input call. A
  // malformed or policy-denied call is a failed tool result, not a missing
  // result or a terminal human-facing pseudo-blocker. That lets the model
  // correct its arguments on the next turn.
  const callResults = (model?.choice?.toolCalls || []).map((call, index) => {
    const action = proposal?.actions?.find((item) => item.index === index) || null;
    const review = proposalReview.reviews.find((item) => item.index === index) || null;
    const executedResult = resultsByAllowedAction.get(index);
    if (executedResult) return executedResult;
    const reasons = review?.blockers?.length ? review.blockers : (action?.errors?.length ? action.errors : ['tool_call_not_executed']);
    return {
      tool: call?.name || action?.tool || null,
      ok: false,
      status: review?.status || 'not_executed',
      failureClass: action?.errors?.length ? 'invalid_tool_arguments' : 'tool_not_executed',
      error: reasons.join(', '),
      validationErrors: reasons,
      callId: call?.id || null,
    };
  });
  return { proposal, proposalReview, proposalExecution, toolCalls: model?.choice?.toolCalls || [], callResults };
}

function isImageAttachment(attachment = {}) {
  const type = String(attachment.type || attachment.mimeType || '').toLowerCase();
  const content = String(attachment.content || '').toLowerCase();
  return type.startsWith('image/') || content.startsWith('data:image/');
}

function modelSupportsVision({ modelConfig = null, modelAdapter = null } = {}) {
  if (modelAdapter?.supportsVision !== undefined) return Boolean(modelAdapter.supportsVision);
  const capabilities = modelConfig?.capabilities || {};
  return Boolean(modelConfig?.supportsVision || modelConfig?.vision || modelConfig?.multimodal || capabilities.vision || capabilities.images);
}

function compactImageAttachment(attachment = {}, index = 0) {
  return {
    index,
    name: String(attachment.name || `image-${index + 1}`),
    type: String(attachment.type || attachment.mimeType || 'image/*'),
    size: attachment.size ?? null,
    dataUrl: String(attachment.content || ''),
  };
}

function imageAttachments(attachments = []) {
  return attachments.filter(isImageAttachment).map(compactImageAttachment).filter((attachment) => attachment.dataUrl.startsWith('data:image/'));
}

function messageTextContent(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(messageTextContent).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';
  const type = String(value.type || '').toLowerCase();
  if (type === 'image_url' || type === 'input_image' || value.image_url || value.input_image) return '';
  return messageTextContent(value.text ?? value.content ?? value.message ?? value.output);
}

function imageFallbackPrompt(promptText, images = []) {
  if (!images.length) return promptText;
  const lines = images.map((image, index) => `- ${image.name || `image-${index + 1}`} (${image.type || 'image/*'}, ${image.size ?? 'unknown'} bytes)`);
  return `${promptText}\n\n# Image attachments\n\n${images.length} image attachment${images.length === 1 ? ' was' : 's were'} provided, but the selected model profile does not advertise vision support. Ask the user to switch to a vision-capable profile if image contents matter.\n${lines.join('\n')}`;
}

function multimodalUserMessages(promptText, images = [], baseMessages = []) {
  return [...baseMessages, {
    role: 'user',
    content: [
      { type: 'text', text: promptText },
      ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
    ],
  }];
}

function modelInputForPlainTurn({ promptText, promptMessages = null, attachments = [], modelConfig = null, modelAdapter = null } = {}) {
  const images = imageAttachments(attachments);
  const messages = Array.isArray(promptMessages) && promptMessages.length ? promptMessages : null;
  if (!images.length) return { prompt: messages ? null : promptText, messages, imageCount: 0, images, vision: false, fallback: false };
  if (modelSupportsVision({ modelConfig, modelAdapter })) {
    // Images belong to the current request, not every historical user turn.
    // Keep prior user/assistant roles intact and make only the final user
    // message multimodal. Collapsing every user message into one image prompt
    // destroys the dialogue shape that the provider uses for continuity.
    if (messages) {
      const lastUserIndex = messages.reduce((latest, entry, index) => entry?.role === 'user' ? index : latest, -1);
      if (lastUserIndex >= 0) {
        const multimodalMessages = messages.map((entry, index) => index === lastUserIndex ? {
          ...entry,
          content: [
            { type: 'text', text: messageTextContent(entry.content) },
            ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
          ],
        } : entry);
        return { prompt: null, messages: multimodalMessages, stableMessages: messages.slice(0, lastUserIndex), imageCount: images.length, images, vision: true, fallback: false };
      }
    }
    return { prompt: null, messages: multimodalUserMessages(promptText, images), stableMessages: [], imageCount: images.length, images, vision: true, fallback: false };
  }
  if (messages) {
    const last = messages.length - 1;
    return { prompt: null, messages: messages.map((entry, index) => index === last && entry.role === 'user' ? { ...entry, content: imageFallbackPrompt(String(entry.content || ''), images) } : entry), imageCount: images.length, images, vision: false, fallback: true };
  }
  return { prompt: imageFallbackPrompt(promptText, images), messages: null, imageCount: images.length, images, vision: false, fallback: true };
}

function modelInputForFollowupPrompt(promptText, baseModelInput = null) {
  // Compatibility follow-ups still describe a bounded evidence window in prose,
  // but they must not discard the canonical role-structured request that led to
  // it. Keep the stable prefix and dialogue as messages, then append one
  // synthesized current user instruction. This gives fallback/final-synthesis
  // calls the same normalizer and manifest path as normal and vision requests.
  if (baseModelInput?.vision) return { prompt: null, messages: multimodalUserMessages(promptText, baseModelInput.images || [], baseModelInput.stableMessages || []) };
  if (Array.isArray(baseModelInput?.messages) && baseModelInput.messages.length) {
    return {
      prompt: null,
      messages: normalizeProviderMessages([
        ...baseModelInput.messages,
        { role: 'user', content: promptText },
      ]),
    };
  }
  return { prompt: promptText, messages: null };
}

export async function runPlainModelTurn({
  prompt,
  message = '',
  shouldCallModel = true,
  modelConfig = null,
  contextThreshold = null,
  modelAdapter = null,
  traceLogger = null,
  workspaceRoot = null,
  rootDir = null,
  dataRoot = null,
  sessionId = null,
  conversationId = null,
  enableChatToolLoop = false,
  stopOnNoProgress = false,
  loopWarningThreshold = 2,
  loopBlockThreshold = 3,
  authorityDecision = null,
  executionPolicy: executionPolicyInput = null,
  abortSignal = null,
  attachments = [],
  executionContext = null,
  onTextDelta = null,
  onThoughtDelta = null,
  onContextUsage = null,
} = {}) {
  if (!prompt?.text) throw new Error('prompt.text is required');
  if (!shouldCallModel) {
    return {
      model: null,
      proposal: null,
      answerText: null,
      chatToolLoop: { enabled: false, iterations: [], toolResults: [] },
      runtime: createRuntimeTurnResult({ blocker: 'model_not_called', metadata: { calledModel: false } }),
    };
  }

  let model = null;
  // Defined outside the provider-call setup so failed/no-callback turns still
  // return a harmless null meter value.
  let peakContextUsage = null;
  let modelInput = modelInputForPlainTurn({ promptText: prompt.text, promptMessages: prompt.modelMessages, attachments, modelConfig, modelAdapter });
  // Responses chains server-side by response ID. Chat Completions needs this
  // local, provider-native transcript so prior call/result pairs survive.
  let nativeTranscript = null;
  const executionPolicy = normalizeExecutionPolicyInput(executionPolicyInput || authorityDecision);
  const executionToolSchemas = executionContext?.toolSchemas || nativeToolSchemas();
  let closePeerExchangeAfterReply = false;
  const continuationToolSchemas = () => closePeerExchangeAfterReply
    ? executionToolSchemas.filter((tool) => tool?.function?.name !== 'agent_send_message')
    : executionToolSchemas;
  // Execution is not capped by history. These are bounded receipts only; raw
  // tool output lives in artifacts and the current evidence window, so a model
  // that keeps selecting tools cannot retain an ever-growing heap.
  const chatToolLoop = {
    enabled: Boolean(enableChatToolLoop),
    stopOnNoProgress: Boolean(stopOnNoProgress),
    loopWarningThreshold,
    loopBlockThreshold,
    iterations: [],
    toolResults: [],
    skipped: [],
    loopWarnings: [],
    terminal: null,
    omittedIterations: 0,
    omittedToolResults: 0,
    semanticInspectionStalls: [],
  };
  const promptEvidenceResults = [];
  const completedToolCallHistory = [];
  try {
    const adapter = modelAdapter || createModelAdapter({ config: modelConfig || {} });
    const toolArgs = enableChatToolLoop ? { tools: continuationToolSchemas(), toolChoice: 'auto' } : {};
    modelInput = modelInputForPlainTurn({ promptText: prompt.text, promptMessages: prompt.modelMessages, attachments, modelConfig, modelAdapter: adapter });
    if (abortSignal?.aborted) throw abortSignal.reason || new Error('agent_stopped');
    await logChatToolLoopHeapStage(traceLogger, 'chat-tool-loop-before-model-call', {
      iteration: 0,
      modelInput,
      chatToolLoop,
      promptEvidenceResults,
    });
    let modelCall = 0;
    const withModelCall = (callback) => typeof callback === 'function'
      ? async (event) => callback({ ...event, modelCall })
      : null;
    const emitTextDelta = withModelCall(onTextDelta);
    const emitThoughtDelta = withModelCall(onThoughtDelta);
    // A terminal synthesis request is intentionally small. Keep the largest
    // actual request from this run as the completed-session meter instead of
    // letting that final answer overwrite the tool-loop high-water mark.
    const emitContextUsage = typeof onContextUsage === 'function'
      ? async (event) => {
          const usage = { ...event, modelCall };
          if (!peakContextUsage || Number(usage.estimatedTokens) >= Number(peakContextUsage.estimatedTokens)) peakContextUsage = usage;
          await onContextUsage(usage);
        }
      : null;
    modelCall += 1;
    model = await adapter.complete({ prompt: modelInput.prompt || (modelInput.vision ? undefined : prompt.text), messages: modelInput.messages || undefined, traceLogger, signal: abortSignal || undefined, ...(emitTextDelta ? { onTextDelta: emitTextDelta } : {}), ...(emitThoughtDelta ? { onThoughtDelta: emitThoughtDelta } : {}), ...(emitContextUsage ? { onContextUsage: emitContextUsage, modelCall } : {}), ...toolArgs });
    nativeTranscript = modelInput.messages || [{ role: 'user', content: modelInput.prompt || prompt.text }];
    await logChatToolLoopHeapStage(traceLogger, 'chat-tool-loop-after-model-response', {
      iteration: 0,
      model,
      chatToolLoop,
      promptEvidenceResults,
    });

    let iteration = 0;
    let toolLoopNoProgress = false;
    let terminalLoopVerdict = null;
    let pendingLoopWarning = null;
    const observedEvidence = new Set();
    const semanticInspectionHistory = new Map();
    while (enableChatToolLoop && hasNativeToolCalls(model) && (!stopOnNoProgress || !toolLoopNoProgress)) {
      const loopVerdict = exactRepeatVerdict(model.choice.toolCalls, completedToolCallHistory, { loopWarningThreshold, loopBlockThreshold });
      if (loopVerdict?.action === 'block') {
        terminalLoopVerdict = loopVerdict;
        chatToolLoop.terminal = {
          outcome: 'loop_blocked',
          actor: 'runtime',
          detector: 'identical_tool_call_and_result',
          tool: loopVerdict.tool,
          attemptedCount: loopVerdict.attemptedCount,
          repeatedCompletedCalls: loopVerdict.repeatedCompletedCalls,
          callFingerprint: loopVerdict.callFingerprint,
        };
        await traceLogger?.event?.('chat-tool-loop-blocked', chatToolLoop.terminal);
        break;
      }
      pendingLoopWarning = loopVerdict?.action === 'warn' ? loopVerdict : null;
      iteration += 1;
      const toolObservations = repeatedToolCallObservations(model.choice.toolCalls, chatToolLoop.iterations);
      await traceLogger?.event?.('chat-tool-loop-observation', {
        iteration,
        planFingerprint: toolPlanFingerprint(model.choice.toolCalls),
        calls: toolObservations,
        repeatedCalls: toolObservations.filter((item) => item.repeatCount > 1).length,
      });
      // Full tool results have one short-lived owner: this iteration. Build all
      // retained state from compact receipts before the native continuation, then
      // release both the executor envelope and raw result graph immediately after
      // the adapter has serialized the paired provider continuation.
      let executed = await executeChatToolCalls({ model, workspaceRoot, rootDir, dataRoot, sessionId, conversationId, iteration, traceLogger, executionPolicy, modelConfig, executionContext, abortSignal });
      let rawToolResults = executed.callResults || [];
      const nativeToolCalls = executed.toolCalls;
      const compactCalls = compactToolCalls(model.choice.toolCalls);
      const compactResults = rawToolResults.map((result) => compactPromptEvidenceResult(result));
      const resultSummaries = summarizeToolResults(rawToolResults);
      const proposal = executed.proposal;
      const proposalReview = executed.proposalReview;
      const skipped = compactSkippedToolActions(executed.proposalExecution.skipped || []);
      const compactExecution = {
        executed: executed.proposalExecution?.executed ?? resultSummaries.length,
        skipped,
        toolResults: resultSummaries,
        defaultInspection: Boolean(executed.proposalExecution?.defaultInspection),
      };
      const compactProposal = compactLoopProposal(proposal);
      const compactProposalReview = compactLoopProposalReview(proposalReview);
      const semanticObservations = semanticInspectionObservations(compactCalls, semanticInspectionHistory);
      compactCalls.forEach((call, index) => {
        const result = rawToolResults[index];
        if (!result) return;
        appendBoundedChatHistory(completedToolCallHistory, {
          callFingerprint: fingerprint({ name: call.name, arguments: call.arguments }),
          outcomeFingerprint: fingerprint(normalizedToolOutcome(result)),
        }, CHAT_TOOL_CALL_HISTORY_LIMIT, 'omittedCompletedToolCalls');
      });
      await traceLogger?.event?.('chat-tool-loop-ownership', {
        iteration,
        rawToolResults: {
          count: rawToolResults.length,
          directTextChars: rawToolResults.reduce((sum, result) => sum + ['content', 'stdout', 'stderr', 'summary', 'preview', 'error'].reduce((inner, key) => inner + (typeof result?.[key] === 'string' ? result[key].length : 0), 0), 0),
        },
        compactResults: ownershipMetrics(compactResults),
        resultSummaries: ownershipMetrics(resultSummaries),
        compactProposal: ownershipMetrics(compactProposal),
        compactProposalReview: ownershipMetrics(compactProposalReview),
        compactExecution: ownershipMetrics(compactExecution),
      });
      await logChatToolLoopHeapStage(traceLogger, 'chat-tool-loop-after-tool-subagent-result', {
        iteration,
        model,
        toolResults: resultSummaries,
        chatToolLoop,
        promptEvidenceResults,
      });
      appendBoundedChatHistory(chatToolLoop.iterations, {
        iteration,
        toolCalls: compactCalls,
        proposal: compactProposal,
        proposalReview: compactProposalReview,
        proposalExecution: compactExecution,
      }, CHAT_TOOL_HISTORY_LIMIT, 'omittedIterations');
      chatToolLoop.omittedIterations = chatToolLoop.iterations.omittedIterations || 0;
      for (const item of skipped) appendBoundedChatHistory(chatToolLoop.skipped, item, CHAT_TOOL_HISTORY_LIMIT, 'omittedSkipped');
      for (const result of resultSummaries) appendBoundedChatHistory(chatToolLoop.toolResults, result, CHAT_TOOL_RESULT_HISTORY_LIMIT, 'omittedToolResults');
      chatToolLoop.omittedToolResults = chatToolLoop.toolResults.omittedToolResults || 0;
      for (const result of compactResults) appendBoundedChatHistory(promptEvidenceResults, result, CHAT_TOOL_HISTORY_LIMIT, 'omittedPromptEvidenceResults');
      chatToolLoop.omittedPromptEvidenceResults = promptEvidenceResults.omittedPromptEvidenceResults || 0;
      if (rawToolResults.some((result) => result?.tool === 'agent_send_message' && result?.messageMode === 'request_reply_complete' && result?.reply?.ok)) {
        closePeerExchangeAfterReply = true;
      }
      const noMaterialProgress = recordMaterialProgress(observedEvidence, rawToolResults) === 0;
      const semanticStalls = semanticObservations.filter((item) => item.count >= 3);
      for (const stall of semanticStalls) {
        const diagnostic = { iteration, ...stall, materialProgress: !noMaterialProgress };
        appendBoundedChatHistory(chatToolLoop.semanticInspectionStalls, diagnostic, 32, 'omittedSemanticInspectionStalls');
        await traceLogger?.event?.('chat-tool-loop-semantic-inspection-stall', diagnostic);
      }
      toolLoopNoProgress = Boolean((stopOnNoProgress && noMaterialProgress) || terminalLoopVerdict?.action === 'block');
      await traceLogger?.event?.('chat-tool-loop-evidence-window', {
        iteration,
        planFingerprint: toolPlanFingerprint(model.choice.toolCalls),
        materialProgress: !noMaterialProgress,
        toolResultCount: promptEvidenceResults.length,
        projectionAuthority: 'continuation_evidence_provider_budget',
      });
      await logChatToolLoopHeapStage(traceLogger, 'chat-tool-loop-after-iteration-state-commit', {
        iteration,
        model,
        chatToolLoop,
        promptEvidenceResults,
      });

      const warningNotice = pendingLoopWarning ? loopReceiptText(pendingLoopWarning) : null;
      if (pendingLoopWarning) {
        const warning = {
          outcome: 'loop_warning',
          actor: 'runtime',
          detector: 'identical_tool_call_and_result',
          tool: pendingLoopWarning.tool,
          attemptedCount: pendingLoopWarning.attemptedCount,
          repeatedCompletedCalls: pendingLoopWarning.repeatedCompletedCalls,
          callFingerprint: pendingLoopWarning.callFingerprint,
        };
        chatToolLoop.loopWarnings.push(warning);
        await traceLogger?.event?.('chat-tool-loop-warning', warning);
      }
      const followupPrompt = toolLoopNoProgress
        ? finalAnswerAfterToolLoopPrompt({ basePrompt: prompt.text, message, toolResults: promptEvidenceResults, skipped: chatToolLoop.skipped, modelConfig, contextThreshold })
        : executedToolResultPrompt({ basePrompt: prompt.text, message, toolResults: promptEvidenceResults, skipped: chatToolLoop.skipped, toolCalls: model.choice.toolCalls, iteration, runtimeNotice: warningNotice, modelConfig, contextThreshold });
      // Native continuations preserve the provider's assistant function call ↔
      // function output pairing. The prose receipt prompt remains a compatibility
      // fallback for adapters that do not implement this capability and for the
      // explicit tool-less final synthesis path.
      const useNativeContinuation = !toolLoopNoProgress && typeof adapter.continueWithToolResults === 'function';
      const followupInput = useNativeContinuation ? null : modelInputForFollowupPrompt(followupPrompt, modelInput);
      await logChatToolLoopHeapStage(traceLogger, 'chat-tool-loop-after-continuation-prompt-build', { iteration, followupPrompt: useNativeContinuation ? '[provider-native tool continuation]' : followupPrompt, followupInput, chatToolLoop, promptEvidenceResults });
      if (abortSignal?.aborted) throw abortSignal.reason || new Error('agent_stopped');
      await logChatToolLoopHeapStage(traceLogger, 'chat-tool-loop-before-model-call', { iteration, followupInput, chatToolLoop, promptEvidenceResults });
      modelCall += 1;
      const nativeContinuation = useNativeContinuation
        ? prepareNativeToolContinuation({
            baseMessages: normalizeProviderMessages(nativeTranscript),
            toolCalls: nativeToolCalls,
            toolResults: rawToolResults,
            modelConfig,
            tools: continuationToolSchemas(),
          })
        : null;
      if (nativeContinuation?.compacted) await traceLogger?.event?.('native-continuation-prepared', {
        compacted: true,
        estimatedTokens: nativeContinuation.inspection?.estimatedTokens ?? null,
        contextTokens: nativeContinuation.inspection?.contextTokens ?? null,
      });
      model = useNativeContinuation
        ? await adapter.continueWithToolResults({
            previousModel: model,
            baseMessages: normalizeProviderMessages(nativeTranscript),
            toolCalls: nativeToolCalls,
            toolResults: rawToolResults,
            preparedMessages: nativeContinuation.messages,
            tools: continuationToolSchemas(),
            toolChoice: 'auto',
            traceLogger,
            signal: abortSignal || undefined,
            ...(emitTextDelta ? { onTextDelta: emitTextDelta } : {}),
            ...(emitThoughtDelta ? { onThoughtDelta: emitThoughtDelta } : {}),
            ...(emitContextUsage ? { onContextUsage: emitContextUsage, modelCall } : {}),
          })
        : await adapter.complete({
            prompt: followupInput.prompt || undefined,
            messages: followupInput.messages || undefined,
            ...(toolLoopNoProgress ? {} : { tools: continuationToolSchemas(), toolChoice: 'auto' }),
            traceLogger,
            signal: abortSignal || undefined,
            ...(emitTextDelta ? { onTextDelta: emitTextDelta } : {}),
            ...(emitThoughtDelta ? { onThoughtDelta: emitThoughtDelta } : {}),
            ...(emitContextUsage ? { onContextUsage: emitContextUsage, modelCall } : {}),
          });
      // The adapter has now transformed raw results into bounded native receipts.
      // Do not let the executor envelope or original tool graph survive into the
      // next iteration through loop state, diagnostics, or closures.
      rawToolResults = null;
      executed = null;
      if (useNativeContinuation && Array.isArray(model?.nativeTranscript)) {
        nativeTranscript = normalizeProviderMessages([
          ...model.nativeTranscript.filter((entry) => {
            const content = String(entry?.content || '');
            return true;
          }),
        ]);
      }
      await logChatToolLoopHeapStage(traceLogger, 'chat-tool-loop-after-model-response', {
        iteration,
        model,
        chatToolLoop,
        promptEvidenceResults,
      });
    }

    if (toolLoopNoProgress) chatToolLoop.noProgress = true;
    if (terminalLoopVerdict && !chatToolLoop.terminal) {
      chatToolLoop.terminal = {
        outcome: 'loop_blocked',
        actor: 'runtime',
        detector: 'identical_tool_call_and_result',
        tool: terminalLoopVerdict.tool,
        attemptedCount: terminalLoopVerdict.attemptedCount,
        repeatedCompletedCalls: terminalLoopVerdict.repeatedCompletedCalls,
        callFingerprint: terminalLoopVerdict.callFingerprint,
      };
    }
    if (terminalLoopVerdict) {
      const finalPrompt = finalAnswerAfterToolLoopPrompt({
        basePrompt: prompt.text,
        message,
        toolResults: promptEvidenceResults,
        skipped: chatToolLoop.skipped,
        runtimeNotice: loopReceiptText(terminalLoopVerdict, { terminal: true }),
        modelConfig,
        contextThreshold,
      });
      const finalInput = modelInputForFollowupPrompt(finalPrompt, modelInput);
      if (abortSignal?.aborted) throw abortSignal.reason || new Error('agent_stopped');
      modelCall += 1;
      model = await adapter.complete({
        prompt: finalInput.prompt || undefined,
        messages: finalInput.messages || undefined,
        traceLogger,
        signal: abortSignal || undefined,
        ...(emitTextDelta ? { onTextDelta: emitTextDelta } : {}),
        ...(emitThoughtDelta ? { onThoughtDelta: emitThoughtDelta } : {}),
        ...(emitContextUsage ? { onContextUsage: emitContextUsage, modelCall } : {}),
      });
    }

  } catch (error) {
    model = { ok: false, error: String(error?.message || error), usage: null, choice: { text: '' } };
  }

  const proposal = model ? parseActionProposal(model.choice?.text ?? '') : null;
  const skipped = allSkippedChatTools(chatToolLoop);
  const answerText = proposal?.answerText ?? null;
  const runtime = createRuntimeTurnResult({
    finalText: answerText || '',
    blocker: model?.ok ? null : (model?.error || 'model_failed'),
    evidence: chatToolLoop.toolResults,
    sideChannels: [{ type: 'receipt', content: { modelOk: model?.ok ?? null, proposedActions: proposal?.actions?.length ?? 0, chatToolCalls: chatToolLoop.iterations.reduce((sum, item) => sum + item.toolCalls.length, 0), executedChatTools: chatToolLoop.toolResults.length, terminal: chatToolLoop.terminal } }],
    metadata: { calledModel: true, modelUsage: model?.usage ?? null, attachments: { images: modelInput.imageCount || 0, visionUsed: Boolean(modelInput.vision), visionFallback: Boolean(modelInput.fallback) }, chatToolLoop: { enabled: chatToolLoop.enabled, iterations: chatToolLoop.iterations.length, toolResults: chatToolLoop.toolResults.length, noProgress: Boolean(chatToolLoop.noProgress), loopWarnings: chatToolLoop.loopWarnings.length, terminal: chatToolLoop.terminal, semanticInspectionStalls: chatToolLoop.semanticInspectionStalls.length, omittedPromptEvidenceResults: chatToolLoop.omittedPromptEvidenceResults || 0 } },
  });

  return { model, proposal, answerText, chatToolLoop, contextUsage: peakContextUsage || model?.contextUsage || null, runtime };
}

export const __test__ = Object.freeze({
  boundedToolArgumentValue,
  stableJson,
  fingerprint,
  toolPlanFingerprint,
  compactToolCalls,
  executedToolResultPrompt,
});

export async function runWorkLoopTurn(args = {}) {
  const { runBurrow } = await import('./runner.mjs');
  const workResult = await runBurrow(args);
  return {
    workResult,
    runtime: createRuntimeTurnResult({
      finalText: workResult.answerText || '',
      blocker: workResult.decision === 'blocked' ? (workResult.blockers || []).join(', ') || 'blocked' : null,
      evidence: workResult.proposalExecution?.toolResults || [],
      sideChannels: [
        { type: 'receipt', content: { decision: workResult.decision, runId: workResult.runId } },
        ...(workResult.verification ? [{ type: 'debug', content: { verification: workResult.verification } }] : []),
      ],
      metadata: {
        decision: workResult.decision,
        proposedActions: workResult.proposedActions?.length ?? 0,
        executedActions: workResult.proposalExecution?.executed ?? 0,
        defaultInspection: Boolean(workResult.proposalExecution?.defaultInspection),
        commit: workResult.commit ? { ok: workResult.commit.ok, skipped: workResult.commit.skipped, reason: workResult.commit.reason } : null,
      },
    }),
  };
}
