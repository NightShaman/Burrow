import { operationalEvent } from './operational-log.mjs';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { extractTraceContext, traceContextFromSpan } from './otel-context.mjs';
import { projectModelRecoveryRecord } from './model-recovery-projection.mjs';

const SERVICE_NAME = 'burrow';
const INSTRUMENTATION_NAME = 'burrow.runtime';
const DEFAULT_EXPORT_TIMEOUT_MS = 3_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_QUEUE_SIZE = 1_024;
const DEFAULT_BATCH_SIZE = 128;
const DEFAULT_METRIC_INTERVAL_MS = 15_000;

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function bounded(value, limit = 160) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, limit) : null;
}

function safeOutcome(result = {}) {
  const statuses = [result?.decision, result?.status];
  // Explicit terminal evidence takes precedence over a generic transport ok.
  if (result?.timedOut === true || statuses.some(value => ['timeout', 'timed_out', 'timedOut'].includes(value))) return 'timeout';
  if (result?.cancelled === true || statuses.includes('cancelled')) return 'cancelled';
  if (statuses.includes('superseded')) return 'superseded';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.some(value => ['failed', 'failure', 'error'].includes(value))) return 'failure';
  if (result?.ok === false) return 'failure';
  if (result?.ok === true || statuses.some(value => ['success', 'succeeded', 'completed'].includes(value))) return 'success';
  return 'failure';
}

function tokenCount(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function usageValues(usage = {}) {
  const input = tokenCount(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens);
  const output = tokenCount(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens);
  const total = tokenCount(usage.total_tokens ?? usage.totalTokens) ?? (input !== null && output !== null ? input + output : null);
  return { input, output, total };
}

function timeout(promise, timeoutMs, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), timeoutMs); timer.unref(); }),
  ]).finally(() => clearTimeout(timer));
}

function signalEndpoint(env, signal) {
  const exact = String(env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`] || '').trim();
  if (exact) return exact;
  const base = String(env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim().replace(/\/$/, '');
  return base ? `${base}/v1/${signal}` : null;
}

function positiveInteger(value, fallback, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? Math.min(maximum, Math.floor(number)) : fallback;
}

function parseExporterHeaders(source) {
  return Object.fromEntries(String(source).split(',').map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1) return [];
    return [entry.slice(0, separator), entry.slice(separator + 1)].map(value => decodeURIComponent(value.trim()));
  }).filter(([key, value]) => key && value));
}

function exportFailure(error, signal) {
  const status = Number(error?.statusCode ?? error?.status ?? (error?.name === 'OTLPExporterError' ? error.code : undefined));
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const code = error?.code ?? error?.cause?.code;
  const reason = httpStatus ? 'http_error' : ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code) || error?.name === 'TimeoutError' ? 'timeout'
    : ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) ? 'connection_error' : 'export_failed';
  return { signal, reason, ...(httpStatus ? { httpStatus } : {}) };
}

function traceExporterOptions(env) {
  const url = signalEndpoint(env, 'traces');
  const headers = env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS;
  return { ...(url ? { url } : {}), ...(headers ? { headers: parseExporterHeaders(headers) } : {}), timeoutMillis: positiveInteger(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT, DEFAULT_EXPORT_TIMEOUT_MS) };
}

function metricExporterOptions(env) {
  const url = signalEndpoint(env, 'metrics');
  const headers = env.OTEL_EXPORTER_OTLP_METRICS_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS;
  return { ...(url ? { url } : {}), ...(headers ? { headers: parseExporterHeaders(headers) } : {}), timeoutMillis: positiveInteger(env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT, DEFAULT_EXPORT_TIMEOUT_MS) };
}

export function createOtelRuntime({ env = process.env, serviceVersion = null, traceExporter = null, metricExporter = null, resource = null, clock = () => Date.now(), logger = console } = {}) {
  let started = false;
  let closed = false;
  let tracerProvider = null;
  let meterProvider = null;
  let tracer = null;
  let instruments = null;
  const activeRuns = new Map();
  const failures = { start: 0, observe: 0, export: 0, shutdown: 0 };
  let dropped = 0;
  let lastExportFailure = null;

  function monitoredExporter(exporter, signal) {
    let consecutiveFailures = 0;
    let lastWarningAt = null;
    let suppressed = 0;
    function exported(error, batch) {
      if (!error) {
        if (consecutiveFailures) operationalEvent(logger, 'otel_export_restored', { signal, failures: consecutiveFailures, suppressed }, { level: 'info', component: 'opentelemetry' });
        consecutiveFailures = 0; lastWarningAt = null; suppressed = 0;
        return;
      }
      lastExportFailure = exportFailure(error, signal);
      failures.export += 1;
      dropped += Array.isArray(batch) ? batch.length : 1;
      consecutiveFailures += 1;
      if (lastWarningAt === null || clock() - lastWarningAt >= 60_000) {
        operationalEvent(logger, lastWarningAt === null ? 'otel_export_failed' : 'otel_export_failure_summary', { ...lastExportFailure, failures: consecutiveFailures, suppressed }, { level: 'warn', component: 'opentelemetry' });
        lastWarningAt = clock(); suppressed = 0;
      } else suppressed += 1;
    }
    const monitored = {
      export(batch, callback) {
        try {
          exporter.export(batch, (result) => {
            exported(result?.code !== 0 ? (result?.error || new Error('otel_export_failed')) : null, batch);
            callback(result);
          });
        } catch (error) {
          exported(error, batch);
          callback({ code: 1, error });
        }
      },
      forceFlush: () => exporter.forceFlush?.() || Promise.resolve(),
      shutdown: () => exporter.shutdown?.() || Promise.resolve(),
    };
    if (typeof exporter.selectAggregationTemporality === 'function') monitored.selectAggregationTemporality = (...args) => exporter.selectAggregationTemporality(...args);
    if (typeof exporter.selectAggregation === 'function') monitored.selectAggregation = (...args) => exporter.selectAggregation(...args);
    return monitored;
  }

  function status() {
    return {
      enabled: started && !closed,
      sdkStarted: started,
      activeRuns: activeRuns.size,
      failures: { ...failures },
      dropped,
      lastExportFailure: lastExportFailure ? { ...lastExportFailure } : null,
      serviceName: SERVICE_NAME,
    };
  }

  async function start() {
    if (started || closed) return status();
    try {
      const resolvedTraceExporter = monitoredExporter(traceExporter || new OTLPTraceExporter(traceExporterOptions(env)), 'traces');
      const resolvedMetricExporter = monitoredExporter(metricExporter || new OTLPMetricExporter(metricExporterOptions(env)), 'metrics');
      const spanProcessor = new BatchSpanProcessor(resolvedTraceExporter, {
        maxQueueSize: positiveInteger(env.OTEL_BSP_MAX_QUEUE_SIZE, DEFAULT_QUEUE_SIZE),
        maxExportBatchSize: positiveInteger(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, DEFAULT_BATCH_SIZE),
        scheduledDelayMillis: positiveInteger(env.OTEL_BSP_SCHEDULE_DELAY, 1_000),
        exportTimeoutMillis: positiveInteger(env.OTEL_BSP_EXPORT_TIMEOUT, DEFAULT_EXPORT_TIMEOUT_MS),
      });
      const metricExportInterval = positiveInteger(env.OTEL_METRIC_EXPORT_INTERVAL, DEFAULT_METRIC_INTERVAL_MS, { minimum: 1_000 });
      const metricReader = new PeriodicExportingMetricReader({
        exporter: resolvedMetricExporter,
        exportIntervalMillis: metricExportInterval,
        exportTimeoutMillis: Math.min(metricExportInterval, positiveInteger(env.OTEL_METRIC_EXPORT_TIMEOUT, DEFAULT_EXPORT_TIMEOUT_MS)),
      });
      const resolvedResource = resource || resourceFromAttributes({ 'service.name': SERVICE_NAME, ...(serviceVersion ? { 'service.version': String(serviceVersion) } : {}) });
      tracerProvider = new NodeTracerProvider({ resource: resolvedResource, spanProcessors: [spanProcessor] });
      meterProvider = new MeterProvider({ resource: resolvedResource, readers: [metricReader] });
      tracer = tracerProvider.getTracer(INSTRUMENTATION_NAME, serviceVersion || undefined);
      const meter = meterProvider.getMeter(INSTRUMENTATION_NAME, serviceVersion || undefined);
      instruments = {
        runs: meter.createCounter('burrow.runs'),
        runDuration: meter.createHistogram('burrow.run.duration', { unit: 'ms' }),
        poolRequests: meter.createCounter('burrow.provider_pool.requests'),
        poolTokens: meter.createCounter('burrow.provider_pool.tokens'),
        poolDuration: meter.createHistogram('burrow.provider_pool.duration', { unit: 'ms' }),
        models: meter.createCounter('burrow.model.requests'),
        modelDuration: meter.createHistogram('burrow.model.duration', { unit: 'ms' }),
        tokens: meter.createCounter('burrow.model.tokens'),
        tools: meter.createCounter('burrow.tool.calls'),
        toolDuration: meter.createHistogram('burrow.tool.duration', { unit: 'ms' }),
        activeRuns: meter.createObservableGauge('burrow.runs.active'),
        processUptime: meter.createObservableGauge('process.runtime.nodejs.uptime', { unit: 's' }),
        processMemory: meter.createObservableGauge('process.memory.usage', { unit: 'By' }),
        exportFailures: meter.createObservableCounter('burrow.otel.export.failures'),
        telemetryDropped: meter.createObservableCounter('burrow.otel.telemetry.dropped'),
      };
      instruments.activeRuns.addCallback((observable) => observable.observe(activeRuns.size));
      instruments.processUptime.addCallback((observable) => observable.observe(process.uptime()));
      instruments.processMemory.addCallback((observable) => {
        const memory = process.memoryUsage();
        observable.observe(memory.rss, { 'process.memory.type': 'rss' });
        observable.observe(memory.heapUsed, { 'process.memory.type': 'heap_used' });
        observable.observe(memory.heapTotal, { 'process.memory.type': 'heap_total' });
        observable.observe(memory.external, { 'process.memory.type': 'external' });
      });
      instruments.exportFailures.addCallback((observable) => observable.observe(failures.export));
      instruments.telemetryDropped.addCallback((observable) => observable.observe(dropped));
      started = true;
    } catch {
      failures.start += 1;
      failures.lastStart = 'otel_runtime_start_failed';
      operationalEvent(logger, 'otel_runtime_start_failed', { errorCode: 'otel_runtime_start_failed' }, { level: 'error', component: 'opentelemetry' });
    }
    return status();
  }

  function startRun({ runId, sessionId = null, agentId = null, source = 'chat', parentTraceContext = null } = {}) {
    if (!started || closed || !runId) return null;
    try {
      const existing = activeRuns.get(String(runId));
      if (existing) return Object.freeze({ runId: existing.runId, traceContext: traceContextFromSpan(existing.span), context: existing.context });
      const parentContext = extractTraceContext(parentTraceContext, context.active());
      const startedAt = clock();
      const span = tracer.startSpan('burrow.run', {
        kind: SpanKind.INTERNAL,
        attributes: {
          'burrow.run.id': String(runId),
          ...(sessionId ? { 'burrow.session.id': String(sessionId) } : {}),
          ...(agentId ? { 'burrow.agent.id': String(agentId) } : {}),
          'burrow.run.source': bounded(source, 64) || 'chat',
        },
      }, parentContext);
      const runContext = trace.setSpan(parentContext, span);
      const state = { runId: String(runId), startedAt, span, context: runContext, modelSpans: new Map(), toolSpans: new Map(), source: bounded(source, 64) || 'chat' };
      activeRuns.set(state.runId, state);
      return Object.freeze({ runId: state.runId, traceContext: traceContextFromSpan(span), context: runContext });
    } catch {
      failures.observe += 1;
      return null;
    }
  }

  function traceContextForRun(runId) {
    const state = activeRuns.get(String(runId || ''));
    return state ? traceContextFromSpan(state.span) : null;
  }

  function traceContextForTool(runId, activityIdOrToolCallId) {
    const state = activeRuns.get(String(runId || ''));
    const key = String(activityIdOrToolCallId || '');
    const entry = state?.toolSpans.get(key) || [...(state?.toolSpans.values() || [])].find((candidate) => candidate.toolCallId === key);
    return entry ? traceContextFromSpan(entry.span) : traceContextForRun(runId);
  }

  function observe(record = {}) {
    if (!started || closed) return;
    try {
      const state = activeRuns.get(String(record.runId || ''));
      if (!state) return;
      const payload = record.payload || {};
      if (record.type === 'model-recovery') {
        const recovery = projectModelRecoveryRecord(payload);
        if (!recovery) return;
        const attributes = { 'burrow.model.recovery.state': recovery.state };
        if (recovery.method) attributes['burrow.model.recovery.method'] = recovery.method;
        if (recovery.attempt !== undefined) attributes['burrow.model.recovery.attempt'] = recovery.attempt;
        if (recovery.maxAttempts !== undefined) attributes['burrow.model.recovery.max_attempts'] = recovery.maxAttempts;
        for (const [key, name] of [['originalFailure', 'original_failure'], ['lastFailure', 'last_failure']]) {
          const failure = recovery[key];
          if (!failure) continue;
          attributes[`burrow.model.recovery.${name}.code`] = failure.code;
          attributes[`burrow.model.recovery.${name}.origin`] = failure.origin;
        }
        if (recovery.originalFailure?.origin === 'upstream' && recovery.originalFailure.status !== undefined) {
          attributes['burrow.model.recovery.upstream_status'] = recovery.originalFailure.status;
        }
        if (recovery.failover) {
          attributes['burrow.model.recovery.failover.code'] = recovery.failover.code;
          attributes['burrow.model.recovery.failover.action'] = recovery.failover.action;
        }
        // Recovery belongs to the live run. Its schema has no physical request
        // ID, so do not guess which request span to annotate or close.
        state.span.addEvent('burrow.model.recovery', attributes);
        return;
      }
      if (record.type === 'model' && payload.stage === 'provider-pool-attempt') {
        const attributes = {'burrow.pool.id':bounded(payload.poolId,160), 'burrow.account.id':bounded(payload.memberId,160),
          'gen_ai.request.model':bounded(payload.model,160), 'burrow.outcome':payload.outcome};
        // Dedicated LB series, not a second emission into the generic transport counter.
        // IDs for individual requests remain in trace records, never metric labels.
        for (const [kind,key] of [['input','inputTokens'],['output','outputTokens'],['cached','cachedTokens']]) {
          const value = payload[key];
          if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
            instruments.poolTokens.add(value,{...attributes,'burrow.token.kind':kind});
        }
        return;
      }
      if (record.type === 'model' && payload.stage === 'provider-pool-outcome') {
        const attributes = {'burrow.pool.id':bounded(payload.poolId,160), 'gen_ai.request.model':bounded(payload.model,160), 'burrow.outcome':payload.outcome};
        instruments.poolRequests.add(1,attributes);
        instruments.poolDuration.record(Math.max(0,Number(payload.durationMs)||0),attributes);
        return;
      }
      if (record.type === 'model' && payload.stage === 'model-request' && payload.requestId) {
        const attributes = {
          ...(bounded(payload.provider, 80) ? { 'gen_ai.provider.name': bounded(payload.provider, 80) } : {}),
          ...(bounded(payload.model, 160) ? { 'gen_ai.request.model': bounded(payload.model, 160) } : {}),
          ...(bounded(payload.api, 80) ? { 'burrow.model.api': bounded(payload.api, 80) } : {}),
        };
        const span = tracer.startSpan('burrow.model.request', { kind: SpanKind.CLIENT, attributes }, state.context);
        state.modelSpans.set(String(payload.requestId), { span, startedAt: clock(), attributes });
        return;
      }
      if (record.type === 'model' && payload.stage === 'model-response' && payload.requestId) {
        const entry = state.modelSpans.get(String(payload.requestId));
        if (!entry) return;
        const outcome = safeOutcome(payload);
        const metricAttributes = { 'gen_ai.provider.name': entry.attributes['gen_ai.provider.name'] || 'unknown', 'gen_ai.request.model': entry.attributes['gen_ai.request.model'] || 'unknown', 'burrow.outcome': outcome };
        const status = finite(payload.status);
        if (status !== null) entry.span.setAttribute('http.response.status_code', status);
        // External statuses are curated too: raw errors remain local receipts.
        entry.span.setStatus({ code: outcome === 'success' ? SpanStatusCode.OK : SpanStatusCode.ERROR, ...(outcome === 'success' ? {} : { message: outcome === 'failure' ? 'model_request_failed' : outcome }) });
        const usage = usageValues(payload.usage || {});
        const cached = tokenCount(payload.cachedTokens);
        for (const [kind, value] of Object.entries(usage)) {
          if (value !== null) entry.span.setAttribute(`gen_ai.usage.${kind}_tokens`, value);
        }
        if (cached !== null) entry.span.setAttribute('gen_ai.usage.cache_read.input_tokens', cached);
        entry.span.end();
        state.modelSpans.delete(String(payload.requestId));
        instruments.models.add(1, metricAttributes);
        instruments.modelDuration.record(Math.max(0, clock() - entry.startedAt), metricAttributes);
        for (const [kind, value] of Object.entries(usage)) if (value !== null) instruments.tokens.add(value, { ...metricAttributes, 'burrow.token.kind': kind });
        if (cached !== null) instruments.tokens.add(cached, { ...metricAttributes, 'burrow.token.kind': 'cached' });
        return;
      }
      if (record.type === 'tool' && payload.phase === 'start' && payload.activityId) {
        const attributes = {
          'burrow.tool.name': bounded(payload.tool, 120) || 'unknown',
          ...(bounded(payload.executionTarget, 32) ? { 'burrow.execution.target': bounded(payload.executionTarget, 32) } : {}),
          ...(bounded(payload.providerId, 120) ? { 'burrow.execution.provider': bounded(payload.providerId, 120) } : {}),
        };
        const span = tracer.startSpan('burrow.tool.call', { kind: payload.executionTarget === 'remote' ? SpanKind.CLIENT : SpanKind.INTERNAL, attributes }, state.context);
        state.toolSpans.set(String(payload.activityId), { span, startedAt: clock(), attributes, toolCallId: String(payload.toolCallId || '') || null });
        return;
      }
      if (record.type === 'tool' && payload.phase === 'result' && payload.activityId) {
        const entry = state.toolSpans.get(String(payload.activityId));
        if (!entry) return;
        const outcome = safeOutcome(payload);
        const metricAttributes = { 'burrow.tool.name': entry.attributes['burrow.tool.name'], 'burrow.execution.target': entry.attributes['burrow.execution.target'] || 'local', 'burrow.outcome': outcome };
        const exitCode = finite(payload.exitCode);
        if (exitCode !== null) entry.span.setAttribute('process.exit.code', exitCode);
        entry.span.setAttribute('burrow.outcome', outcome);
        entry.span.setStatus({ code: outcome === 'success' ? SpanStatusCode.OK : SpanStatusCode.ERROR, ...(outcome === 'success' ? {} : { message: outcome === 'failure' ? 'tool_call_failed' : outcome }) });
        entry.span.end();
        state.toolSpans.delete(String(payload.activityId));
        instruments.tools.add(1, metricAttributes);
        instruments.toolDuration.record(Math.max(0, clock() - entry.startedAt), metricAttributes);
      }
    } catch {
      failures.observe += 1;
    }
  }

  function endRun(runId, result = {}) {
    const state = activeRuns.get(String(runId || ''));
    if (!state) return;
    activeRuns.delete(state.runId);
    const outcome = safeOutcome(result);
    for (const entry of [...state.modelSpans.values(), ...state.toolSpans.values()]) {
      entry.span.setStatus({ code: SpanStatusCode.ERROR, message: 'run_ended_before_child_span' });
      entry.span.end();
    }
    state.span.setAttribute('burrow.run.outcome', outcome);
    if (outcome !== 'success') state.span.setStatus({ code: SpanStatusCode.ERROR, message: outcome });
    else state.span.setStatus({ code: SpanStatusCode.OK });
    state.span.end();
    const attributes = { 'burrow.run.source': state.source, 'burrow.outcome': outcome };
    instruments.runs.add(1, attributes);
    instruments.runDuration.record(Math.max(0, clock() - state.startedAt), attributes);
  }

  async function shutdown({ timeoutMs = Number(env.BURROW_OTEL_SHUTDOWN_TIMEOUT_MS || DEFAULT_SHUTDOWN_TIMEOUT_MS) } = {}) {
    if (closed) return status();
    for (const state of [...activeRuns.values()]) endRun(state.runId, { ok: false, status: 'cancelled' });
    closed = true;
    try {
      await timeout(Promise.all([
        tracerProvider?.shutdown?.(),
        meterProvider?.shutdown?.(),
      ].filter(Boolean)), positiveInteger(timeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS), 'otel_shutdown_timeout');
    } catch { failures.shutdown += 1; operationalEvent(logger, 'otel_runtime_shutdown_failed', { errorCode: 'otel_runtime_shutdown_failed' }, { level: 'warn', component: 'opentelemetry' }); }
    return status();
  }

  return Object.freeze({ start, startRun, observe, endRun, traceContextForRun, traceContextForTool, status, shutdown });
}

function genericEndpointForConfiguration(config = {}) {
  const endpoint = String(config.endpoint || '').trim();
  // otel-settings also reports the effective display endpoint in `endpoint`
  // when only signal-specific environment URLs exist. That alias is not a base.
  return [config.tracesEndpoint, config.metricsEndpoint].includes(endpoint) ? '' : endpoint;
}

// Private transport configuration: generic endpoints are bases; signal endpoints
// are exact URLs. Keep this allowlist separate from ambient process credentials.
export function otelEnvironmentForConfiguration(config = {}) {
  const transport = { ...config, endpoint: genericEndpointForConfiguration(config) };
  return Object.fromEntries([
    ['endpoint', 'OTEL_EXPORTER_OTLP_ENDPOINT'],
    ['tracesEndpoint', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
    ['metricsEndpoint', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'],
    ['headers', 'OTEL_EXPORTER_OTLP_HEADERS'],
    ['tracesHeaders', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS'],
    ['metricsHeaders', 'OTEL_EXPORTER_OTLP_METRICS_HEADERS'],
  ].filter(([key]) => transport[key]).map(([key, envKey]) => [envKey, String(transport[key])]));
}

export function createReconfigurableOtelRuntime({ serviceVersion = null, clock = () => Date.now(), runtimeFactory = createOtelRuntime, tuningEnv = process.env, logger = console } = {}) {
  const runtimeTuning = Object.fromEntries(Object.entries(tuningEnv).filter(([key, value]) => value && /^(?:OTEL_BSP_|OTEL_METRIC_EXPORT_|OTEL_RESOURCE_ATTRIBUTES$|OTEL_SERVICE_NAME$|OTEL_SDK_DISABLED$|OTEL_EXPORTER_OTLP_(?:TIMEOUT|TRACES_TIMEOUT|METRICS_TIMEOUT))/.test(key)));
  const emptyConfiguration = { enabled: false, endpoint: '', headers: null, tracesEndpoint: null, metricsEndpoint: null, tracesHeaders: null, metricsHeaders: null };
  const runtimes = new Set();
  const owners = new Map();
  const completed = { failures: { start: 0, observe: 0, export: 0, shutdown: 0 }, dropped: 0, lastExportFailure: null };
  function generationRuntime(runtime, config) {
    const entry = { runtime, config, runIds: new Set(), draining: null };
    runtimes.add(entry);
    return entry;
  }
  let active = generationRuntime(runtimeFactory({ env: runtimeTuning, serviceVersion, clock, logger }), emptyConfiguration);
  let applied = emptyConfiguration;
  let generation = 0;
  let applying = Promise.resolve();
  let closed = false;
  let shuttingDown = null;

  function configurationKey(config) {
    return JSON.stringify([config.enabled === true, String(config.endpoint || ''), String(config.headers || ''), String(config.tracesEndpoint || ''), String(config.metricsEndpoint || ''), String(config.tracesHeaders || ''), String(config.metricsHeaders || '')]);
  }

  function accumulate(target, snapshot = {}) {
    for (const key of Object.keys(target.failures)) target.failures[key] += snapshot.failures?.[key] || 0;
    target.dropped += snapshot.dropped || 0;
    if (snapshot.lastExportFailure) target.lastExportFailure = snapshot.lastExportFailure;
  }

  function drain(entry, options) {
    if (entry.draining) return entry.draining;
    // A settings change is not a run terminal. Old generations keep accepting
    // their own observations and completions, including while disabled globally.
    if (entry.runIds.size && !closed) return Promise.resolve();
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
      tracesEndpoint: config.tracesEndpoint || null, metricsEndpoint: config.metricsEndpoint || null, tracesHeaders: config.tracesHeaders || null, metricsHeaders: config.metricsHeaders || null };
    const operation = async () => {
      if (closed || configurationKey(normalized) === configurationKey(applied)) return status();
      const previous = active;
      const env = { ...runtimeTuning, ...otelEnvironmentForConfiguration(normalized) };
      const candidate = runtimeFactory({ env, serviceVersion, clock, logger });
      try {
        if (normalized.enabled && (normalized.endpoint || normalized.tracesEndpoint || normalized.metricsEndpoint)) {
          const started = await candidate.start();
          if (started?.sdkStarted !== true) throw new Error('opentelemetry_runtime_start_failed');
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
    const snapshot = { failures: { ...completed.failures }, dropped: completed.dropped, lastExportFailure: completed.lastExportFailure };
    for (const entry of runtimes) accumulate(snapshot, entry.runtime.status());
    const current = active.runtime.status();
    return { ...current, ...snapshot, enabled: !closed && current.enabled,
      activeRuns: owners.size, drainingRuntimes: [...runtimes].filter(entry => entry !== active).length,
      configured: Boolean(applied.endpoint || applied.tracesEndpoint || applied.metricsEndpoint), generation };
  }

  function remoteConfiguration(runId = null) {
    const config = owners.get(String(runId || ''))?.config || applied;
    return Object.freeze({ enabled: config.enabled && Boolean(config.endpoint || config.tracesEndpoint || config.metricsEndpoint), endpoint: config.endpoint,
      ...Object.fromEntries(['headers', 'tracesEndpoint', 'metricsEndpoint', 'tracesHeaders', 'metricsHeaders'].filter(key => config[key]).map(key => [key, config[key]])) });
  }

  function startRun(options = {}) {
    if (closed) return null;
    const runId = String(options.runId || '');
    // Ownership is trusted internal provenance, independent of the W3C span
    // parent. A delegated run joins its parent's generation even after a
    // replacement/disable; its own runIds entry then retains that generation.
    const owner = owners.get(runId) || owners.get(String(options.parentRunId || '')) || active;
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
    // Drain known generations immediately, even if an apply is still starting.
    // In-flight candidates see closed and dispose themselves before installing.
    const draining = Promise.all([...runtimes].map(entry => drain(entry, options)));
    shuttingDown = (async () => {
      try {
        await timeout(Promise.all([applying.catch(() => {}), draining]),
          positiveInteger(options.timeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS), 'otel_shutdown_timeout');
      } catch { completed.failures.shutdown += 1; operationalEvent(logger, 'otel_runtime_shutdown_failed', { errorCode: 'otel_runtime_shutdown_timeout' }, { level: 'warn', component: 'opentelemetry' }); }
      owners.clear();
      return status();
    })();
    return shuttingDown;
  }

  const ownerFor = runId => owners.get(String(runId || ''))?.runtime || active.runtime;
  return Object.freeze({
    apply,
    remoteConfiguration,
    start: () => closed ? Promise.resolve(status()) : active.runtime.start(),
    startRun,
    observe: (record = {}) => ownerFor(record.runId).observe(record),
    endRun,
    traceContextForRun: (runId, ...args) => ownerFor(runId).traceContextForRun(runId, ...args),
    traceContextForTool: (runId, ...args) => ownerFor(runId).traceContextForTool(runId, ...args),
    status,
    shutdown,
  });
}

export const __otelRuntime__ = Object.freeze({ usageValues, safeOutcome, signalEndpoint, positiveInteger, traceExporterOptions, metricExporterOptions });
