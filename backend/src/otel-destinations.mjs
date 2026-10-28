// Provider presets describe supported transports, not hosted connection validation.
const protocols = Object.freeze(['http/json', 'http/protobuf']);
const preset = (id, label, description, documentationUrl, { traces = true, metrics = true, defaultProtocol = 'http/protobuf', defaultTemporality = 'cumulative', guidance } = {}) => Object.freeze({ id, label, description, protocols, defaultProtocol, traces, metrics, defaultTemporality, documentationUrl, ...(guidance ? { guidance } : {}) });
export const OTEL_PROVIDERS = Object.freeze([
  preset('openobserve', 'OpenObserve', 'OpenObserve OTLP ingest', 'https://openobserve.ai/docs/ingestion/traces/opentelemetry/', { guidance: 'Enter the server URL and organization. Optional stream and Basic or Authorization credentials are supported.' }),
  preset('grafana-tempo', 'Grafana Tempo', 'Tempo trace receiver', 'https://grafana.com/docs/tempo/latest/set-up-for-tracing/instrument-send/set-up-collector/', { metrics: false }),
  preset('grafana-cloud', 'Grafana Cloud', 'Grafana Cloud OTLP gateway', 'https://grafana.com/docs/grafana-cloud/send-data/otlp/'),
  preset('jaeger', 'Jaeger', 'Jaeger trace receiver', 'https://www.jaegertracing.io/docs/latest/architecture/apis/', { metrics: false }),
  preset('signoz', 'SigNoz', 'SigNoz OTLP receiver', 'https://signoz.io/docs/ingestion/opentelemetry/'),
  preset('uptrace', 'Uptrace', 'Uptrace OTLP receiver', 'https://uptrace.dev/get/opentelemetry-js'),
  preset('elastic', 'Elastic', 'Elastic OTLP receiver', 'https://www.elastic.co/docs/solutions/observability/apm/opentelemetry'),
  preset('datadog', 'Datadog', 'Datadog OTLP ingest or collector', 'https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/', { defaultTemporality: 'delta', guidance: 'Direct metrics require delta temporality; collector mode can use cumulative.' }),
  preset('new-relic', 'New Relic', 'New Relic OTLP gateway', 'https://docs.newrelic.com/docs/opentelemetry/best-practices/opentelemetry-otlp/'),
  preset('honeycomb', 'Honeycomb', 'Honeycomb OTLP gateway', 'https://docs.honeycomb.io/send-data/opentelemetry/'),
  preset('splunk', 'Splunk Observability', 'Splunk OTLP ingest or collector', 'https://help.splunk.com/en/splunk-observability-cloud/manage-data/splunk-distribution-of-the-opentelemetry-collector', { guidance: 'Direct ingest accepts traces only; collector mode supports traces and metrics.' }),
  preset('custom', 'Custom OTLP', 'Generic OTLP/HTTP collector', 'https://opentelemetry.io/docs/specs/otlp/', { defaultProtocol: 'http/json' }),
]);
const providers = new Map(OTEL_PROVIDERS.map((item) => [item.id, item]));
const DESTINATION_KEYS = new Set(['id', 'name', 'provider', 'enabled', 'endpoint', 'tracesEndpoint', 'metricsEndpoint', 'protocol', 'tracesEnabled', 'metricsEnabled', 'metricsTemporality', 'connection', 'tls', 'headers', 'clearHeaders', 'credentials', 'clearCredentials']);
const CONNECTION_KEYS = new Set(['organization', 'stream', 'tenantId', 'instanceId', 'dataset', 'site', 'realm', 'mode']);
const CREDENTIAL_KEYS = ['username', 'password', 'token', 'caCertificate'];
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_HEADERS_LENGTH = 8_192;

const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const validKeys = (value, keys) => plainObject(value) && Object.keys(value).every((key) => keys.has(key));
const invalid = () => { throw new Error('opentelemetry_settings_invalid'); };

export function endpointValue(value, { allowEmpty = true, exact = false } = {}) {
  if (typeof value !== 'string') throw new Error('opentelemetry_endpoint_invalid');
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('opentelemetry_endpoint_invalid');
  const endpoint = value.trim();
  if (!endpoint && allowEmpty) return '';
  if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH || /[\x00-\x20\x7f]/.test(endpoint)) throw new Error('opentelemetry_endpoint_invalid');
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error('opentelemetry_endpoint_invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || /@/.test(endpoint.slice(endpoint.indexOf('://') + 3).split('/')[0]) || parsed.search || parsed.hash || endpoint.includes('?') || endpoint.includes('#')) throw new Error('opentelemetry_endpoint_invalid');
  if (exact) return endpoint;
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

export function headerValue(value) {
  if (typeof value !== 'string') throw new Error('opentelemetry_headers_invalid');
  if (/[\r\n]/.test(value)) throw new Error('opentelemetry_headers_invalid');
  const headers = value.trim();
  if (!headers) return '';
  if (headers.length > MAX_HEADERS_LENGTH || /[\r\n]/.test(headers)) throw new Error('opentelemetry_headers_invalid');
  const entries = headers.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length || entries.some((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1 || !entry.slice(separator + 1).trim()) return true;
    try {
      const key = decodeURIComponent(entry.slice(0, separator).trim());
      const value = decodeURIComponent(entry.slice(separator + 1).trim());
      return !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || !value || /[\x00-\x1f\x7f]/.test(value);
    } catch { return true; }
  })) throw new Error('opentelemetry_headers_invalid');
  return entries.join(',');
}

/** Normalize public input and validate shape, but retain write-only patches for transactional merge. */
export function normalizeDestination(input) {
  if (!validKeys(input, DESTINATION_KEYS) || typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.id)
      || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 160 || /[\x00-\x1f\x7f]/.test(input.name)
      || typeof input.provider !== 'string' || !providers.has(input.provider) || typeof input.enabled !== 'boolean') invalid();
  const meta = providers.get(input.provider);
  for (const key of ['endpoint', 'tracesEndpoint', 'metricsEndpoint', 'protocol', 'metricsTemporality', 'headers']) if (input[key] !== undefined && typeof input[key] !== 'string') invalid();
  for (const key of ['tracesEnabled', 'metricsEnabled', 'clearHeaders', 'clearCredentials']) if (input[key] !== undefined && typeof input[key] !== 'boolean') invalid();
  if (input.clearHeaders === true && input.headers !== undefined || input.clearCredentials === true && input.credentials !== undefined) invalid();
  const protocol = input.protocol ?? meta.defaultProtocol;
  const metricsTemporality = input.metricsTemporality ?? meta.defaultTemporality;
  if (!protocols.includes(protocol) || !['cumulative', 'delta'].includes(metricsTemporality)) invalid();
  const connection = input.connection ?? {};
  if (!validKeys(connection, CONNECTION_KEYS)) invalid();
  for (const [key, value] of Object.entries(connection)) {
    if (typeof value !== 'string' || !value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value) || key === 'mode' && value && !['direct', 'collector'].includes(value)) invalid();
  }
  if (input.provider === 'openobserve' && ['.', '..'].includes(connection.organization)) invalid();
  const tls = input.tls ?? {};
  if (!validKeys(tls, new Set(['verify'])) || tls.verify !== undefined && typeof tls.verify !== 'boolean') invalid();
  if (connection.mode && !['datadog', 'splunk'].includes(input.provider)) invalid();
  const credentials = input.credentials;
  if (credentials !== undefined && !validKeys(credentials, new Set(CREDENTIAL_KEYS))) invalid();
  if (credentials) for (const [key, value] of Object.entries(credentials)) {
    if (typeof value !== 'string' || !value.isWellFormed() || key !== 'caCertificate' && /[\x00-\x1f\x7f]/.test(value) || key === 'caCertificate' && /[\x00\x7f]/.test(value)) invalid();
  }
  const mode = connection.mode || 'direct';
  const tracesEnabled = input.tracesEnabled ?? true;
  const metricsEnabled = input.metricsEnabled ?? (meta.metrics && !(input.provider === 'splunk' && mode === 'direct'));
  if (metricsEnabled && (!meta.metrics || input.provider === 'splunk' && mode === 'direct')) throw new Error('opentelemetry_metrics_unsupported');
  if (input.provider === 'datadog' && mode === 'direct' && metricsEnabled && metricsTemporality !== 'delta') throw new Error('opentelemetry_metrics_temporality_invalid');
  const normalized = {
    id: input.id, name: input.name.trim(), provider: input.provider, enabled: input.enabled,
    endpoint: endpointValue(input.endpoint ?? ''), tracesEndpoint: endpointValue(input.tracesEndpoint ?? '', { exact: true }), metricsEndpoint: endpointValue(input.metricsEndpoint ?? '', { exact: true }),
    protocol, tracesEnabled, metricsEnabled, metricsTemporality, connection: { ...connection }, tls: { verify: tls.verify ?? true },
    ...(input.headers !== undefined ? { headers: headerValue(input.headers) } : {}),
    ...(input.clearHeaders !== undefined ? { clearHeaders: input.clearHeaders } : {}),
    ...(credentials !== undefined ? { credentials: { ...credentials } } : {}),
    ...(input.clearCredentials !== undefined ? { clearCredentials: input.clearCredentials } : {}),
  };
  if (normalized.enabled) {
    if (!tracesEnabled && !metricsEnabled) throw new Error('opentelemetry_signals_required');
    if (['datadog', 'splunk'].includes(input.provider) && mode === 'direct' && (tracesEnabled && !normalized.tracesEndpoint || metricsEnabled && !normalized.metricsEndpoint)) throw new Error('opentelemetry_exact_endpoint_required');
    if (tracesEnabled && !normalized.endpoint && !normalized.tracesEndpoint || metricsEnabled && !normalized.endpoint && !normalized.metricsEndpoint) throw new Error('opentelemetry_endpoint_required');
    if (input.provider === 'openobserve' && normalized.endpoint && !/\/api\/[^/]+\/?$/.test(new URL(normalized.endpoint).pathname) && !connection.organization?.trim()) throw new Error('opentelemetry_organization_required');
  }
  return normalized;
}

/** Omitted secrets survive edits to the same destination/provider; provider changes start clean. */
export function mergeDestination(input, previous = null) {
  const sameOwner = previous && previous.id === input.id && previous.provider === input.provider;
  const oldHeaders = sameOwner ? previous.headers || null : null;
  const oldCredentials = sameOwner ? previous.credentials || {} : {};
  const headers = input.clearHeaders ? null : input.headers || oldHeaders;
  const credentials = input.clearCredentials ? {} : { ...oldCredentials };
  if (!input.clearCredentials) for (const key of CREDENTIAL_KEYS) if (input.credentials?.[key]) credentials[key] = input.credentials[key];
  const { clearHeaders, clearCredentials, ...publicFields } = input;
  return { ...publicFields, headers, credentials };
}

export function virtualDestination(settings = {}) {
  if (!settings.endpoint && !settings.headers) return [];
  return [{ legacy: true, id: 'default', name: 'Default', provider: 'custom', enabled: Boolean(settings.endpoint), endpoint: settings.endpoint || '', tracesEndpoint: '', metricsEndpoint: '', protocol: 'http/json', tracesEnabled: true, metricsEnabled: true, metricsTemporality: 'cumulative', connection: {}, tls: { verify: true }, headers: settings.headers || null, credentials: {} }];
}
export function savedDestinations(settings = {}) { return Array.isArray(settings.destinations) ? settings.destinations : virtualDestination(settings); }

export function publicDestination(destination) {
  const { id, name, provider, enabled, endpoint, tracesEndpoint, metricsEndpoint, protocol, tracesEnabled, metricsEnabled, metricsTemporality, connection, tls } = destination;
  const credentialFields = CREDENTIAL_KEYS.filter((key) => Boolean(destination.credentials?.[key]));
  return { id, name, provider, legacy: destination.legacy === true, enabled, endpoint, tracesEndpoint, metricsEndpoint, protocol, tracesEnabled, metricsEnabled, metricsTemporality, connection: { ...connection }, tls: { verify: tls?.verify !== false }, headersConfigured: Boolean(destination.headers), credentialsConfigured: credentialFields.length > 0, credentialFields };
}

function encodedHeaders(destination) {
  const generated = new Map();
  const add = (key, value) => { if (value) generated.set(key.toLowerCase(), [key, value]); };
  const { provider, credentials = {}, connection = {} } = destination;
  const token = credentials.token;
  switch (provider) {
    case 'openobserve':
      if (token) add('Authorization', token);
      else if (credentials.username || credentials.password) add('Authorization', `Basic ${Buffer.from(`${credentials.username || ''}:${credentials.password || ''}`).toString('base64')}`);
      add('stream-name', connection.stream); break;
    case 'grafana-cloud': if (connection.instanceId && token) add('Authorization', `Basic ${Buffer.from(`${connection.instanceId}:${token}`).toString('base64')}`); break;
    case 'grafana-tempo': add('X-Scope-OrgID', connection.tenantId); // fall through
    case 'jaeger': if (token) add('Authorization', `Bearer ${token}`); break;
    case 'signoz': add('signoz-ingestion-key', token); break;
    case 'uptrace': add('uptrace-dsn', token); break;
    case 'elastic': if (token) add('Authorization', `ApiKey ${token}`); break;
    case 'datadog': add('dd-api-key', token); break;
    case 'new-relic': add('api-key', token); break;
    case 'honeycomb': add('x-honeycomb-team', token); add('x-honeycomb-dataset', connection.dataset); break;
    case 'splunk': add('X-SF-Token', token); break;
    default: break;
  }
  if (destination.headers) for (const entry of headerValue(destination.headers).split(',')) {
    const index = entry.indexOf('=');
    const key = decodeURIComponent(entry.slice(0, index).trim());
    const value = decodeURIComponent(entry.slice(index + 1).trim());
    generated.set(key.toLowerCase(), [key, value]);
  }
  return [...generated.values()].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join(',') || null;
}

/** This object is private transport configuration, never an API response. */
export function resolveDestination(destination) {
  let endpoint = destination.endpoint;
  if (destination.provider === 'openobserve' && endpoint && destination.connection?.organization) {
    const url = new URL(endpoint);
    if (!/\/api\/[^/]+\/?$/.test(url.pathname)) {
      let organization;
      try { organization = encodeURIComponent(destination.connection.organization); } catch { throw new Error('opentelemetry_settings_invalid'); }
      endpoint = `${endpoint.replace(/\/$/, '')}/api/${organization}`;
    }
  }
  return { id: destination.id, enabled: destination.enabled, endpoint, tracesEndpoint: destination.tracesEndpoint || null, metricsEndpoint: destination.metricsEndpoint || null,
    headers: encodedHeaders(destination), protocol: destination.protocol, tracesEnabled: destination.tracesEnabled, metricsEnabled: destination.metricsEnabled,
    metricsTemporality: destination.metricsTemporality, tls: { verify: destination.tls?.verify !== false, ...(destination.credentials?.caCertificate ? { caCertificate: destination.credentials.caCertificate } : {}) } };
}

export const __otelDestinations__ = Object.freeze({ MAX_ENDPOINT_LENGTH, MAX_HEADERS_LENGTH, CREDENTIAL_KEYS, encodedHeaders });
