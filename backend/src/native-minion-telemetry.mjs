import { randomUUID } from 'node:crypto';
import { appendSubagentToolProgress } from './subagent-store.mjs';
import { configuredProviderId, providerUsageValues } from './model-adapters/provider-responsiveness.mjs';

const toolNames = {
  codex: new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch', 'imageView', 'imageGeneration']),
  claude: new Set(['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit', 'Agent', 'Skill', 'WebFetch', 'WebSearch', 'TodoWrite', 'MultiEdit']),
  gemini: new Set(['run_shell_command', 'read_file', 'read_many_files', 'write_file', 'replace', 'edit', 'list_directory', 'glob', 'grep_search', 'google_web_search', 'web_fetch', 'save_memory', 'activate_skill', 'write_todos']),
};
const counts = values => Object.fromEntries(Object.entries(values).filter(([, v]) => Number.isSafeInteger(v) && v >= 0));
const codexUsage = ({ inputTokens, outputTokens, totalTokens, cachedInputTokens, cacheWriteInputTokens, reasoningOutputTokens } = {}) =>
  counts({ input: inputTokens, output: outputTokens, total: totalTokens, cached: cachedInputTokens, cacheWrite: cacheWriteInputTokens, reasoning: reasoningOutputTokens });
const geminiUsage = ({ input_tokens, output_tokens, total_tokens, cached } = {}) => counts({ input: input_tokens, output: output_tokens, total: total_tokens, cached });
const claudeUsage = usage => counts(providerUsageValues(usage, { provider: 'anthropic' }));
const idKey = id => typeof id === 'string' && id.length > 0 && id.length <= 300 ? id : null;

const issueDetail = {
  blocked: 'Tool was blocked.',
  cancelled: 'Tool was interrupted; completion was not confirmed.',
  unobserved: 'Tool result was not observed.',
};
const toolLabel = tool => ['mcp', 'mcpToolCall'].includes(tool) ? 'MCP tool' : tool === 'other' ? 'Other native tool'
  : tool.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, first => first.toUpperCase());

/** Display sinks run separately from native session/checkpoint writes: a
 * display failure must not cancel native work or make it unsafe to resume.
 * Serialize each sink to preserve stream order without waiting in stdout/RPC
 * handlers. Record one durable row per observed completion, not per update. */
export function createNativeMinionActivity({ dataRoot, runId, sessionId, traceDir, getAuthority, isRecorded, onTraceRecord }) {
  let progressWrites = Promise.resolve();
  let activityWrites = Promise.resolve();
  return {
    observe(event) {
      if (isRecorded()) {
        progressWrites = progressWrites.then(() => appendSubagentToolProgress({ dataRoot, id: runId, event })).catch(() => {});
      }
      if (typeof onTraceRecord === 'function') {
        // This is the ordinary transport observer, not the OTel-wrapped one.
        try {
          const pending = onTraceRecord({ type: 'tool', source: 'native-minion-tool', runId, sessionId, ts: event.ts,
            payload: { ...event.data, phase: event.type === 'tool.started' ? 'start' : 'result' }, publicProgress: { ...event, data: { ...event.data } } });
          Promise.resolve(pending).catch(() => {});
        } catch { /* observer only */ }
      }
      if (event.type !== 'tool.completed') return;
      const { tool, activityId, label, ok, status } = event.data;
      activityWrites = activityWrites.then(() => {
        const detail = issueDetail[status];
        const summary = `${label}: ${ok ? 'Completed.' : detail || 'Failed.'}`;
        const toolActivity = {
          runId, status: ok ? 'ok' : 'warn', title: 'Tool activity', summary, totalCalls: 1,
          items: [{ id: activityId, tool, label, status: ok ? 'ok' : 'error', count: 1, ...(detail ? { detail } : {}) }],
        };
        return getAuthority()?.append({ sessionId, runId, traceDir, type: 'event', role: null, visibility: 'activity',
          entersPrompt: false, clock: () => event.ts, content: summary, metadata: { decision: 'chat_tool_activity', subagentExecution: true, toolActivity } });
      }).catch(() => {});
    },
    async flush() { await Promise.all([progressWrites, activityWrites]); },
  };
}

/** CLI stdout/app-server producer. Never forward content, paths, arbitrary tool
 * labels, native IDs, account data, diagnostics, or individual usage snapshots. */
export function createNativeMinionTelemetry({ harness, runId, telemetry, executionTarget, requestedModel, redact = value => value, onToolProgress }) {
  if (typeof telemetry?.observe !== 'function' && typeof onToolProgress !== 'function') return null;
  const emit = (type, payload) => { try { telemetry?.observe?.({ type, runId, payload: { ...payload, harness } }); } catch { /* optional observer */ } };
  // Model labels are protocol/config identifiers, not arbitrary CLI text.
  const modelId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value)
    ? configuredProviderId(redact(value)) : null;
  const requestModel = modelId(requestedModel);
  const invocation = randomUUID();
  const tools = new Map();
  let sequence = 0, started = false, ended = false, model, usage, nativeOutcome;
  let fresh = false, codexSnapshot, invalidCodexUsage = false;
  const responses = new Set();
  const childId = () => `${invocation}:${++sequence}`;

  function start({ model: reportedModel, fresh: isFresh } = {}) {
    if (started) return;
    started = true;
    fresh = isFresh;
    model = modelId(reportedModel);
    emit('native-minion', { phase: 'start', activityId: invocation, requestedModel: requestModel });
  }
  function publishTool(type, data) {
    try { onToolProgress?.({ type, data, ts: new Date().toISOString() }); } catch { /* display observer only */ }
  }
  function startTool(id, name, { observed = true } = {}) {
    const key = idKey(id);
    if (!key || typeof name !== 'string' || tools.has(key)) return;
    const activityId = childId();
    // Built-ins have a stable taxonomy. Arbitrary plugins remain observable
    // without making their names an external payload or a metric dimension.
    const tool = toolNames[harness].has(name) ? name : name.startsWith('mcp__') ? 'mcp' : 'other';
    const data = { activityId, tool, label: toolLabel(tool) };
    tools.set(key, data);
    emit('tool', { phase: 'start', activityId, tool, executionTarget });
    if (observed) publishTool('tool.started', data);
  }
  function endTool(id, outcome, exitCode, displayOutcome = outcome) {
    const key = idKey(id);
    const data = tools.get(key);
    if (!data) return;
    tools.set(key, null); // Keep the tombstone to suppress late/repeated events.
    emit('tool', { phase: 'result', activityId: data.activityId, ok: outcome === 'success', status: outcome,
      ...(Number.isSafeInteger(exitCode) ? { exitCode } : {}) });
    publishTool('tool.completed', { ...data, ok: displayOutcome === 'success', status: displayOutcome });
  }
  function codex({ method, params }) {
    const item = params.item;
    if (method === 'item/started' || method === 'item/completed') {
      if (!toolNames.codex.has(item?.type)) return;
      // Completions can carry the whole typed item without an observed start.
      // Keep OTel pairing, but do not fabricate a start in the transcript.
      if (method === 'item/started' || item.status !== 'inProgress') startTool(item.id, item.type, { observed: method === 'item/started' });
      if (method === 'item/completed' && item.status !== 'inProgress') {
        const outcome = item.status === 'interrupted' ? 'cancelled' : item.status === 'declined' ? 'blocked'
          : item.status === 'failed' || item.success === false || (Number.isSafeInteger(item.exitCode) && item.exitCode !== 0) ? 'failure'
          : item.status === 'completed' || ['webSearch', 'imageView', 'imageGeneration'].includes(item.type) ? 'success' : 'unobserved';
        endTool(item.id, outcome, item.exitCode);
      }
    } else if (method === 'thread/tokenUsage/updated' && fresh && params.tokenUsage?.total) {
      const next = codexUsage(params.tokenUsage.total);
      if (Object.entries(codexSnapshot || {}).some(([kind, value]) => next[kind] !== undefined && next[kind] < value)) invalidCodexUsage = true;
      codexSnapshot = next;
    } else if (method === 'turn/completed') {
      nativeOutcome = params.turn?.status === 'completed' ? 'success' : params.turn?.status === 'interrupted' ? 'cancelled' : 'failure';
    }
  }
  function claude(event) {
    if (event.isReplay === true) return;
    if (event.type === 'assistant' || event.type === 'user') {
      if (event.type === 'assistant') {
        const reported = modelId(event.message?.model);
        if (!event.parent_tool_use_id && reported) model = reported;
        const id = idKey(event.message?.id);
        // Multiple assistant records can contain different blocks of one
        // response. The CLI does not expose its HTTP request timing or final
        // usage per message, so record the observed response, not a request.
        if (id && reported && !responses.has(id)) {
          responses.add(id);
          emit('native-minion', { phase: 'response', activityId: invocation, model: reported });
        }
      }
      for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (event.type === 'assistant' && part?.type === 'tool_use') startTool(part.id, part.name);
        if (event.type === 'user' && part?.type === 'tool_result') endTool(part.tool_use_id, part.is_error === true ? 'failure' : 'success');
      }
    } else if (event.type === 'result' && nativeOutcome === undefined) {
      nativeOutcome = event.is_error || event.subtype !== 'success' ? 'failure' : 'success';
      if (fresh) usage = claudeUsage(event.usage);
    }
  }
  function gemini(event) {
    if (event.isReplay === true) return;
    if (event.type === 'init') model = modelId(event.model) || model;
    if (event.type === 'tool_use') startTool(event.tool_id, event.tool_name);
    if (event.type === 'tool_result') endTool(event.tool_id, event.error || event.status === 'error' ? 'failure'
      : event.status === 'success' ? 'success' : 'unobserved');
    if (event.type === 'result' && nativeOutcome === undefined) {
      nativeOutcome = event.error || event.status !== 'success' ? 'failure' : 'success';
      // Gemini hydrates cumulative session metrics on resume. There is no
      // independently observed pre-turn baseline in stream-json.
      if (fresh && (!event.stats?.models || Object.keys(event.stats.models).length)) usage = geminiUsage(event.stats);
      for (const value of fresh ? Object.keys(event.stats?.models || {}) : []) {
        const reported = modelId(value);
        if (reported) emit('native-minion', { phase: 'usage-model', activityId: invocation, model: reported });
      }
    }
  }
  return {
    start,
    observe(event) {
      if (!started || ended) return;
      try {
        if (harness === 'codex') {
          if (event.method === 'model/rerouted') model = null; // Aggregate may cover more than one model.
          if (event.params?.item?.type === 'contextCompaction') invalidCodexUsage = true;
          codex(event);
        } else if (harness === 'claude') claude(event);
        else if (harness === 'gemini') gemini(event);
      } catch { /* telemetry never controls native execution */ }
    },
    finish(result, { cancelled, timedOut } = {}) {
      if (!started || ended) return;
      ended = true;
      const outcome = cancelled ? 'cancelled' : timedOut ? 'timeout' : result?.ok ? 'success' : 'failure';
      for (const id of tools.keys()) endTool(id, 'unobserved', undefined,
        cancelled || nativeOutcome === 'cancelled' ? 'cancelled' : 'unobserved');
      emit('native-minion', { phase: 'result', activityId: invocation, model, outcome, nativeOutcome,
        usage: harness === 'codex' ? (nativeOutcome === 'success' && !invalidCodexUsage ? codexSnapshot : undefined) : usage });
    },
  };
}
