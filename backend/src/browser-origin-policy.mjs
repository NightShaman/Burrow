export function browserRequestPolicy(req, url, { allowedOrigins = [] } = {}) {
  const origin = req.headers?.origin;
  if (origin) {
    const trusted = new Set([url.origin, ...allowedOrigins]);
    if (!trusted.has(origin)) return { status: 403, error: 'browser_origin_not_allowed' };
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
