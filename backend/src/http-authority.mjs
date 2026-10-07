import { isIP } from 'node:net';

// Exact authority, never a suffix, wildcard, URL, credentials or header list.
export function normalizeAuthority(value) {
  if (typeof value !== 'string' || !value || /[\s*,/@?#\\]/.test(value)) throw new Error('invalid_allowed_host_authority');
  const url = new URL(`http://${value}`);
  if (url.pathname !== '/' || url.username || url.password || !url.hostname) throw new Error('invalid_allowed_host_authority');
  return url.host;
}
const csv = value => String(value || '').split(',').map(x => x.trim()).filter(Boolean);
export function httpAuthorityConfig({ host = '127.0.0.1', port = 42817, env = process.env } = {}) {
  const explicit = csv(env.BURROW_UI_ALLOWED_HOSTS);
  // A non-empty explicit list opts in; existing LAN listeners need no migration.
  const allowedHosts = explicit.map(normalizeAuthority);
  const trustedProxies = csv(env.BURROW_UI_TRUSTED_PROXIES);
  if (trustedProxies.some(x => !isIP(x))) throw new Error('BURROW_UI_TRUSTED_PROXIES requires exact IP addresses');
  return { enabled: allowedHosts.length > 0, allowedHosts, trustedProxies };
}
export function requestAuthority(req, config) {
  let authority = req.headers?.host;
  let protocol = req.socket?.encrypted ? 'https:' : 'http:';
  const address = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (config.trustedProxies.includes(address)) {
    authority = req.headers?.['x-forwarded-host'] ?? authority;
    const forwarded = req.headers?.['x-forwarded-proto'];
    if (forwarded !== undefined) {
      if (!['http', 'https'].includes(forwarded)) throw new Error('invalid_forwarded_protocol');
      protocol = `${forwarded}:`;
    }
  }
  return { authority: normalizeAuthority(authority), protocol };
}
export function hostAuthorityPolicy(req, config, authMode) {
  if (!config.enabled) return { authority: req.headers?.host, protocol: 'http:' };
  try {
    const result = requestAuthority(req, config);
    if (authMode === 'none' && !config.allowedHosts.includes(result.authority)) return { status: 403, error: 'host_authority_not_allowed' };
    return result;
  } catch { return { status: 403, error: 'host_authority_not_allowed' }; }
}
