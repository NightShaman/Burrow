import { isAbsoluteRemotePath } from './remote-execution-path.mjs';
import { createNativeMinionActivity, createNativeMinionTelemetry } from './native-minion-telemetry.mjs';
import { diagnosticText, collectDiagnosticSecrets } from './native-minion-diagnostics.mjs';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { conversationAuthority } from './conversation-authority.mjs';
import { resolveProcessExecutionTarget } from './process-execution-router.mjs';
import { openRemoteGeminiProcess } from './codex-remote-process.mjs';
import { updateSubagentStatus, readSubagentRecord } from './subagent-store.mjs';
import { normalizeExecutionPolicyInput } from './execution-policy.mjs';
import { validateGeminiModelSelection, GEMINI_SELECTION_ACTIONS, geminiCliModel } from './gemini-model-selection.mjs';

const RUNNER_ERROR = Symbol('geminiRunnerError');
const fail = code => { throw Object.assign(new Error(code), { [RUNNER_ERROR]: code }); };
const MAX_LINE = 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function discoverGeminiExecutable(env = process.env) {
  const override = env.BURROW_GEMINI_EXECUTABLE;
  if (override && !path.isAbsolute(override)) fail('gemini_executable_override_must_be_absolute');
  const candidates = override ? [override] : String(env.PATH || '').split(path.delimiter).filter(path.isAbsolute).map(d => path.join(d, 'gemini'));
  if (!override) {
    if (env.BURROW_RUNTIME_ROOT && path.isAbsolute(env.BURROW_RUNTIME_ROOT)) candidates.push(path.join(env.BURROW_RUNTIME_ROOT, 'integrations', 'gemini-cli', 'node_modules', '.bin', 'gemini'));
    candidates.push(fileURLToPath(new URL('../runtime/integrations/gemini-cli/node_modules/.bin/gemini', import.meta.url)));
    candidates.push(fileURLToPath(new URL('../node_modules/.bin/gemini', import.meta.url)));
  }
  for (const file of candidates) try { if ((await fs.stat(file)).isFile() && (await fs.access(file, 1), true)) return file; } catch {}
  fail('gemini_executable_unavailable');
}

// Attach every listener before start()/stdin. Bound diagnostic retention, not turns.
// Result is provisional until the actual process closes.
function processClient(child, onEvent, redact) {
  let buffer = '', text = '', result, failure, closed = false;
  let stderr = '', stderrLine = '', droppingLine = false, nativeError = '', processError = '', exitCode = null, exitSignal = null, processCode, stage = 'process';
  const diagnostic = value => diagnosticText(value, redact);
  const retainStderr = chunk => {
    for (const part of String(chunk).split(/(?<=\n)/)) {
      if (!droppingLine) stderrLine += part;
      if (stderrLine.length > 32768) { stderrLine = ''; droppingLine = true; }
      if (part.endsWith('\n')) {
        if (!droppingLine) stderr = (stderr + ' ' + diagnostic(stderrLine)).slice(-8000);
        stderrLine = ''; droppingLine = false;
      }
    }
  };
  let resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  const reject = code => {
    if (!failure && !processCode) processCode = code;
    if (!failure && stage === 'process' && !processError) stage = 'stream';
    failure ||= code;
  };
  function line(raw) {
    if (!raw.trim()) return;
    let event;
    try { event = JSON.parse(raw); } catch { reject('gemini_invalid_stream'); return; }
    if (!event || typeof event !== 'object') { reject('gemini_invalid_stream'); return; }
    onEvent(event);
    if (event.type === 'message' && ['assistant', 'model'].includes(event.role || event.type)) {
      const chunk = typeof event.content === 'string' ? event.content : typeof event.text === 'string' ? event.text : '';
      if (text.length + chunk.length > MAX_OUTPUT) reject('gemini_output_limit'); else text += chunk;
    }
    if (event.type === 'error' && event.severity === 'error') {
      stage = 'error'; nativeError = diagnostic(event.message); reject('gemini_native_result_failed');
    }
    if (event.type === 'result') {
      if (result) reject('gemini_invalid_stream');
      result = event;
      if (event.error || event.status !== 'success') {
        stage = 'result';
        nativeError ||= diagnostic(typeof event.error === 'string' ? event.error : event.error?.message);
        reject('gemini_native_result_failed');
      }
      const finalText = event.response ?? event.result;
      if (typeof finalText === 'string') {
        if (finalText.length > MAX_OUTPUT) reject('gemini_output_limit');
        else text = finalText;
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
      if (i > MAX_LINE) { reject('gemini_stream_line_limit'); buffer = ''; return; }
      line(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
      if (failure) { buffer = ''; return; }
    }
    if (buffer.length > MAX_LINE) { buffer = ''; reject('gemini_stream_line_limit'); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', retainStderr);
  const processFailure = (error, at, code) => {
    stage = diagnostic(error?.stage) || at;
    processError = diagnostic(error?.message);
    if (error?.code != null) processCode = diagnostic(String(error.code));
    reject(code);
  };
  child.stderr.on('error', error => processFailure(error, 'stderr', 'gemini_process_failed'));
  child.stdout.on('error', error => processFailure(error, 'output', 'gemini_process_failed'));
  child.stdin.on('error', error => processFailure(error, 'input', 'gemini_input_failed'));
  child.on('error', error => processFailure(error, 'process', 'gemini_process_failed'));
  child.once('close', (code, signal) => {
    exitCode = code; exitSignal = signal || null;
    closed = true;
    if (buffer && !failure) line(buffer);
    if (code !== 0) reject('gemini_process_failed');
    resolveExit();
  });
  return { exit, diagnostics() {
    return { ...(nativeError ? { nativeError } : {}), ...(processError ? { processError } : {}),
      stderr: diagnostic(stderr + ' ' + (droppingLine ? '' : stderrLine)), stage, ...(processCode ? { code: processCode } : {}), exitCode, signal: exitSignal };
  }, get closed() { return closed; }, get failure() { return failure; }, finish() {
    if (failure) fail(failure);
    if (!result) fail('gemini_result_missing');
    if (!text.trim()) fail('gemini_empty_result');
    return text;
  } };
}

/** Server-only native CLI adapter. Admission/terminal receipts remain parent-owned. */
export async function runGeminiMinion({ id, task, target, dataRoot, childSessionId, owner = {}, modelConfig,
  traceDir = null, parentExecutionContext = null, onTraceRecord = null, signal = parentExecutionContext?.abortSignal,
  executionPolicy = parentExecutionContext?.executionPolicy, continuation = null } = {}) {
  const cancellation = new AbortController();
  let nativeTelemetry;
  signal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  let resolvedConnectionId, actualModel = null, launchAttempted = false;
  let child, client, poll, killTimer, spawned = false, nativeSession, store, authority, recorded = false;
  let writes = Promise.resolve(), persistenceFailed = false, sequence = 0, pendingWrites = 0, result, lastActivity = 0, initSeen = false;
  const secrets = new Set();
  collectDiagnosticSecrets(secrets, process.env);
  const collect = value => { // Never persist native credential echoes.
    for (const [key, item] of Object.entries(value || {})) {
      if (/token|secret|apiKey/i.test(key) && typeof item === 'string' && item) secrets.add(item);
    }
  };
  const redact = value => {
    let text = String(value || '');
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
    return text;
  };
  const base = { evidence: [], artifacts: [], changedFiles: [], memoryWrites: [], verificationTarget: target?.root || null,
    verification: { status: 'not_run', check: 'Native Gemini work independently verified by Burrow',
      observed: 'Native CLI output is model provenance, not verified Burrow evidence.', actionRequired: false } };
  const save = async patch => {
    nativeSession = { ...nativeSession, ...patch };
    await store.updateMetadata({ agentId: owner.agentId, sessionId: childSessionId,
      update: old => ({ ...old, geminiSession: nativeSession }) });
  };
  const append = (content, activity = true) => authority.append({ sessionId: childSessionId, runId: id, traceDir,
    type: activity ? 'event' : 'message', role: activity ? null : 'assistant', content: redact(content),
    visibility: activity ? 'activity' : 'chat', entersPrompt: !activity,
    metadata: { kind: activity ? 'gemini-minion-activity' : 'gemini-minion-response', subagentExecution: true, provenance: 'model' } });
  const nativeActivity = createNativeMinionActivity({ dataRoot, runId: id, sessionId: childSessionId, traceDir,
    getAuthority: () => authority, isRecorded: () => recorded && !continuation, onTraceRecord });
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
    nativeTelemetry = createNativeMinionTelemetry({ harness: 'gemini', runId: id, telemetry: parentExecutionContext?.telemetry,
      executionTarget: remote ? 'remote' : 'local', requestedModel: modelConfig?.model, redact, onToolProgress: nativeActivity.observe });
    const boundaries = parentExecutionContext?.executionBoundaries;
    if (boundaries && (!Array.isArray(boundaries.hardBlocks) || boundaries.hardBlocks.some(rule => rule.enabled !== false))) fail('gemini_execution_boundaries_unsupported');
    const policy = normalizeExecutionPolicyInput(executionPolicy);
    if (policy.blockers.length) fail('gemini_execution_policy_blocked');
    // No read-only sandbox bridge is provided in this MVP. Native tools retain
    // Gemini permissions, with coding tools pre-authorized after admission below.
    // Commit authorization is conveyed like Codex, not
    // misrepresented as an OS sandbox.
    if (!policy.mayInspect || !policy.capabilities.readWorkspace || !policy.mayMutate || !policy.capabilities.mutateWorkspace) fail('gemini_execution_policy_unsupported');
    if (!id || typeof task !== 'string' || !task.trim() || !childSessionId || !dataRoot) fail('gemini_runner_input_required');
    if (!owner.agentId || (parentExecutionContext?.agentId && owner.agentId !== parentExecutionContext.agentId)) fail('gemini_owner_invalid');
    if (target?.kind !== 'filesystem' || !(remote ? isAbsoluteRemotePath(target.root) : path.isAbsolute(target.root || ''))) fail('gemini_target_invalid');
    if (!remote && !(await fs.stat(target.root)).isDirectory()) fail('gemini_target_invalid');
    const controller = parentExecutionContext?.processExecutionController;
    if (remote && typeof controller?.codexRpc !== 'function') fail('gemini_remote_process_unavailable');
    const models = parentExecutionContext?.stores?.models;
    let selected;
    try { selected = await validateGeminiModelSelection(models, modelConfig); }
    catch (error) { if (Object.hasOwn(GEMINI_SELECTION_ACTIONS, error?.message || '')) fail(error.message); throw error; }
    if (!models.auth) fail('gemini_model_settings_store_required');
    store = parentExecutionContext?.conversationStore || parentExecutionContext?.stores?.conversations;
    if (!store?.updateMetadata || !store?.getMetadata) fail('gemini_session_metadata_required');
    authority = conversationAuthority({ store, agentId: owner.agentId });
    const persisted = (await store.getMetadata({ agentId: owner.agentId, sessionId: childSessionId }))?.geminiSession;
    const saved = persisted || continuation;
    if (saved) {
      if (!['completed', 'failed', 'interrupted', 'ready'].includes(saved.state) || !saved.sessionId || saved.cleanupUnconfirmed) fail('gemini_session_unavailable');
      if (saved.executionHost?.kind !== host.kind || saved.executionHost?.providerId !== host.providerId || saved.executionHost?.targetId !== host.targetId) fail('gemini_session_host_changed');
      if (saved.connectionId !== selected.connectionId || saved.model !== selected.model) fail('gemini_session_model_changed');
      if (saved.target?.kind !== target.kind || saved.target?.root !== target.root) fail('gemini_session_target_changed');
    }
    recorded = Boolean(await readSubagentRecord({ dataRoot, id }));
    if (recorded) {
      const check = async () => { try { if ((await readSubagentRecord({ dataRoot, id }))?.status === 'cancelled') cancellation.abort(); } catch { cancellation.abort(); } };
      await check(); poll = setInterval(() => { void check(); }, 200); poll.unref();
    }
    signal.throwIfAborted();
    resolvedConnectionId = selected.connectionId;
    const auth = await models.auth(resolvedConnectionId); collect(auth);
    if (auth?.type !== 'api_key' || typeof auth.apiKey !== 'string' || !auth.apiKey || auth.apiKey.length > 16384 || /[\x00-\x20\x7f]/.test(auth.apiKey)) fail('gemini_google_api_key_required');
    const prompt = `Working directory: ${target.root}\nDo not commit changes unless explicitly permitted: ${policy.mayCommit}.\nReturn readable Markdown findings and disclose verification gaps.\n\n${task}`;
    if (Buffer.byteLength(prompt) > 96 * 1024 || prompt.includes('\0')) fail('gemini_prompt_invalid');
    const args = ['-p', prompt, '--output-format', 'stream-json', '--model', geminiCliModel(selected.model), '--approval-mode', 'yolo', '--skip-trust',
      ...(saved?.sessionId ? ['--resume', saved.sessionId] : [])];
    const executable = remote ? null : await discoverGeminiExecutable();
    await save({ sessionId: saved?.sessionId || null, resolvedConnectionId, portableHistory: false, connectionId: selected.connectionId, model: selected.model,
      modelConfig: selected, target, executionPolicy: policy, executionHost: host, state: 'running' });
    await append('Gemini Code starting.');
    signal.throwIfAborted();
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_)/.test(key)) delete env[key];
    env.GEMINI_API_KEY = auth.apiKey;
    if (!remote) {
      // Durable connection-scoped HOME prevents borrowing interactive OAuth and
      // retains native sessions across text followups. No key is written to disk.
      const scope = createHash('sha256').update(`${owner.agentId}:${selected.connectionId}`).digest('hex');
      env.HOME = path.join(dataRoot, 'gemini-cli', scope);
      await fs.mkdir(path.join(env.HOME, '.gemini'), { recursive: true, mode: 0o700 });
      const settingsPath = path.join(env.HOME, 'burrow-system-settings.json');
      await fs.writeFile(settingsPath, JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key', enforcedType: 'gemini-api-key', useExternal: false } } }), { mode: 0o600 });
      env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settingsPath;
    }
    launchAttempted = true;
    child = remote ? await openRemoteGeminiProcess(controller, host.targetId, target.root, { args, apiKey: auth.apiKey })
      : spawn(executable, args, { cwd: target.root, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env });
    spawned = true;
    nativeTelemetry?.start({ fresh: !saved?.sessionId });
    client = processClient(child, event => {
      nativeTelemetry?.observe(event);
      if (event.type === 'init' && typeof event.model === 'string') actualModel = redact(event.model).slice(0, 240);
      // Persist init on arrival, not just on a successful final result.
      if (event.type === 'init' || event.type === 'result') {
        const sessionId = event.session_id || event.sessionId;
        if ((!initSeen || event.type === 'result') && typeof sessionId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId) && ![...secrets].some(secret => sessionId.includes(secret))) { initSeen = true; enqueue(() => save({ sessionId })); }
      }
      const label = ['message', 'tool_use', 'tool_result', 'init', 'error', 'result'].includes(event.type) ? `Gemini ${event.type.replace('_', ' ')} activity.` : null;
      if (label && Date.now() - lastActivity >= 250) {
        lastActivity = Date.now();
        enqueue(async () => {
        await append(label);
        if (recorded && !signal.aborted) await updateSubagentStatus({ dataRoot, id, status: 'running', phase: 'gemini-native',
          activity: { kind: 'run', status: 'running', phase: 'gemini-native', label, sequence: ++sequence, lastActualActivityAt: new Date().toISOString() } });
        });
      }
    }, redact);
    if (signal.aborted) abort();
    else {
      child.start?.();
      child.stdin.end();
    }
    // Polling also bounds a broken transport/process after cancellation or parser
    // failure, without mistaking a result event for process termination.
    while (!client.closed) {
      if (client.failure) { abort(); fail(client.failure); }
      if (signal.aborted) { abort(); signal.throwIfAborted(); }
      await Promise.race([client.exit, delay(25)]);
    }
    await writes;
    if (persistenceFailed) fail('gemini_session_persistence_failed');
    signal.throwIfAborted();
    const text = redact(client.finish());
    await append(text, false);
    await save({ state: 'completed', actualModel });
    result = { ...base, ok: true, summary: text, blockers: [], warnings: [], sideEffectsApplied: null };
  } catch (error) {
    // Keep stable blockers; diagnostics are separately sanitized and process-scoped.
    const code = persistenceFailed ? 'gemini_session_persistence_failed' : signal.aborted ? 'gemini_cancelled'
      : error?.[RUNNER_ERROR] || 'gemini_native_run_failed';
    result = { ...base, ok: false, summary: signal.aborted ? 'Gemini minion cancelled.' : 'Gemini minion unavailable or failed.',
      blockers: [code], warnings: [], sideEffectsApplied: spawned ? null : false };
    // Remote open errors can include a native/transport reason; pre-auth/store
    // exceptions remain opaque because their contents are not process output.
    if (launchAttempted && secrets.size && !client) {
      const message = diagnosticText(error?.message, redact);
      if (message && !error?.[RUNNER_ERROR]) {
        result.diagnostics = { stage: 'open', ...(error?.code != null ? { code: diagnosticText(String(error.code), redact) } : {}), processError: message }; result.summary += ` ${message}`;
      }
    }
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
    if (client && !result?.ok) {
      result.diagnostics = client.diagnostics();
      const detail = [result.diagnostics.nativeError, result.diagnostics.processError, result.diagnostics.stderr,
        ...(client.closed ? [`Process exit: ${result.diagnostics.exitCode ?? 'none'}${result.diagnostics.signal ? ` (${result.diagnostics.signal})` : ''}.`] : [])].filter(Boolean).join(' ');
      if (detail) result.summary += ` ${detail}`;
    }
    clearTimeout(killTimer);
    await writes;
    if (nativeSession && (!result?.ok || cleanupUnconfirmed)) {
      try { await save({ state: cleanupUnconfirmed ? 'running' : signal.aborted ? 'interrupted' : 'failed', ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}) }); } catch { /* Fail closed: running metadata cannot resume. */ }
    }
    if (cleanupUnconfirmed) result = { ...result, ...base, ok: false, summary: 'Gemini process cleanup could not be confirmed.', blockers: ['gemini_cleanup_failed'], warnings: [], sideEffectsApplied: null };
  }
  await nativeActivity.flush();
  return { ...result, model: { requested: modelConfig?.model || null, actual: actualModel, connectionId: modelConfig?.connectionId || null, resolvedConnectionId: resolvedConnectionId || null }, spawned, cancelled: signal.aborted };
}
