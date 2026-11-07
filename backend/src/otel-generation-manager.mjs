import { operationalEvent } from './operational-log.mjs';
import { observeOperationalTelemetry } from './operational-telemetry.mjs';
import { createOtelRuntime } from './otel-sdk-runtime.mjs';
import { positiveInteger, genericEndpointForConfiguration, copyEnvironmentTls, copyDestinations, environmentTlsForDestination, destinationSignalUrl, otelEnvironmentForConfiguration, configurationHasTransport } from './otel-transport.mjs';
import { timeout } from './otel-runtime-utils.mjs';
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export function createReconfigurableOtelRuntime({ serviceVersion = null, clock = () => Date.now(), runtimeFactory = createOtelRuntime, tuningEnv = process.env, logger = console } = {}) {
  const runtimeTuning = Object.fromEntries(Object.entries(tuningEnv).filter(([key, value]) => value && /^(?:OTEL_BSP_|OTEL_METRIC_EXPORT_|OTEL_RESOURCE_ATTRIBUTES$|OTEL_SERVICE_NAME$|OTEL_SDK_DISABLED$|OTEL_EXPORTER_OTLP_(?:TIMEOUT|TRACES_TIMEOUT|METRICS_TIMEOUT|COMPRESSION|TRACES_COMPRESSION|METRICS_COMPRESSION|METRICS_TEMPORALITY_PREFERENCE))/.test(key)));
  const emptyConfiguration = { enabled: false, endpoint: '', headers: null, tracesEndpoint: null, metricsEndpoint: null, tracesHeaders: null, metricsHeaders: null };
  const runtimes = new Set();
  const owners = new Map();
  const operationOwners = new Map();
  const completed = { failures: { start: 0, observe: 0, export: 0, shutdown: 0 }, dropped: 0, lastExportFailure: null, destinations: [] };
  function generationRuntime(runtime, config) {
    const entry = { runtime, config, runIds: new Set(), operations:new Set(), draining: null };
    runtimes.add(entry);
    return entry;
  }
  let active = generationRuntime(runtimeFactory({ env: runtimeTuning, serviceVersion, clock, logger, subscribeOperational:false }), emptyConfiguration);
  let applied = emptyConfiguration;
  let generation = 0;
  let applying = Promise.resolve();
  let closed = false;
  let shuttingDown = null;

  function configurationKey(config) {
    return JSON.stringify([config.enabled === true, String(config.endpoint || ''), String(config.headers || ''), String(config.tracesEndpoint || ''), String(config.metricsEndpoint || ''), String(config.tracesHeaders || ''), String(config.metricsHeaders || ''), config.environmentTls ?? null, config.environmentTlsErrors ?? null, config.destinations ?? null]);
  }

  function accumulate(target, snapshot = {}) {
    for (const key of ['start', 'observe', 'export', 'shutdown']) target.failures[key] += snapshot.failures?.[key] || 0;
    // Runtime.start reports a fixed, redacted category. Retain it across
    // generation drains without copying arbitrary error text into status.
    if (snapshot.failures?.lastStart === 'otel_runtime_start_failed') target.failures.lastStart = 'otel_runtime_start_failed';
    target.dropped = Math.min(Number.MAX_SAFE_INTEGER, target.dropped + (snapshot.dropped || 0));
    if (snapshot.lastExportFailure) target.lastExportFailure = snapshot.lastExportFailure;
    for (const destination of snapshot.destinations || []) {
      let total = target.destinations.find(item => item.id === destination.id);
      if (!total) {
        total = { id: destination.id, enabled: false, tracesEnabled: false, metricsEnabled: false, failures: { start: 0, export: 0, shutdown: 0 }, dropped: 0, lastExportFailure: null };
        target.destinations.push(total);
      }
      for (const key of Object.keys(total.failures)) total.failures[key] += destination.failures?.[key] || 0;
      total.dropped = Math.min(Number.MAX_SAFE_INTEGER, total.dropped + (destination.dropped || 0));
      if (destination.lastExportFailure) total.lastExportFailure = { ...destination.lastExportFailure };
    }
  }

  function drain(entry, options) {
    if (entry.draining) return entry.draining;
    // A settings change is not a run terminal. Old generations keep accepting
    // their own observations and completions, including while disabled globally.
    if ((entry.runIds.size || entry.operations.size) && !closed) return Promise.resolve();
    entry.draining = Promise.resolve().then(() => entry.runtime.shutdown(options)).catch(() => {
      completed.failures.shutdown += 1;
      operationalEvent(logger, 'otel_runtime_shutdown_failed', { errorCode: 'otel_runtime_shutdown_failed' }, { level: 'warn', component: 'opentelemetry' });
    }).finally(() => {
      accumulate(completed, entry.runtime.status());
      runtimes.delete(entry);
    });
    return entry.draining;
  }

  async function apply(config = {}) {
    if (closed) throw new Error('opentelemetry_runtime_closed');
    const normalized = { enabled: config.enabled === true, endpoint: genericEndpointForConfiguration(config), headers: config.headers ? String(config.headers) : null,
      tracesEndpoint: config.tracesEndpoint || null, metricsEndpoint: config.metricsEndpoint || null, tracesHeaders: config.tracesHeaders || null, metricsHeaders: config.metricsHeaders || null,
      ...(config.environmentTls ? { environmentTls: copyEnvironmentTls(config.environmentTls) } : {}),
      ...(Array.isArray(config.environmentTlsErrors) ? { environmentTlsErrors: config.environmentTlsErrors.filter(signal => ['traces', 'metrics'].includes(signal)) } : {}),
      ...(Array.isArray(config.destinations) ? { destinations: copyDestinations(config.destinations) } : {}) };
    const selectedEnvironment = config.endpointSource === 'environment' || config.headersSource === 'environment';
    // Provenance comes from the trusted settings resolver, never an id alone: a
    // saved destination may legitimately have the id "environment".
    const environmentIndex = selectedEnvironment && normalized.destinations?.length === 1 && normalized.destinations[0].id === 'environment' ? 0 : -1;
    const operation = async () => {
      if (closed) return status();
      if (normalized.enabled && normalized.destinations) for (const [index, destination] of normalized.destinations.entries()) {
        if (!destination.enabled || (index !== environmentIndex && destination.environmentOwned !== true)) continue;
        const { tls, errors } = environmentTlsForDestination(destination, tuningEnv);
        const hasTls = Object.values(tls).some(signal => Object.keys(signal).length);
        const hasHeaderUnion = Boolean(destination.headers && (destination.tracesHeaders || destination.metricsHeaders));
        const hasHttps = ['traces', 'metrics'].some(signal => destination[`${signal}Enabled`] !== false && destinationSignalUrl(destination, signal).startsWith('https:'));
        if (hasTls || errors.length || hasHeaderUnion || hasHttps || destination.environmentOwned === true) destination.environmentOwned = true;
        if (hasTls || hasHttps || destination.environmentTls) destination.environmentTls = tls;
        // Failed signals report through existing safe start diagnostics instead
        // of silently falling back; a healthy peer signal can still start.
        if (errors.length) destination.environmentTlsErrors = errors;
      }
      if (normalized.enabled && !normalized.destinations && selectedEnvironment && !normalized.environmentTls) {
        const legacy = { ...normalized, tracesEnabled: true, metricsEnabled: true };
        const { tls, errors } = environmentTlsForDestination(legacy, tuningEnv);
        normalized.environmentTls = tls;
        if (errors.length) normalized.environmentTlsErrors = errors;
      }
      if (configurationKey(normalized) === configurationKey(applied)) return status();
      const previous = active;
      const env = { ...runtimeTuning, ...otelEnvironmentForConfiguration(normalized) };
      const candidate = runtimeFactory({ env, serviceVersion, clock, logger, subscribeOperational:false, ...(Array.isArray(normalized.destinations) ? { destinations: copyDestinations(normalized.destinations) } : {}) });
      try {
        if (normalized.enabled && configurationHasTransport(normalized)) {
          const started = await candidate.start();
          // A classified failure is an unavailable telemetry generation, not
          // a Core/child startup failure. Install it inactive so its redacted
          // diagnostics remain visible and no fallback exporter is created.
          // An unclassified result or thrown exception still rolls back.
          if (started?.sdkStarted !== true && !(started?.sdkStarted === false
              && Number.isSafeInteger(started?.failures?.start) && started.failures.start > 0
              && started.failures.lastStart === 'otel_runtime_start_failed')) throw new Error('opentelemetry_runtime_start_failed');
          // The physical runtime may already have allocated a processor/reader
          // before a later provider initialization failed. An inactive
          // generation must release those components rather than leave a timer
          // capable of exporting despite reporting sdkStarted=false.
          if (started.sdkStarted === false) await candidate.shutdown();
        }
      } catch (error) {
        await candidate.shutdown().catch(() => {});
        throw error;
      }
      if (closed) {
        await candidate.shutdown();
        return status();
      }
      active = generationRuntime(candidate, normalized);
      applied = normalized;
      generation += 1;
      await drain(previous);
      return status();
    };
    applying = applying.then(operation, operation);
    return applying;
  }

  function status() {
    const snapshot = { failures: { ...completed.failures }, dropped: completed.dropped, lastExportFailure: completed.lastExportFailure, destinations: completed.destinations.map(item => ({ ...item, failures: { ...item.failures }, lastExportFailure: item.lastExportFailure ? { ...item.lastExportFailure } : null })) };
    for (const entry of runtimes) accumulate(snapshot, entry.runtime.status());
    const current = active.runtime.status();
    for (const item of snapshot.destinations) {
      const now = current.destinations?.find(destination => destination.id === item.id);
      if (now && !closed) Object.assign(item, { enabled: now.enabled, tracesEnabled: now.tracesEnabled, metricsEnabled: now.metricsEnabled });
    }
    return { ...current, ...snapshot, enabled: !closed && current.enabled,
      activeRuns: owners.size, drainingRuntimes: [...runtimes].filter(entry => entry !== active).length,
      configured: configurationHasTransport(applied), generation };
  }

  function remoteConfiguration(runId = null) {
    const config = owners.get(String(runId || ''))?.config || applied;
    return Object.freeze({ enabled: config.enabled && configurationHasTransport(config), endpoint: config.endpoint,
      ...Object.fromEntries(['headers', 'tracesEndpoint', 'metricsEndpoint', 'tracesHeaders', 'metricsHeaders'].filter(key => config[key]).map(key => [key, config[key]])),
      ...(config.environmentTls ? { environmentTls: copyEnvironmentTls(config.environmentTls) } : {}),
      ...(Array.isArray(config.environmentTlsErrors) ? { environmentTlsErrors: [...config.environmentTlsErrors] } : {}),
      ...(Array.isArray(config.destinations) ? { destinations: copyDestinations(config.destinations) } : {}) });
  }

  function startRun(options = {}) {
    if (closed) return null;
    const runId = String(options.runId || '');
    // Ownership is trusted internal provenance, independent of the W3C span
    // parent. A delegated run joins its parent's generation even after a
    // replacement/disable; its own runIds entry then retains that generation.
    const owner = owners.get(runId) || operationOwners.get(`recovery:${runId}`) || owners.get(String(options.parentRunId || '')) || active;
    const result = owner.runtime.startRun(options);
    if (result) {
      owners.set(runId, owner);
      owner.runIds.add(runId);
    }
    return result;
  }

  function endRun(runId, result) {
    const key = String(runId || '');
    const owner = owners.get(key);
    if (!owner) return;
    try { return owner.runtime.endRun(runId, result); }
    finally {
      owners.delete(key);
      owner.runIds.delete(key);
      if (owner !== active) void drain(owner);
    }
  }

  function shutdown(options = {}) {
    if (shuttingDown) return shuttingDown;
    closed = true;
    stopOperational();
    // Drain known generations immediately, even if an apply is still starting.
    // In-flight candidates see closed and dispose themselves before installing.
    const draining = Promise.all([...runtimes].map(entry => drain(entry, options)));
    shuttingDown = (async () => {
      try {
        await timeout(Promise.all([applying.catch(() => {}), draining]),
          positiveInteger(options.timeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS), 'otel_shutdown_timeout');
      } catch { completed.failures.shutdown += 1; operationalEvent(logger, 'otel_runtime_shutdown_failed', { errorCode: 'otel_runtime_shutdown_timeout' }, { level: 'warn', component: 'opentelemetry' }); }
      owners.clear(); operationOwners.clear();
      return status();
    })();
    return shuttingDown;
  }

  const ownerFor = runId => owners.get(String(runId || ''))?.runtime || active.runtime;
  function observeOperational(record = {}) {
    if (closed) return;
    const recovery = ['recovery-attempt','recovery-completed'].includes(record.type) && typeof record.runId === 'string';
    const drainOperation = record.type === 'run-drain-overdue' && record.operationToken && typeof record.operationToken === 'object';
    const key = recovery ? `recovery:${record.runId}` : drainOperation ? record.operationToken : null;
    const start = recovery ? record.type === 'recovery-attempt' : drainOperation && record.outcome === 'deadline_exceeded';
    const terminal = recovery ? record.type === 'recovery-completed' : drainOperation && record.outcome === 'drained';
    // A terminal for a start observed while disabled/unavailable is not work
    // belonging to a later generation. In particular it cannot drain a peer.
    if (terminal && !operationOwners.has(key)) return;
    const owner = (key && operationOwners.get(key)) || owners.get(String(record.runId || '')) || active;
    if (start && !operationOwners.has(key) && owner.runtime.status().enabled) {
      operationOwners.set(key,owner); owner.operations.add(key);
    }
    try { owner.runtime.observeOperational?.(record); }
    finally {
      if (terminal && operationOwners.get(key) === owner) {
        operationOwners.delete(key); owner.operations.delete(key);
        if (owner !== active) void drain(owner);
      }
    }
  }
  const stopOperational = observeOperationalTelemetry(observeOperational, {active:() => !closed && active.runtime.status().enabled});
  return Object.freeze({
    apply,
    remoteConfiguration,
    start: () => closed ? Promise.resolve(status()) : active.runtime.start(),
    startRun,
    observe: (record = {}) => ownerFor(record.runId).observe(record),
    observeOperational,
    endRun,
    traceContextForRun: (runId, ...args) => ownerFor(runId).traceContextForRun(runId, ...args),
    traceContextForTool: (runId, ...args) => ownerFor(runId).traceContextForTool(runId, ...args),
    status,
    shutdown,
  });
}
