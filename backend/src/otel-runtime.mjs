import { operationalEvent } from './operational-log.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, PeriodicExportingMetricReader, InstrumentType, AggregationTemporality } from '@opentelemetry/sdk-metrics';
import { AggregationTemporalityPreference } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPExporterBase } from '@opentelemetry/otlp-exporter-base';
import { createOtlpHttpExportDelegate } from '@opentelemetry/otlp-exporter-base/node-http';
import { JsonTraceSerializer, JsonMetricsSerializer, ProtobufTraceSerializer, ProtobufMetricsSerializer, TraceExporterMetricsHelper, MetricsExporterMetricsHelper } from '@opentelemetry/otlp-transformer';
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

// Header names are case-insensitive on the wire. Generic and signal-specific
// environment entries are a union; the latter wins even when casing differs.
function environmentHeaders(generic, specific) {
  const headers = new Map();
  for (const source of [generic, specific]) {
    for (const [key, value] of Object.entries(parseExporterHeaders(source || ''))) headers.set(key.toLowerCase(), [key, value]);
  }
  return Object.fromEntries(headers.values());
}

function exporterOptions(env, signal) {
  const url = signalEndpoint(env, signal);
  const headers = environmentHeaders(env.OTEL_EXPORTER_OTLP_HEADERS, env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`]);
  return { ...(url ? { url } : {}), ...(Object.keys(headers).length ? { headers } : {}), timeoutMillis: positiveInteger(env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_TIMEOUT`] || env.OTEL_EXPORTER_OTLP_TIMEOUT, DEFAULT_EXPORT_TIMEOUT_MS) };
}
function traceExporterOptions(env) { return exporterOptions(env, 'traces'); }
function metricExporterOptions(env) { return exporterOptions(env, 'metrics'); }

const TLS_FIELDS = Object.freeze([['CERTIFICATE', 'caCertificate'], ['CLIENT_CERTIFICATE', 'clientCertificate'], ['CLIENT_KEY', 'clientKey']]);

// Called only for an enabled environment-owned HTTPS signal. A selected
// signal's file wins over the generic file independently for CA, cert and key.
// A missing/unreadable selected file fails closed, without logging its path.
function readEnvironmentTls(env, signal) {
  const tls = {};
  for (const [suffix, field] of TLS_FIELDS) {
    const path = env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_${suffix}`] || env[`OTEL_EXPORTER_OTLP_${suffix}`];
    if (!path) continue;
    try { tls[field] = readFileSync(String(path), 'utf8'); }
    catch { throw new Error('otel_environment_tls_unavailable'); }
  }
  return tls;
}
function copyEnvironmentTls(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const signal of ['traces', 'metrics']) {
    if (!value[signal] || typeof value[signal] !== 'object') continue;
    result[signal] = Object.fromEntries(TLS_FIELDS.map(([, field]) => field)
      .filter(field => typeof value[signal][field] === 'string' && value[signal][field])
      .map(field => [field, value[signal][field]]));
  }
  return result;
}
function destinationSignalUrl(destination, signal) {
  const exact = String(destination[`${signal}Endpoint`] || '').trim();
  const base = String(destination.endpoint || '').trim().replace(/\/+$/, '');
  return exact || (base ? `${base}/v1/${signal}` : '');
}
function environmentTlsForDestination(destination, env) {
  const snapshot = destination.environmentTls && typeof destination.environmentTls === 'object';
  const tls = copyEnvironmentTls(destination.environmentTls) || {};
  const errors = new Set(destination.environmentTlsErrors || []);
  for (const signal of ['traces', 'metrics']) {
    if (destination[`${signal}Enabled`] === false || snapshot || errors.has(signal)) continue;
    const url = destinationSignalUrl(destination, signal);
    try {
      // Validate before touching paths; malformed or non-TLS targets need no PEM.
      if (url && new URL(url).protocol === 'https:') tls[signal] = readEnvironmentTls(env, signal);
    } catch { errors.add(signal); }
  }
  return { tls, errors: [...errors] };
}

// The SDK's public response serializers decode but do not encode responses,
// and JSON decoding logs malformed input. Parse locally (never log raw input),
// then project before its response logger sees collector-controlled strings.
const MAX_OTLP_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REJECTED_ITEMS = Number.MAX_SAFE_INTEGER;

function boundedRejectedItems(value) {
  if (typeof value === 'bigint') {
    if (value < 0n || value > 0x7fffffffffffffffn) return null;
    return Number(value > BigInt(MAX_REJECTED_ITEMS) ? BigInt(MAX_REJECTED_ITEMS) : value);
  }
  if (typeof value === 'string') {
    if (!/^[0-9]+$/.test(value)) return null;
    // Convert only bounded significant digits, not an unbounded bigint.
    const significant = value.replace(/^0+/, '');
    if (significant.length > 16) return MAX_REJECTED_ITEMS;
    value = Number(significant || '0');
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
  return Math.min(value, MAX_REJECTED_ITEMS);
}

// OTLP trace/metric responses use field 1 (length-delimited partial success),
// whose field 1 is an int64 varint count and field 2 is a string warning.
// Walk and skip the other protobuf fields without decoding any collector text.
function visitProtobufFields(bytes, visit) {
  let offset = 0;
  function varint() {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw new Error('invalid_protobuf');
      const byte = bytes[offset++];
      if (i === 9 && byte > 1) throw new Error('invalid_protobuf');
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) return value;
    }
    throw new Error('invalid_protobuf');
  }
  while (offset < bytes.length) {
    const tag = varint();
    if (tag < 8n || tag > 0xffffffffn) throw new Error('invalid_protobuf');
    const number = Number(tag >> 3n); const wire = Number(tag & 7n);
    let value = null;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const length = varint();
      if (length > BigInt(bytes.length - offset)) throw new Error('invalid_protobuf');
      value = bytes.subarray(offset, offset + Number(length));
      offset += Number(length);
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error('invalid_protobuf');
    } else throw new Error('invalid_protobuf');
    visit(number, wire, value);
  }
}

function encodeVarint(value) {
  const encoded = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 127n);
    remaining >>= 7n;
    if (remaining) byte |= 128;
    encoded.push(byte);
  } while (remaining);
  return Buffer.from(encoded);
}

function projectCollectorResponse(body, protocol, signal) {
  let rejectedItems = null; let warning = false;
  try {
    if (protocol === 'http/protobuf') {
      visitProtobufFields(body, (number, wire, value) => {
        if (number !== 1 || wire !== 2) return;
        let count = null; let hasWarning = false;
        visitProtobufFields(value, (field, type, data) => {
          if (field === 1 && type === 0) count = boundedRejectedItems(data);
          if (field === 2 && type === 2) hasWarning = data.length > 0;
        });
        rejectedItems = count; warning = hasWarning;
      });
    } else if (body.length) {
      // JSON.parse is intentionally local: the SDK's parser logs parse errors.
      const response = JSON.parse(body.toString('utf8'));
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('invalid_otlp_response');
      const partial = response.partialSuccess ?? response.partial_success;
      if (partial !== undefined && (!partial || typeof partial !== 'object' || Array.isArray(partial))) throw new Error('invalid_otlp_response');
      if (partial) {
        const key = signal === 'traces' ? 'rejectedSpans' : 'rejectedDataPoints';
        const snakeKey = signal === 'traces' ? 'rejected_spans' : 'rejected_data_points';
        rejectedItems = boundedRejectedItems(partial[key] ?? partial[snakeKey]);
        const message = partial.errorMessage ?? partial.error_message;
        warning = typeof message === 'string' && message.length > 0;
        if (rejectedItems === null && message === undefined) warning = Object.keys(partial).length > 0;
      }
    }
  } catch { return { body: protocol === 'http/protobuf' ? Buffer.alloc(0) : Buffer.from('{}'), partial: null, invalid: true }; }

  // A zero rejection count without a warning is a full success. A warning-only
  // response gets a fixed marker so neither the SDK nor its diag logger receives
  // the untrusted errorMessage, while the warning remains observable.
  const partial = (rejectedItems > 0 || warning) ? { rejectedItems: rejectedItems ?? 0, warning } : null;
  if (protocol === 'http/protobuf') {
    if (!partial) return { body: Buffer.alloc(0), partial: null };
    const count = Buffer.concat([Buffer.from([0x08]), encodeVarint(partial.rejectedItems)]);
    const marker = partial.warning ? Buffer.from('otel_collector_warning') : Buffer.alloc(0);
    const nested = marker.length ? Buffer.concat([count, Buffer.from([0x12, marker.length]), marker]) : count;
    return { body: Buffer.concat([Buffer.from([0x0a]), encodeVarint(nested.length), nested]), partial };
  }
  const key = signal === 'traces' ? 'rejectedSpans' : 'rejectedDataPoints';
  const response = partial ? { partialSuccess: { [key]: partial.rejectedItems, ...(partial.warning ? { errorMessage: 'otel_collector_warning' } : {}) } } : {};
  return { body: Buffer.from(JSON.stringify(response)), partial };
}

// Install only this signal's own header allowlist before the request gets a
// socket. The agent, TLS policy and response projection belong to one exporter.
function privateAgentFactory(url, headers, tls = {}, agents = null, responseOptions = {}) {
  const ownHeaders = Object.entries(headers || {}).filter(([key]) => !['content-type', 'user-agent', 'host'].includes(key.toLowerCase()));
  const authority = new URL(url).host;
  return async (protocol) => {
    const { Agent } = await (protocol === 'https:' ? import('node:https') : import('node:http'));
    class DestinationAgent extends Agent {
      addRequest(request, options) {
        for (const key of request.getHeaderNames()) {
          if (!['content-type', 'user-agent'].includes(key.toLowerCase())) request.removeHeader(key);
        }
        request.setHeader('host', authority);
        for (const [key, value] of ownHeaders) request.setHeader(key, value);

        // The SDK installs its response callback before addRequest. Hand that
        // callback a private stream instead of the collector's raw bytes. The
        // response is bounded by the SDK's existing 4 MiB limit; on overflow,
        // feed an equally oversized *safe* chunk to the SDK so its own guard
        // produces the original non-retryable failure and destroys the stream.
        const listeners = request.rawListeners('response');
        for (const listener of listeners) request.removeListener('response', listener);
        // The documented agent may be reused across exports. Bind this request
        // to its own monitored export, even if an earlier export times out.
        const exportState = responseOptions.scope?.getStore();
        request.on('response', response => {
          const projected = new PassThrough();
          projected.statusCode = response.statusCode;
          projected.statusMessage = 'otel_collector_response';
          projected.headers = { 'retry-after': response.headers['retry-after'] };
          const chunks = []; let size = 0; let oversized = false;
          projected.on('close', () => { if (!response.complete) response.destroy(); });
          response.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_OTLP_RESPONSE_BYTES) {
              oversized = true;
              chunks.length = 0;
              projected.write(Buffer.alloc(MAX_OTLP_RESPONSE_BYTES + 1));
              response.destroy();
            } else chunks.push(chunk);
          });
          response.on('end', () => {
            if (oversized) return;
            const success = response.statusCode && response.statusCode <= 299;
            const projection = success ? projectCollectorResponse(Buffer.concat(chunks, size), responseOptions.protocol, responseOptions.signal)
              : { body: Buffer.alloc(0), partial: null };
            if (success && exportState && !exportState.complete) {
              if (projection.partial) exportState.partial = { ...projection.partial, httpStatus: response.statusCode };
              if (projection.invalid) exportState.invalid = true;
            }
            projected.end(projection.body);
          });
          response.on('error', () => projected.destroy(new Error('otel_response_read_failed')));
          response.on('aborted', () => projected.destroy(new Error('otel_response_read_failed')));
          for (const listener of listeners) listener.call(request, projected);
        });
        return super.addRequest(request, options);
      }
    }
    const agent = new DestinationAgent({ keepAlive: true, maxSockets: 1,
      ...(protocol === 'https:' ? { rejectUnauthorized: tls.verify !== false, ...(tls.caCertificate ? { ca: tls.caCertificate } : {}),
        ...(tls.clientCertificate ? { cert: tls.clientCertificate } : {}), ...(tls.clientKey ? { key: tls.clientKey } : {}) } : {}) });
    agents?.add(agent);
    return agent;
  };
}

function resolvedDestinationOptions(destination, signal, env, agents, scope) {
  if (destination.environmentTlsErrors?.includes(signal)) throw new Error('otel_environment_tls_unavailable');
  const url = destinationSignalUrl(destination, signal);
  if (!url) throw new Error('otel_destination_endpoint_missing');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('otel_destination_endpoint_invalid');
  const headers = destination.environmentOwned === true
    ? environmentHeaders(destination.headers, destination[`${signal}Headers`])
    : parseExporterHeaders(destination[`${signal}Headers`] || destination.headers || '');
  const tls = destination.environmentOwned === true
    ? { verify: true, ...(destination.environmentTls?.[signal] || (destination.environmentTls ? {} : parsed.protocol === 'https:' ? readEnvironmentTls(env, signal) : {})) }
    : destination.tls;
  return {
    url, headers, httpAgentOptions: privateAgentFactory(url, headers, tls, agents, { signal, protocol: destination.protocol, scope }), concurrencyLimit: 1,
    timeoutMillis: positiveInteger(env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_TIMEOUT`] || env.OTEL_EXPORTER_OTLP_TIMEOUT, DEFAULT_EXPORT_TIMEOUT_MS, { maximum: 30_000 }),
    ...(signal === 'metrics' ? { temporalityPreference: destination.metricsTemporality === 'delta' ? AggregationTemporalityPreference.DELTA : AggregationTemporalityPreference.CUMULATIVE } : {}),
  };
}

// SDK exporter constructors unconditionally read process.env, including PEM
// files, even with an explicit agent. Use their public HTTP delegate directly,
// so a saved owner never reads or inherits ambient transport credentials.
function privateOtlpExporter(options, signal, protocol, env, environmentOwned) {
  const proto = protocol === 'http/protobuf';
  const serializer = signal === 'traces' ? (proto ? ProtobufTraceSerializer : JsonTraceSerializer)
    : (proto ? ProtobufMetricsSerializer : JsonMetricsSerializer);
  const compression = environmentOwned && (env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_COMPRESSION`] || env.OTEL_EXPORTER_OTLP_COMPRESSION) === 'gzip' ? 'gzip' : 'none';
  const delegate = createOtlpHttpExportDelegate({
    url: options.url, headers: async () => ({ 'content-type': proto ? 'application/x-protobuf' : 'application/json' }),
    timeoutMillis: options.timeoutMillis, concurrencyLimit: 1, compression, agentFactory: options.httpAgentOptions,
  }, serializer, signal === 'traces' ? 'otlp_http_span_exporter' : 'otlp_http_metric_exporter',
  signal === 'traces' ? TraceExporterMetricsHelper : MetricsExporterMetricsHelper, undefined);
  const exporter = new OTLPExporterBase(delegate);
  if (signal === 'metrics') {
    const preference = options.temporalityPreference ?? ({ delta: AggregationTemporalityPreference.DELTA,
      lowmemory: AggregationTemporalityPreference.LOWMEMORY }[String(env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE || '').toLowerCase()]);
    exporter.selectAggregationTemporality = instrument => {
      if (preference === AggregationTemporalityPreference.DELTA && ![InstrumentType.UP_DOWN_COUNTER, InstrumentType.OBSERVABLE_UP_DOWN_COUNTER].includes(instrument)) return AggregationTemporality.DELTA;
      if (preference === AggregationTemporalityPreference.LOWMEMORY && [InstrumentType.COUNTER, InstrumentType.HISTOGRAM].includes(instrument)) return AggregationTemporality.DELTA;
      return AggregationTemporality.CUMULATIVE;
    };
  }
  return exporter;
}

function safeDestinationId(value, index) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : `invalid-${index + 1}`;
}

export function createOtelRuntime({ env = process.env, destinations = null, serviceVersion = null, traceExporter = null, metricExporter = null, resource = null, clock = () => Date.now(), logger = console } = {}) {
  let started = false;
  let attemptedStart = false;
  let closed = false;
  let tracerProvider = null;
  let meterProvider = null;
  let tracer = null;
  let instruments = null;
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
  return { ...Object.fromEntries([
    ['endpoint', 'OTEL_EXPORTER_OTLP_ENDPOINT'],
    ['tracesEndpoint', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
    ['metricsEndpoint', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'],
    ['headers', 'OTEL_EXPORTER_OTLP_HEADERS'],
    ['tracesHeaders', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS'],
    ['metricsHeaders', 'OTEL_EXPORTER_OTLP_METRICS_HEADERS'],
  ].filter(([key]) => transport[key]).map(([key, envKey]) => [envKey, String(transport[key])])),
    ...(config.environmentTls ? { BURROW_OTEL_PRIVATE_TLS: copyEnvironmentTls(config.environmentTls) } : {}),
    ...(Array.isArray(config.environmentTlsErrors) ? { BURROW_OTEL_PRIVATE_TLS_ERRORS: config.environmentTlsErrors.filter(signal => ['traces', 'metrics'].includes(signal)) } : {}) };
}

// Copy only the private resolved transport fields; do not propagate provider
// credentials, draft metadata or references into remote generations.
function copyDestinations(destinations) {
  return destinations.map(destination => ({
    id: String(destination?.id || ''), enabled: destination?.enabled === true,
    endpoint: String(destination?.endpoint || ''), tracesEndpoint: destination?.tracesEndpoint || null, metricsEndpoint: destination?.metricsEndpoint || null,
    headers: destination?.headers || null, tracesHeaders: destination?.tracesHeaders || null, metricsHeaders: destination?.metricsHeaders || null,
    protocol: destination?.protocol || 'http/json', tracesEnabled: destination?.tracesEnabled !== false, metricsEnabled: destination?.metricsEnabled !== false,
    metricsTemporality: destination?.metricsTemporality || 'cumulative',
    tls: { verify: destination?.tls?.verify !== false, ...(destination?.tls?.caCertificate ? { caCertificate: String(destination.tls.caCertificate) } : {}) },
    // Trusted internal generation/child payload only, never public settings:
    // environmentTls holds resolved per-signal PEM strings, not file paths.
    ...(destination?.environmentOwned === true ? { environmentOwned: true, ...(destination.environmentTls ? { environmentTls: copyEnvironmentTls(destination.environmentTls) } : {}),
      ...(Array.isArray(destination.environmentTlsErrors) ? { environmentTlsErrors: destination.environmentTlsErrors.filter(signal => ['traces', 'metrics'].includes(signal)) } : {}) } : {}),
  }));
}

function configuredDestination(destination) {
  return destination.enabled && (destination.tracesEnabled && Boolean(destination.tracesEndpoint || destination.endpoint)
    || destination.metricsEnabled && Boolean(destination.metricsEndpoint || destination.endpoint));
}

function configurationHasTransport(config) {
  return Array.isArray(config.destinations) ? config.destinations.some(configuredDestination) : Boolean(config.endpoint || config.tracesEndpoint || config.metricsEndpoint);
}

export function createReconfigurableOtelRuntime({ serviceVersion = null, clock = () => Date.now(), runtimeFactory = createOtelRuntime, tuningEnv = process.env, logger = console } = {}) {
  const runtimeTuning = Object.fromEntries(Object.entries(tuningEnv).filter(([key, value]) => value && /^(?:OTEL_BSP_|OTEL_METRIC_EXPORT_|OTEL_RESOURCE_ATTRIBUTES$|OTEL_SERVICE_NAME$|OTEL_SDK_DISABLED$|OTEL_EXPORTER_OTLP_(?:TIMEOUT|TRACES_TIMEOUT|METRICS_TIMEOUT|COMPRESSION|TRACES_COMPRESSION|METRICS_COMPRESSION|METRICS_TEMPORALITY_PREFERENCE))/.test(key)));
  const emptyConfiguration = { enabled: false, endpoint: '', headers: null, tracesEndpoint: null, metricsEndpoint: null, tracesHeaders: null, metricsHeaders: null };
  const runtimes = new Set();
  const owners = new Map();
  const completed = { failures: { start: 0, observe: 0, export: 0, shutdown: 0 }, dropped: 0, lastExportFailure: null, destinations: [] };
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
      const candidate = runtimeFactory({ env, serviceVersion, clock, logger, ...(Array.isArray(normalized.destinations) ? { destinations: copyDestinations(normalized.destinations) } : {}) });
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
