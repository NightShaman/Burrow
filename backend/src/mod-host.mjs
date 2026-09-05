import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const CHILD_PATH = fileURLToPath(new URL('./mod-host-child.mjs', import.meta.url));
// A hung extension handler must not hold Burrow core's HTTP request open forever.
export const DEFAULT_MOD_ROUTE_TIMEOUT_MS = 30_000;

function finiteTimeout(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
function hostError(code, detail = '') {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  return error;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const NATIVE_FILESYSTEM_TOOLS = new Set(['files_read', 'files_list', 'files_find', 'files_inspect', 'files_search', 'files_write', 'files_edit']);
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

export function startModHost({ mod, store, logger = console, systemCapability = null, activationTimeoutMs = 10_000, routeTimeoutMs = DEFAULT_MOD_ROUTE_TIMEOUT_MS, cleanupTimeoutMs = 5_000, onUnavailable = null, onSystemControllerReady = null, onSystemControllerUnavailable = null } = {}) {
  if (!store) throw hostError('mod_store_required', mod?.id);
  const child = fork(CHILD_PATH, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
  const pending = new Map();
  let sequence = 0;
  let activationSettled = false;
  let stopped = false;
  let closing = false;
  let closePromise = null;
  let shutdownError = null;
  let unavailable = false;
  let systemControllerReady = false;
  const controllerInstanceId = systemCapability ? randomUUID() : null;
  const pendingSystemProcess = new Map();
  const pendingSystemFilesystem = new Map();
  const rejectSystemProcesses = (code = 'remote_process_controller_unavailable') => {
    const error = hostError(code);
    for (const entry of pendingSystemProcess.values()) {
      entry.abortSignal?.removeEventListener?.('abort', entry.cancel);
      entry.reject(error);
    }
    pendingSystemProcess.clear();
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
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
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
      onSystemControllerReady?.(createSystemControllerProxy());
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
    if (message?.type === 'system-controller-process-result') {
      if (message.protocol !== systemCapability || message.controllerInstanceId !== controllerInstanceId) return;
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const entry = pendingSystemProcess.get(requestId);
      if (!entry || message.operationId !== entry.operationId || message.targetId !== entry.targetId) return;
      pendingSystemProcess.delete(requestId);
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
      resolveActivation(message.routes || []);
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
    clearTimeout(entry.timer);
    if (message.error) {
      const error = hostError('mod_route_failed');
      const status = Number(message.statusCode);
      error.statusCode = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
      entry.reject(error);
    } else {
      try { entry.resolve(validateRouteResult(message.result)); }
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
    markUnavailable('mod_host_error');
    if (!stopped) child.kill('SIGKILL');
  });

  // Deliberately send only identity and entrypoint. Database ownership and path
  // remain in core and are never part of the child activation context.
  child.send({ type: 'activate', modId: mod.id, serverPath: mod.server, ...(systemCapability ? { systemCapability, controllerInstanceId } : {}) }, (error) => {
    if (!error || activationSettled) return;
    activationSettled = true;
    clearTimeout(activationTimer);
    rejectActivation(hostError('mod_host_send_failed', error.message));
    child.kill('SIGKILL');
  });

  function createSystemControllerProxy() {
    return Object.freeze({
      executeProcess(request = {}, { abortSignal = null } = {}) {
        if (!systemControllerReady || closing || stopped || !child.connected) return Promise.reject(hostError('remote_process_controller_unavailable'));
        const operationId = String(request.operationId || '');
        const targetId = String(request.targetId || '');
        const parentRunId = String(request.parentRunId || '');
        const toolCallId = String(request.toolCallId || '');
        if (!operationId || !targetId || !parentRunId || !toolCallId || !request.process || typeof request.process !== 'object' || Array.isArray(request.process)) return Promise.reject(hostError('remote_process_request_invalid'));
        let operation;
        try {
          operation = JSON.parse(JSON.stringify({ operationId, targetId, parentRunId, toolCallId, process: request.process,
            ...(request.protectedBindingMetadata ? { protectedBindingMetadata: request.protectedBindingMetadata } : {}),
            ...(request.protectedValues ? { protectedValues: request.protectedValues } : {}) }));
        } catch { return Promise.reject(hostError('remote_process_request_invalid')); }
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
          const cancel = () => {
            if (!pendingSystemProcess.has(requestId) || !child.connected) return;
            child.send({ type: 'system-controller-process-cancel', protocol: systemCapability, controllerInstanceId, requestId, operationId, targetId }, () => {});
          };
          pendingSystemProcess.set(requestId, { operationId, targetId, resolve, reject, abortSignal, cancel });
          if (abortSignal?.aborted) cancel(); else abortSignal?.addEventListener?.('abort', cancel, { once: true });
          child.send({ type: 'system-controller-process-execute', protocol: systemCapability, controllerInstanceId, requestId, operation }, (error) => {
            if (!error || !pendingSystemProcess.has(requestId)) return;
            pendingSystemProcess.delete(requestId);
            abortSignal?.removeEventListener?.('abort', cancel);
            reject(hostError('remote_process_send_failed'));
            markUnavailable('system_controller_send_failed');
            if (!stopped) child.kill('SIGKILL');
          });
        });
      },
      executeNativeFilesystem(request = {}, { abortSignal = null } = {}) {
        if (!systemControllerReady || closing || stopped || !child.connected) return Promise.reject(hostError('remote_native_filesystem_controller_unavailable'));
        const operationId = String(request.operationId || '');
        const targetId = String(request.targetId || '');
        const parentRunId = String(request.parentRunId || '');
        const toolCallId = String(request.toolCallId || '');
        const tool = String(request.operation?.tool || '');
        if (!operationId || !targetId || !parentRunId || !toolCallId || !NATIVE_FILESYSTEM_TOOLS.has(tool)) return Promise.reject(hostError('remote_filesystem_request_invalid'));
        let operation;
        try {
          const args = jsonObject(request.operation?.arguments || {}, 'remote_filesystem_request_invalid');
          operation = { operationId, targetId, parentRunId, toolCallId, tool, arguments: args };
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

  async function invoke(routeId, request) {
    if (stopped || closing || !child.connected) throw hostError('mod_host_unavailable', mod.id);
    const requestId = `${process.pid}-${Date.now()}-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        const error = hostError('mod_route_timeout', mod.id);
        markUnavailable('mod_route_timeout');
        reject(error);
        rejectPending(hostError('mod_host_unavailable', mod.id));
        child.kill('SIGKILL');
      }, finiteTimeout(routeTimeoutMs, DEFAULT_MOD_ROUTE_TIMEOUT_MS));
      pending.set(requestId, { resolve, reject, timer });
      child.send({ type: 'invoke', requestId, routeId, request }, (error) => {
        if (!error || !pending.has(requestId)) return;
        pending.delete(requestId);
        clearTimeout(timer);
        const failure = hostError('mod_host_send_failed');
        reject(failure);
        rejectPending(hostError('mod_host_unavailable', mod.id));
        markUnavailable('mod_host_send_failed');
        if (!stopped) child.kill('SIGKILL');
      });
    });
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
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

  return { child, activated, invoke, close, exited, pendingCount: () => pending.size, pendingSystemProcessCount: () => pendingSystemProcess.size, pendingSystemFilesystemCount: () => pendingSystemFilesystem.size, controllerInstanceId };
}
