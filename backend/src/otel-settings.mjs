const LEGACY_METADATA_KEY = 'opentelemetry';
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_HEADERS_LENGTH = 8_192;

function booleanEnvironment(value) {
  if (value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!['true', 'false'].includes(normalized)) throw new Error('BURROW_OTEL_ENABLED requires true or false');
  return normalized === 'true';
}

function endpointValue(value, { allowEmpty = true } = {}) {
  const endpoint = String(value ?? '').trim();
  if (!endpoint && allowEmpty) return '';
  if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) throw new Error('opentelemetry_endpoint_invalid');
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error('opentelemetry_endpoint_invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('opentelemetry_endpoint_invalid');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function headerValue(value) {
  const headers = String(value ?? '').trim();
  if (!headers) return '';
  if (headers.length > MAX_HEADERS_LENGTH || /[\r\n]/.test(headers)) throw new Error('opentelemetry_headers_invalid');
  const entries = headers.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length || entries.some((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1 || !entry.slice(separator + 1).trim()) return true;
    try { decodeURIComponent(entry.slice(0, separator).trim()); decodeURIComponent(entry.slice(separator + 1).trim()); return false; }
    catch { return true; }
  })) throw new Error('opentelemetry_headers_invalid');
  return entries.join(',');
}

function optionalEndpoint(value) { return String(value || '').trim() ? endpointValue(value) : null; }
function optionalHeaders(value) { return String(value || '').trim() ? headerValue(value) : null; }

function transportEnvironment(env = {}) {
  const genericEndpoint = optionalEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const tracesEndpoint = optionalEndpoint(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const metricsEndpoint = optionalEndpoint(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT);
  const genericHeaders = optionalHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  const tracesHeaders = optionalHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS);
  const metricsHeaders = optionalHeaders(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS);
  return {
    genericEndpoint, tracesEndpoint, metricsEndpoint,
    genericHeaders, tracesHeaders, metricsHeaders,
    endpointConfigured: Boolean(genericEndpoint || tracesEndpoint || metricsEndpoint),
    headersConfigured: Boolean(genericHeaders || tracesHeaders || metricsHeaders),
  };
}

export function otelConfig({ env = process.env, settings = {} } = {}) {
  const environmentEnabled = booleanEnvironment(env.BURROW_OTEL_ENABLED);
  const environmentTransport = transportEnvironment(env);
  const savedEndpoint = endpointValue(settings.endpoint || '');
  const savedHeaders = settings.headers || null;
  const hasEnvironmentEndpoint = environmentTransport.endpointConfigured;
  const hasEnvironmentHeaders = environmentTransport.headersConfigured;
  const effectiveEndpoint = environmentTransport.genericEndpoint || environmentTransport.tracesEndpoint || environmentTransport.metricsEndpoint || savedEndpoint;
  const effectiveHeadersConfigured = hasEnvironmentHeaders || Boolean(savedHeaders);
  const requestedEnabled = environmentEnabled ?? (settings.enabled === true);
  return {
    enabled: requestedEnabled && Boolean(effectiveEndpoint),
    endpoint: effectiveEndpoint,
    headers: environmentTransport.genericHeaders || (!hasEnvironmentHeaders ? savedHeaders : null),
    headersConfigured: effectiveHeadersConfigured,
    tracesEndpoint: environmentTransport.tracesEndpoint,
    metricsEndpoint: environmentTransport.metricsEndpoint,
    tracesHeaders: environmentTransport.tracesHeaders,
    metricsHeaders: environmentTransport.metricsHeaders,
    source: environmentEnabled !== null ? 'environment' : settings.enabled !== undefined ? 'database' : 'default',
    endpointSource: hasEnvironmentEndpoint ? 'environment' : savedEndpoint ? 'database' : 'default',
    headersSource: hasEnvironmentHeaders ? 'environment' : savedHeaders ? 'database' : 'default',
    restartRequired: false,
  };
}

async function storedSettings({ store, metadata }) {
  if (store?.read) {
    const stored = await store.read();
    if (stored) return stored;
  }
  if (!metadata?.get) return { enabled: false, endpoint: '', headers: null };
  const legacy = await metadata.get(LEGACY_METADATA_KEY);
  return { enabled: legacy?.enabled === true, endpoint: '', headers: null };
}

export async function otelSettings({ store, metadata, env = process.env, runtimeStatus = null } = {}) {
  if (!store?.read && !metadata?.get) throw new Error('opentelemetry_settings_store_required');
  const stored = await storedSettings({ store, metadata });
  const settings = { enabled: stored?.enabled === true, endpoint: endpointValue(stored?.endpoint || ''), headersConfigured: Boolean(stored?.headers) };
  const effective = otelConfig({ env, settings: { ...settings, headers: stored?.headers || null } });
  const runtime = typeof runtimeStatus === 'function' ? runtimeStatus() : null;
  return {
    ok: true,
    settings,
    effective: {
      enabled: effective.enabled,
      endpoint: effective.endpoint,
      headersConfigured: effective.headersConfigured,
      source: effective.source,
      endpointSource: effective.endpointSource,
      headersSource: effective.headersSource,
      restartRequired: false,
    },
    ...(runtime ? { runtime } : {}),
  };
}

export async function readOtelRuntimeConfig(options = {}) {
  const stored = await storedSettings(options);
  return otelConfig({ env: options.env || process.env, settings: stored });
}

export async function saveOtelSettings(body, options = {}) {
  const allowed = new Set(['enabled', 'endpoint', 'headers', 'clearHeaders']);
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !allowed.has(key))
      || typeof body.enabled !== 'boolean' || typeof body.endpoint !== 'string'
      || (body.headers !== undefined && typeof body.headers !== 'string')
      || (body.clearHeaders !== undefined && typeof body.clearHeaders !== 'boolean')
      || (body.headers !== undefined && body.clearHeaders === true)) {
    return { ok: false, status: 400, error: 'opentelemetry_settings_invalid' };
  }
  if (!options.store?.write) throw new Error('opentelemetry_settings_store_required');
  let endpoint;
  let replacementHeaders;
  try {
    endpoint = endpointValue(body.endpoint);
    replacementHeaders = body.headers === undefined ? undefined : headerValue(body.headers);
  } catch (error) { return { ok: false, status: 400, error: error.message }; }
  const current = await storedSettings(options);
  const headers = body.clearHeaders === true ? null : replacementHeaders === undefined || replacementHeaders === '' ? undefined : replacementHeaders;
  const candidateHeaders = headers === undefined ? current.headers || null : headers;
  const candidate = otelConfig({ env: options.env || process.env, settings: { enabled: body.enabled, endpoint, headers: candidateHeaders } });
  if (!candidate.enabled && body.enabled && !candidate.endpoint) return { ok: false, status: 400, error: 'opentelemetry_endpoint_required' };
  await options.store.write({ enabled: body.enabled, endpoint, headers });
  return otelSettings(options);
}

export const __otelSettings__ = Object.freeze({ LEGACY_METADATA_KEY, MAX_ENDPOINT_LENGTH, MAX_HEADERS_LENGTH, booleanEnvironment, endpointValue, headerValue, transportEnvironment });
