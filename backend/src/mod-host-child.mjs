import { pathToFileURL } from 'node:url';

let cleanup = null;
let sequence = 0;
let stopping = false;
let systemController = null;
const handlers = new Map();
const pendingStore = new Map();
const activeSystemProcesses = new Map();
const activeSystemFilesystems = new Map();
const NATIVE_FILESYSTEM_TOOLS = new Set(['files_read', 'files_list', 'files_find', 'files_inspect', 'files_search', 'files_write', 'files_edit']);
let controllerInstanceId = null;
const SYSTEM_PROTOCOL = 'execution-provider-v1';

function send(message, callback) {
  if (!process.connected) {
    callback?.(new Error('mod_host_disconnected'));
    return;
  }
  process.send(message, callback);
}

function errorText(error) {
  return String(error?.message || error || 'mod_host_failed');
}

function opaqueCode(error, fallback = 'remote_process_failed') {
  const code = String(error?.code || error?.message || '');
  return /^[a-z0-9_]+$/.test(code) ? code : fallback;
}

function validSystemMessage(message, type) {
  return message?.type === type && message.protocol === SYSTEM_PROTOCOL && message.controllerInstanceId === controllerInstanceId
    && typeof message.requestId === 'string' && message.requestId.length > 0
    && typeof message.operationId === 'string' && message.operationId.length > 0
    && typeof message.targetId === 'string' && message.targetId.length > 0;
}

function rejectStoreRequests(error) {
  for (const entry of pendingStore.values()) entry.reject(error);
  pendingStore.clear();
}

function storeRequest(scope, method, args) {
  if (stopping || !process.connected) return Promise.reject(new Error('mod_store_unavailable'));
  const requestId = `store-${process.pid}-${++sequence}`;
  return new Promise((resolve, reject) => {
    pendingStore.set(requestId, { resolve, reject });
    send({ type: 'store-request', requestId, scope, method, args }, (error) => {
      if (!error || !pendingStore.has(requestId)) return;
      pendingStore.delete(requestId);
      reject(new Error('mod_store_unavailable'));
    });
  });
}

function settingsApi() {
  return Object.freeze({
    get: (name, fallback = null) => storeRequest('settings', 'get', [name, fallback]),
    set: (name, value) => storeRequest('settings', 'set', [name, value]),
    delete: (name) => storeRequest('settings', 'delete', [name]),
  });
}

function secretsApi() {
  return Object.freeze({
    get: (name) => storeRequest('secrets', 'get', [name]),
    set: (name, value) => storeRequest('secrets', 'set', [name, value]),
    clear: (name) => storeRequest('secrets', 'clear', [name]),
    has: (name) => storeRequest('secrets', 'has', [name]),
  });
}

function registrar(modId) {
  const routes = [];
  const add = (method, routePath, handler) => {
    const value = String(routePath || '').trim();
    if (!value.startsWith('/') || value.includes('?') || value.split('/').includes('..') || typeof handler !== 'function') throw new Error(`mod_route_invalid:${modId}`);
    const routeId = `route-${routes.length + 1}`;
    handlers.set(routeId, handler);
    routes.push({ routeId, method, path: value === '/' ? '' : value.replace(/\/$/, '') });
  };
  return {
    routes,
    api: Object.freeze({
      get: (path, handler) => add('GET', path, handler),
      post: (path, handler) => add('POST', path, handler),
      put: (path, handler) => add('PUT', path, handler),
      patch: (path, handler) => add('PATCH', path, handler),
      delete: (path, handler) => add('DELETE', path, handler),
    }),
  };
}

function logger(modId) {
  return Object.freeze(Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...args) => {
    const message = args.map((entry) => {
      if (typeof entry === 'string') return entry;
      try { return JSON.stringify(entry); } catch { return '[unserializable]'; }
    }).join(' ');
    send({ type: 'log', level, message, modId }, () => {});
  }])));
}

async function activate(message) {
  const { modId, serverPath } = message;
  const registration = registrar(modId);
  const module = await import(`${pathToFileURL(serverPath).href}?hosted=${Date.now()}`);
  if (typeof module.activate !== 'function') throw new Error(`mod_activate_missing:${modId}`);
  const context = {
    id: modId,
    api: registration.api,
    settings: settingsApi(),
    secrets: secretsApi(),
    logger: logger(modId),
  };
  if (message.systemCapability === SYSTEM_PROTOCOL) {
    controllerInstanceId = String(message.controllerInstanceId || '');
    if (!controllerInstanceId) throw new Error('system_controller_instance_invalid');
    let registered = false;
    context.processExecution = Object.freeze({
      registerController(controller) {
        if (registered || !controller || typeof controller.executeProcess !== 'function' || typeof controller.executeNativeFilesystem !== 'function') throw new Error('system_controller_invalid');
        registered = true;
        systemController = controller;
        send({ type: 'system-controller-ready', protocol: SYSTEM_PROTOCOL });
        return () => {
          if (!registered) return;
          registered = false;
          systemController = null;
          send({ type: 'system-controller-unregistered', protocol: SYSTEM_PROTOCOL }, () => {});
        };
      },
    });
  }
  const result = await module.activate(Object.freeze(context));
  cleanup = typeof result === 'function' ? result : result && typeof result.close === 'function' ? () => result.close() : null;
  send({ type: 'activated', routes: registration.routes });
}

async function invoke(message) {
  const handler = handlers.get(message.routeId);
  if (!handler) throw new Error('mod_route_handler_not_found');
  return handler(message.request);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  rejectStoreRequests(new Error('mod_store_unavailable'));
  for (const active of activeSystemProcesses.values()) active.abort.abort();
  activeSystemProcesses.clear();
  for (const active of activeSystemFilesystems.values()) active.abort.abort();
  activeSystemFilesystems.clear();
  if (cleanup) await cleanup();
  cleanup = null;
}

process.on('message', async (message) => {
  if (message?.type === 'system-controller-filesystem-cancel') {
    if (!validSystemMessage(message, 'system-controller-filesystem-cancel')) return;
    activeSystemFilesystems.get(message.requestId)?.abort.abort();
    return;
  }
  if (message?.type === 'system-controller-filesystem-execute') {
    const operation = message.operation;
    let argumentsValue = null;
    try {
      argumentsValue = operation?.arguments && typeof operation.arguments === 'object' && !Array.isArray(operation.arguments)
        ? JSON.parse(JSON.stringify(operation.arguments)) : null;
    } catch {}
    if (!validSystemMessage({ ...message, operationId: operation?.operationId, targetId: operation?.targetId }, 'system-controller-filesystem-execute')
      || typeof operation.parentRunId !== 'string' || !operation.parentRunId || typeof operation.toolCallId !== 'string' || !operation.toolCallId
      || !NATIVE_FILESYSTEM_TOOLS.has(operation.tool) || !argumentsValue || !systemController?.executeNativeFilesystem) return;
    const abort = new AbortController();
    activeSystemFilesystems.set(message.requestId, { abort, operationId: operation.operationId, targetId: operation.targetId });
    try {
      const result = await systemController.executeNativeFilesystem({ operationId: operation.operationId, targetId: operation.targetId,
        parentRunId: operation.parentRunId, toolCallId: operation.toolCallId, operation: { tool: operation.tool, arguments: argumentsValue } }, { abortSignal: abort.signal });
      if (!activeSystemFilesystems.has(message.requestId)) return;
      send({ type: 'system-controller-filesystem-result', protocol: SYSTEM_PROTOCOL, controllerInstanceId, requestId: message.requestId,
        operationId: operation.operationId, targetId: operation.targetId, ok: true, result }, () => {});
    } catch (error) {
      if (!activeSystemFilesystems.has(message.requestId)) return;
      send({ type: 'system-controller-filesystem-result', protocol: SYSTEM_PROTOCOL, controllerInstanceId, requestId: message.requestId,
        operationId: operation.operationId, targetId: operation.targetId, ok: false, error: opaqueCode(error, 'remote_filesystem_failed') }, () => {});
    } finally { activeSystemFilesystems.delete(message.requestId); }
    return;
  }
  if (message?.type === 'system-controller-process-cancel') {
    if (!validSystemMessage(message, 'system-controller-process-cancel')) return;
    activeSystemProcesses.get(message.requestId)?.abort.abort();
    return;
  }
  if (message?.type === 'system-controller-process-execute') {
    const operation = message.operation;
    if (!validSystemMessage({ ...message, operationId: operation?.operationId, targetId: operation?.targetId }, 'system-controller-process-execute')
      || typeof operation.parentRunId !== 'string' || !operation.parentRunId || typeof operation.toolCallId !== 'string' || !operation.toolCallId
      || !operation.process || typeof operation.process !== 'object' || Array.isArray(operation.process) || !systemController?.executeProcess) return;
    const abort = new AbortController();
    activeSystemProcesses.set(message.requestId, { abort, operationId: operation.operationId, targetId: operation.targetId });
    try {
      const result = await systemController.executeProcess(operation, { abortSignal: abort.signal });
      if (!activeSystemProcesses.has(message.requestId)) return;
      send({ type: 'system-controller-process-result', protocol: SYSTEM_PROTOCOL, controllerInstanceId, requestId: message.requestId,
        operationId: operation.operationId, targetId: operation.targetId, ok: true, result }, () => {});
    } catch (error) {
      if (!activeSystemProcesses.has(message.requestId)) return;
      send({ type: 'system-controller-process-result', protocol: SYSTEM_PROTOCOL, controllerInstanceId, requestId: message.requestId,
        operationId: operation.operationId, targetId: operation.targetId, ok: false, error: opaqueCode(error) }, () => {});
    } finally { activeSystemProcesses.delete(message.requestId); }
    return;
  }
  if (message?.type === 'store-result') {
    const entry = pendingStore.get(message.requestId);
    if (!entry) return;
    pendingStore.delete(message.requestId);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
    return;
  }
  try {
    if (message?.type === 'activate') await activate(message);
    else if (message?.type === 'invoke') send({ type: 'result', requestId: message.requestId, result: await invoke(message) });
    else if (message?.type === 'shutdown') {
      try { await shutdown(); send({ type: 'shutdown-complete' }); }
      catch (error) { send({ type: 'shutdown-failed', error: errorText(error) }); }
      process.disconnect();
    }
  } catch (error) {
    if (message?.type === 'invoke') send({ type: 'result', requestId: message.requestId, error: errorText(error), statusCode: Number(error?.statusCode) || 500 });
    else {
      try { await shutdown(); } catch {}
      send({ type: 'activation-failed', error: errorText(error) });
      process.disconnect();
    }
  }
});

process.on('disconnect', async () => {
  rejectStoreRequests(new Error('mod_store_unavailable'));
  try { await shutdown(); } finally { process.exit(process.exitCode || 0); }
});
