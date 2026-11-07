import { operationalEvent } from './operational-log.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { extractTraceContext, traceContextFromSpan } from './otel-context.mjs';
import { projectModelRecoveryRecord } from './model-recovery-projection.mjs';
import { createProviderResponsivenessProjection } from './provider-responsiveness-otel.mjs';
import { createOperationalProjection } from './operational-otel.mjs';
import { observeOperationalTelemetry, operationalTelemetrySnapshot } from './operational-telemetry.mjs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { positiveInteger, exportFailure, safeDestinationId, traceExporterOptions, metricExporterOptions, resolvedDestinationOptions, readEnvironmentTls, privateAgentFactory, privateOtlpExporter } from './otel-transport.mjs';
import { timeout } from './otel-runtime-utils.mjs';
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

export function safeOutcome(result = {}) {
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

export function usageValues(usage = {}) {
  const input = tokenCount(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens);
  const output = tokenCount(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens);
  const total = tokenCount(usage.total_tokens ?? usage.totalTokens) ?? (input !== null && output !== null ? input + output : null);
  return { input, output, total };
}

export function createOtelRuntime({ env = process.env, destinations = null, serviceVersion = null, traceExporter = null, metricExporter = null, resource = null, clock = () => Date.now(), logger = console, subscribeOperational = true } = {}) {
  let started = false;
  let attemptedStart = false;
  let closed = false;
  let tracerProvider = null;
  let meterProvider = null;
  let tracer = null;
  let instruments = null;
  let providerProjection = null;
  let operationalProjection = null, stopOperational = null, eventLoop = null;
  const activeRuns = new Map();
  const destinationStatuses = [];
  const spanProcessors = [];
  const metricReaders = [];
  const agents = new Set();
  const failures = { start: 0, observe: 0, export: 0, shutdown: 0 };
  let dropped = 0;
  let lastExportFailure = null;

  function monitoredExporter(exporter, signal, destinationStatus, exportTimeoutMs, responseScope) {
    let consecutiveFailures = 0;
    let lastWarningAt = null;
    let suppressed = 0;
    let lastCollectorWarningAt = null;
    let lastInvalidResponseWarningAt = null;
    function exported(error, batch, partial, invalid) {
      if (!error && invalid && (lastInvalidResponseWarningAt === null || clock() - lastInvalidResponseWarningAt >= 60_000)) {
        operationalEvent(logger, 'otel_export_response_invalid', { signal, destinationId: destinationStatus.id }, { level: 'warn', component: 'opentelemetry' });
        lastInvalidResponseWarningAt = clock();
      }
      if (!error && partial?.warning && partial.rejectedItems === 0
        && (lastCollectorWarningAt === null || clock() - lastCollectorWarningAt >= 60_000)) {
        operationalEvent(logger, 'otel_export_collector_warning', { signal, destinationId: destinationStatus.id, httpStatus: partial.httpStatus, rejectedItems: 0 }, { level: 'warn', component: 'opentelemetry' });
        lastCollectorWarningAt = clock();
      }
      const rejectedItems = !error && partial?.rejectedItems > 0 ? partial.rejectedItems : null;
      if (!error && rejectedItems === null) {
        if (consecutiveFailures) operationalEvent(logger, 'otel_export_restored', { signal, destinationId: destinationStatus.id, failures: consecutiveFailures, suppressed }, { level: 'info', component: 'opentelemetry' });
        consecutiveFailures = 0; lastWarningAt = null; suppressed = 0;
        return;
      }
      lastExportFailure = rejectedItems !== null ? { signal, reason: 'partial_success', httpStatus: partial.httpStatus, rejectedItems } : exportFailure(error, signal);
      failures.export += 1;
      destinationStatus.failures.export += 1;
      destinationStatus.lastExportFailure = { ...lastExportFailure };
      const dropCount = rejectedItems !== null ? rejectedItems : Array.isArray(batch) ? batch.length : 1;
      dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + dropCount);
      destinationStatus.dropped = Math.min(Number.MAX_SAFE_INTEGER, destinationStatus.dropped + dropCount);
      consecutiveFailures += 1;
      if (lastWarningAt === null || clock() - lastWarningAt >= 60_000) {
        operationalEvent(logger, lastWarningAt === null ? (rejectedItems !== null ? 'otel_export_partial_success' : 'otel_export_failed') : 'otel_export_failure_summary', { ...lastExportFailure, destinationId: destinationStatus.id, failures: consecutiveFailures, suppressed }, { level: 'warn', component: 'opentelemetry' });
        lastWarningAt = clock(); suppressed = 0;
      } else suppressed += 1;
    }
    const monitored = {
      export(batch, callback) {
        let complete = false;
        const responseState = { complete: false, partial: null, invalid: false };
        const timer = setTimeout(() => finish({ code: 1, error: Object.assign(new Error('otel_export_timeout'), { name: 'TimeoutError' }) }), exportTimeoutMs);
        timer.unref?.();
        function finish(result) {
          if (complete) return;
          complete = true;
          responseState.complete = true;
          clearTimeout(timer);
          const error = result?.code !== 0 ? (result?.error || new Error('otel_export_failed')) : null;
          exported(error, batch, responseState.partial, responseState.invalid);
          // The SDK may log callback errors through its global diagnostic handler.
          // Never pass an exporter response body, URL or raw error back into it.
          callback(error ? { code: 1, error: new Error('otel_export_failed') } : { code: 0 });
        }
        try { responseScope.run(responseState, () => exporter.export(batch, finish)); }
        catch (error) { finish({ code: 1, error }); }
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
      destinations: destinationStatuses.map(item => ({ ...item, failures: { ...item.failures }, lastExportFailure: item.lastExportFailure ? { ...item.lastExportFailure } : null })),
    };
  }

  async function start() {
    // Failed starts retain diagnostics and may contain partial SDK components;
    // recover only via a fresh reconfigured generation, never by retrying this
    // immutable snapshot or duplicating its destinations and failure counts.
    if (attemptedStart || closed) return status();
    attemptedStart = true;
    try {
      const entries = Array.isArray(destinations) ? destinations : [{ id: 'default', enabled: true, tracesEnabled: true, metricsEnabled: true }];
      const metricExportInterval = positiveInteger(env.OTEL_METRIC_EXPORT_INTERVAL, DEFAULT_METRIC_INTERVAL_MS, { minimum: 1_000, maximum: 3_600_000 });
      const traceExportTimeout = positiveInteger(env.OTEL_BSP_EXPORT_TIMEOUT, DEFAULT_EXPORT_TIMEOUT_MS, { maximum: 30_000 });
      const metricExportTimeout = Math.min(metricExportInterval, positiveInteger(env.OTEL_METRIC_EXPORT_TIMEOUT, DEFAULT_EXPORT_TIMEOUT_MS, { maximum: 30_000 }));
      const queueSize = positiveInteger(env.OTEL_BSP_MAX_QUEUE_SIZE, DEFAULT_QUEUE_SIZE, { maximum: 10_240 });
      for (const [index, destination] of entries.entries()) {
        const item = { id: safeDestinationId(destination?.id, index), enabled: destination?.enabled === true,
          tracesEnabled: destination?.tracesEnabled !== false, metricsEnabled: destination?.metricsEnabled !== false,
          failures: { start: 0, export: 0, shutdown: 0 }, dropped: 0, lastExportFailure: null };
        destinationStatuses.push(item);
        if (!item.enabled) continue;
        let failedStart = false;
        for (const signal of ['traces', 'metrics']) {
          if (!item[`${signal}Enabled`]) continue;
          try {
            const legacy = !Array.isArray(destinations);
            let exporter = signal === 'traces' ? traceExporter : metricExporter;
            const responseScope = new AsyncLocalStorage();
            if (!exporter) {
              const options = legacy ? (signal === 'traces' ? traceExporterOptions(env) : metricExporterOptions(env)) : resolvedDestinationOptions(destination, signal, env, agents, responseScope);
              if (legacy) {
                // Match the SDK default only after start(), never on a disabled runtime.
                options.url ||= `http://localhost:4318/v1/${signal}`;
                const parsed = new URL(options.url);
                if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('otel_destination_endpoint_invalid');
                if (env.BURROW_OTEL_PRIVATE_TLS_ERRORS?.includes(signal)) throw new Error('otel_environment_tls_unavailable');
                const suppliedTls = env.BURROW_OTEL_PRIVATE_TLS?.[signal];
                const tls = suppliedTls || (env.BURROW_OTEL_PRIVATE_TLS ? {} : parsed.protocol === 'https:' ? readEnvironmentTls(env, signal) : {});
                options.httpAgentOptions = privateAgentFactory(options.url, options.headers || {}, tls, agents, { signal, protocol: 'http/json', scope: responseScope });
              }
              if (!legacy && !['http/json', 'http/protobuf'].includes(destination.protocol)) throw new Error('otel_destination_protocol_invalid');
              exporter = privateOtlpExporter(options, signal, legacy ? 'http/json' : destination.protocol, env, legacy || destination.environmentOwned === true);
            }
            const monitored = monitoredExporter(exporter, signal, item, signal === 'traces' ? traceExportTimeout : metricExportTimeout, responseScope);
            if (signal === 'traces') {
              const processor = new BatchSpanProcessor(monitored, {
                maxQueueSize: queueSize,
                maxExportBatchSize: Math.min(queueSize, positiveInteger(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, DEFAULT_BATCH_SIZE, { maximum: 1_024 })),
                scheduledDelayMillis: positiveInteger(env.OTEL_BSP_SCHEDULE_DELAY, 1_000, { maximum: 60_000 }),
                exportTimeoutMillis: traceExportTimeout + 100,
              });
              spanProcessors.push({ processor, item });
            } else {
              const reader = new PeriodicExportingMetricReader({ exporter: monitored, exportIntervalMillis: metricExportInterval, exportTimeoutMillis: metricExportTimeout + 100 > metricExportInterval ? metricExportInterval : metricExportTimeout + 100 });
              metricReaders.push({ reader, item });
            }
          } catch {
            if (!Array.isArray(destinations) && !env.BURROW_OTEL_PRIVATE_TLS_ERRORS) throw new Error('otel_runtime_start_failed');
            if (!failedStart) { failures.start += 1; item.failures.start += 1; failedStart = true; }
            failures.lastStart = 'otel_runtime_start_failed';
            operationalEvent(logger, 'otel_destination_start_failed', { destinationId: item.id, signal, errorCode: 'otel_runtime_start_failed' }, { level: 'error', component: 'opentelemetry' });
          }
        }
      }
      if (!spanProcessors.length && !metricReaders.length) return status();
      const resolvedResource = resource || resourceFromAttributes({ 'service.name': SERVICE_NAME, ...(serviceVersion ? { 'service.version': String(serviceVersion) } : {}) });
      tracerProvider = new NodeTracerProvider({ resource: resolvedResource, spanProcessors: spanProcessors.map(entry => entry.processor) });
      meterProvider = new MeterProvider({ resource: resolvedResource, readers: metricReaders.map(entry => entry.reader) });
      tracer = tracerProvider.getTracer(INSTRUMENTATION_NAME, serviceVersion || undefined);
      const meter = meterProvider.getMeter(INSTRUMENTATION_NAME, serviceVersion || undefined);
      instruments = {
        runs: meter.createCounter('burrow.runs'),
        runDuration: meter.createHistogram('burrow.run.duration', { unit: 'ms' }),
        poolRequests: meter.createCounter('burrow.provider_pool.requests'),
        poolTokens: meter.createCounter('burrow.provider_pool.tokens'),
        poolDuration: meter.createHistogram('burrow.provider_pool.duration', { unit: 'ms' }),
        poolAttempts: meter.createCounter('burrow.provider_pool.attempts'),
        poolAttemptDuration: meter.createHistogram('burrow.provider_pool.attempt.duration', { unit: 'ms' }),
        poolTTFT: meter.createHistogram('burrow.provider_pool.ttft', { unit: 'ms' }),
        poolRequestTTFT: meter.createHistogram('burrow.provider_pool.request.ttft', { unit:'ms' }),
        poolRetries: meter.createCounter('burrow.provider_pool.retries'),
        poolFailovers: meter.createCounter('burrow.provider_pool.failovers'),
        poolCooldownTransitions: meter.createCounter('burrow.provider_pool.cooldown.transitions'),
        poolCooldownDuration: meter.createHistogram('burrow.provider_pool.cooldown.duration', { unit: 'ms' }),
        models: meter.createCounter('burrow.model.requests'),
        modelDuration: meter.createHistogram('burrow.model.duration', { unit: 'ms' }),
        modelTTFT: meter.createHistogram('burrow.model.ttft', { unit: 'ms' }),
        modelFirstDelta: meter.createHistogram('burrow.model.first_delta', { unit: 'ms' }),
        tokens: meter.createCounter('burrow.model.tokens'),
        tools: meter.createCounter('burrow.tool.calls'),
        toolDuration: meter.createHistogram('burrow.tool.duration', { unit: 'ms' }),
        activeRuns: meter.createObservableGauge('burrow.runs.active'),
        processUptime: meter.createObservableGauge('process.runtime.nodejs.uptime', { unit: 's' }),
        processMemory: meter.createObservableGauge('process.memory.usage', { unit: 'By' }),
        exportFailures: meter.createObservableCounter('burrow.otel.export.failures'),
        telemetryDropped: meter.createObservableCounter('burrow.otel.telemetry.dropped'),
      };
      providerProjection = createProviderResponsivenessProjection({ tracer, instruments, clock, usageValues, tokenCount, onContext:observeOperational });
      operationalProjection = createOperationalProjection({ tracer, meter, clock, stateForRun:runId => activeRuns.get(String(runId || '')) });
      eventLoop = monitorEventLoopDelay({ resolution:20 });
      eventLoop.enable();
      const lag = meter.createObservableGauge('burrow.core.event_loop.lag', { unit:'ms' });
      lag.addCallback(observer => {
        if (!eventLoop?.count) return;
        for (const statistic of ['mean','max']) if (Number.isFinite(eventLoop[statistic])) observer.observe(eventLoop[statistic] / 1e6, { 'burrow.statistic':statistic });
      });
      const runStates = meter.createObservableGauge('burrow.runs.state', { unit:'{run}' });
      runStates.addCallback(observer => {
        for (const phase of ['working','recovering']) observer.observe([...activeRuns.values()].filter(state => (state.recoveryState === 'recovering' ? 'recovering' : 'working') === phase).length, { 'burrow.run.state':phase });
      });
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
      for (const record of operationalTelemetrySnapshot()) observeOperational(record);
      if (subscribeOperational) stopOperational = observeOperationalTelemetry(observeOperational);
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
      const parentContext = extractTraceContext(parentTraceContext, operationalProjection?.parentForRun(String(runId)) || context.active());
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

  function observeOperational(record = {}) {
    if (!started || closed) return;
    try { operationalProjection?.observe(record); } catch { failures.observe += 1; }
  }

  function observe(record = {}) {
    if (!started || closed) return;
    try {
      const state = activeRuns.get(String(record.runId || ''));
      if (!state) return;
      const payload = record.payload || {};
      if (record.type === 'context-build-receipt') {
        const budget = payload.budget || {};
        const usage = typeof budget.estimatedTokens === 'number' ? budget.estimatedTokens : null;
        observeOperational({ type:'context-pressure',runId:record.runId,usageTokens:usage, budgetTokens:budget.contextTokens ?? budget.contextWindow, usageRatio:budget.usageRatio,pressure:budget.pressure,source:'runtime_receipt',tokenSource:budget.source === 'provider-input-tokens' ? 'measured' : 'estimated' });
        return;
      }
      if (record.type === 'model-recovery') {
        const recovery = projectModelRecoveryRecord(payload);
        if (!recovery) return;
        state.recoveryState = recovery.state;
        operationalProjection?.modelRecovery(recovery);
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
      if (providerProjection?.observe(record, state)) return;
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
    providerProjection?.endRun(state);
    for (const entry of state.toolSpans.values()) {
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
    stopOperational?.(); stopOperational = null;
    eventLoop?.disable();
    operationalProjection?.shutdown();
    closed = true;
    try {
      // Start every destination shutdown independently, even when one rejects
      // or never settles. Provider Promise.all rejects early and would report
      // completion before a healthy peer finishes flushing.
      const waitMs = positiveInteger(timeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
      let anyFailure = false;
      const tasks = [...spanProcessors.map(({ processor, item }) => ({ component: processor, item })), ...metricReaders.map(({ reader, item }) => ({ component: reader, item }))];
      await Promise.all(tasks.map(async ({ component, item }) => {
        try { await timeout(Promise.resolve().then(() => component.shutdown()), waitMs, 'otel_shutdown_timeout'); }
        catch { item.failures.shutdown += 1; anyFailure = true; }
      }));
      if (anyFailure) throw new Error('otel_runtime_shutdown_failed');
    } catch { failures.shutdown += 1; operationalEvent(logger, 'otel_runtime_shutdown_failed', { errorCode: 'otel_runtime_shutdown_failed' }, { level: 'warn', component: 'opentelemetry' }); }
    finally { for (const agent of agents) agent.destroy(); agents.clear(); }
    return status();
  }

  return Object.freeze({ start, startRun, observe, observeOperational, endRun, traceContextForRun, traceContextForTool, status, shutdown });
}
