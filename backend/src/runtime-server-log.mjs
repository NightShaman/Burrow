import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { boundedRedactedValue, redactProtectedText } from './redaction.mjs';

const MAX_EVENT_CHARS = 12_000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_BACKUPS = 3;
const MAX_REPEAT_KEYS = 256;
const RESERVED = new Set(['at', 'service', 'event', 'level', 'component']);
const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);
const ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'DOMException', 'AbortError', 'TimeoutError', 'SystemError']);
const INFRA_CODES = new Set([
  'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAGAIN', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET',
  'EEXIST', 'EHOSTUNREACH', 'EIO', 'EISDIR', 'EMFILE', 'ENETDOWN', 'ENETUNREACH', 'ENFILE',
  'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTFOUND', 'EPERM', 'EPIPE', 'EROFS', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EAI_AGAIN',
  'ABORT_ERR', 'ERR_ABORTED', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_WORKER_OUT_OF_MEMORY',
  '08000', '08003', '08006', '23505', '25006', '28000', '28P01', '40001', '40P01', '42P01',
  '53300', '53400', '57P01', '57P02', '57P03', '58000', '58030',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_INVALID_URL', 'ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWT_INVALID', 'ERR_JWS_INVALID', 'ERR_JOSE_ALG_NOT_ALLOWED', 'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JWK_INVALID', 'ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);
// Exact classifications owned by these producers, not a pattern for accepting
// provider prose or arbitrary token-shaped values as an internal error code.
const RUNTIME_CODES = new Set([
  // scripts/burrow-ui.mjs, http-operational-log.mjs and background-lifecycle.mjs.
  'operation_failed', 'callback_failed', 'server_log_write_failed', 'listener_failed',
  'http_request_failed', 'http_response_failed', 'operation_result_failed', 'run_failed',
  'chat_command_failed', 'chat_run_failed', 'task_execution_pre_dispatch_recovery_failed',
  'runtime_database_already_owned', 'runtime_database_ownership_failed', 'background_operation_failed',
  'infrastructure_failed', 'receipt_storage_failed', 'managed_skill_sync_failed',
  'codex_client_version_refresh_failed', 'model_catalog_refresh_failed', 'mcp_catalog_refresh_failed',
  // brain-embedding-provider.mjs / postgres-brain-embeddings.mjs.
  'brain_embedding_provider_http_failed', 'brain_embedding_provider_request_failed',
  'brain_embedding_invalid_vector', 'brain_embedding_input_invalid', 'brain_embedding_connection_missing',
  'brain_embedding_provider_unsupported', 'brain_embedding_api_key_required', 'brain_embedding_invalid_response',
  'brain_embedding_storage_failed', 'brain_embedding_worker_session_lost',
  // mcporter-adapter.mjs and skill-git-sync.mjs.
  'mcp_connection_disabled', 'mcp_transport_invalid', 'mcp_tool_name_invalid', 'mcp_discovery_invalid_response',
  'mcp_runtime_timeout', 'mcp_runtime_failed', 'mcp_tool_failed', 'mcp_response_too_large',
  'mcp_provider_state_storage_failed', 'mcp_provider_state_hydration_failed',
  'skill_local_changes', 'skill_sync_timeout', 'skill_sync_failed', 'skill_package_cleanup_failed',
  // mod-host.mjs / mod-runtime.mjs / mod-management.mjs / mod-distribution.mjs.
  'mod_directory_unavailable', 'mod_manifest_invalid', 'mod_directory_unreadable', 'mod_activation_failed', 'mod_activation_timeout', 'mod_cleanup_failed',
  'mod_host_exited', 'mod_host_error', 'mod_host_send_failed', 'mod_host_closed', 'mod_host_disconnected',
  'mod_host_unavailable', 'mod_busy', 'mod_capability_cancelled', 'mod_capability_unavailable',
  'mod_route_failed', 'mod_route_response_invalid', 'mod_route_timeout', 'mod_tool_cancelled',
  'mod_tool_description_invalid', 'mod_route_description_invalid', 'mod_route_parameter_invalid',
  'mod_store_required', 'mod_store_cleanup_failed', 'mod_management_caller_required',
  'system_controller_registration_failed', 'system_controller_registration_invalid',
  'remote_configuration_controller_unavailable', 'remote_configuration_invalid', 'remote_configuration_failed',
  'remote_configuration_send_failed', 'remote_configuration_timeout', 'remote_trace_context_invalid',
  'remote_filesystem_aborted', 'remote_filesystem_request_invalid', 'remote_filesystem_result_invalid',
  'remote_filesystem_send_failed', 'remote_native_filesystem_controller_unavailable',
  'remote_host_description_failed', 'remote_host_description_invalid', 'remote_host_description_send_failed',
  'remote_host_description_timeout', 'remote_process_aborted', 'remote_process_cancel_timeout',
  'remote_process_controller_unavailable', 'remote_process_failed', 'remote_process_request_invalid',
  'remote_process_result_invalid', 'remote_process_send_failed',
  'mod_authority_forbidden', 'mod_not_found', 'mod_id_invalid', 'mod_source_not_resolved',
  'mod_version_unavailable', 'mod_install_in_progress', 'mod_archive_resources_exceeded',
  'mod_archive_resources_unavailable', 'mod_management_failed', 'mod_management_interrupted',
  'mod_management_input_invalid', 'mod_management_unavailable', 'mod_management_storage_failed',
  'mod_management_operation_not_found', 'mod_operation_recovery_failed',
  'mod_source_authentication_failed', 'mod_source_timeout', 'mod_source_git_failed',
  'mod_source_manifest_invalid', 'mod_source_version_invalid', 'mod_source_manifest_version_mismatch',
  'mod_source_tag_changed', 'mod_source_refresh_failed', 'mod_source_storage_failed',
  'secret_reference_provider_unavailable',
  // Provider catalog and logical model-result whole codes.
  'model_discovery_failed', 'model_discovery_invalid', 'model_auth_refresh_failed',
  'model_auth_refresh_invalid_grant', 'model_auth_refresh_token_reused', 'model_auth_refresh_token_expired',
  'model_auth_refresh_token_invalidated', 'model_auth_refresh_token_revoked',
  'model_auth_refresh_missing_access_token', 'model_auth_refresh_provider_unsupported',
  'model_auth_refresh_token_required', 'model_connection_not_found', 'model_connection_auth_required',
  'member_catalog_empty', 'openai_oauth_access_token_required', 'openai_oauth_refresh_token_required',
  'openai_oauth_expires_at_required', 'codex_client_version_npm_failed', 'codex_client_version_github_failed',
  'codex_client_version_npm_invalid', 'codex_client_version_github_invalid', 'models_dev_catalog_failed',
  'model_response_malformed_envelope', 'model_response_provider_error', 'model_response_empty',
  'model_response_incomplete', 'model_response_malformed_json', 'model_response_failed',
  'model_response_missing_status', 'model_response_missing_finish_reason', 'model_response_length',
  'model_response_content_filter', 'model_response_budget_exhausted', 'invalid_model_response_budget',
  // otel-runtime.mjs.
  'otel_runtime_start_failed', 'otel_runtime_shutdown_failed', 'otel_runtime_shutdown_timeout',
  'opentelemetry_runtime_closed', 'opentelemetry_runtime_start_failed',
  // ui-auth-diagnostics.mjs / ui-oidc-auth.mjs: whole messages only. Upstream
  // HTTP statuses must be supplied as numeric fields, never parsed from prose.
  'auth_internal_error', 'auth_configuration_missing', 'oidc_issuer_required', 'oidc_session_secret_required',
  'oidc_discovery_failed', 'oidc_discovery_invalid_response', 'oidc_discovery_issuer_mismatch',
  'oidc_callback_missing_code_or_state', 'oidc_state_invalid', 'oidc_provider_access_denied',
  'oidc_provider_login_required', 'oidc_provider_interaction_required', 'oidc_provider_consent_required',
  'oidc_provider_server_error', 'oidc_provider_temporarily_unavailable', 'oidc_token_exchange_failed',
  'oidc_token_response_invalid', 'oidc_id_token_missing', 'oidc_token_issuer_mismatch',
  'oidc_token_audience_mismatch', 'oidc_token_expired', 'oidc_token_claim_invalid',
  'oidc_token_signature_invalid', 'oidc_token_invalid', 'oidc_jwks_failed', 'oidc_nonce_invalid',
  'oidc_verified_email_required', 'oidc_email_not_allowed', 'oidc_domain_not_allowed',
  'oidc_session_invalid', 'oidc_session_authorization_changed', 'oidc_cookie_invalid',
  'oidc_network_timeout', 'oidc_network_failed', 'oidc_endpoint_invalid',
]);
const guardedStreams = new WeakSet();
const REPEAT_SCOPE = ['mod', 'modId', 'ownerModId', 'provider', 'providerId', 'connection', 'connectionId', 'dependency', 'sourceId', 'skillId', 'signal'];
const CORRELATION_FIELDS = ['requestId', 'traceId', 'spanId', 'runId', 'sessionId', 'agentId', 'taskId', 'turnId', 'jobId', 'operationId'];
const HTTP_STATUS_FIELDS = ['httpStatus', 'status', 'statusCode', 'upstreamStatus', 'resultStatus'];
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE', 'OTHER']);

function read(object, key) { try { return object?.[key]; } catch { return undefined; } }
function bounded(value, limit = 512) {
  const source = typeof value === 'string' ? value.trim() : '';
  return source.length <= limit ? source : `${source.slice(0, Math.max(0, limit - 12))} [truncated]`;
}
function positiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
function recognizedCode(value) { return INFRA_CODES.has(value) || RUNTIME_CODES.has(value); }
function safeCode(value, fallback) { return recognizedCode(value) ? value : fallback; }
function httpStatus(value) { return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined; }
function safeLabel(value, fallback, protectedValues = []) {
  if (typeof value !== 'string' || value.length > 64_000 || !value.trim()) return fallback;
  return boundedRedactedValue(redactProtectedText(value, protectedValues).trim(), { maxChars: 120, maxStringChars: 120 });
}
function stripLocation(value) {
  if (value.length > 64_000) return '[operational location omitted: too large]';
  const source = value.trim();
  try {
    const url = new URL(source);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  } catch {
    return source.split(/[?#]/, 1)[0].replace(/^((?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/)[^/]*@/, '$1');
  }
}
function frameStack(value, protectedValues = []) {
  if (typeof value !== 'string' || value.length > 64_000) return '';
  const frames = [];
  let chars = 0;
  // Only V8-style location frames are diagnostic data. Never retain the first
  // line, source excerpts, parser pointers, causes, or a thrown value's prose.
  for (const line of redactProtectedText(value, protectedValues).slice(0, 32_000).split('\n')) {
    const match = /^\s*at\s+(?:(.{1,120})\s+\()?((?:file:\/\/|https?:\/\/|\/|node:|[A-Za-z]:\\)[^\r\n]*?):(\d{1,9}):(\d{1,9})\)?\s*$/.exec(line);
    if (!match) continue;
    const name = match[1] && /^[\w$.[\]<> -]+$/.test(match[1]) ? `${match[1]} (` : '';
    const location = bounded(stripLocation(match[2]), 256);
    const frame = boundedRedactedValue(`    at ${name}${location}:${match[3]}:${match[4]}${name ? ')' : ''}`, { maxChars: 512, maxStringChars: 512 });
    if (chars + frame.length + 1 > 1_800) break;
    frames.push(frame);
    chars += frame.length + 1;
    if (frames.length === 8) break;
  }
  return frames.join('\n');
}

/** Operational projection, not serialization of an exception or provider reply. */
export function safeOperationalError(error, fallback = 'operation_failed', { protectedValues = [] } = {}) {
  const cause = read(error, 'cause');
  // An explicit outer classification (notably failed task-claim recovery) must
  // win over the lower-level cause. Do not trim, split, or search any message.
  const errorCode = [read(error, 'errorCode'), read(error, 'code'), read(error, 'message'),
    read(cause, 'errorCode'), read(cause, 'code'), read(cause, 'message')].find(recognizedCode)
    ?? safeCode(fallback, 'operation_failed');
  const name = read(error, 'errorType') ?? read(error, 'name');
  const statuses = {};
  for (const key of HTTP_STATUS_FIELDS) {
    const status = httpStatus(read(error, key));
    if (status !== undefined) statuses[key] = status;
  }
  return {
    errorCode,
    errorType: ERROR_TYPES.has(name) ? name : 'Error',
    stack: frameStack(read(error, 'stack'), protectedValues),
    ...statuses,
  };
}

function operationalFields(fields, type, protectedValues) {
  const state = { remaining: MAX_EVENT_CHARS, nodes: 300, seen: new WeakSet() };
  const leaf = value => {
    // Redaction precedes truncation, so a truncated <secret> envelope cannot
    // leak its body. Oversized untrusted prose is omitted without scanning it.
    if (value.length > 64_000) return '[operational field omitted: too large]';
    const result = boundedRedactedValue(value, { maxChars: state.remaining, maxStringChars: 2_000, protectedValues });
    state.remaining = Math.max(0, state.remaining - result.length);
    return result;
  };
  const visit = (item, depth = 0, field = '') => {
    if (state.nodes-- <= 0 || state.remaining <= 0 || depth > 5) return '[metadata traversal truncated]';
    const key = field.replace(/[-_]/g, '').toLowerCase();
    if (/^(?:cookie|cookies|setcookie|state|oauthstate|oidcstate|code|authorizationcode|authcode|nonce|codeverifier|codechallenge)$/.test(key)) return '[redacted]';
    if (key === 'errors') {
      if (!Array.isArray(item)) return visit(safeOperationalError(item, 'operation_failed', { protectedValues }), depth + 1);
      return item.slice(0, 20).map(error => visit(safeOperationalError(error, 'operation_failed', { protectedValues }), depth + 1));
    }
    if (item instanceof Error || /(?:error|exception)$/.test(key) || key === 'err' || key === 'cause') return visit(safeOperationalError(item, 'operation_failed', { protectedValues }), depth + 1);
    if (key === 'stack') return leaf(frameStack(item, protectedValues));
    if (key === 'errorcode') return leaf(safeCode(item, 'operation_failed'));
    if (key === 'errortype') return ERROR_TYPES.has(item) ? item : 'Error';
    if (typeof item === 'string') {
      if (/^(?:message|errormessage|description|errordescription|detail|details|stdout|stderr|body|responsebody|diagnostic|diagnostics)$/.test(key) && !(type === 'mod_log' && key === 'message')) return '[operational prose omitted]';
      if (key === 'reason' && (item.length > 128 || !/^[a-z][a-z0-9]*(?:[_.:-][a-z0-9]+)*$/.test(item))) return '[operational prose omitted]';
      if (/(?:url|uri|path|href|endpoint|issuer)$/.test(key) || /^(?:route|location|redirect|callback|returnto)$/.test(key)) return leaf(stripLocation(item));
      return leaf(item);
    }
    if (item === null || item === undefined || typeof item === 'boolean') { state.remaining -= 5; return item; }
    if (typeof item === 'number') { state.remaining -= 24; return Number.isFinite(item) ? item : null; }
    if (typeof item !== 'object') return '[unsupported operational value]';
    if (depth >= 5 || state.remaining <= 0 || state.seen.has(item)) return '[metadata traversal truncated]';
    state.seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 20).map(value => visit(value, depth + 1));
    const result = Object.create(null);
    let count = 0;
    for (const name in item) {
      if (!Object.hasOwn(item, name) || name === '__proto__' || (depth === 0 && RESERVED.has(name))) continue;
      if (count++ >= 30 || state.remaining <= 0 || state.nodes <= 0) { result.__metadataTruncated = 'keys or aggregate content omitted'; break; }
      const safeName = redactProtectedText(name, protectedValues).slice(0, 256);
      state.remaining -= safeName.length;
      result[safeName] = visit(read(item, name), depth + 1, name);
    }
    return result;
  };
  return boundedRedactedValue(visit(fields && typeof fields === 'object' ? fields : {}), {
    maxChars: MAX_EVENT_CHARS, maxStringChars: 2_000, maxDepth: 7, maxItems: 20, maxKeys: 30, protectedValues,
  });
}
function defaultLevel(type) {
  if (type === 'http_request' || type === 'client_disconnect') return 'debug';
  if (/(?:^|[_.:-])(?:failed|failure|error|exception|rejection|rejected|uncaughtexception|unhandledrejection)(?:[_.:-]|$)/i.test(type)) return 'error';
  return 'info';
}

export function runtimeServerLogPath(runtimeRoot) {
  return path.join(path.resolve(runtimeRoot), 'logs', 'server-events.jsonl');
}

export function createRuntimeServerLogger({
  runtimeRoot, service = 'burrow-ui', now = () => new Date(),
  stdout = process.stdout, stderr = process.stderr, protectedValues = [],
  maxLogBytes = MAX_LOG_BYTES, maxBackups = MAX_BACKUPS, repeatIntervalMs = 60_000,
} = {}) {
  const filePath = runtimeServerLogPath(runtimeRoot);
  const directory = path.dirname(filePath);
  const byteLimit = positiveInteger(maxLogBytes, MAX_LOG_BYTES);
  const backups = positiveInteger(maxBackups, MAX_BACKUPS, 0, 100);
  const repeatInterval = positiveInteger(repeatIntervalMs, 60_000);
  const factoryProtectedValues = Array.isArray(protectedValues) ? protectedValues.filter(value => typeof value === 'string' && value) : [];
  let fileQueue = Promise.resolve();
  let consoleQueue = Promise.resolve();
  let repeatTimer;
  const repeats = new Map();

  function timestamp() {
    try { const value = now(); return new Date(value).toISOString(); }
    catch { return new Date().toISOString(); }
  }
  function writeConsole(entry) {
    const stream = entry.level === 'info' ? stdout : stderr;
    const line = `${JSON.stringify(entry)}\n`;
    consoleQueue = consoleQueue.then(() => new Promise(resolve => {
      try {
        if (!stream || typeof stream.write !== 'function') { resolve(); return; }
        // Writable emits 'error' after invoking its failed write callback. Keep
        // one guard per stream, not a transient listener removed too early.
        if (typeof stream.on === 'function' && !guardedStreams.has(stream)) {
          stream.on('error', () => {});
          guardedStreams.add(stream);
        }
        const result = stream.write(line, () => resolve());
        if (result && typeof result.then === 'function') result.then(resolve, resolve);
        else if (stream.write.length < 2) resolve();
      } catch { resolve(); }
    })).catch(() => {});
    return consoleQueue;
  }
  function summary(state, at = timestamp()) {
    if (!state.suppressed) return;
    const representative = { ...state.entry };
    const firstCorrelation = {};
    for (const name of CORRELATION_FIELDS) {
      if (representative[name] === undefined) continue;
      firstCorrelation[name] = representative[name];
      delete representative[name];
    }
    writeConsole({
      ...representative, at, repeatSummary: true, representative: 'first_event', firstAt: state.entry.at,
      ...(Object.keys(firstCorrelation).length ? { firstCorrelation } : {}), suppressedCount: state.suppressed,
    });
    state.suppressed = 0;
    state.visibleAt = Date.parse(at);
  }
  function scheduleSummaries() {
    clearTimeout(repeatTimer);
    let due = Infinity;
    for (const state of repeats.values()) if (state.suppressed) due = Math.min(due, state.visibleAt + repeatInterval);
    if (due === Infinity) return;
    repeatTimer = setTimeout(() => {
      const at = timestamp();
      const time = Date.parse(at);
      for (const state of repeats.values()) if (state.suppressed && time - state.visibleAt >= repeatInterval) summary(state, at);
      scheduleSummaries();
    }, Math.max(1, Math.min(2_147_483_647, due - Date.parse(timestamp()))));
    repeatTimer.unref?.();
  }
  function consoleEvent(entry) {
    if (entry.level === 'debug') return;
    if (entry.level !== 'warn' && entry.level !== 'error') {
      if (/(?:^|[_.:-])(?:recovered|recovery|restored|reconnected)(?:[_.:-]|$)/.test(entry.event)) {
        for (const [key, state] of repeats) {
          const matches = state.entry.component === entry.component && REPEAT_SCOPE.every(name =>
            entry[name] === undefined || entry[name] === state.entry[name]);
          if (matches) { summary(state, entry.at); repeats.delete(key); }
        }
        scheduleSummaries();
      }
      writeConsole(entry);
      return;
    }
    // Omit correlation IDs, timestamps, messages and stacks. Cardinality and
    // retained state are both bounded, even when a provider invents new IDs.
    const identity = ['reason', 'reasonCode', 'errorCode', 'errorType', ...REPEAT_SCOPE, 'stage', 'phase', 'operation', 'action', 'classification'];
    const key = JSON.stringify([entry.service, entry.event, entry.level, entry.component,
      ...identity.map(name => typeof entry[name] === 'string' ? entry[name].slice(0, 128) : null),
      // HTTP producers supply projected route templates and numeric statuses.
      // Keep these distinctions without retaining unbounded request identities.
      typeof entry.route === 'string' && entry.route.length <= 512 && /^\/[A-Za-z0-9_:/.-]*$/.test(entry.route) ? entry.route : null,
      HTTP_METHODS.has(entry.method) ? entry.method : null,
      ...HTTP_STATUS_FIELDS.map(name => httpStatus(entry[name]) ?? null),
      entry.error?.errorCode, entry.error?.errorType,
      ...HTTP_STATUS_FIELDS.map(name => httpStatus(entry.error?.[name]) ?? null)]);
    const existing = repeats.get(key);
    if (existing) {
      existing.suppressed += 1;
      if (Date.parse(entry.at) - existing.visibleAt >= repeatInterval) summary(existing, entry.at);
    } else {
      if (repeats.size >= MAX_REPEAT_KEYS) {
        const [oldKey, oldState] = repeats.entries().next().value;
        summary(oldState, entry.at);
        repeats.delete(oldKey);
      }
      repeats.set(key, { entry, visibleAt: Date.parse(entry.at), suppressed: 0 });
      writeConsole(entry);
    }
    scheduleSummaries();
  }

  async function rotate() {
    // Also remove backups left by the previous off-by-one implementation.
    for (const name of await fs.readdir(directory)) {
      const match = /^server-events\.jsonl\.(\d+)$/.exec(name);
      if (match && Number(match[1]) > backups) await fs.rm(path.join(directory, name), { force: true });
    }
    if (!backups) { await fs.rm(filePath, { force: true }); return; }
    await fs.rm(`${filePath}.${backups}`, { force: true });
    for (let index = backups - 1; index >= 1; index -= 1) {
      const from = `${filePath}.${index}`;
      try {
        // Do not follow a pre-existing symlink while repairing permissions.
        const handle = await fs.open(from, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try { await handle.chmod(0o600); } finally { await handle.close(); }
        await fs.rename(from, `${filePath}.${index + 1}`);
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    await fs.rename(filePath, `${filePath}.1`);
  }
  async function append(line) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw Object.assign(new Error(), { code: 'ENOTDIR' });
    await fs.chmod(directory, 0o700);
    const open = () => fs.open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0), 0o600);
    let handle = await open();
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw Object.assign(new Error(), { code: 'EISDIR' });
      await handle.chmod(0o600);
      // Re-stat on every append: our writes and external runtime growth count,
      // using UTF-8 bytes rather than chars. One oversized event remains atomic.
      if (stat.size > 0 && stat.size + Buffer.byteLength(line, 'utf8') > byteLimit) {
        await handle.close(); handle = undefined;
        await rotate();
        handle = await open();
        await handle.chmod(0o600);
      }
      await handle.writeFile(line, 'utf8');
    } finally { await handle?.close(); }
  }
  function event(type, fields = {}, options = {}) {
    try {
      const level = read(options, 'level');
      const component = read(options, 'component');
      // Exact credentials are supplied by the owning boundary, not guessed from
      // ordinary mod prose. Per-event values supplement, not replace, defaults.
      const suppliedProtectedValues = read(options, 'protectedValues');
      const eventProtectedValues = Array.isArray(suppliedProtectedValues)
        ? factoryProtectedValues.concat(suppliedProtectedValues.filter(value => typeof value === 'string' && value))
        : factoryProtectedValues;
      const eventType = safeLabel(type, 'server_event', eventProtectedValues);
      const entry = {
        ...operationalFields(fields, eventType, eventProtectedValues),
        at: timestamp(), service: safeLabel(service, 'burrow-ui', eventProtectedValues), event: eventType,
        level: LEVELS.has(level) ? level : defaultLevel(eventType),
        component: safeLabel(component, 'runtime', eventProtectedValues),
      };
      consoleEvent(entry); // Never wait for, or depend on, the durable sink.
      const line = `${JSON.stringify(entry)}\n`;
      fileQueue = fileQueue.then(() => append(line)).catch(error => {
        try {
          consoleEvent({ at: timestamp(), service: entry.service, event: 'server_log_write_failed', level: 'error', component: 'runtime-log', ...safeOperationalError(error, 'server_log_write_failed', { protectedValues: eventProtectedValues }) });
        } catch { /* A failed diagnostic must not re-reject the durable queue. */ }
      });
    } catch {
      // Hostile field getters/proxies and failed adapters must not introduce a
      // synchronous throw or an unhandled rejected log promise.
    }
    return Promise.all([fileQueue, consoleQueue]).then(() => undefined, () => undefined);
  }
  async function flush() {
    await fileQueue;
    clearTimeout(repeatTimer);
    for (const state of repeats.values()) summary(state);
    await consoleQueue;
  }
  return { filePath, event, flush };
}
