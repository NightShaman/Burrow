import { createHash } from 'node:crypto';
import { runtimeHeapStage } from './runtime-heap-diagnostics.mjs';
function compactToolCalls(toolCalls = []) {
  return (toolCalls || []).map((call, index) => ({
    id: String(call?.id || `tool-call-${index}`).slice(0, 256),
    name: call?.name ? String(call.name).slice(0, 256) : null,
    callFingerprint: call?.callFingerprint || exactArgumentFingerprint({ name: call?.name, arguments: call?.arguments || {} }),
    // This is a receipt projection only. The original provider calls remain
    // available to the executor for this iteration; no tool is rejected or
    // skipped because its retained representation was compacted.
    arguments: boundedToolArgumentValue(call?.arguments || {}),
  }));
}



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

// Stream exact identity independently of the bounded display receipt. Iterative
// traversal avoids recursive stack limits; only active ancestry is retained.
function exactArgumentFingerprint(value) {
  const hash = createHash('sha256');
  const ancestors = new WeakSet();
  const stack = [{ value }];
  const text = (value) => {
    hash.update(`${value.length}:`);
    for (let offset = 0; offset < value.length; offset += 4096) hash.update(value.slice(offset, offset + 4096), 'utf16le');
  };
  while (stack.length) {
    const entry = stack.pop();
    if (entry.iterator) {
      const next = entry.iterator.next();
      if (next.done) { ancestors.delete(entry.value); hash.update('end;'); continue; }
      const key = next.value;
      let child;
      try { child = entry.value[key]; } catch { child = '[unreadable]'; }
      stack.push(entry, { value: child }, { value: key });
      continue;
    }
    const input = entry.value;
    if (input === null || typeof input !== 'object') {
      hash.update(`${typeof input}:`); text(String(input)); continue;
    }
    if (ancestors.has(input)) { hash.update('cycle;'); continue; }
    ancestors.add(input);
    hash.update(Array.isArray(input) ? 'array;' : 'object;');
    // JSON objects require sorted keys for insertion-order independent identity;
    // arrays stream indices without an additional full-size allocation.
    const keys = Array.isArray(input)
      ? (function* () { for (let i = 0; i < input.length; i++) yield String(i); })()
      : Object.keys(input).sort()[Symbol.iterator]();
    stack.push({ value: input, iterator: keys });
  }
  return hash.digest('hex');
}

function toolPlanFingerprint(toolCalls = []) {
  return exactArgumentFingerprint(compactToolCalls(toolCalls).map(call => call.callFingerprint));
}

function fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16);
}

function repeatedToolCallObservations(toolCalls = [], priorIterations = []) {
  const prior = (priorIterations || []).flatMap((entry) => entry.toolCalls || []);
  return compactToolCalls(toolCalls).map((call) => {
    const callFingerprint = call.callFingerprint;
    const priorCount = prior.filter((entry) => (entry.callFingerprint || exactArgumentFingerprint({ name: entry.name, arguments: entry.arguments })) === callFingerprint).length;
    return { tool: call.name, fingerprint: callFingerprint, repeatCount: priorCount + 1, reason: typeof call.arguments?.reason === 'string' ? call.arguments.reason.slice(0, 500) : null };
  });
}

function normalizedToolOutcome(result = {}) {
  return {
    // Hash full observed payload before any bounded display projection.
    observedPayloadFingerprint: exactArgumentFingerprint(Object.fromEntries(['output', 'job', 'jobs', 'handoff', 'attachment', 'entries', 'paths', 'matches', 'results', 'reply', 'content', 'stdout', 'stderr'].filter(key => result[key] !== undefined).map(key => [key, result[key]]))),
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
  let warning = null;
  for (const call of compactToolCalls(toolCalls)) {
    const callFingerprint = call.callFingerprint;
    let streak = 0;
    let outcomeFingerprint = null;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (entry.callFingerprint !== callFingerprint) continue;
      if (outcomeFingerprint === null) outcomeFingerprint = entry.outcomeFingerprint;
      if (entry.outcomeFingerprint !== outcomeFingerprint) break;
      streak += 1;
    }
    const attemptedCount = streak + 1;
    if (streak && attemptedCount >= loopBlockThreshold) return { action: 'block', tool: call.name, callFingerprint, outcomeFingerprint, repeatedCompletedCalls: streak, attemptedCount, arguments: call.arguments };
    if (streak && attemptedCount >= loopWarningThreshold) warning = { action: 'warn', tool: call.name, callFingerprint, outcomeFingerprint, repeatedCompletedCalls: streak, attemptedCount, arguments: call.arguments };
  }
  return warning;
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
    attachmentId: typeof result.attachmentId === 'string' ? result.attachmentId : null,
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
  if (result.attachment && typeof result.attachment === 'object') compact.attachment = {
    id: result.attachment.id || null,
    name: result.attachment.name || null,
    type: result.attachment.type || null,
    size: result.attachment.size ?? null,
    kind: result.attachment.kind || null,
    ...(typeof result.attachment.text === 'string' ? { text: result.attachment.text.slice(0, CHAT_TOOL_SINGLE_EXCERPT_CHARS) } : {}),
  };
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
  // Retain only declared answer-bearing payloads, never arbitrary result graphs.
  const payloadFields = {
    mcp_call: ['output', 'protectedValues'], session_read_handoff: ['handoff'],
    forge_catalog: ['models', 'music', 'video', 'sourceAttachments'],
    forge_create_job: ['job', 'replayed'], forge_list_jobs: ['jobs'],
    forge_inspect_job: ['job'], forge_attach_artifact: ['attachment'],
    agent_send_message: ['reply'],
  };
  for (const key of payloadFields[result.tool] || []) {
    if (result[key] !== undefined) compact[key] = boundedToolArgumentValue(result[key], { maxStringChars: CHAT_TOOL_SINGLE_EXCERPT_CHARS });
  }
  compact.incomplete = Boolean(result.incomplete);
  const omissions = {};
  for (const key of ['content', 'stdout', 'stderr', 'summary', 'entries', 'paths', 'matches', 'results', 'tasks', 'warnings']) {
    if (result[key]?.length > compact[key]?.length) omissions[key] = { observed: result[key].length, retained: compact[key].length, omitted: result[key].length - compact[key].length };
  }
  for (const [collection, fields] of [['matches', ['text']], ['results', ['title', 'content']], ['tasks', ['title', 'description']]]) {
    let omittedChars = 0;
    for (let index = 0; index < (compact[collection]?.length || 0); index += 1) for (const field of fields) {
      omittedChars += Math.max(0, (result[collection][index]?.[field]?.length || 0) - (compact[collection][index]?.[field]?.length || 0));
    }
    if (omittedChars) omissions[`${collection}Fields`] = { omittedChars };
  }
  if (result.attachment?.text?.length > compact.attachment?.text?.length) omissions.attachmentText = { omitted: result.attachment.text.length - compact.attachment.text.length };
  // Nested bounded payloads carry explicit inline omission markers as well.
  if (Object.keys(omissions).length) compact.retentionOmissions = omissions;
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



export { CHAT_TOOL_HISTORY_LIMIT, CHAT_TOOL_RESULT_HISTORY_LIMIT, CHAT_TOOL_CALL_HISTORY_LIMIT, CHAT_TOOL_SEMANTIC_HISTORY_LIMIT, CHAT_TOOL_SINGLE_EXCERPT_CHARS, compactToolCalls, boundedToolArgumentValue, stableJson, fingerprint, toolPlanFingerprint, exactRepeatVerdict, loopReceiptText, appendBoundedChatHistory, appendBoundedMapEntry, compactPromptEvidenceResult, runtimeObservationFacts, materialEvidenceKeys, recordMaterialProgress, repeatedToolCallObservations, semanticInspectionObservations, logChatToolLoopHeapStage, normalizedToolOutcome };
