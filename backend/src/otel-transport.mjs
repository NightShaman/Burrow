import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { InstrumentType, AggregationTemporality } from '@opentelemetry/sdk-metrics';
import { AggregationTemporalityPreference } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPExporterBase } from '@opentelemetry/otlp-exporter-base';
import { createOtlpHttpExportDelegate } from '@opentelemetry/otlp-exporter-base/node-http';
import { JsonTraceSerializer, JsonMetricsSerializer, ProtobufTraceSerializer, ProtobufMetricsSerializer, TraceExporterMetricsHelper, MetricsExporterMetricsHelper } from '@opentelemetry/otlp-transformer';
const DEFAULT_EXPORT_TIMEOUT_MS = 3_000;

export function signalEndpoint(env, signal) {
  const exact = String(env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`] || '').trim();
  if (exact) return exact;
  const base = String(env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim().replace(/\/$/, '');
  return base ? `${base}/v1/${signal}` : null;
}

export function positiveInteger(value, fallback, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
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

export function exportFailure(error, signal) {
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
export function traceExporterOptions(env) { return exporterOptions(env, 'traces'); }
export function metricExporterOptions(env) { return exporterOptions(env, 'metrics'); }

const TLS_FIELDS = Object.freeze([['CERTIFICATE', 'caCertificate'], ['CLIENT_CERTIFICATE', 'clientCertificate'], ['CLIENT_KEY', 'clientKey']]);

// Called only for an enabled environment-owned HTTPS signal. A selected
// signal's file wins over the generic file independently for CA, cert and key.
// A missing/unreadable selected file fails closed, without logging its path.
export function readEnvironmentTls(env, signal) {
  const tls = {};
  for (const [suffix, field] of TLS_FIELDS) {
    const path = env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_${suffix}`] || env[`OTEL_EXPORTER_OTLP_${suffix}`];
    if (!path) continue;
    try { tls[field] = readFileSync(String(path), 'utf8'); }
    catch { throw new Error('otel_environment_tls_unavailable'); }
  }
  return tls;
}
export function copyEnvironmentTls(value) {
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
export function destinationSignalUrl(destination, signal) {
  const exact = String(destination[`${signal}Endpoint`] || '').trim();
  const base = String(destination.endpoint || '').trim().replace(/\/+$/, '');
  return exact || (base ? `${base}/v1/${signal}` : '');
}
export function environmentTlsForDestination(destination, env) {
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

export function projectCollectorResponse(body, protocol, signal) {
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
export function privateAgentFactory(url, headers, tls = {}, agents = null, responseOptions = {}) {
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

export function resolvedDestinationOptions(destination, signal, env, agents, scope) {
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
export function privateOtlpExporter(options, signal, protocol, env, environmentOwned) {
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

export function safeDestinationId(value, index) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : `invalid-${index + 1}`;
}

export function genericEndpointForConfiguration(config = {}) {
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
export function copyDestinations(destinations) {
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

export function configurationHasTransport(config) {
  return Array.isArray(config.destinations) ? config.destinations.some(configuredDestination) : Boolean(config.endpoint || config.tracesEndpoint || config.metricsEndpoint);
}
