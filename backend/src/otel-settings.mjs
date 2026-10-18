const METADATA_KEY = 'opentelemetry';

function booleanEnvironment(value) {
  if (value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!['true', 'false'].includes(normalized)) throw new Error('BURROW_OTEL_ENABLED requires true or false');
  return normalized === 'true';
}

export function otelConfig({ env = process.env, settings = {} } = {}) {
  const environment = booleanEnvironment(env.BURROW_OTEL_ENABLED);
  return {
    enabled: environment ?? (settings.enabled === true),
    source: environment !== null ? 'environment' : settings.enabled !== undefined ? 'database' : 'default',
    restartRequired: false,
  };
}

export async function otelSettings({ metadata, env = process.env, runtimeStatus = null } = {}) {
  if (!metadata?.get) throw new Error('settings_metadata_store_required');
  const stored = await metadata.get(METADATA_KEY);
  const settings = { enabled: stored?.enabled === true };
  const effective = otelConfig({ env, settings });
  const runtime = typeof runtimeStatus === 'function' ? runtimeStatus() : null;
  return {
    ok: true,
    settings,
    effective: { ...effective, restartRequired: Boolean(runtime?.sdkStarted && !effective.enabled) },
    ...(runtime ? { runtime } : {}),
  };
}

export async function saveOtelSettings(body, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => key !== 'enabled') || typeof body.enabled !== 'boolean') {
    return { ok: false, status: 400, error: 'opentelemetry_enabled_boolean_required' };
  }
  if (!options.metadata?.set) throw new Error('settings_metadata_store_required');
  await options.metadata.set(METADATA_KEY, { enabled: body.enabled });
  return otelSettings(options);
}

export const __otelSettings__ = Object.freeze({ METADATA_KEY, booleanEnvironment });
