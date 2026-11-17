import { createNativeMinionTelemetry } from './native-minion-telemetry.mjs';
import { createProcessDiagnostics, diagnosticText, collectDiagnosticSecrets, attachDiagnostics } from './native-minion-diagnostics.mjs';
import { createClaudePoolRouting } from './claude-pool-routing.mjs';
import { createClaudeCheckpoint, claudeHandoffContext } from './claude-native-checkpoint.mjs';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conversationAuthority } from './conversation-authority.mjs';
import { resolveProcessExecutionTarget } from './process-execution-router.mjs';
import { openRemoteClaudeProcess } from './codex-remote-process.mjs';
import { updateSubagentStatus, readSubagentRecord } from './subagent-store.mjs';
import { normalizeExecutionPolicyInput } from './execution-policy.mjs';
import { validateClaudeModelSelection, CLAUDE_SELECTION_ACTIONS } from './claude-model-selection.mjs';

const RUNNER_ERROR = Symbol('claudeRunnerError');
const fail = code => { throw Object.assign(new Error(code), { [RUNNER_ERROR]: code }); };
const MAX_LINE = 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function discoverClaudeExecutable(env = process.env) {
  const override = env.BURROW_CLAUDE_EXECUTABLE;
  if (override && !path.isAbsolute(override)) fail('claude_executable_override_must_be_absolute');
  const candidates = override ? [override] : String(env.PATH || '').split(path.delimiter).filter(path.isAbsolute).map(d => path.join(d, 'claude'));
  if (!override) {
    if (env.BURROW_RUNTIME_ROOT && path.isAbsolute(env.BURROW_RUNTIME_ROOT)) candidates.push(path.join(env.BURROW_RUNTIME_ROOT, 'integrations', 'claude-code', 'node_modules', '.bin', 'claude'));
    candidates.push(fileURLToPath(new URL('../node_modules/.bin/claude', import.meta.url)));
  }
  for (const file of candidates) try { if ((await fs.stat(file)).isFile() && (await fs.access(file, 1), true)) return file; } catch {}
  fail('claude_executable_unavailable');
}

// Attach every listener before start()/stdin. Retain only sanitized diagnostics, not tool payloads,
// or unbounded JSONL. Result is provisional until the actual process closes.
function processClient(child, onEvent, redact) {
  const diagnostics = createProcessDiagnostics(redact);
  let buffer = '', text = '', result, failure, closed = false;
  let resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  const reject = code => {
    if (!failure && !diagnostics.snapshot().nativeError && !diagnostics.snapshot().processError) diagnostics.error({ code }, 'stream');
    failure ||= code;
  };
  function line(raw) {
    if (!raw.trim()) return;
    let event;
    try { event = JSON.parse(raw); } catch { reject('claude_invalid_stream'); return; }
    if (!event || typeof event !== 'object') { reject('claude_invalid_stream'); return; }
    onEvent(event);
    if (event.type === 'assistant') for (const c of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (c?.type === 'text' && typeof c.text === 'string') {
        if (text.length + c.text.length > MAX_OUTPUT) reject('claude_output_limit');
        else text += c.text;
      }
    }
    if (event.type === 'result') {
      if (result) reject('claude_invalid_stream');
      result = event;
      if (event.is_error || event.subtype !== 'success') {
        diagnostics.error({ message: [event.result, ...(Array.isArray(event.errors) ? event.errors : [])].filter(v => typeof v === 'string').join(' ') }, 'result', 'nativeError');
        reject('claude_native_result_failed');
      }
      if (typeof event.result === 'string') {
        if (event.result.length > MAX_OUTPUT) reject('claude_output_limit');
        else text = event.result;
      }
    }
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    // Continue draining after a protocol failure; cancellation/cleanup owns kill.
    if (failure) return;
    buffer += chunk;
    for (;;) {
      const i = buffer.indexOf('\n');
      if (i < 0) break;
      if (i > MAX_LINE) { reject('claude_stream_line_limit'); buffer = ''; return; }
      line(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
      if (failure) { buffer = ''; return; }
    }
    if (buffer.length > MAX_LINE) { buffer = ''; reject('claude_stream_line_limit'); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => diagnostics.stderr(chunk));
  child.stderr.on('error', error => { diagnostics.error(error); reject('claude_process_failed'); });
  child.stdout.on('error', error => { diagnostics.error(error); reject('claude_process_failed'); });
  child.stdin.on('error', error => { diagnostics.error(error, 'input'); reject('claude_input_failed'); });
  child.on('error', error => { diagnostics.error(error); reject('claude_process_failed'); });
  child.once('close', (code, signal) => {
    diagnostics.close(code, signal);
    closed = true;
    if (buffer && !failure) line(buffer);
    if (code !== 0) reject('claude_process_failed');
    resolveExit();
  });
  return { exit, diagnostics: () => diagnostics.snapshot(), get closed() { return closed; }, get failure() { return failure; }, finish() {
    if (failure) fail(failure);
    if (!result) fail('claude_result_missing');
    if (!text.trim()) fail('claude_empty_result');
    return text;
  } };
}

/** Server-only native CLI adapter. Admission/terminal receipts remain parent-owned. */
export async function runClaudeMinion({ id, task, target, dataRoot, childSessionId, owner = {}, modelConfig,
  traceDir = null, parentExecutionContext = null, signal = parentExecutionContext?.abortSignal,
  executionPolicy = parentExecutionContext?.executionPolicy, continuation = null } = {}) {
  const cancellation = new AbortController();
  let nativeTelemetry;
  signal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  let poolEngine, route, resolvedConnectionId, actualModel = null, checkpoint, history = [], launchAttempted = false;
  let child, client, poll, killTimer, spawned = false, nativeSession, store, authority, recorded = false;
  let writes = Promise.resolve(), persistenceFailed = false, sequence = 0, pendingWrites = 0, result, lastActivity = 0, initSeen = false;
  const secrets = new Set();
  collectDiagnosticSecrets(secrets, process.env);
  const collect = value => { // OAuth records can change on refresh; capture both generations.
    for (const [key, item] of Object.entries(value || {})) {
      if (/token|secret|api_?key/i.test(key) && typeof item === 'string' && item) secrets.add(item);
    }
  };
  const redact = value => {
    let text = String(value || '');
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
    return text;
  };
  const base = { evidence: [], artifacts: [], changedFiles: [], memoryWrites: [], verificationTarget: target?.root || null,
    verification: { status: 'not_run', check: 'Native Claude work independently verified by Burrow',
      observed: 'Native CLI output is model provenance, not verified Burrow evidence.', actionRequired: false } };
  const save = async patch => {
    nativeSession = { ...nativeSession, ...patch };
    await store.updateMetadata({ agentId: owner.agentId, sessionId: childSessionId,
      update: old => ({ ...old, claudeSession: nativeSession }) });
  };
  const append = (content, activity = true) => authority.append({ sessionId: childSessionId, runId: id, traceDir,
    type: activity ? 'event' : 'message', role: activity ? null : 'assistant', content: redact(content),
    visibility: activity ? 'activity' : 'chat', entersPrompt: !activity,
    metadata: { kind: activity ? 'claude-minion-activity' : 'claude-minion-response', subagentExecution: true, provenance: 'model' } });
  const enqueue = fn => {
    if (++pendingWrites > 32) { pendingWrites--; persistenceFailed = true; cancellation.abort(); return; }
    writes = writes.then(fn).catch(() => { persistenceFailed = true; cancellation.abort(); }).finally(() => { pendingWrites--; });
  };
  const kill = sig => {
    if (!child) return;
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch { /* Process may already be gone. */ }
  };
  const abort = () => {
    kill('SIGTERM');
    killTimer ||= setTimeout(() => kill('SIGKILL'), 500);
    killTimer.unref();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const host = resolveProcessExecutionTarget(parentExecutionContext || {});
    const remote = host.kind === 'remote';
    nativeTelemetry = createNativeMinionTelemetry({ harness: 'claude', runId: id, telemetry: parentExecutionContext?.telemetry,
      executionTarget: remote ? 'remote' : 'local', requestedModel: modelConfig?.model, redact });
    const boundaries = parentExecutionContext?.executionBoundaries;
    if (boundaries && (!Array.isArray(boundaries.hardBlocks) || boundaries.hardBlocks.some(rule => rule.enabled !== false))) fail('claude_execution_boundaries_unsupported');
    const policy = normalizeExecutionPolicyInput(executionPolicy);
    if (policy.blockers.length) fail('claude_execution_policy_blocked');
    // No read-only sandbox bridge is provided in this MVP. Native tools retain
    // Claude permissions, with coding tools pre-authorized after admission below.
    // Commit authorization is conveyed like Codex, not
    // misrepresented as an OS sandbox.
    if (!policy.mayInspect || !policy.capabilities.readWorkspace || !policy.mayMutate || !policy.capabilities.mutateWorkspace) fail('claude_execution_policy_unsupported');
    if (!id || typeof task !== 'string' || !task.trim() || !childSessionId || !dataRoot) fail('claude_runner_input_required');
    if (!owner.agentId || (parentExecutionContext?.agentId && owner.agentId !== parentExecutionContext.agentId)) fail('claude_owner_invalid');
    if (target?.kind !== 'filesystem' || !path.isAbsolute(target.root || '')) fail('claude_target_invalid');
    if (!remote && !(await fs.stat(target.root)).isDirectory()) fail('claude_target_invalid');
    const controller = parentExecutionContext?.processExecutionController;
    if (remote && typeof controller?.codexRpc !== 'function') fail('claude_remote_process_unavailable');
    const models = parentExecutionContext?.stores?.models;
    let selected;
    try { selected = await validateClaudeModelSelection(models, modelConfig); }
    catch (error) { if (Object.hasOwn(CLAUDE_SELECTION_ACTIONS, error?.message || '')) fail(error.message); throw error; }
    if (!models.auth || !models.resolveAuth) fail('claude_model_settings_store_required');
    store = parentExecutionContext?.conversationStore || parentExecutionContext?.stores?.conversations;
    if (!store?.updateMetadata || !store?.getMetadata) fail('claude_session_metadata_required');
    authority = conversationAuthority({ store, agentId: owner.agentId });
    const persisted = (await store.getMetadata({ agentId: owner.agentId, sessionId: childSessionId }))?.claudeSession;
    const saved = persisted || continuation;
    if (saved) {
      if (!['completed', 'failed', 'interrupted', 'ready'].includes(saved.state) || !saved.sessionId || saved.cleanupUnconfirmed) fail('claude_session_unavailable');
      if (saved.executionHost?.kind !== host.kind || saved.executionHost?.providerId !== host.providerId || saved.executionHost?.targetId !== host.targetId) fail('claude_session_host_changed');
      if (saved.connectionId !== selected.connectionId || saved.model !== selected.model) fail('claude_session_model_changed');
      if (saved.target?.kind !== target.kind || saved.target?.root !== target.root) fail('claude_session_target_changed');
    }
    recorded = Boolean(await readSubagentRecord({ dataRoot, id }));
    if (recorded) {
      const check = async () => { try { if ((await readSubagentRecord({ dataRoot, id }))?.status === 'cancelled') cancellation.abort(); } catch { cancellation.abort(); } };
      await check(); poll = setInterval(() => { void check(); }, 200); poll.unref();
    }
    signal.throwIfAborted();
    resolvedConnectionId = selected.connectionId;
    if ((await models.get(selected.connectionId))?.apiType === 'anthropic-lb') {
      poolEngine = await createClaudePoolRouting(models, selected.connectionId, selected.model, parentExecutionContext);
      try {
        route = await poolEngine.select({ threadKey: childSessionId, model: selected.model,
          preferredMemberId: saved?.resolvedConnectionId,
          requiredMemberId: saved && !saved.portableHistory ? saved.resolvedConnectionId : null });
      } catch (error) {
        if (error.message === 'provider_pool_no_eligible_members') fail('provider_pool_no_eligible_members');
        if (error.message === 'provider_pool_continuation_owner_unavailable') fail('claude_continuation_effects_ambiguous');
        throw error;
      }
      resolvedConnectionId = route.memberId;
    }
    const handoff = saved && resolvedConnectionId !== (saved.resolvedConnectionId || saved.connectionId);
    if (handoff && (!saved.portableHistory || !Array.isArray(saved.preparedHistory))) fail('claude_continuation_effects_ambiguous');
    history = saved?.preparedHistory || [];
    checkpoint = createClaudeCheckpoint(task);
    const auth = await models.auth(resolvedConnectionId); collect(auth);
    if (auth?.type !== 'oauth' || !['anthropic', 'claude'].includes(String(auth.provider || '').toLowerCase())) fail('claude_anthropic_oauth_required');
    const resolved = await models.resolveAuth(resolvedConnectionId, { signal }); collect(resolved);
    collect(await models.auth(resolvedConnectionId));
    if (typeof resolved?.token !== 'string' || !resolved.token) fail('claude_anthropic_oauth_required');
    const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit', '--permission-prompts', 'none', '--model', selected.model,
      ...(saved?.sessionId && !handoff ? ['--resume', saved.sessionId] : [])];
    const executable = remote ? null : await discoverClaudeExecutable();
    await save({ sessionId: handoff ? null : saved?.sessionId || null, resolvedConnectionId, portableHistory: false, connectionId: selected.connectionId, model: selected.model,
      modelConfig: selected, target, executionPolicy: policy, executionHost: host, state: 'running' });
    await append('Claude Code starting.');
    signal.throwIfAborted();
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$)/.test(key)) delete env[key];
    env.CLAUDE_CODE_OAUTH_TOKEN = resolved.token;
    launchAttempted = true;
    child = remote ? await openRemoteClaudeProcess(controller, host.targetId, target.root, { args, token: resolved.token })
      : spawn(executable, args, { cwd: target.root, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env });
    spawned = true;
    nativeTelemetry?.start({ fresh: !saved?.sessionId || Boolean(handoff) });
    client = processClient(child, event => {
      nativeTelemetry?.observe(event);
      checkpoint.observe(event);
      if (event.type === 'assistant' && typeof event.message?.model === 'string') actualModel = redact(event.message.model);
      // Persist init on arrival, not just on a successful final result.
      if ((event.type === 'system' && event.subtype === 'init') || event.type === 'result') {
        if ((!initSeen || event.type === 'result') && typeof event.session_id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(event.session_id) && ![...secrets].some(secret => event.session_id.includes(secret))) { initSeen = true; enqueue(() => save({ sessionId: event.session_id })); }
      }
      const label = event.type === 'assistant' ? 'Claude response activity.'
          : event.type === 'stream_event' ? 'Claude streaming activity.'
        : event.type === 'system' && event.subtype === 'init' ? 'Claude session initialized.' : null;
      if (label && Date.now() - lastActivity >= 250) {
        lastActivity = Date.now();
        enqueue(async () => {
        await append(label);
        if (recorded && !signal.aborted) await updateSubagentStatus({ dataRoot, id, status: 'running', phase: 'claude-native',
          activity: { kind: 'run', status: 'running', phase: 'claude-native', label, sequence: ++sequence, lastActualActivityAt: new Date().toISOString() } });
        });
      }
    }, redact);
    if (signal.aborted) abort();
    else {
      child.start?.();
      child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: `${handoff ? claudeHandoffContext(history) : ''}Working directory: ${target.root}\nDo not commit changes unless explicitly permitted: ${policy.mayCommit}.\nReturn readable Markdown findings and disclose verification gaps.\n\n${task}` } })}\n`);
    }
    // Polling also bounds a broken transport/process after cancellation or parser
    // failure, without mistaking a result event for process termination.
    while (!client.closed) {
      if (client.failure) { abort(); fail(client.failure); }
      if (signal.aborted) { abort(); signal.throwIfAborted(); }
      await Promise.race([client.exit, delay(25)]);
    }
    await writes;
    if (persistenceFailed) fail('claude_session_persistence_failed');
    signal.throwIfAborted();
    const text = redact(client.finish());
    await append(text, false);
    const projection = checkpoint.finish({ success: true, closed: client.closed, redact });
    history = [...history, ...projection.messages];
    const bounded = JSON.stringify(history).length <= 1_000_000;
    await save({ state: 'completed', actualModel, portableHistory: projection.portable && bounded && (!saved || saved.portableHistory === true),
      preparedHistory: bounded ? history : [], checkpointFailure: projection.reason || (bounded ? null : 'oversized_history') });
    result = { ...base, ok: true, summary: text, blockers: [], warnings: [], sideEffectsApplied: null };
  } catch (error) {
    // Stable blockers remain separate from sanitized native diagnostics; store errors stay opaque.
    if (poolEngine && route && !signal.aborted && error?.[RUNNER_ERROR] === 'claude_native_result_failed') {
      // Native print mode does not expose trustworthy HTTP status. Account only
      // a generic native failure; never invent auth/quota classifications.
      try { await poolEngine.cooldown(resolvedConnectionId, 'claude_native_result_failed'); } catch { /* Original failure remains terminal. */ }
    }
    const code = persistenceFailed ? 'claude_session_persistence_failed' : signal.aborted ? 'claude_cancelled'
      : error?.[RUNNER_ERROR] || 'claude_native_run_failed';
    result = { ...base, ok: false, summary: signal.aborted ? 'Claude minion cancelled.' : 'Claude minion unavailable or failed.',
      blockers: [code], warnings: [], sideEffectsApplied: spawned ? null : false };
    if (launchAttempted && !client) attachDiagnostics(result, { stage: 'open', processError: diagnosticText(error?.message, redact), ...(error?.code ? { code: diagnosticText(String(error.code), redact) } : {}) });
  } finally {
    nativeTelemetry?.finish(result, { cancelled: signal.aborted });
    clearInterval(poll);
    signal.removeEventListener('abort', abort);
    let cleanupUnconfirmed = false;
    if (child) {
      // Kill the local process group even when its leader exited; descendants
      // must not outlive the runner. Remote adapter forwards group kill to host.
      kill('SIGTERM');
      if (!client?.closed) await Promise.race([client?.exit || delay(750), delay(750)]);
      kill('SIGKILL');
      if (!client?.closed) await Promise.race([client?.exit || delay(750), delay(750)]);
      cleanupUnconfirmed = !client?.closed;
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
    clearTimeout(killTimer);
    await writes;
    if (nativeSession && (!result?.ok || cleanupUnconfirmed)) {
      try { await save({ state: cleanupUnconfirmed ? 'running' : signal.aborted ? 'interrupted' : 'failed', ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}) }); } catch { /* Fail closed: running metadata cannot resume. */ }
    }
    if (cleanupUnconfirmed) result = { ...result, ...base, ok: false, summary: 'Claude process cleanup could not be confirmed.', blockers: ['claude_cleanup_failed'], warnings: [], sideEffectsApplied: null };
  }
  if (client && !result.ok) attachDiagnostics(result, client.diagnostics());
  return { ...result, model: { requested: modelConfig?.model || null, actual: actualModel, connectionId: modelConfig?.connectionId || null, resolvedConnectionId: resolvedConnectionId || null }, spawned, cancelled: signal.aborted };
}
