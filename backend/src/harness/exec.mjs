import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTraceLogger } from '../trace-logger.mjs';
import { redactAndTruncateText, redactProtectedText } from '../redaction.mjs';
import { resolveRuntimeTraceRoot } from '../config.mjs';

function nowMs() {
  return Date.now();
}

function safeName(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || randomUUID();
}

function commandHash(command) {
  return createHash('sha256').update(String(command || '')).digest('hex').slice(0, 12);
}

function asText(chunks) {
  return Buffer.concat(chunks).toString('utf8');
}

function appendBoundedChunk(chunks, state, chunk, limitBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.originalBytes += buffer.length;
  if (state.capturedBytes >= limitBytes) return;
  const remaining = limitBytes - state.capturedBytes;
  const retained = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
  chunks.push(retained);
  state.capturedBytes += retained.length;
}

function executionEnv(env = {}, inheritEnv = false) {
  const base = inheritEnv ? { ...process.env } : { PATH: process.env.PATH, HOME: process.env.HOME };
  return Object.fromEntries(Object.entries({ ...base, ...env }).filter(([, value]) => value !== undefined && value !== null));
}


export async function runExec({
  command,
  cwd,
  env = {},
  timeoutMs = 30_000,
  abortSignal = null,
  traceLogger,
  rootDir,
  runId,
  artifactPrefix,
  reason = null,
  inheritEnv = false,
  maxOutputChars = 100_000,
  protectedValues = [],
} = {}) {
  if (!command || typeof command !== 'string') throw new Error('command is required');

  const logger = traceLogger || createTraceLogger({ rootDir: await resolveRuntimeTraceRoot(rootDir || process.cwd()), runId });
  const startedAt = nowMs();
  const stdoutChunks = [];
  const stderrChunks = [];
  // Bound bytes before decoding/redaction. Truncating only after Buffer.concat()
  // still lets a noisy command allocate an unbounded string in the parent.
  const captureLimitBytes = Math.max(1, Math.floor(Number(maxOutputChars) || 100_000) * 2);
  const stdoutState = { originalBytes: 0, capturedBytes: 0 };
  const stderrState = { originalBytes: 0, capturedBytes: 0 };
  const prefix = safeName(artifactPrefix || `shell_exec-${commandHash(command)}`);
  const redact = (value) => redactProtectedText(value, protectedValues);
  const redactAndTruncate = (value, options) => {
    const envelope = redactAndTruncateText(value, options);
    envelope.text = redact(envelope.text);
    return envelope;
  };
  const started = await logger.toolStart?.({ tool: 'shell_exec', command: redact(command), cwd: cwd || process.cwd(), reason: typeof reason === 'string' ? reason.slice(0, 500) : null });
  const activityId = started?.payload?.activityId || null;

  let timedOut = false;
  let killed = false;
  let cancelled = false;
  const child = spawn(command, {
    cwd: cwd || process.cwd(),
    env: executionEnv(env, inheritEnv),
    shell: true,
    // A shell may leave grandchildren holding stdout/stderr open. Run it in
    // its own process group so timeout/cancel can terminate the whole command.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const exit = await new Promise((resolve) => {
    let settled = false;
    let killTimer = null;
    let fallbackTimer = null;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const terminate = (signal) => {
      if (!child.pid) return false;
      try {
        if (process.platform !== 'win32') {
          process.kill(-child.pid, signal);
          return true;
        }
        return child.kill(signal);
      } catch {
        try { return child.kill(signal); } catch { return false; }
      }
    };
    const stop = (kind) => {
      if (settled) return;
      timedOut ||= kind === 'timeout';
      cancelled ||= kind === 'cancel';
      killed = terminate('SIGTERM') || killed;
      killTimer = setTimeout(() => terminate('SIGKILL'), 1_000);
      killTimer.unref?.();
      // `close` normally settles us. This prevents a shell grandchild holding
      // inherited pipes from stranding the chat run forever.
      fallbackTimer = setTimeout(() => finish({ exitCode: null, signal: 'SIGTERM', error: new Error(kind === 'timeout' ? 'exec_timeout' : 'exec_cancelled') }), 1_100);
      fallbackTimer.unref?.();
    };
    const onAbort = () => stop('cancel');
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    child.stdout.on('data', (chunk) => appendBoundedChunk(stdoutChunks, stdoutState, chunk, captureLimitBytes));
    child.stderr.on('data', (chunk) => appendBoundedChunk(stderrChunks, stderrState, chunk, captureLimitBytes));
    child.once('error', (error) => finish({ exitCode: null, signal: null, error }));
    child.once('close', (exitCode, signal) => finish({ exitCode, signal, error: null }));
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener('abort', onAbort, { once: true });
  });

  const durationMs = nowMs() - startedAt;
  const rawStdout = asText(stdoutChunks);
  const rawStderr = asText(stderrChunks);
  const stdoutEnvelope = redactAndTruncate(rawStdout, { maxChars: maxOutputChars });
  const stderrEnvelope = redactAndTruncate(rawStderr, { maxChars: maxOutputChars });
  if (stdoutState.originalBytes > stdoutState.capturedBytes) {
    stdoutEnvelope.text = `${stdoutEnvelope.text}\n[shell_exec stdout capture truncated: ${stdoutState.originalBytes - stdoutState.capturedBytes} bytes omitted]`;
    stdoutEnvelope.truncated = true;
  }
  if (stderrState.originalBytes > stderrState.capturedBytes) {
    stderrEnvelope.text = `${stderrEnvelope.text}\n[shell_exec stderr capture truncated: ${stderrState.originalBytes - stderrState.capturedBytes} bytes omitted]`;
    stderrEnvelope.truncated = true;
  }
  const stdout = stdoutEnvelope.text;
  const stderr = stderrEnvelope.text;
  const ok = exit.exitCode === 0 && !timedOut && !cancelled && !exit.error;

  const stdoutPath = await logger.artifact(`${prefix}-stdout.txt`, stdout);
  const stderrPath = await logger.artifact(`${prefix}-stderr.txt`, stderr);

  const result = {
    tool: 'shell_exec',
    ok,
    command: redact(command),
    reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
    cwd: cwd || process.cwd(),
    exitCode: exit.exitCode,
    signal: exit.signal,
    timedOut,
    cancelled,
    killed,
    durationMs,
    stdout,
    stderr,
    stdoutTruncated: stdoutEnvelope.truncated,
    stderrTruncated: stderrEnvelope.truncated,
    stdoutOriginalChars: stdoutState.originalBytes,
    stderrOriginalChars: stderrState.originalBytes,
    error: exit.error ? redact(String(exit.error.message || exit.error)) : null,
    artifacts: {
      stdoutPath,
      stderrPath,
      resultPath: null,
    },
  };

  const resultPath = path.join(logger.traceDir, 'artifacts', `${prefix}-result.json`);
  result.artifacts.resultPath = resultPath;
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

  await (logger.toolEnd || logger.tool)({
    tool: 'shell_exec',
    ...(activityId ? { activityId } : {}),
    ok: result.ok,
    command: result.command,
    cwd: result.cwd,
    reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    durationMs: result.durationMs,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    artifacts: result.artifacts,
  });

  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootDir = process.argv[2] || process.cwd();
  const command = process.argv.slice(3).join(' ');
  const result = await runExec({ rootDir, runId: 'manual-shell_exec-smoke', command });
  console.log(JSON.stringify(result, null, 2));
}
