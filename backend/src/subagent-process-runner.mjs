import { terminateProcessGroup } from './process-execution-router.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_STREAM_CAPTURE_BYTES = 256 * 1024;

function compactString(value) {
  return String(value || '').trim();
}

function childScriptPath() {
  return new URL('./subagent-worker-child.mjs', import.meta.url).pathname;
}

async function writePayload(payload, tempDir = os.tmpdir()) {
  const dir = await fs.mkdtemp(path.join(tempDir, 'burrow-subagent-'));
  await fs.chmod(dir, 0o700);
  const payloadPath = path.join(dir, `payload-${randomUUID()}.json`);
  await fs.writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { dir, payloadPath };
}

function childEnv(baseEnv = process.env) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'BURROW_RUNTIME_ROOT', 'BURROW_WORKSPACE_ROOT', 'BURROW_AGENT_WORKSPACE_ROOT', 'BURROW_AGENT_DATA_ROOT', 'BURROW_CACHE_ROOT', 'BURROW_TRACE_ISOLATION', 'BURROW_SETTINGS_KEY', 'BURROW_POSTGRES_URL', 'BURROW_POSTGRES_HOST', 'BURROW_POSTGRES_PORT', 'BURROW_POSTGRES_DATABASE', 'BURROW_POSTGRES_USER', 'BURROW_POSTGRES_PASSWORD', 'DATABASE_URL']) {
    if (baseEnv[key]) env[key] = baseEnv[key];
  }
  return env;
}

async function cleanupPayloadDir(dir) {
  if (!dir) return;
  try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
}

function appendTail(state, chunk, limitBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.originalBytes += buffer.length;
  state.chunks.push(buffer);
  state.capturedBytes += buffer.length;
  while (state.capturedBytes > limitBytes && state.chunks.length) {
    const overflow = state.capturedBytes - limitBytes;
    const first = state.chunks[0];
    if (first.length <= overflow) {
      state.chunks.shift();
      state.capturedBytes -= first.length;
    } else {
      state.chunks[0] = first.subarray(overflow);
      state.capturedBytes -= overflow;
    }
  }
}

function renderedStream(state) {
  const text = Buffer.concat(state.chunks).toString('utf8');
  return state.originalBytes > state.capturedBytes
    ? `[${state.originalBytes - state.capturedBytes} earlier bytes omitted]\n${text}`
    : text;
}

function parseChildJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  for (const line of [...lines].reverse()) {
    const parsed = JSON.parse(line);
    if (parsed?.__burrowSubagentResult === true) return parsed;
    if (parsed && parsed.__burrowSubagentProgress !== true && Object.hasOwn(parsed, 'ok')) return parsed;
  }
  throw new Error('subagent_terminal_result_missing');
}

export async function runSubagentProcess({
  args = {},
  tempDir = os.tmpdir(),
  nodePath = process.execPath,
  childScriptPath: overrideChildScriptPath = null,
  maxStreamCaptureBytes = DEFAULT_STREAM_CAPTURE_BYTES,
  signal = null,
  cancellationGraceMs = 1_000,
} = {}) {
  const { dir, payloadPath } = await writePayload({ args }, tempDir);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const captureLimit = Math.max(1, Math.floor(Number(maxStreamCaptureBytes) || DEFAULT_STREAM_CAPTURE_BYTES));
    const stdoutState = { chunks: [], originalBytes: 0, capturedBytes: 0 };
    const stderrState = { chunks: [], originalBytes: 0, capturedBytes: 0 };
    const streams = () => ({
      stdout: renderedStream(stdoutState),
      stderr: renderedStream(stderrState),
      stdoutTruncated: stdoutState.originalBytes > stdoutState.capturedBytes,
      stderrTruncated: stderrState.originalBytes > stderrState.capturedBytes,
      stdoutOriginalBytes: stdoutState.originalBytes,
      stderrOriginalBytes: stderrState.originalBytes,
    });
    let settled = false;
    const child = spawn(nodePath, [overrideChildScriptPath || childScriptPath(), payloadPath], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
    });
    let cancelled = Boolean(signal?.aborted);
    let killTimer = null;
    const graceMs = Math.max(1, Number(cancellationGraceMs) || 1_000);
    const abortChild = () => {
      cancelled = true;
      if (settled || killTimer) return;
      terminateProcessGroup(child, 'SIGTERM');
      // Configurable grace allows cooperative worker cleanup before forcing the
      // entire isolated group down, including descendants holding inherited pipes.
      killTimer = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), graceMs);
    };
    if (signal?.aborted) abortChild();
    else signal?.addEventListener?.('abort', abortChild, { once: true });
    const finish = async (payload) => {
      signal?.removeEventListener?.('abort', abortChild);
      // Even if the leader closes early, descendants may ignore SIGTERM.
      if (killTimer) {
        clearTimeout(killTimer);
        terminateProcessGroup(child, 'SIGKILL');
      }
      await cleanupPayloadDir(dir);
      resolve({ durationMs: Date.now() - startedAt, payloadCleaned: true, ...payload });
    };

    child.stdout.on('data', (chunk) => { appendTail(stdoutState, chunk, captureLimit); });
    child.stderr.on('data', (chunk) => { appendTail(stderrState, chunk, captureLimit); });
    child.on('error', async (error) => {
      if (settled) return;
      settled = true;
      await finish({
        ok: false,
        spawned: false,
        error: error?.message || String(error),
        ...streams(),
        result: { ok: false, summary: 'Minion failed to spawn.', blockers: ['subagent_spawn_failed'], warnings: [], evidence: [], artifacts: [], changedFiles: [], memoryWrites: [], sideEffectsApplied: false },
      });
    });
    child.on('close', async (code, signal) => {
      if (settled) return;
      settled = true;
      let parsed;
      try {
        parsed = parseChildJson(renderedStream(stdoutState));
      } catch (error) {
        parsed = {
          ok: false,
          result: { ok: false, summary: 'Minion returned invalid JSON.', blockers: [`subagent_invalid_json:${error?.message || error}`], warnings: [], evidence: [], artifacts: [], changedFiles: [], memoryWrites: [], sideEffectsApplied: false },
        };
      }
      await finish({
        ...parsed,
        ok: code === 0 && !signal && !cancelled && Boolean(parsed.ok),
        cancelled,
        spawned: true,
        timedOut: false,
        exitCode: code,
        signal,
        ...streams(),
      });
    });
  });
}

export const __subagentProcessRunner__ = Object.freeze({ defaultHeartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS, defaultStreamCaptureBytes: DEFAULT_STREAM_CAPTURE_BYTES, childScript: childScriptPath, compactString, appendTail, renderedStream, parseChildJson });
