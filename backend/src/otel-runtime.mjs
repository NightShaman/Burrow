import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { extractTraceContext, traceContextFromSpan } from './otel-context.mjs';

const SERVICE_NAME = 'burrow';
const INSTRUMENTATION_NAME = 'burrow.runtime';
const DEFAULT_EXPORT_TIMEOUT_MS = 3_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_QUEUE_SIZE = 1_024;
const DEFAULT_BATCH_SIZE = 128;
const DEFAULT_METRIC_INTERVAL_MS = 15_000;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function bounded(value, limit = 160) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, limit) : null;
}

function safeOutcome(result = {}) {
  if (result?.ok === true) return 'success';
  if (result?.decision === 'cancelled' || result?.status === 'cancelled') return 'cancelled';
  if (result?.decision === 'superseded') return 'superseded';
  if (result?.decision === 'blocked') return 'blocked';
  return 'failure';
}

function usageValues(usage = {}) {
  const input = finite(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens);
  const output = finite(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens);
  const total = finite(usage.total_tokens ?? usage.totalTokens) ?? (input !== null && output !== null ? input + output : null);
  return { input, output, total };
}

function timeout(promise, timeoutMs, code) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(code)), timeoutMs).unref()),
  ]);
}

function traceExporterOptions(env) {
  const url = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const headers = env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS;
  return { ...(url ? { url } : {}), ...(headers ? { headers: Object.fromEntries(String(headers).split(',').map((entry) => entry.split('=', 2).map((value) => decodeURIComponent(value.trim()))).filter(([key, value]) => key && value)) } : {}), timeoutMillis: Math.max(1, Number(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT || DEFAULT_EXPORT_TIMEOUT_MS)) };
}

function metricExporterOptions(env) {
  const url = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  const headers = env.OTEL_EXPORTER_OTLP_METRICS_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS;
  return { ...(url ? { url } : {}), ...(headers ? { headers: Object.fromEntries(String(headers).split(',').map((entry) => entry.split('=', 2).map((value) => decodeURIComponent(value.trim()))).filter(([key, value]) => key && value)) } : {}), timeoutMillis: Math.max(1, Number(env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT || DEFAULT_EXPORT_TIMEOUT_MS)) };
}

export function createOtelRuntime({ env = process.env, serviceVersion = null, traceExporter = null, metricExporter = null, resource = null, clock = () => Date.now() } = {}) {
  let started = false;
  let closed = false;
  let tracerProvider = null;
  let meterProvider = null;
  let tracer = null;
  let instruments = null;
  const activeRuns = new Map();
  const failures = { start: 0, observe: 0, export: 0, shutdown: 0 };
  let dropped = 0;

  function monitoredExporter(exporter) {
    const monitored = {
      export(batch, callback) {
        try {
          exporter.export(batch, (result) => {
            if (result?.code !== 0) { failures.export += 1; dropped += Array.isArray(batch) ? batch.length : 1; }
            callback(result);
          });
        } catch (error) {
          failures.export += 1;
          dropped += Array.isArray(batch) ? batch.length : 1;
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
      serviceName: SERVICE_NAME,
    };
  }

  async function start() {
    if (started || closed) return status();
    try {
      const resolvedTraceExporter = monitoredExporter(traceExporter || new OTLPTraceExporter(traceExporterOptions(env)));
      const resolvedMetricExporter = monitoredExporter(metricExporter || new OTLPMetricExporter(metricExporterOptions(env)));
      const spanProcessor = new BatchSpanProcessor(resolvedTraceExporter, {
        maxQueueSize: Math.max(1, Number(env.OTEL_BSP_MAX_QUEUE_SIZE || DEFAULT_QUEUE_SIZE)),
        maxExportBatchSize: Math.max(1, Number(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE || DEFAULT_BATCH_SIZE)),
        scheduledDelayMillis: Math.max(1, Number(env.OTEL_BSP_SCHEDULE_DELAY || 1_000)),
        exportTimeoutMillis: Math.max(1, Number(env.OTEL_BSP_EXPORT_TIMEOUT || DEFAULT_EXPORT_TIMEOUT_MS)),
      });
      const metricExportInterval = Math.max(1_000, Number(env.OTEL_METRIC_EXPORT_INTERVAL || DEFAULT_METRIC_INTERVAL_MS));
      const metricReader = new PeriodicExportingMetricReader({
        exporter: resolvedMetricExporter,
        exportIntervalMillis: metricExportInterval,
        exportTimeoutMillis: Math.min(metricExportInterval, Math.max(1, Number(env.OTEL_METRIC_EXPORT_TIMEOUT || DEFAULT_EXPORT_TIMEOUT_MS))),
      });
      const resolvedResource = resource || resourceFromAttributes({ 'service.name': SERVICE_NAME, ...(serviceVersion ? { 'service.version': String(serviceVersion) } : {}) });
      tracerProvider = new NodeTracerProvider({ resource: resolvedResource, spanProcessors: [spanProcessor] });
      meterProvider = new MeterProvider({ resource: resolvedResource, readers: [metricReader] });
      tracer = tracerProvider.getTracer(INSTRUMENTATION_NAME, serviceVersion || undefined);
      const meter = meterProvider.getMeter(INSTRUMENTATION_NAME, serviceVersion || undefined);
      instruments = {
        runs: meter.createCounter('burrow.runs'),
        runDuration: meter.createHistogram('burrow.run.duration', { unit: 'ms' }),
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
    } catch (error) {
      failures.start += 1;
      failures.lastStart = bounded(error?.message || error, 160);
    }
    return status();
  }

  function startRun({ runId, sessionId = null, agentId = null, source = 'chat', parentTraceContext = null } = {}) {
    if (!started || closed || !runId) return null;
    try {
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
        const outcome = payload.ok === true ? 'success' : 'failure';
        const metricAttributes = { 'gen_ai.provider.name': entry.attributes['gen_ai.provider.name'] || 'unknown', 'gen_ai.request.model': entry.attributes['gen_ai.request.model'] || 'unknown', 'burrow.outcome': outcome };
        const status = finite(payload.status);
        if (status !== null) entry.span.setAttribute('http.response.status_code', status);
        entry.span.setStatus({ code: payload.ok === true ? SpanStatusCode.OK : SpanStatusCode.ERROR, ...(payload.ok === true ? {} : { message: bounded(payload.error, 160) || 'model_request_failed' }) });
        entry.span.end();
        state.modelSpans.delete(String(payload.requestId));
        instruments.models.add(1, metricAttributes);
        instruments.modelDuration.record(Math.max(0, clock() - entry.startedAt), metricAttributes);
        const usage = usageValues(payload.usage || {});
        for (const [kind, value] of Object.entries(usage)) if (value !== null) instruments.tokens.add(value, { ...metricAttributes, 'burrow.token.kind': kind });
        const cached = finite(payload.cachedTokens);
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
        const outcome = payload.ok === true ? 'success' : 'failure';
        const metricAttributes = { 'burrow.tool.name': entry.attributes['burrow.tool.name'], 'burrow.execution.target': entry.attributes['burrow.execution.target'] || 'local', 'burrow.outcome': outcome };
        const exitCode = finite(payload.exitCode);
        if (exitCode !== null) entry.span.setAttribute('process.exit.code', exitCode);
        entry.span.setStatus({ code: payload.ok === true ? SpanStatusCode.OK : SpanStatusCode.ERROR, ...(payload.ok === true ? {} : { message: bounded(payload.error, 160) || 'tool_call_failed' }) });
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
    if (outcome !== 'success') state.span.setStatus({ code: SpanStatusCode.ERROR, message: bounded(result.error || result.decision || result.status, 160) || outcome });
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
      ].filter(Boolean)), Math.max(1, timeoutMs), 'otel_shutdown_timeout');
    } catch { failures.shutdown += 1; }
    return status();
  }

  return Object.freeze({ start, startRun, observe, endRun, traceContextForRun, traceContextForTool, status, shutdown });
}

export const __otelRuntime__ = Object.freeze({ usageValues, safeOutcome, traceExporterOptions, metricExporterOptions });
