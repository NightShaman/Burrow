import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const CHILD_PATH = fileURLToPath(new URL('./mod-host-child.mjs', import.meta.url));
// A hung extension handler must not hold Burrow core's HTTP request open forever.
export const DEFAULT_MOD_ROUTE_TIMEOUT_MS = 30_000;
// Leave enough room for the gateway's TERM -> KILL -> forced-settlement path,
// while still bounding a lost terminal response at the core/mod boundary.
export const SYSTEM_PROCESS_WATCHDOG_GRACE_MS = 1_500;

function finiteTimeout(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
function hostError(code, detail = '') {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  return error;
}
function safeErrorDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const parsed = JSON.parse(JSON.stringify(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
function capabilityErrorEnvelope(error, fallback = 'mod_capability_failed') {
  const message = String(error?.message || '');
  const code = /^[a-z0-9_]+$/.test(message) ? message : fallback;
  return { error: code, ...(safeErrorDetails(error?.details) ? { errorDetails: safeErrorDetails(error.details) } : {}) };
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const NATIVE_FILESYSTEM_TOOLS = new Set(['files_read', 'files_list', 'files_find', 'files_inspect', 'files_search', 'files_write', 'files_edit']);
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
function traceContextCarrier(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw hostError('remote_trace_context_invalid');
  const traceparent = String(value.traceparent || '').trim().toLowerCase();
  const tracestate = value.tracestate == null ? '' : String(value.tracestate).trim();
  if (!TRACEPARENT.test(traceparent) || traceparent.slice(3, 35) === '0'.repeat(32) || traceparent.slice(36, 52) === '0'.repeat(16)
    || (tracestate && (tracestate.length > 512 || /[\r\n]/.test(tracestate)))) throw hostError('remote_trace_context_invalid');
  return { traceparent, ...(tracestate ? { tracestate } : {}) };
}
function validateJsonBody(value) {
  if (value === undefined) throw hostError('mod_route_response_invalid');
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw hostError('mod_route_response_invalid'); }
  if (encoded === undefined) throw hostError('mod_route_response_invalid');
  try { return JSON.parse(encoded); } catch { throw hostError('mod_route_response_invalid'); }
}
function validateResponseHeaders(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw hostError('mod_route_response_invalid');
  const output = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!HEADER_NAME.test(name)) throw hostError('mod_route_response_invalid');
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.length || values.some((entry) => typeof entry !== 'string' || /[\r\n]/.test(entry))) throw hostError('mod_route_response_invalid');
    output[name.toLowerCase()] = Array.isArray(raw) ? [...values] : values[0];
  }
  return output;
}
// Mod HTTP responses remain JSON-only. Streaming, buffers and arbitrary structured
// clone values are deliberately outside the generic mod-host contract.
function validateSystemProcessResult(value, operationId, targetId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.tool !== 'shell_exec'
    || value.operationId !== operationId || value.targetId !== targetId || typeof value.ok !== 'boolean') throw hostError('remote_process_result_invalid');
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw hostError('remote_process_result_invalid'); }
  if (encoded === undefined) throw hostError('remote_process_result_invalid');
  try { return JSON.parse(encoded); } catch { throw hostError('remote_process_result_invalid'); }
}

function jsonObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw hostError(code);
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw hostError(code); }
  if (encoded === undefined) throw hostError(code);
  let parsed;
  try { parsed = JSON.parse(encoded); } catch { throw hostError(code); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw hostError(code);
  return parsed;
}

function validateSystemFilesystemResult(value, operationId, targetId, tool) {
  const result = jsonObject(value, 'remote_filesystem_result_invalid');
  if (result.tool !== tool || typeof result.ok !== 'boolean' || result.operationId !== operationId || result.targetId !== targetId) {
    throw hostError('remote_filesystem_result_invalid');
  }
  return result;
}

function validateRouteResult(value) {
  const envelope = value && typeof value === 'object' && !Array.isArray(value) && ('status' in value || 'headers' in value || 'body' in value);
  if (!envelope) return validateJsonBody(value);
  const status = value.status === undefined ? 200 : value.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) throw hostError('mod_route_response_invalid');
  const body = value.body === undefined ? { ok: true } : validateJsonBody(value.body);
  const headers = validateResponseHeaders(value.headers);
  return { status, ...(headers === undefined ? {} : { headers }), body };
}

const STORE_METHODS = Object.freeze({
  settings: Object.freeze({ get: 'get', set: 'set', delete: 'delete' }),
  secrets: Object.freeze({ get: 'getSecret', set: 'setSecret', clear: 'clearSecret', has: 'hasSecret' }),
});

export function startModHost({ mod, store, logger = console, systemCapability = null, modAuthority = null, capabilities = null, capabilityTimeoutMs = null, modelCapabilityTimeoutMs = null, activationTimeoutMs = 10_000, routeTimeoutMs = DEFAULT_MOD_ROUTE_TIMEOUT_MS, cleanupTimeoutMs = 5_000, systemProcessWatchdogGraceMs = SYSTEM_PROCESS_WATCHDOG_GRACE_MS, onUnavailable = null, onSystemControllerReady = null, onSystemControllerUnavailable = null } = {}) {
  if (!store) throw hostError('mod_store_required', mod?.id);
  const child = fork(CHILD_PATH, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
  const pending = new Map();
  let sequence = 0;
  let activationSettled = false;
  let stopped = false;
  let closing = false;
  let admissionsPaused = false;
  let closePromise = null;
  let shutdownError = null;
  let unavailable = false;
  let systemControllerReady = false;
  const controllerInstanceId = systemCapability ? randomUUID() : null;
  const pendingSystemProcess = new Map();
  const pendingSystemConfiguration = new Map();
  const pendingSystemHostDescriptions = new Map();
  const activeCapabilities = new Map();
  const cancelCapabilities = () => { for (const { controller } of activeCapabilities.values()) controller.abort(hostError("mod_capability_shutdown")); activeCapabilities.clear(); capabilities?.dispose?.(); };
  async function serviceCapabilityRequest(message) {
    const requestId = String(message?.requestId || "");
    if (!requestId || requestId.length > 128 || closing || stopped || !child.connected) return;
    // Never replace the controller of an in-flight request with a forged ID.
    if (activeCapabilities.has(requestId)) return;
    if (admissionsPaused) {
      child.send({ type: "capability-result", requestId, error: "mod_busy" }, () => {}); return;
    }
    const controller = new AbortController();
    const parentInvocationId = String(message.parentInvocationId || "");
    const invocation = pending.get(parentInvocationId);
    const parentRequired = message.method === 'readRuntimeDiagnostics' || message.method.startsWith('management');
    if (parentRequired && parentInvocationId && !invocation) {
      child.send({ type: "capability-result", requestId, error: message.method.startsWith('management') ? 'mod_management_caller_required' : 'mod_diagnostic_caller_required' }, () => {}); return;
    }
    if (!parentRequired && parentInvocationId && !invocation) { child.send({ type: "capability-result", requestId, error: "mod_capability_cancelled" }, () => {}); return; }
    if (activeCapabilities.size >= 4 || !capabilities || !["managementInventory", "managementSubmit", "managementOperation", "readRuntimeDiagnostics", "listAgents", "getOperatorIdentity", "getOperatorTimezone", "listConversations", "readConversation", "listModels", "generateText", "submitGeneration", "readGeneration", "submitExternalTurn", "readExternalTurn", "cancelExternalTurn", "createExternalSession", "readExternalSessionModel", "setExternalSessionModel", "getForgeImageStatus", "createForgeImage", "readForgeImageJob", "listScheduledJobs", "readScheduledJob", "createScheduledJob", "updateScheduledJob", "deleteScheduledJob", "listScheduledJobRuns", "triggerScheduledJob"].includes(message.method)) {
      child.send({ type: "capability-result", requestId, error: "mod_capability_unavailable" }, () => {}); return;
    }
    // Capability methods validate their own inputs; transport does not impose a
    // smaller arbitrary envelope than the model/provider or archive reader.
    activeCapabilities.set(requestId, { controller, parentInvocationId, method: message.method, startedAt: Date.now() });
    const configuredTimeout = message.method === "generateText" ? modelCapabilityTimeoutMs : capabilityTimeoutMs;
    const deadline = Number(configuredTimeout);
    const timer = Number.isFinite(deadline) && deadline > 0
      ? setTimeout(() => controller.abort(hostError("mod_capability_timeout")), deadline)
      : null;
    let onAbort;
    try {
      // Install rejection before invoking even a synchronous reader. Deferring
      // invocation also catches synchronous throws and already-aborted signals.
      const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason || hostError("mod_capability_cancelled"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      const result = await Promise.race([cancelled, Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        let caller = null;
        const management = message.method.startsWith('management');
        let parent = null;
        if (message.method === 'readRuntimeDiagnostics' || management) {
          if (management && !(mod.systemCapabilities || []).includes('mod-management-v1')) throw hostError('mod_capability_unavailable');
          parent = pending.get(String(message.parentInvocationId || ''));
          if (!parent?.trustedCaller || !parent.routeId?.startsWith('tool:')) throw hostError(management ? 'mod_management_caller_required' : 'mod_diagnostic_caller_required');
          caller = parent.trustedCaller;
        }
        const assertCallerActive = () => {
          if (controller.signal.aborted || !parent || pending.get(String(message.parentInvocationId || '')) !== parent) throw hostError('mod_management_caller_required');
        };
        return capabilities[message.method](message.input, { signal: controller.signal, caller, assertCallerActive, waitForCaller: parent?.completed });
      })]);
      if (result === undefined) throw hostError("mod_capability_output_invalid");
      if (!controller.signal.aborted && !closing && child.connected) child.send({ type: "capability-result", requestId, result }, () => {});
    } catch (error) {
      // Adapter abort errors can win the race; preserve the host cancellation cause.
      if (controller.signal.aborted) error = controller.signal.reason || hostError("mod_capability_cancelled");
      if (!closing && child.connected) child.send({ type: "capability-result", requestId, ...capabilityErrorEnvelope(error) }, () => {});
    } finally { controller.signal.removeEventListener("abort", onAbort); clearTimeout(timer); if (activeCapabilities.get(requestId)?.controller === controller) activeCapabilities.delete(requestId); }
  }
  const cancelInvocationCapabilities = requestId => { for (const entry of activeCapabilities.values()) if (entry.parentInvocationId === requestId) entry.controller.abort(hostError("mod_capability_cancelled")); };
  const pendingSystemFilesystem = new Map();
  const rejectSystemProcesses = (code = 'remote_process_controller_unavailable') => {
    const error = hostError(code);
    for (const entry of pendingSystemProcess.values()) {
      clearTimeout(entry.watchdogTimer);
      entry.abortSignal?.removeEventListener?.('abort', entry.cancel);
      entry.reject(error);
    }
    pendingSystemProcess.clear();
    for (const entry of pendingSystemConfiguration.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pendingSystemConfiguration.clear();
    for (const entry of pendingSystemHostDescriptions.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pendingSystemHostDescriptions.clear();
  };
  const rejectSystemFilesystems = (code = 'remote_native_filesystem_controller_unavailable') => {
    const error = hostError(code);
    for (const entry of pendingSystemFilesystem.values()) {
      entry.abortSignal?.removeEventListener?.('abort', entry.cancel);
      entry.reject(error);
    }
    pendingSystemFilesystem.clear();
  };
  const revokeSystemController = (code) => {
    const shutdown = code === 'system_controller_shutdown';
    rejectSystemProcesses(shutdown ? 'remote_process_controller_closed' : 'remote_process_controller_unavailable');
    rejectSystemFilesystems(shutdown ? 'remote_native_filesystem_controller_closed' : 'remote_native_filesystem_controller_unavailable');
    if (!systemControllerReady) return;
    systemControllerReady = false;
    onSystemControllerUnavailable?.(code);
  };
  const markUnavailable = (code) => {
    if (unavailable || closing) return;
    unavailable = true;
    revokeSystemController(code);
    onUnavailable?.(code);
  };
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });

  const rejectPending = (error) => {
    for (const [requestId, entry] of pending) { cancelInvocationCapabilities(requestId); clearTimeout(entry.timer); entry.abortSignal?.removeEventListener('abort', entry.cancel); entry.reject(error); }
    pending.clear();
  };

  function replyStore(requestId, payload) {
    if (!child.connected || stopped || closing) return;
    child.send({ type: 'store-result', requestId, ...payload }, () => {});
  }

  async function serviceStoreRequest(message) {
    const requestId = String(message?.requestId || '');
    if (!requestId || stopped || closing) return;
    const method = STORE_METHODS[message.scope]?.[message.method];
    if (!method) {
      replyStore(requestId, { error: 'mod_store_method_invalid' });
      return;
    }
    try {
      const args = Array.isArray(message.args) ? message.args : [];
      // The store was constructed from the manifest ID. Any child-supplied modId
      // is deliberately ignored and can never select another namespace.
      const result = await store[method](...args);
      replyStore(requestId, { result });
    } catch {
      // Store failures are intentionally opaque: values, keys, SQL and secrets
      // must not be reflected into IPC errors or logs.
      replyStore(requestId, { error: 'mod_store_operation_failed' });
    }
  }

  let resolveActivation;
  let rejectActivation;
  const activated = new Promise((resolve, reject) => { resolveActivation = resolve; rejectActivation = reject; });
  const activationTimer = setTimeout(() => {
    if (activationSettled) return;
    activationSettled = true;
    const error = hostError('mod_activation_timeout', mod.id);
    rejectActivation(error);
    child.kill('SIGKILL');
  }, finiteTimeout(activationTimeoutMs, 10_000));

  child.on('message', (message) => {
    if (message?.type === 'capability-request') { serviceCapabilityRequest(message); return; }
    if (message?.type === 'capability-cancel') {
      const entry = activeCapabilities.get(message.requestId);
      if (entry) entry.controller.abort(hostError('mod_capability_cancelled'));
      return;
    }
    if (message?.type === 'store-request') {
      serviceStoreRequest(message);
      return;
    }
    if (message?.type === 'log') logger[message.level]?.(`[mod:${mod.id}] ${message.message}`);
    if (message?.type === 'system-controller-ready') {
      if (systemCapability !== 'execution-provider-v1' || message.protocol !== systemCapability || systemControllerReady) {
        markUnavailable('system_controller_registration_invalid');
        if (!stopped) child.kill('SIGKILL');
        return;
      }
      systemControllerReady = true;
      try {
        onSystemControllerReady?.(createSystemControllerProxy());
      } catch {
        // IPC EventEmitter callbacks are outside loadMods' async try/catch.
        // Reject activation here rather than crashing the core process.
        if (!activationSettled) {
          activationSettled = true;
          clearTimeout(activationTimer);
          rejectActivation(hostError('system_controller_registration_failed', mod.id));
        }
        markUnavailable('system_controller_registration_failed');
        if (!stopped) child.kill('SIGKILL');
      }
      return;
    }
    if (message?.type === 'system-controller-unregistered') {
      revokeSystemController('system_controller_unregistered');
      return;
    }
    if (message?.type === 'system-controller-filesystem-result') {
      if (message.protocol !== systemCapability || message.controllerInstanceId !== controllerInstanceId) return;
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const entry = pendingSystemFilesystem.get(requestId);
      if (!entry || message.operationId !== entry.operationId || message.targetId !== entry.targetId) return;
      pendingSystemFilesystem.delete(requestId);
      entry.abortSignal?.removeEventListener?.('abort', entry.cancel);
      if (message.ok !== true) entry.reject(hostError(typeof message.error === 'string' && /^[a-z0-9_]+$/.test(message.error) ? message.error : 'remote_filesystem_failed'));
      else {
        try { entry.resolve(validateSystemFilesystemResult(message.result, entry.operationId, entry.targetId, entry.tool)); }
        catch { entry.reject(hostError('remote_filesystem_result_invalid')); }
      }
      return;
    }
    if (message?.type === 'system-controller-configuration-result') {
      if (message.protocol !== systemCapability || message.controllerInstanceId !== controllerInstanceId) return;
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const entry = pendingSystemConfiguration.get(requestId);
      if (!entry) return;
      pendingSystemConfiguration.delete(requestId);
      clearTimeout(entry.timer);
      if (message.ok !== true) entry.reject(hostError(typeof message.error === 'string' && /^[a-z0-9_]+$/.test(message.error) ? message.error : 'remote_configuration_failed'));
      else entry.resolve(validateJsonBody(message.result));
      return;
    }
    if (message?.type === 'system-controller-host-description-result') {
      if (message.protocol !== systemCapability || message.controllerInstanceId !== controllerInstanceId) return;
      const entry = pendingSystemHostDescriptions.get(message.requestId);
      if (!entry || message.targetId !== entry.targetId) return;
      pendingSystemHostDescriptions.delete(message.requestId);
      clearTimeout(entry.timer);
      if (message.ok !== true) entry.reject(hostError('remote_host_description_failed'));
      else {
        try {
          const encoded = JSON.stringify(message.result);
          if (encoded === undefined || encoded.length > 8_192) throw new Error('invalid');
          const result = JSON.parse(encoded);
          entry.resolve(result === null ? null : jsonObject(result, 'remote_host_description_invalid'));
        } catch { entry.reject(hostError('remote_host_description_invalid')); }
      }
      return;
    }
    if (message?.type === 'system-controller-process-result') {
      if (message.protocol !== systemCapability || message.controllerInstanceId !== controllerInstanceId) return;
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const entry = pendingSystemProcess.get(requestId);
      if (!entry || message.operationId !== entry.operationId || message.targetId !== entry.targetId) return;
      pendingSystemProcess.delete(requestId);
      clearTimeout(entry.watchdogTimer);
      entry.abortSignal?.removeEventListener?.('abort', entry.cancel);
      if (message.ok !== true) entry.reject(hostError(typeof message.error === 'string' && /^[a-z0-9_]+$/.test(message.error) ? message.error : 'remote_process_failed'));
      else {
        try { entry.resolve(validateSystemProcessResult(message.result, entry.operationId, entry.targetId)); }
        catch { entry.reject(hostError('remote_process_result_invalid')); }
      }
      return;
    }
    if (message?.type === 'shutdown-failed') {
      shutdownError = hostError('mod_cleanup_failed', message.error);
      return;
    }
    if (!activationSettled && message?.type === 'activated') {
      activationSettled = true;
      clearTimeout(activationTimer);
      const routes = message.routes || [];
      routes.diagnosticsSupported = message.diagnostics === true;
      routes.secretReferenceSchemes = Array.isArray(message.secretReferenceSchemes) && message.secretReferenceSchemes.every(scheme => typeof scheme === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(scheme)) ? [...new Set(message.secretReferenceSchemes)] : [];
      routes.tools = message.tools;
      resolveActivation(routes);
      return;
    }
    if (!activationSettled && message?.type === 'activation-failed') {
      activationSettled = true;
      clearTimeout(activationTimer);
      rejectActivation(hostError('mod_activation_failed', message.error));
      return;
    }
    if (message?.type !== 'result') return;
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    cancelInvocationCapabilities(message.requestId);
    clearTimeout(entry.timer);
    entry.abortSignal?.removeEventListener('abort', entry.cancel);
    if (message.error) {
      const error = hostError('mod_route_failed');
      const status = Number(message.statusCode);
      error.statusCode = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
      entry.reject(error);
    } else {
      try { entry.resolve(entry.routeId?.startsWith('diagnostic-') || entry.routeId?.startsWith('secret-reference-') || entry.routeId?.startsWith('tool:') ? validateJsonBody(message.result) : validateRouteResult(message.result)); }
      catch { entry.reject(hostError('mod_route_response_invalid')); }
    }
  });

  child.on('disconnect', () => {
    const error = hostError('mod_host_disconnected');
    if (!activationSettled) {
      activationSettled = true;
      clearTimeout(activationTimer);
      rejectActivation(error);
    }
    rejectPending(error);
    cancelCapabilities();
    markUnavailable('mod_host_disconnected');
    if (!stopped) child.kill('SIGKILL');
  });
  child.once('exit', (code, signal) => {
    stopped = true;
    clearTimeout(activationTimer);
    const error = hostError('mod_host_exited', `${code ?? 'null'}:${signal || 'none'}`);
    if (!activationSettled) {
      activationSettled = true;
      rejectActivation(error);
    }
    rejectPending(error);
    cancelCapabilities();
    markUnavailable('mod_host_exited');
    resolveExit({ code, signal });
  });
  child.once('error', () => {
    const wrapped = hostError('mod_host_error');
    if (!activationSettled) {
      activationSettled = true;
      clearTimeout(activationTimer);
      rejectActivation(wrapped);
    }
    rejectPending(wrapped);
    cancelCapabilities();
    markUnavailable('mod_host_error');
    if (!stopped) child.kill('SIGKILL');
  });

  // Deliberately send only identity and entrypoint. Database ownership and path
  // remain in core and are never part of the child activation context.
  child.send({ type: 'activate', modId: mod.id, serverPath: mod.server, management: (mod.systemCapabilities || []).includes('mod-management-v1'), ...(systemCapability ? { systemCapability, controllerInstanceId } : {}) }, (error) => {
    if (!error || activationSettled) return;
    activationSettled = true;
    clearTimeout(activationTimer);
    rejectActivation(hostError('mod_host_send_failed', error.message));
    child.kill('SIGKILL');
  });

  function createSystemControllerProxy() {
    return Object.freeze({
      async configureTelemetry(configuration = {}) {
        if (!modAuthority) throw hostError('mod_authority_forbidden');
        await modAuthority.assertAllowed(mod.id, 'execution-provider-v1');
        if (!systemControllerReady || closing || stopped || !child.connected) throw hostError('remote_configuration_controller_unavailable');
        let value;
        try { value = jsonObject(configuration, 'remote_configuration_invalid'); }
        catch { throw hostError('remote_configuration_invalid'); }
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (!pendingSystemConfiguration.has(requestId)) return;
            pendingSystemConfiguration.delete(requestId);
            reject(hostError('remote_configuration_timeout'));
          }, finiteTimeout(routeTimeoutMs, DEFAULT_MOD_ROUTE_TIMEOUT_MS));
          timer.unref?.();
          pendingSystemConfiguration.set(requestId, { resolve, reject, timer });
          child.send({ type: 'system-controller-configure-telemetry', protocol: systemCapability, controllerInstanceId, requestId, configuration: value }, (error) => {
            if (!error || !pendingSystemConfiguration.has(requestId)) return;
            pendingSystemConfiguration.delete(requestId);
            clearTimeout(timer);
            reject(hostError('remote_configuration_send_failed'));
          });
        });
      },
      async describeHost(targetId) {
        if (!modAuthority) throw hostError('mod_authority_forbidden');
        await modAuthority.assertAllowed(mod.id, 'execution-provider-v1');
        if (admissionsPaused || !systemControllerReady || closing || stopped || !child.connected) return null;
        if (typeof targetId !== 'string' || !targetId.trim() || targetId.length > 240) return null;
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingSystemHostDescriptions.delete(requestId);
            reject(hostError('remote_host_description_timeout'));
          }, 1_000);
          timer.unref?.();
          pendingSystemHostDescriptions.set(requestId, { targetId, resolve, reject, timer });
          child.send({ type: 'system-controller-describe-host', protocol: systemCapability, controllerInstanceId, requestId, targetId }, error => {
            if (!error || !pendingSystemHostDescriptions.has(requestId)) return;
            pendingSystemHostDescriptions.delete(requestId);
            clearTimeout(timer);
            reject(hostError('remote_host_description_send_failed'));
          });
        });
      },
      async executeProcess(request = {}, { abortSignal = null } = {}) {
        if (!modAuthority) throw hostError('mod_authority_forbidden');
        await modAuthority.assertAllowed(mod.id, 'execution-provider-v1');
        if (admissionsPaused) return Promise.reject(Object.assign(hostError('mod_busy'), { statusCode: 409 }));
        if (!systemControllerReady || closing || stopped || !child.connected) return Promise.reject(hostError('remote_process_controller_unavailable'));
        const operationId = String(request.operationId || '');
        const targetId = String(request.targetId || '');
        const parentRunId = String(request.parentRunId || '');
        const toolCallId = String(request.toolCallId || '');
        if (!operationId || !targetId || !parentRunId || !toolCallId || !request.process || typeof request.process !== 'object' || Array.isArray(request.process)) return Promise.reject(hostError('remote_process_request_invalid'));
        let operation;
        const traceContext = traceContextCarrier(request.traceContext);
        try {
          operation = JSON.parse(JSON.stringify({ operationId, targetId, parentRunId, toolCallId, process: request.process,
            ...(traceContext ? { traceContext } : {}),
            ...(request.protectedBindingMetadata ? { protectedBindingMetadata: request.protectedBindingMetadata } : {}),
            ...(request.protectedValues ? { protectedValues: request.protectedValues } : {}) }));
        } catch { return Promise.reject(hostError('remote_process_request_invalid')); }
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
          const cancel = () => {
            const entry = pendingSystemProcess.get(requestId);
            if (!entry || entry.watchdogTimer) return;
            entry.watchdogTimer = setTimeout(() => {
              if (pendingSystemProcess.get(requestId) !== entry) return;
              pendingSystemProcess.delete(requestId);
              abortSignal?.removeEventListener?.('abort', cancel);
              reject(hostError('remote_process_cancel_timeout'));
            }, finiteTimeout(systemProcessWatchdogGraceMs, SYSTEM_PROCESS_WATCHDOG_GRACE_MS));
            entry.watchdogTimer.unref?.();
            if (child.connected) child.send({ type: 'system-controller-process-cancel', protocol: systemCapability, controllerInstanceId, requestId, operationId, targetId }, () => {});
          };
          pendingSystemProcess.set(requestId, { operationId, targetId, resolve, reject, abortSignal, cancel, watchdogTimer: null });
          if (abortSignal?.aborted) {
            pendingSystemProcess.delete(requestId);
            reject(hostError('remote_process_aborted'));
            return;
          }
          abortSignal?.addEventListener?.('abort', cancel, { once: true });
          child.send({ type: 'system-controller-process-execute', protocol: systemCapability, controllerInstanceId, requestId, operation }, (error) => {
            const entry = pendingSystemProcess.get(requestId);
            if (!error || !entry) return;
            pendingSystemProcess.delete(requestId);
            clearTimeout(entry.watchdogTimer);
            abortSignal?.removeEventListener?.('abort', cancel);
            reject(hostError('remote_process_send_failed'));
            markUnavailable('system_controller_send_failed');
            if (!stopped) child.kill('SIGKILL');
          });
        });
      },
      async executeNativeFilesystem(request = {}, { abortSignal = null } = {}) {
        if (!modAuthority) throw hostError('mod_authority_forbidden');
        await modAuthority.assertAllowed(mod.id, 'execution-provider-v1');
        if (admissionsPaused) return Promise.reject(Object.assign(hostError('mod_busy'), { statusCode: 409 }));
        if (!systemControllerReady || closing || stopped || !child.connected) return Promise.reject(hostError('remote_native_filesystem_controller_unavailable'));
        const operationId = String(request.operationId || '');
        const targetId = String(request.targetId || '');
        const parentRunId = String(request.parentRunId || '');
        const toolCallId = String(request.toolCallId || '');
        const tool = String(request.operation?.tool || '');
        if (!operationId || !targetId || !parentRunId || !toolCallId || !NATIVE_FILESYSTEM_TOOLS.has(tool)) return Promise.reject(hostError('remote_filesystem_request_invalid'));
        let operation;
        const traceContext = traceContextCarrier(request.traceContext);
        try {
          const args = jsonObject(request.operation?.arguments || {}, 'remote_filesystem_request_invalid');
          operation = { operationId, targetId, parentRunId, toolCallId, tool, arguments: args, ...(traceContext ? { traceContext } : {}) };
        } catch { return Promise.reject(hostError('remote_filesystem_request_invalid')); }
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
          const cancel = () => {
            const entry = pendingSystemFilesystem.get(requestId);
            if (!entry) return;
            pendingSystemFilesystem.delete(requestId);
            abortSignal?.removeEventListener?.('abort', cancel);
            if (child.connected) child.send({ type: 'system-controller-filesystem-cancel', protocol: systemCapability, controllerInstanceId, requestId, operationId, targetId }, () => {});
            reject(hostError('remote_filesystem_aborted'));
          };
          pendingSystemFilesystem.set(requestId, { operationId, targetId, tool, resolve, reject, abortSignal, cancel });
          if (abortSignal?.aborted) { cancel(); return; }
          abortSignal?.addEventListener?.('abort', cancel, { once: true });
          child.send({ type: 'system-controller-filesystem-execute', protocol: systemCapability, controllerInstanceId, requestId, operation }, (error) => {
            if (!error || !pendingSystemFilesystem.has(requestId)) return;
            pendingSystemFilesystem.delete(requestId);
            abortSignal?.removeEventListener?.('abort', cancel);
            reject(hostError('remote_filesystem_send_failed'));
            markUnavailable('system_controller_send_failed');
            if (!stopped) child.kill('SIGKILL');
          });
        });
      },
    });
  }

  async function invoke(routeId, request, { abortSignal = null } = {}) {
    if (admissionsPaused) throw Object.assign(hostError('mod_busy'), { statusCode: 409 });
    if (abortSignal?.aborted) throw hostError('mod_tool_cancelled');
    if (stopped || closing || !child.connected) throw hostError('mod_host_unavailable', mod.id);
    const requestId = `${process.pid}-${Date.now()}-${++sequence}`;
    return new Promise((resolve, reject) => {
      let finish;
      const completed = new Promise(done => { finish = done; });
      const succeed = value => { finish(); resolve(value); };
      const fail = error => { finish(); reject(error); };
      const cancel = () => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        cancelInvocationCapabilities(requestId);
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', cancel);
        child.send({ type: 'invoke-cancel', requestId }, () => {});
        fail(hostError('mod_tool_cancelled'));
      };
      abortSignal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        abortSignal?.removeEventListener('abort', cancel);
        cancelInvocationCapabilities(requestId);
        child.send({ type: 'invoke-cancel', requestId }, () => {});
        fail(hostError('mod_route_timeout', mod.id));
      }, finiteTimeout(routeTimeoutMs, DEFAULT_MOD_ROUTE_TIMEOUT_MS));
      pending.set(requestId, { resolve: succeed, reject: fail, completed, timer, routeId, abortSignal, cancel, trustedCaller: routeId?.startsWith('tool:') ? Object.freeze({ ...(request?.caller || {}) }) : null });
      if (abortSignal?.aborted) { cancel(); return; }
      child.send({ type: 'invoke', requestId, routeId, request }, (error) => {
        if (!error || !pending.has(requestId)) return;
        pending.delete(requestId);
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', cancel);
        const failure = hostError('mod_host_send_failed');
        fail(failure);
        rejectPending(hostError('mod_host_unavailable', mod.id));
        markUnavailable('mod_host_send_failed');
        if (!stopped) child.kill('SIGKILL');
      });
    });
  }

  function invokeTool(name, argumentsValue, caller, options = {}) {
    return invoke(`tool:${name}`, { arguments: argumentsValue, caller }, options);
  }

  function resolveProtectedReference(name, reference, caller) {
    return invoke(`protected:${name}`, { reference, caller });
  }

  // Acquire synchronously with the idle check: no work may enter while a
  // replacement awaits catalog storage. The caller owns release on rollback.
  function pauseAdmissions() {
    if (admissionsPaused || pending.size + activeCapabilities.size + pendingSystemProcess.size + pendingSystemFilesystem.size > 0) {
      throw Object.assign(hostError('mod_busy'), { statusCode: 409 });
    }
    admissionsPaused = true;
    return () => { admissionsPaused = false; };
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    cancelCapabilities();
    revokeSystemController('system_controller_shutdown');
    closePromise = (async () => {
      if (stopped) return exited;
      if (!activationSettled) {
        activationSettled = true;
        clearTimeout(activationTimer);
        rejectActivation(hostError('mod_host_closed', mod.id));
      }
      rejectPending(hostError('mod_host_closed', mod.id));
      if (child.connected) child.send({ type: 'shutdown' }, () => {});
      const timer = setTimeout(() => { if (!stopped) child.kill('SIGKILL'); }, finiteTimeout(cleanupTimeoutMs, 5_000));
      try { await exited; } finally { clearTimeout(timer); }
      if (shutdownError) throw shutdownError;
    })();
    return closePromise;
  }

  return { child, activated, pauseAdmissions, invoke, invokeTool, resolveProtectedReference, close, exited, pendingCount: () => pending.size, activeOperationCount: () => pending.size + activeCapabilities.size + pendingSystemProcess.size + pendingSystemFilesystem.size, pendingDiagnostics: () => [...activeCapabilities.values()].map(({ method, startedAt }) => ({ kind: "capability", operation: method, status: "pending", elapsedMs: Math.max(0, Date.now() - startedAt) })), pendingSystemProcessCount: () => pendingSystemProcess.size, pendingSystemFilesystemCount: () => pendingSystemFilesystem.size, controllerInstanceId };
}
