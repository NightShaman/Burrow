// Persisted operator preference; service environment is an optional override.
export function browserOriginConfig({ env = process.env, settings = {} } = {}) {
  const value = String(env.BURROW_UI_ORIGIN_CHECK ?? settings.checkOrigin ?? 'true').trim().toLowerCase();
  if (!['true', 'false'].includes(value)) throw new Error('BURROW_UI_ORIGIN_CHECK requires true or false');
  return {
    checkOrigin: value === 'true',
    allowedOrigins: String(env.BURROW_UI_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
  };
}

export async function browserOriginSettings({ metadata, env = process.env } = {}) {
  const stored = await metadata.get('browser_origin');
  const settings = { checkOrigin: stored?.checkOrigin ?? true };
  const config = browserOriginConfig({ env, settings });
  return { ok: true, settings, effective: {
    ...config,
    source: env.BURROW_UI_ORIGIN_CHECK !== undefined ? 'environment' : stored?.checkOrigin !== undefined ? 'database' : 'default',
  } };
}

export async function saveBrowserOriginSettings(body, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'checkOrigin') || typeof body.checkOrigin !== 'boolean') {
    return { ok: false, status: 400, error: 'browser_origin_check_boolean_required' };
  }
  await options.metadata.set('browser_origin', { checkOrigin: body.checkOrigin });
  return browserOriginSettings(options);
}

export function browserRequestPolicy(req, url, { allowedOrigins = [], checkOrigin = true } = {}) {
  const origin = req.headers?.origin;
  if (origin && checkOrigin) {
    const trusted = new Set([url.origin, ...allowedOrigins]);
    // The server URL uses HTTP behind TLS-terminating proxies. Host is the
    // request authority; do not infer browser scheme from the backend socket
    // or trust arbitrary forwarded host headers.
    let sameAuthority = false;
    try {
      const browserUrl = new URL(origin);
      sameAuthority = ['http:', 'https:'].includes(browserUrl.protocol)
        && browserUrl.origin === origin && browserUrl.host === url.host;
    } catch {}
    if (!trusted.has(origin) && !sameAuthority) return { status: 403, error: 'browser_origin_not_allowed' };
  }
  const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (mutation && url.pathname.startsWith('/api/')) {
    const type = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    // Bodyless DELETE remains valid. Browser simple requests with content cannot
    // mutate operator state through a form or text/plain fetch.
    const body = Number(req.headers?.['content-length'] || 0) > 0 || Boolean(req.headers?.['transfer-encoding']);
    if ((body || req.method !== 'DELETE') && type !== 'application/json') return { status: 415, error: 'application_json_required' };
  }
  return { status: req.method === 'OPTIONS' ? 204 : null, origin: origin || null };
}
