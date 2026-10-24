import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

// Validate, never coerce, default, or silently strip model-supplied arguments.
const toolSchemaValidator = new Ajv({ strict: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
addFormats(toolSchemaValidator);
const toolValidators = new Map();

let cleanup = null;
let sequence = 0;
let stopping = false;
let systemController = null;
const handlers = new Map();
const toolHandlers = new Map();
const protectedResolvers = new Map();
const secretReferenceProviders = new Map();
const activeInvocations = new Map();
const cancelledInvocations = new Set();
let diagnosticHandlers = null;
const pendingStore = new Map();
const pendingCapabilities = new Map();
const invocationScope = new AsyncLocalStorage();
function capabilityRequest(method, input, { signal } = {}) {
  if (stopping || !process.connected) return Promise.reject(new Error("mod_capability_unavailable"));
  const inheritedInvocation = invocationScope.getStore();
  const activeInvocation = inheritedInvocation && activeInvocations.get(inheritedInvocation.invocationId)?.signal === inheritedInvocation.signal
    ? inheritedInvocation
    : null;
  const invocationSignal = activeInvocation?.signal;
  signal = signal && invocationSignal ? AbortSignal.any([signal, invocationSignal]) : signal || invocationSignal;
  if (signal?.aborted) return Promise.reject(new Error("mod_capability_cancelled"));
  const requestId = `cap-${process.pid}-${++sequence}`;
  return new Promise((resolve, reject) => {
    const cancel = () => {
      if (!pendingCapabilities.delete(requestId)) return;
      send({ type: "capability-cancel", requestId }, () => {});
      reject(new Error("mod_capability_cancelled"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    pendingCapabilities.set(requestId, { resolve, reject, signal, cancel });
    send({ type: "capability-request", requestId, method, input, parentInvocationId: activeInvocation?.invocationId || null }, (error) => {
      if (error && pendingCapabilities.delete(requestId)) { signal?.removeEventListener("abort", cancel); reject(new Error("mod_capability_unavailable")); }
    });
    if (signal?.aborted) cancel();
  });
}

const activeSystemProcesses = new Map();
const activeSystemFilesystems = new Map();
const NATIVE_FILESYSTEM_TOOLS = new Set(['files_read', 'files_list', 'files_find', 'files_inspect', 'files_search', 'files_write', 'files_edit']);
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
function traceContextCarrier(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('remote_trace_context_invalid');
  const traceparent = String(value.traceparent || '').trim().toLowerCase();
  const tracestate = value.tracestate == null ? '' : String(value.tracestate).trim();
  if (!TRACEPARENT.test(traceparent) || traceparent.slice(3, 35) === '0'.repeat(32) || traceparent.slice(36, 52) === '0'.repeat(16)
    || (tracestate && (tracestate.length > 512 || /[\r\n]/.test(tracestate)))) throw new Error('remote_trace_context_invalid');
  return { traceparent, ...(tracestate ? { tracestate } : {}) };
}
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
function safeErrorDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const parsed = JSON.parse(JSON.stringify(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function validSystemMessage(message, type, { operation = true } = {}) {
  return message?.type === type && message.protocol === SYSTEM_PROTOCOL && message.controllerInstanceId === controllerInstanceId
    && typeof message.requestId === 'string' && message.requestId.length > 0
    && (!operation || (typeof message.operationId === 'string' && message.operationId.length > 0
      && typeof message.targetId === 'string' && message.targetId.length > 0));
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
  const tools = [];
  let registrationOpen = true;
  return {
    routes, tools, closeRegistration() { registrationOpen = false; },
    toolsApi: Object.freeze({ register({ name, description, inputSchema, handler, resolveProtectedReference, availability = 'grant-required' }) {
      if (!registrationOpen || typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || toolHandlers.has(name) || typeof description !== 'string' || !description.trim() || !inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema) || inputSchema.type !== 'object' || typeof handler !== 'function') throw new Error('mod_tool_registration_invalid');
      // IPC catalog is JSON. Reject non-serializable schemas rather than advertising a different contract.
      const schema = JSON.parse(JSON.stringify(inputSchema));
      if (JSON.stringify(schema) !== JSON.stringify(inputSchema)) throw new Error('mod_tool_registration_invalid');
      if (resolveProtectedReference !== undefined && typeof resolveProtectedReference !== 'function') throw new Error('mod_tool_registration_invalid');
      if (!['grant-required', 'mod-authorized'].includes(availability)) throw new Error('mod_tool_registration_invalid');
      let validate;
      try { validate = toolSchemaValidator.compile(schema); }
      catch { throw new Error('mod_tool_registration_invalid'); }
      toolValidators.set(name, validate);
      toolHandlers.set(name, handler);
      if (resolveProtectedReference) protectedResolvers.set(name, resolveProtectedReference);
      tools.push({ name, description, inputSchema: schema, availability });
    } }),
    secretReferences: Object.freeze({ register({ scheme, list, resolve }) {
      if (!registrationOpen || typeof scheme !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(scheme) || secretReferenceProviders.has(scheme) || typeof list !== 'function' || typeof resolve !== 'function') throw new Error('mod_secret_reference_provider_invalid');
      secretReferenceProviders.set(scheme, { list, resolve });
    } }),
    diagnostics: Object.freeze({ register(adapter) {
      if (diagnosticHandlers || !adapter || typeof adapter.listJobs !== "function" || typeof adapter.getJob !== "function") throw new Error("mod_diagnostics_invalid");
      diagnosticHandlers = { listJobs: adapter.listJobs, getJob: adapter.getJob };
    } }),
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
    tools: registration.toolsApi,
    diagnostics: registration.diagnostics,
    secretReferences: registration.secretReferences,
    runtimeDiagnostics: Object.freeze({ read: (input, options) => capabilityRequest("readRuntimeDiagnostics", input, options) }),
    settings: settingsApi(),
    secrets: secretsApi(),
    conversations: Object.freeze({ list: (input) => capabilityRequest("listConversations", input), read: (input, options) => capabilityRequest("readConversation", input, options) }),
    models: Object.freeze({ list: () => capabilityRequest("listModels", {}), generateText: (input, options) => capabilityRequest("generateText", input, options), generations: Object.freeze({ submit: (input) => capabilityRequest("submitGeneration", input), read: (jobId) => capabilityRequest("readGeneration", { jobId }) }) }),
    forge: Object.freeze({ images: Object.freeze({ status: () => capabilityRequest("getForgeImageStatus", {}), create: (input) => capabilityRequest("createForgeImage", input) }), jobs: Object.freeze({ read: (jobId) => capabilityRequest("readForgeImageJob", { jobId }) }) }),
    agents: Object.freeze({ list: () => capabilityRequest("listAgents", {}), turns: Object.freeze({ submit: (input) => capabilityRequest("submitExternalTurn", input), read: (turnId) => capabilityRequest("readExternalTurn", { turnId }) }) }),
    operator: Object.freeze({ timezone: () => capabilityRequest("getOperatorTimezone", {}), displayIdentity: () => capabilityRequest("getOperatorIdentity", {}) }),
    scheduler: Object.freeze({ list: (input = {}) => capabilityRequest("listScheduledJobs", input), read: (jobId) => capabilityRequest("readScheduledJob", { jobId }), create: (input) => capabilityRequest("createScheduledJob", input), update: (jobId, patch) => capabilityRequest("updateScheduledJob", { jobId, patch }), delete: (jobId) => capabilityRequest("deleteScheduledJob", { jobId }), runs: (jobId, input = {}) => capabilityRequest("listScheduledJobRuns", { ...input, jobId }), trigger: (jobId) => capabilityRequest("triggerScheduledJob", { jobId }) }),
    logger: logger(modId),
  };
  if (message.management === true) {
    context.modManagement = Object.freeze({
      inventory: (input = {}) => capabilityRequest('managementInventory', input),
      refresh: () => capabilityRequest('managementSubmit', { action: 'refresh' }),
      submit: input => capabilityRequest('managementSubmit', input),
      operation: operationId => capabilityRequest('managementOperation', { operationId }),
    });
  }
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
  registration.closeRegistration();
  cleanup = typeof result === 'function' ? result : result && typeof result.close === 'function' ? () => result.close() : null;
  send({ type: 'activated', routes: registration.routes, tools: registration.tools, diagnostics: Boolean(diagnosticHandlers), secretReferenceSchemes: [...secretReferenceProviders.keys()] });
}

async function invoke(message) {
  const secretListScheme = message.routeId?.startsWith("secret-reference-list:") ? message.routeId.slice(22) : null;
  const secretResolveScheme = message.routeId?.startsWith("secret-reference-resolve:") ? message.routeId.slice(25) : null;
  const handler = secretListScheme ? secretReferenceProviders.get(secretListScheme)?.list : secretResolveScheme ? secretReferenceProviders.get(secretResolveScheme)?.resolve : message.routeId?.startsWith("protected:") ? protectedResolvers.get(message.routeId.slice(10)) : message.routeId?.startsWith("tool:") ? toolHandlers.get(message.routeId.slice(5)) : message.routeId === "diagnostic-list" ? diagnosticHandlers?.listJobs : message.routeId === "diagnostic-detail" ? diagnosticHandlers?.getJob : handlers.get(message.routeId);
  if (!handler) throw new Error('mod_route_handler_not_found');
  const controller = new AbortController();
  activeInvocations.set(message.requestId, controller);
  try {
    return await invocationScope.run(Object.freeze({ invocationId: message.requestId, signal: controller.signal }), async () => {
      if (message.routeId?.startsWith('protected:')) return handler(message.request.reference, Object.freeze(message.request.caller));
      if (message.routeId?.startsWith('tool:')) {
        const validate = toolValidators.get(message.routeId.slice(5));
        if (!validate || !validate(message.request.arguments)) throw Object.assign(new Error('mod_tool_input_invalid'), { statusCode: 400 });
        return handler(message.request.arguments, Object.freeze({ ...message.request.caller, signal: controller.signal }));
      }
      return handler(message.request, Object.freeze({ signal: controller.signal }));
    });
  } finally { if (activeInvocations.get(message.requestId) === controller) activeInvocations.delete(message.requestId); }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  rejectStoreRequests(new Error('mod_store_unavailable'));
  for (const entry of pendingCapabilities.values()) entry.reject(new Error("mod_capability_unavailable"));
  pendingCapabilities.clear();
  for (const active of activeSystemProcesses.values()) active.abort.abort();
  activeSystemProcesses.clear();
  for (const active of activeSystemFilesystems.values()) active.abort.abort();
  activeSystemFilesystems.clear();
  for (const controller of activeInvocations.values()) controller.abort();
  activeInvocations.clear();
  if (cleanup) await cleanup();
  cleanup = null;
}

process.on('message', async (message) => {
  if (message?.type === 'invoke-cancel') { const controller = activeInvocations.get(message.requestId); if (controller) { cancelledInvocations.add(message.requestId); controller.abort(); } return; }
  if (message?.type === 'system-controller-configure-telemetry') {
    if (!validSystemMessage(message, 'system-controller-configure-telemetry', { operation: false }) || !systemController?.configureTelemetry) return;
    try {
      const configuration = message.configuration && typeof message.configuration === 'object' && !Array.isArray(message.configuration)
        ? JSON.parse(JSON.stringify(message.configuration)) : null;
      if (!configuration) throw new Error('remote_configuration_invalid');
      const result = await systemController.configureTelemetry(configuration);
      send({ type: 'system-controller-configuration-result', protocol: SYSTEM_PROTOCOL, controllerInstanceId, requestId: message.requestId, ok: true, result }, () => {});
    } catch (error) {
      send({ type: 'system-controller-configuration-result', protocol: SYSTEM_PROTOCOL, controllerInstanceId, requestId: message.requestId, ok: false, error: opaqueCode(error, 'remote_configuration_failed') }, () => {});
    }
    return;
  }
  if (message?.type === 'system-controller-describe-host') {
    if (!validSystemMessage(message, 'system-controller-describe-host', { operation: false })
      || typeof message.targetId !== 'string' || !message.targetId || stopping) return;
    try {
      const result = typeof systemController?.describeHost === 'function'
        ? await systemController.describeHost(message.targetId) : null;
      send({ type: 'system-controller-host-description-result', protocol: SYSTEM_PROTOCOL, controllerInstanceId,
        requestId: message.requestId, targetId: message.targetId, ok: true, result: result ?? null }, () => {});
    } catch {
      send({ type: 'system-controller-host-description-result', protocol: SYSTEM_PROTOCOL, controllerInstanceId,
        requestId: message.requestId, targetId: message.targetId, ok: false }, () => {});
    }
    return;
  }
  if (message?.type === 'system-controller-filesystem-cancel') {
    if (!validSystemMessage(message, 'system-controller-filesystem-cancel')) return;
    activeSystemFilesystems.get(message.requestId)?.abort.abort();
    return;
  }
  if (message?.type === 'system-controller-filesystem-execute') {
    const operation = message.operation;
    let argumentsValue = null;
    let traceContext = null;
    try {
      argumentsValue = operation?.arguments && typeof operation.arguments === 'object' && !Array.isArray(operation.arguments)
        ? JSON.parse(JSON.stringify(operation.arguments)) : null;
      traceContext = traceContextCarrier(operation?.traceContext);
    } catch {}
    if (!validSystemMessage({ ...message, operationId: operation?.operationId, targetId: operation?.targetId }, 'system-controller-filesystem-execute')
      || typeof operation.parentRunId !== 'string' || !operation.parentRunId || typeof operation.toolCallId !== 'string' || !operation.toolCallId
      || !NATIVE_FILESYSTEM_TOOLS.has(operation.tool) || !argumentsValue || !systemController?.executeNativeFilesystem) return;
    const abort = new AbortController();
    activeSystemFilesystems.set(message.requestId, { abort, operationId: operation.operationId, targetId: operation.targetId });
    try {
      const result = await systemController.executeNativeFilesystem({ operationId: operation.operationId, targetId: operation.targetId,
        parentRunId: operation.parentRunId, toolCallId: operation.toolCallId, ...(traceContext ? { traceContext } : {}), operation: { tool: operation.tool, arguments: argumentsValue } }, { abortSignal: abort.signal });
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
    let traceContext;
    try { traceContext = traceContextCarrier(operation?.traceContext); } catch { return; }
    if (!validSystemMessage({ ...message, operationId: operation?.operationId, targetId: operation?.targetId }, 'system-controller-process-execute')
      || typeof operation.parentRunId !== 'string' || !operation.parentRunId || typeof operation.toolCallId !== 'string' || !operation.toolCallId
      || !operation.process || typeof operation.process !== 'object' || Array.isArray(operation.process) || !systemController?.executeProcess) return;
    const abort = new AbortController();
    activeSystemProcesses.set(message.requestId, { abort, operationId: operation.operationId, targetId: operation.targetId });
    try {
      const processOperation = { ...operation };
      delete processOperation.traceContext;
      const result = await systemController.executeProcess({ ...processOperation, ...(traceContext ? { traceContext } : {}) }, { abortSignal: abort.signal });
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
  if (message?.type === 'capability-result') {
    const entry = pendingCapabilities.get(message.requestId);
    if (!entry) return;
    pendingCapabilities.delete(message.requestId);
    entry.signal?.removeEventListener("abort", entry.cancel);
    if (message.error) {
      const error = new Error(message.error);
      const details = safeErrorDetails(message.errorDetails);
      if (details) error.details = details;
      entry.reject(error);
    } else entry.resolve(message.result);
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
    else if (message?.type === 'invoke') { const result = await invoke(message); if (!cancelledInvocations.delete(message.requestId)) send({ type: 'result', requestId: message.requestId, result }); }
    else if (message?.type === 'shutdown') {
      try { await shutdown(); send({ type: 'shutdown-complete' }); }
      catch (error) { send({ type: 'shutdown-failed', error: errorText(error) }); }
      process.disconnect();
    }
  } catch (error) {
    if (message?.type === 'invoke') { if (!cancelledInvocations.delete(message.requestId)) send({ type: 'result', requestId: message.requestId, error: errorText(error), statusCode: Number(error?.statusCode) || 500 }); }
    else {
      try { await shutdown(); } catch {}
      send({ type: 'activation-failed', error: errorText(error) });
      process.disconnect();
    }
  }
});

process.on('disconnect', async () => {
  rejectStoreRequests(new Error('mod_store_unavailable'));
  for (const entry of pendingCapabilities.values()) entry.reject(new Error("mod_capability_unavailable"));
  pendingCapabilities.clear();
  try { await shutdown(); } finally { process.exit(process.exitCode || 0); }
});
