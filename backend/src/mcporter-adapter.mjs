import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { redactProtectedText } from './redaction.mjs';

function runtimeRootOrThrow(runtimeRoot = null) {
  const resolved = String(runtimeRoot || process.env.BURROW_RUNTIME_ROOT || '').trim();
  if (!resolved) throw new Error('burrow_runtime_root_required');
  return path.resolve(resolved);
}

export function resolveMcporterRuntime({ runtimeRoot = null, root = null, binary = null } = {}) {
  // `runtimeRoot` is the historical explicit mcporter integration root. Keep
  // that contract for direct callers; only omitted values derive from Burrow.
  const resolvedRoot = root || runtimeRoot || process.env.BURROW_MCPORTER_ROOT || path.join(runtimeRootOrThrow(), 'integrations', 'mcporter');
  return {
    root: path.resolve(resolvedRoot),
    binary: binary || process.env.BURROW_MCPORTER_BIN || path.join(resolvedRoot, 'node_modules', '.bin', 'mcporter'),
  };
}

// Compatibility exports. Production calls resolve these at invocation time so
// a migrated runtime is never silently redirected to a historic install path.
export const MCPORTER_ROOT = process.env.BURROW_MCPORTER_ROOT || (process.env.BURROW_RUNTIME_ROOT ? path.join(process.env.BURROW_RUNTIME_ROOT, 'integrations', 'mcporter') : null);
export const MCPORTER_BIN = process.env.BURROW_MCPORTER_BIN || (MCPORTER_ROOT ? path.join(MCPORTER_ROOT, 'node_modules', '.bin', 'mcporter') : null);
const text = (value) => String(value ?? '').trim();
const DEFAULT_STREAM_CAPTURE_BYTES = 256 * 1024;
const boundedJson = (value, maxChars = 1_000) => { try { const rendered = typeof value === 'string' ? value : JSON.stringify(value); return rendered.length <= maxChars ? rendered : `${rendered.slice(0, maxChars)}…`; } catch { return String(value).slice(0, maxChars); } };
// MCP diagnostics are external, untrusted text. Public errors must be stable
// classifications, never launcher stderr or remote server payloads.
export function publicMcpError(error, fallback = 'mcp_runtime_failed') {
  const message = String(error?.message || error || '');
  if (/^mcp_(?:connection_disabled|transport_invalid|tool_name_invalid|discovery_invalid_response|runtime_timeout)$/.test(message)) return message;
  if (message.startsWith('mcp_tool_failed:')) return 'mcp_tool_failed';
  if (message.startsWith('mcp_runtime_failed:')) return 'mcp_runtime_failed';
  return fallback;
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
  const output = Buffer.concat(state.chunks).toString('utf8');
  return state.originalBytes > state.capturedBytes ? `[${state.originalBytes - state.capturedBytes} earlier bytes omitted]
${output}` : output;
}

function diagnosticText(value, protectedValues = []) {
  return redactProtectedText(String(value || '').slice(0, 4_000), protectedValues).trim() || null;
}

function runtimeFailure(code, { stdout = '', stderr = '', detail = null, protectedValues = [], toolErrorCode = null } = {}) {
  const error = new Error(code);
  // Keep raw streams only on the transient internal Error so callers can
  // recognize mcporter's documented non-zero exit for an MCP isError result.
  // Nothing serializes these fields; publicMcpFailureDetail exposes only the
  // bounded, redacted diagnostic below.
  error.stdout = stdout;
  error.stderr = stderr;
  error.diagnostic = diagnosticText(detail ?? (stderr || stdout), protectedValues);
  // Remote provider codes are useful causal context, but only expose a small,
  // inert identifier. The provider's free-form text stays in the redacted,
  // bounded diagnostic rather than becoming a public error classification.
  if (typeof toolErrorCode === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(toolErrorCode)) error.toolErrorCode = toolErrorCode;
  return error;
}

function providerFailureDetail(result) {
  const error = result?.error;
  const contentText = Array.isArray(result?.content)
    ? result.content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n')
    : null;
  const detail = typeof error === 'string' ? error : error?.message || contentText || null;
  return {
    detail,
    toolErrorCode: typeof error?.code === 'string' ? error.code : null,
  };
}

export function publicMcpFailureDetail(error, protectedValues = []) {
  const detail = diagnosticText(error?.diagnostic || error?.message, protectedValues);
  const toolErrorCode = typeof error?.toolErrorCode === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(error.toolErrorCode)
    ? error.toolErrorCode
    : null;
  return { ...(toolErrorCode ? { toolErrorCode } : {}), ...(detail ? { diagnostic: detail } : {}) };
}

function run(command, args, { cwd, timeoutMs = 20_000, killAfterMs = 1_000, maxStreamCaptureBytes = DEFAULT_STREAM_CAPTURE_BYTES, protectedValues = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const captureLimit = Math.max(1, Number(maxStreamCaptureBytes) || DEFAULT_STREAM_CAPTURE_BYTES);
    const stdoutState = { chunks: [], originalBytes: 0, capturedBytes: 0 };
    const stderrState = { chunks: [], originalBytes: 0, capturedBytes: 0 };
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); fn(); };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, Math.max(1, Number(killAfterMs) || 1_000));
      killTimer.unref?.();
    }, Math.max(1, Number(timeoutMs) || 20_000));
    child.stdout.on('data', (chunk) => { appendTail(stdoutState, chunk, captureLimit); });
    child.stderr.on('data', (chunk) => { appendTail(stderrState, chunk, captureLimit); });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => {
      const stdout = renderedStream(stdoutState);
      const stderr = renderedStream(stderrState);
      if (timedOut) reject(runtimeFailure('mcp_runtime_timeout', { stdout, stderr, protectedValues }));
      else code === 0 ? resolve(stdout) : reject(runtimeFailure('mcp_runtime_failed', { stdout, stderr, protectedValues }));
    }));
  });
}

function configFor(connection, apiKey, environmentVariables = {}) {
  const lifecycle = connection.lifecycle === 'keep_alive' ? { lifecycle: 'keep-alive' } : {};
  // mcporter treats a server env map as the complete child environment rather
  // than an overlay. Preserve the service PATH so stdio providers can resolve
  // legitimate user-installed CLIs (for example, Bitwarden's `bw`), while
  // allowing a provider-specific PATH to override it deliberately.
  const childEnvironment = {
    ...(text(process.env.PATH) ? { PATH: process.env.PATH } : {}),
    ...environmentVariables,
  };
  const definition = connection.transport === 'stdio'
    ? { command: connection.command, args: Array.isArray(connection.args) ? connection.args : [], ...(Object.keys(childEnvironment).length ? { env: childEnvironment } : {}), ...lifecycle }
    : { baseUrl: connection.baseUrl, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, ...lifecycle };
  return { mcpServers: { connection: definition } };
}

async function withConnectionConfig(connection, apiKey, environmentVariables, operation, { runtimeRoot = null, binary = null, runCommand = run } = {}) {
  const resolved = resolveMcporterRuntime({ runtimeRoot, binary });
  runtimeRoot = resolved.root; binary = resolved.binary;
  const configRoot = path.join(runtimeRoot, 'runtime');
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  // Keep-alive servers are keyed by their stable config path in mcporter's
  // daemon. Ephemeral calls retain the old disposable configuration behavior.
  if (connection.lifecycle === 'keep_alive') {
    const configPath = path.join(configRoot, `mcp-${text(connection.id) || 'connection'}.json`);
    const config = JSON.stringify(configFor(connection, apiKey, environmentVariables));
    // Do not touch an unchanged config: mcporter uses its mtime to decide
    // whether an existing daemon must be replaced.
    const existing = await readFile(configPath, 'utf8').catch(() => null);
    if (existing !== config) await writeFile(configPath, config, { mode: 0o600 });
    await runCommand(binary, ['daemon', 'start', '--config', configPath], { cwd: runtimeRoot, protectedValues: [apiKey, ...Object.values(environmentVariables || {})] });
    return operation(configPath, { binary, runtimeRoot });
  }
  const temporary = await mkdtemp(path.join(configRoot, 'mcp-'));
  const configPath = path.join(temporary, 'mcporter.json');
  try { await writeFile(configPath, JSON.stringify(configFor(connection, apiKey, environmentVariables)), { mode: 0o600 }); return await operation(configPath, { binary, runtimeRoot }); } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function stopPersistentMcpConnection(connection, { apiKey, binary = null, runtimeRoot = null, runCommand = run } = {}) {
  if (connection?.lifecycle !== 'keep_alive') return false;
  ({ root: runtimeRoot, binary } = resolveMcporterRuntime({ runtimeRoot, binary }));
  const configPath = path.join(runtimeRoot, 'runtime', `mcp-${text(connection.id) || 'connection'}.json`);
  // A keep-alive connection does not materialize its config or daemon until
  // first use. Disabling or deleting one that was never used is already stopped.
  const configExists = await readFile(configPath).then(() => true).catch((error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (!configExists) return true;
  await runCommand(binary, ['daemon', 'stop', '--config', configPath], { cwd: runtimeRoot });
  await rm(configPath, { force: true });
  return true;
}

export async function reconcilePersistentMcpConnection(previous, next, { previousApiKey, nextApiKey, previousEnvironmentVariables = {}, nextEnvironmentVariables = {}, binary = null, runtimeRoot = null, runCommand = run } = {}) {
  if (previous?.lifecycle !== 'keep_alive') return false;
  const changed = !next || !next.enabled || next.lifecycle !== 'keep_alive' || JSON.stringify(configFor(previous, previousApiKey, previousEnvironmentVariables)) !== JSON.stringify(configFor(next, nextApiKey, nextEnvironmentVariables));
  if (!changed) return false;
  return stopPersistentMcpConnection(previous, { apiKey: previousApiKey, binary, runtimeRoot, runCommand });
}

export async function discoverMcpTools(connection, { apiKey, environmentVariables = {}, binary = null, runtimeRoot = null, runCommand = run } = {}) {
  if (!connection?.enabled) throw new Error('mcp_connection_disabled');
  if (!['http', 'stdio'].includes(connection.transport)) throw new Error('mcp_transport_invalid');
  try {
    return await withConnectionConfig(connection, apiKey, environmentVariables, async (configPath, runtime) => {
      const output = await runCommand(runtime.binary, ['list', 'connection', '--config', configPath, '--json'], { cwd: runtime.runtimeRoot, protectedValues: [apiKey, ...Object.values(environmentVariables || {})] });
      const parsed = JSON.parse(output);
      if (parsed?.status !== 'ok' || !Array.isArray(parsed.tools)) throw new Error('mcp_discovery_invalid_response');
      return parsed.tools.map((tool) => ({ name: text(tool.name), description: text(tool.description) || null, inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} } })).filter((tool) => tool.name);
    }, { runtimeRoot, binary, runCommand });
  } catch (error) { if (error instanceof SyntaxError) throw new Error('mcp_discovery_invalid_response'); throw error; }
}

export async function invokeMcpTool(connection, { apiKey, environmentVariables = {}, toolName, arguments: toolArguments = {}, binary = null, runtimeRoot = null, runCommand = run } = {}) {
  if (!connection?.enabled) throw new Error('mcp_connection_disabled');
  if (!['http', 'stdio'].includes(connection.transport)) throw new Error('mcp_transport_invalid');
  if (!text(toolName)) throw new Error('mcp_tool_name_invalid');
  return withConnectionConfig(connection, apiKey, environmentVariables, async (configPath, runtime) => {
    let output;
    try {
      output = await runCommand(runtime.binary, ['call', `connection.${toolName}`, '--config', configPath, '--args', JSON.stringify(toolArguments), '--output', 'json'], { cwd: runtime.runtimeRoot, timeoutMs: 30_000, protectedValues: [apiKey, ...Object.values(environmentVariables || {})] });
    } catch (error) {
      // mcporter deliberately exits non-zero for a valid MCP `{ isError:
      // true }` result, while writing that result to stdout. Parse it before
      // treating the process exit as a launcher/runtime failure.
      if (String(error?.message || error) !== 'mcp_runtime_failed' || typeof error?.stdout !== 'string') throw error;
      output = error.stdout;
    }
    try {
      const parsed = JSON.parse(output);
      if (parsed?.isError === true || parsed?.error || parsed?.ok === false || parsed?.success === false) {
        const providerFailure = providerFailureDetail(parsed);
        throw runtimeFailure('mcp_tool_failed', { stdout: boundedJson(parsed), protectedValues: [apiKey, ...Object.values(environmentVariables || {})], toolErrorCode: providerFailure.toolErrorCode, detail: providerFailure.detail });
      }
      return parsed;
    } catch (error) {
      if (String(error?.message || error) === 'mcp_tool_failed') throw error;
      return output.trim();
    }
  }, { runtimeRoot, binary, runCommand });
}

export async function diagnoseMcpConnection(connection, { apiKey, environmentVariables = {}, toolName = null, arguments: toolArguments = {}, binary = null, runtimeRoot = null, runCommand = run } = {}) {
  try {
    if (toolName) {
      await invokeMcpTool(connection, { apiKey, environmentVariables, toolName, arguments: toolArguments, binary, runtimeRoot, runCommand });
      return { ok: true, diagnostic: null };
    }
    const tools = await discoverMcpTools(connection, { apiKey, environmentVariables, binary, runtimeRoot, runCommand });
    return { ok: true, diagnostic: null, toolCount: tools.length };
  } catch (error) {
    return { ok: false, error: publicMcpError(error, toolName ? 'mcp_tool_failed' : 'mcp_runtime_failed'), ...publicMcpFailureDetail(error, [apiKey, ...Object.values(environmentVariables || {})]) };
  }
}

export const __test__ = { appendTail, renderedStream, run, configFor, resolveMcporterRuntime, diagnosticText, defaultStreamCaptureBytes: DEFAULT_STREAM_CAPTURE_BYTES };
