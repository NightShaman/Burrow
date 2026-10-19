import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { unsafeImageAddress } from './model-adapters/provider-image-url.mjs';

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
  const settings = { enabled: stored?.enabled === true, endpoint: endpointValue(stored?.endpoint || ''), headersConfigured: Boolean(stored?.headers), ...(streamName(stored?.headers) ? { streamName: streamName(stored.headers) } : {}) };
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

function decodedHeaders(value) {
  if (!value) return {};
  const reserved = new Set(['connection', 'content-length', 'content-type', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  const entries = headerValue(value).split(',').map((entry) => {
    const separator = entry.indexOf('=');
    const key = decodeURIComponent(entry.slice(0, separator).trim());
    if (reserved.has(key.toLowerCase())) throw new Error('opentelemetry_headers_reserved');
    return [key, decodeURIComponent(entry.slice(separator + 1).trim())];
  });
  return Object.fromEntries(entries);
}

function streamName(value) {
  if (!value) return null;
  for (const entry of headerValue(value).split(',')) {
    const separator = entry.indexOf('=');
    const key = decodeURIComponent(entry.slice(0, separator).trim());
    if (key.toLowerCase() === 'stream-name') return decodeURIComponent(entry.slice(separator + 1).trim()) || null;
  }
  return null;
}

async function pinnedCollectorRequest(endpoint, { headers, signal, lookupImpl = lookup } = {}) {
  const url = new URL(endpoint);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const dnsLookup = isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookupImpl(hostname, { all: true, verbatim: true });
  const addresses = signal ? await Promise.race([dnsLookup, new Promise((_, reject) => {
    const abort = () => reject(signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  })]) : await dnsLookup;
  if (!addresses.length || addresses.some(({ address }) => unsafeImageAddress(address))) throw new Error('opentelemetry_destination_blocked');
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST', headers, signal,
      lookup: (_host, options, callback) => {
        const selected = addresses.find((address) => !options.family || address.family === options.family) || addresses[0];
        callback(null, options.all ? [selected] : selected.address, selected.family);
      },
    }, (response) => {
      const status = response.statusCode;
      response.destroy();
      request.destroy();
      resolve({ ok: status >= 200 && status < 300, status, body: null });
    });
    request.on('error', reject);
    request.end(Buffer.alloc(0));
  });
}

export async function testOtelConnection(body, options = {}) {
  const allowed = new Set(['endpoint', 'headers', 'clearHeaders']);
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !allowed.has(key))
      || typeof body.endpoint !== 'string'
      || (body.headers !== undefined && typeof body.headers !== 'string')
      || (body.clearHeaders !== undefined && typeof body.clearHeaders !== 'boolean')
      || (body.headers !== undefined && body.clearHeaders === true)) {
    return { ok: false, status: 400, error: 'opentelemetry_test_invalid' };
  }
  let endpoint;
  let replacementHeaders;
  try {
    endpoint = endpointValue(body.endpoint);
    replacementHeaders = body.headers === undefined ? undefined : headerValue(body.headers);
  } catch (error) { return { ok: false, status: 400, error: error.message }; }
  if (!endpoint) return { ok: false, status: 400, error: 'opentelemetry_endpoint_required' };
  const stored = await storedSettings(options);
  const storedEndpoint = endpointValue(stored?.endpoint || '');
  if (replacementHeaders === undefined && body.clearHeaders !== true && stored?.headers && endpoint !== storedEndpoint) {
    return { ok: false, status: 400, error: 'opentelemetry_saved_headers_endpoint_mismatch' };
  }
  const headers = body.clearHeaders === true ? null : replacementHeaders === undefined ? stored?.headers || null : replacementHeaders || null;
  const traceEndpoint = `${endpoint.replace(/\/$/, '')}/v1/traces`;
  const timeoutMs = Number(options.timeoutMs ?? options.env?.BURROW_OTEL_TEST_TIMEOUT_MS ?? process.env.BURROW_OTEL_TEST_TIMEOUT_MS ?? 5_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) return { ok: false, status: 400, error: 'opentelemetry_test_timeout_invalid' };
  const timeoutController = new AbortController();
  const signal = options.signal ? AbortSignal.any([timeoutController.signal, options.signal]) : timeoutController.signal;
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  timer.unref?.();
  const startedAt = (options.clock || Date.now)();
  try {
    let requestHeaders;
    try { requestHeaders = decodedHeaders(headers); }
    catch (error) { return { ok: false, status: 400, error: error.message }; }
    const request = options.fetch
      ? (url, init) => options.fetch(url, { ...init, redirect: 'error', body: Buffer.alloc(0) })
      : (url, init) => pinnedCollectorRequest(url, { ...init, lookupImpl: options.lookup });
    const response = await request(traceEndpoint, {
      headers: { ...requestHeaders, 'content-type': 'application/x-protobuf' },
      signal,
    });
    await response.body?.cancel?.().catch(() => {});
    const durationMs = Math.max(0, Math.round((options.clock || Date.now)() - startedAt));
    if (response.ok) return { ok: true, collectorStatus: response.status, durationMs };
    if ([401, 403].includes(response.status)) return { ok: false, status: 502, error: 'opentelemetry_authentication_failed', collectorStatus: response.status };
    if (response.status === 404) return { ok: false, status: 502, error: 'opentelemetry_endpoint_not_found', collectorStatus: response.status };
    return { ok: false, status: 502, error: 'opentelemetry_connection_failed', collectorStatus: response.status };
  } catch (error) {
    if (error?.message === 'opentelemetry_destination_blocked') return { ok: false, status: 400, error: 'opentelemetry_destination_blocked' };
    const timedOut = timeoutController.signal.aborted || error?.name === 'TimeoutError';
    return { ok: false, status: timedOut ? 504 : 502, error: timedOut ? 'opentelemetry_connection_timeout' : 'opentelemetry_connection_failed' };
  } finally { clearTimeout(timer); }
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
