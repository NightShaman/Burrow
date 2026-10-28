import { OTEL_PROVIDERS, endpointValue, headerValue, normalizeDestination, mergeDestination, savedDestinations, publicDestination, resolveDestination, __otelDestinations__ } from './otel-destinations.mjs';

const LEGACY_METADATA_KEY = 'opentelemetry';
const { MAX_ENDPOINT_LENGTH, MAX_HEADERS_LENGTH } = __otelDestinations__;

function booleanEnvironment(value) {
  if (value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!['true', 'false'].includes(normalized)) throw new Error('BURROW_OTEL_ENABLED requires true or false');
  return normalized === 'true';
}
function optionalEndpoint(value) { return String(value || '').trim() ? endpointValue(String(value), { exact: true }) : null; }
function optionalHeaders(value) { return String(value || '').trim() ? headerValue(String(value)) : null; }
function streamName(value) {
  if (!value) return null;
  for (const entry of headerValue(value).split(',')) {
    const separator = entry.indexOf('=');
    const key = decodeURIComponent(entry.slice(0, separator).trim());
    if (key.toLowerCase() === 'stream-name') return decodeURIComponent(entry.slice(separator + 1).trim()) || null;
  }
  return null;
}
function transportEnvironment(env = {}) {
  const genericEndpoint = optionalEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const tracesEndpoint = optionalEndpoint(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const metricsEndpoint = optionalEndpoint(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT);
  const genericHeaders = optionalHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  const tracesHeaders = optionalHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS);
  const metricsHeaders = optionalHeaders(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS);
  return { genericEndpoint, tracesEndpoint, metricsEndpoint, genericHeaders, tracesHeaders, metricsHeaders,
    endpointConfigured: Boolean(genericEndpoint || tracesEndpoint || metricsEndpoint), headersConfigured: Boolean(genericHeaders || tracesHeaders || metricsHeaders) };
}

export function otelConfig({ env = process.env, settings = {} } = {}) {
  const environmentEnabled = booleanEnvironment(env.BURROW_OTEL_ENABLED);
  const transport = transportEnvironment(env);
  const saved = savedDestinations(settings);
  const resolved = saved.map(resolveDestination);
  const first = resolved.find((destination) => destination.enabled) || null;
  const savedEndpoint = first?.endpoint || first?.tracesEndpoint || first?.metricsEndpoint || '';
  const savedHeaders = first?.headers || null;
  const transportOverride = transport.endpointConfigured || transport.headersConfigured;
  let destinations = resolved;
  if (transportOverride) {
    // A transport override is one destination, never environment credentials fanned
    // out to saved owners. Signal-specific endpoints and headers stay signal-specific.
    const base = transport.genericEndpoint || (!transport.endpointConfigured ? first?.endpoint : '') || '';
    const tracesEndpoint = transport.tracesEndpoint || (!transport.endpointConfigured ? first?.tracesEndpoint : null) || null;
    const metricsEndpoint = transport.metricsEndpoint || (!transport.endpointConfigured ? first?.metricsEndpoint : null) || null;
    destinations = [{ id: 'environment', enabled: true, endpoint: base, tracesEndpoint, metricsEndpoint,
      headers: transport.genericHeaders || (!transport.headersConfigured && !Array.isArray(settings.destinations) && first ? settings.headers || null : null), tracesHeaders: transport.tracesHeaders, metricsHeaders: transport.metricsHeaders,
      protocol: !transport.endpointConfigured && first ? first.protocol : 'http/json',
      tracesEnabled: Boolean(base || tracesEndpoint) && (!transport.endpointConfigured ? first?.tracesEnabled !== false : true),
      metricsEnabled: Boolean(base || metricsEndpoint) && (!transport.endpointConfigured ? first?.metricsEnabled !== false : true),
      metricsTemporality: !transport.endpointConfigured && first ? first.metricsTemporality : 'cumulative', tls: { verify: true } }];
  }
  const effectiveFirst = destinations.find((destination) => destination.enabled && (destination.endpoint || destination.tracesEndpoint || destination.metricsEndpoint));
  const endpoint = transport.endpointConfigured ? transport.genericEndpoint || transport.tracesEndpoint || transport.metricsEndpoint : savedEndpoint;
  const headers = transportOverride ? destinations[0].headers : savedHeaders;
  const requestedEnabled = environmentEnabled ?? (settings.enabled === true);
  return {
    enabled: requestedEnabled && Boolean(effectiveFirst), endpoint: endpoint || '', headers,
    headersConfigured: transportOverride ? Boolean(destinations[0].headers || transport.tracesHeaders || transport.metricsHeaders) : Boolean(savedHeaders),
    tracesEndpoint: transportOverride ? destinations[0].tracesEndpoint : first?.tracesEndpoint || null,
    metricsEndpoint: transportOverride ? destinations[0].metricsEndpoint : first?.metricsEndpoint || null,
    tracesHeaders: transport.tracesHeaders, metricsHeaders: transport.metricsHeaders,
    destinations,
    source: environmentEnabled !== null ? 'environment' : settings.enabled !== undefined ? 'database' : 'default',
    endpointSource: transport.endpointConfigured ? 'environment' : savedEndpoint ? 'database' : 'default',
    headersSource: transport.headersConfigured ? 'environment' : headers ? 'database' : 'default',
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

function publicEnvironmentDestination(destination) {
  return { id: 'environment', name: 'Environment', provider: 'custom', enabled: destination.enabled,
    endpoint: destination.endpoint, tracesEndpoint: destination.tracesEndpoint || '', metricsEndpoint: destination.metricsEndpoint || '',
    protocol: destination.protocol, tracesEnabled: destination.tracesEnabled, metricsEnabled: destination.metricsEnabled,
    metricsTemporality: destination.metricsTemporality, connection: {}, tls: { verify: true },
    headersConfigured: Boolean(destination.headers || destination.tracesHeaders || destination.metricsHeaders), credentialsConfigured: false, credentialFields: [] };
}

export async function otelSettings({ store, metadata, env = process.env, runtimeStatus = null } = {}) {
  if (!store?.read && !metadata?.get) throw new Error('opentelemetry_settings_store_required');
  const stored = await storedSettings({ store, metadata });
  const destinations = savedDestinations(stored);
  const first = destinations[0];
  const scalarHeaders = first?.headers || (!Array.isArray(stored.destinations) ? stored.headers : null);
  const savedStream = !Array.isArray(stored.destinations) ? streamName(scalarHeaders) : null;
  const settings = { enabled: stored?.enabled === true, endpoint: first?.endpoint || (!Array.isArray(stored.destinations) ? endpointValue(stored?.endpoint || '') : ''),
    headersConfigured: Boolean(scalarHeaders), ...(savedStream ? { streamName: savedStream } : {}), destinations: destinations.map(publicDestination) };
  const effective = otelConfig({ env, settings: stored });
  const runtime = typeof runtimeStatus === 'function' ? runtimeStatus() : null;
  const transportOverride = transportEnvironment(env).endpointConfigured || transportEnvironment(env).headersConfigured;
  return { ok: true, settings, effective: {
    enabled: effective.enabled, endpoint: effective.endpoint, headersConfigured: effective.headersConfigured,
    source: effective.source, endpointSource: effective.endpointSource, headersSource: effective.headersSource, restartRequired: false,
    destinations: transportOverride ? effective.destinations.map(publicEnvironmentDestination) : destinations.map(publicDestination),
  }, providers: OTEL_PROVIDERS, ...(runtime ? { runtime } : {}) };
}

export async function readOtelRuntimeConfig(options = {}) {
  const stored = await storedSettings(options);
  return otelConfig({ env: options.env || process.env, settings: stored });
}

function settingsError(error) {
  if (['opentelemetry_legacy_ambiguous'].includes(error?.message)) return { ok: false, status: 409, error: error.message };
  if (String(error?.message || '').startsWith('opentelemetry_') && !String(error.message).endsWith('_unavailable')) return { ok: false, status: 400, error: error.message };
  throw error;
}

async function atomicUpdate(store, mutate, fallbackCurrent) {
  if (store.update) return store.update((current) => mutate(current || fallbackCurrent));
  const current = await store.read();
  const result = mutate(current || fallbackCurrent);
  return store.write(result);
}

export async function saveOtelSettings(body, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean') return { ok: false, status: 400, error: 'opentelemetry_settings_invalid' };
  if (!options.store?.write && !options.store?.update) throw new Error('opentelemetry_settings_store_required');
  try {
    const fallback = await storedSettings(options);
    if ('destinations' in body) {
      if (Object.keys(body).some((key) => !['enabled', 'destinations'].includes(key)) || !Array.isArray(body.destinations)) throw new Error('opentelemetry_settings_invalid');
      const inputs = body.destinations.map(normalizeDestination);
      if (new Set(inputs.map((input) => input.id)).size !== inputs.length) throw new Error('opentelemetry_settings_invalid');
      if (body.enabled && !inputs.some((input) => input.enabled)) throw new Error('opentelemetry_destination_required');
      await atomicUpdate(options.store, (current) => {
        const previous = new Map(savedDestinations(current).map((destination) => [destination.id, destination]));
        return { enabled: body.enabled, destinations: inputs.map((input) => mergeDestination(input, previous.get(input.id))) };
      }, fallback);
    } else {
      const allowed = new Set(['enabled', 'endpoint', 'headers', 'clearHeaders']);
      if (Object.keys(body).some((key) => !allowed.has(key)) || typeof body.endpoint !== 'string'
          || body.headers !== undefined && typeof body.headers !== 'string'
          || body.clearHeaders !== undefined && typeof body.clearHeaders !== 'boolean'
          || body.headers !== undefined && body.clearHeaders === true) throw new Error('opentelemetry_settings_invalid');
      const endpoint = endpointValue(body.endpoint);
      const headers = body.headers === undefined ? undefined : headerValue(body.headers);
      if (body.enabled && !endpoint && !otelConfig({ env: options.env || process.env, settings: { enabled: true, endpoint: '', headers: null } }).enabled) throw new Error('opentelemetry_endpoint_required');
      await atomicUpdate(options.store, (current) => {
        const previous = savedDestinations(current);
        if (Array.isArray(current?.destinations)) {
          if (previous.length > 1 || previous.length === 1 && (previous[0].provider !== 'custom' || previous[0].tracesEndpoint || previous[0].metricsEndpoint || previous[0].protocol !== 'http/json' || previous[0].tracesEnabled !== true || previous[0].metricsEnabled !== true || previous[0].tls.verify !== true || Object.keys(previous[0].connection || {}).length || Object.values(previous[0].credentials || {}).some(Boolean))) throw new Error('opentelemetry_legacy_ambiguous');
          if (!previous.length) {
            const fresh = normalizeDestination({ id: 'default', name: 'Default', provider: 'custom', enabled: Boolean(endpoint), endpoint, protocol: 'http/json', ...(headers ? { headers } : {}) });
            return { enabled: body.enabled, destinations: [mergeDestination(fresh)] };
          }
          const old = previous[0];
          const input = { ...old, endpoint, enabled: Boolean(endpoint), headers, credentials: undefined, clearHeaders: body.clearHeaders === true };
          return { enabled: body.enabled, destinations: [mergeDestination(input, old)] };
        }
        // Preserve the existing scalar replace/preserve/clear contract.
        return { enabled: body.enabled, endpoint, headers: body.clearHeaders ? null : headers || current?.headers || null };
      }, fallback);
    }
    return otelSettings(options);
  } catch (error) { return settingsError(error); }
}

export const __otelSettings__ = Object.freeze({ LEGACY_METADATA_KEY, MAX_ENDPOINT_LENGTH, MAX_HEADERS_LENGTH, booleanEnvironment, endpointValue, headerValue, transportEnvironment });
