import { performance } from 'node:perf_hooks';
import { operationalTelemetry } from './operational-telemetry.mjs';

// Auth diagnostics are an allowlisted projection, never an Error/message dump.
// Provider errors (including JOSE errors) can contain tokens, claims and URLs
// with credentials. Keep the original exception for callers, but log only this
// separately held, sanitized context.
const errorDiagnostics = new WeakMap();
const stages = new Set(['configuration', 'discovery', 'login', 'callback', 'state', 'token_exchange', 'jwks', 'token_validation', 'authorization', 'session', 'logout']);
const configFields = new Set(['issuer', 'clientId', 'clientSecret', 'sessionSecret']);
const reasons = new Map([
  ['auth_internal_error', 'error'], ['auth_configuration_missing', 'error'],
  ['oidc_issuer_required', 'error'], ['oidc_session_secret_required', 'error'],
  ['oidc_discovery_failed', 'error'], ['oidc_discovery_invalid_response', 'error'], ['oidc_discovery_issuer_mismatch', 'error'],
  ['oidc_callback_missing_code_or_state', 'warn'], ['oidc_state_invalid', 'warn'],
  ['oidc_provider_access_denied', 'warn'], ['oidc_provider_login_required', 'warn'],
  ['oidc_provider_interaction_required', 'warn'], ['oidc_provider_consent_required', 'warn'],
  ['oidc_provider_server_error', 'error'], ['oidc_provider_temporarily_unavailable', 'error'],
  ['oidc_token_exchange_failed', 'error'], ['oidc_token_response_invalid', 'error'], ['oidc_id_token_missing', 'error'],
  ['oidc_token_issuer_mismatch', 'warn'], ['oidc_token_audience_mismatch', 'warn'],
  ['oidc_token_expired', 'warn'], ['oidc_token_claim_invalid', 'warn'], ['oidc_token_signature_invalid', 'warn'],
  ['oidc_token_invalid', 'warn'], ['oidc_jwks_failed', 'error'], ['oidc_nonce_invalid', 'warn'],
  ['oidc_verified_email_required', 'warn'], ['oidc_email_not_allowed', 'warn'], ['oidc_domain_not_allowed', 'warn'],
  ['oidc_session_invalid', 'warn'], ['oidc_session_authorization_changed', 'warn'],
  ['oidc_cookie_invalid', 'warn'], ['oidc_network_timeout', 'error'], ['oidc_network_failed', 'error'], ['oidc_endpoint_invalid', 'error'],
]);
const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
const joseReasons = new Map([
  ['ERR_JWT_EXPIRED', 'oidc_token_expired'], ['ERR_JWT_CLAIM_VALIDATION_FAILED', 'oidc_token_claim_invalid'],
  ['ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'oidc_token_signature_invalid'],
  ['ERR_JWT_INVALID', 'oidc_token_invalid'], ['ERR_JWS_INVALID', 'oidc_token_invalid'],
  ['ERR_JOSE_ALG_NOT_ALLOWED', 'oidc_token_invalid'], ['ERR_JOSE_NOT_SUPPORTED', 'oidc_token_invalid'],
  ['ERR_JWKS_TIMEOUT', 'oidc_jwks_failed'], ['ERR_JWKS_INVALID', 'oidc_jwks_failed'],
  ['ERR_JWK_INVALID', 'oidc_jwks_failed'], ['ERR_JWKS_NO_MATCHING_KEY', 'oidc_jwks_failed'],
  ['ERR_JWKS_MULTIPLE_MATCHING_KEYS', 'oidc_jwks_failed'],
]);

export function safeAuthUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `${url.origin}${url.pathname}`;
  } catch { return undefined; }
}

function project(fields = {}) {
  const out = {};
  if (stages.has(fields.stage)) out.stage = fields.stage;
  if (reasons.has(fields.reason)) out.reason = fields.reason;
  if (Number.isInteger(fields.upstreamStatus) && fields.upstreamStatus >= 100 && fields.upstreamStatus <= 599) out.upstreamStatus = fields.upstreamStatus;
  for (const key of ['endpoint', 'expectedIssuer', 'discoveredIssuer']) {
    const value = safeAuthUrl(fields[key]);
    if (value) out[key] = value;
  }
  if (Array.isArray(fields.missingConfig)) {
    const missing = [...new Set(fields.missingConfig.filter(key => configFields.has(key)))];
    if (missing.length) out.missingConfig = missing;
  }
  if (networkCodes.has(fields.errorCode) || joseReasons.has(fields.errorCode) || fields.errorCode === 'ERR_INVALID_URL') out.errorCode = fields.errorCode;
  if (fields.cacheHit === true) out.cacheHit = true;
  return out;
}

function classify(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (reasons.has(message)) return { reason: message };
  const status = /^(oidc_discovery_failed|oidc_token_exchange_failed):([1-5]\d\d)$/.exec(message);
  if (status) return { reason: status[1], upstreamStatus: Number(status[2]) };
  const code = networkCodes.has(error?.code) ? error.code : error?.cause?.code;
  if (networkCodes.has(code)) return { reason: 'oidc_network_failed', errorCode: code };
  if (error?.code === 'ERR_INVALID_URL') return { reason: 'oidc_endpoint_invalid', errorCode: error.code };
  if (joseReasons.has(error?.code)) {
    let reason = joseReasons.get(error.code);
    if (error.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && error.claim === 'iss') reason = 'oidc_token_issuer_mismatch';
    if (error.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && error.claim === 'aud') reason = 'oidc_token_audience_mismatch';
    return { reason, errorCode: error.code };
  }
  if (error?.name === 'TimeoutError') return { reason: 'oidc_network_timeout' };
  if (error instanceof URIError) return { reason: 'oidc_cookie_invalid' };
  return { reason: 'auth_internal_error' };
}

export function authErrorDiagnostics(error, fallback = {}) {
  const saved = error && (typeof error === 'object' || typeof error === 'function') ? errorDiagnostics.get(error) : null;
  return project({ ...project(fallback), ...classify(error), ...saved });
}

export function withAuthDiagnostics(error, fields = {}) {
  const exception = error && (typeof error === 'object' || typeof error === 'function') ? error : new Error(String(error));
  // An outer operation may add context, but must not obscure the producer stage
  // or the more precise reason from an inner boundary.
  const saved = errorDiagnostics.get(exception);
  const missingConfig = [...(fields.missingConfig || []), ...(saved?.missingConfig || [])];
  errorDiagnostics.set(exception, project({ ...classify(exception), ...project(fields), ...saved, missingConfig }));
  return exception;
}

export function authFailureLevel(diagnostics) {
  if (diagnostics.reason === 'oidc_token_exchange_failed' && diagnostics.upstreamStatus < 500) return 'warn';
  return reasons.get(diagnostics.reason) || 'error';
}

export function oidcMissingConfiguration(runtime, stage) {
  const oidc = runtime?.ui?.oidc || {};
  const required = stage === 'login' || stage === 'callback' ? ['issuer', 'clientId', 'clientSecret'] : [];
  return required.filter(key => !String(oidc[key] ?? '').trim());
}

const authModes = new Set(['none', 'basic', 'oidc', 'trusted-proxy']);
const loginReasons = new Set([...reasons.keys(), 'basic_credentials_invalid', 'auth_mode_unsupported', 'api_token_rejected', 'trusted_proxy_not_allowed', 'trusted_proxy_user_missing']);
let observedOverrideMode = null;

function publishAuth(type, fields) {
  try { operationalTelemetry(type, fields); } catch { /* Authentication never depends on telemetry. */ }
}

/** A terminal login attempt, not an ordinary authenticated session poll. */
export function startAuthLoginTelemetry(mode) {
  const startedAt = performance.now();
  let completed = false;
  return (outcome, { error, diagnostics, oidcCallback = false } = {}) => {
    if (completed) return;
    completed = true;
    try {
      const fields = { mode: authModes.has(mode) ? mode : 'unknown', outcome: outcome === 'success' ? 'success' : 'failure', durationMs: Math.max(0, performance.now() - startedAt) };
      if (fields.outcome === 'failure') {
        const detail = diagnostics || authErrorDiagnostics(error);
        fields.reason = loginReasons.has(detail.reason) ? detail.reason : 'auth_internal_error';
        if (stages.has(detail.stage)) fields.stage = detail.stage;
      }
      publishAuth('auth-login', fields);
      if (oidcCallback && fields.outcome === 'failure') publishAuth('auth-oidc-callback-failed', fields);
    } catch { /* Ignore diagnostics objects that cannot be safely projected. */ }
  };
}

/** Observe an effective environment override without reading/exporting values. */
export function observeAuthEnvironmentOverride(runtime, env = process.env) {
  try {
    const mode = authModes.has(runtime?.ui?.authMode) ? runtime.ui.authMode : 'unknown';
    const active = runtime?.ui?.authSource === 'environment'
      || Object.keys(env).some(key => key.startsWith('BURROW_UI_AUTH_') && Boolean(env[key]));
    if (!active) { if (observedOverrideMode !== null) publishAuth('auth-environment-inactive', {}); observedOverrideMode = null; return; }
    if (observedOverrideMode === mode) return;
    observedOverrideMode = mode;
    publishAuth('auth-environment-override', { mode, outcome: 'activated', durationMs: 0 });
  } catch { /* Observation does not resolve or validate authentication config. */ }
}

export async function logAuthFailure(logger, { req, route, stage, error, diagnostics } = {}) {
  if (typeof logger?.event !== 'function') return;
  const fields = diagnostics ? project(diagnostics) : authErrorDiagnostics(error, { stage });
  const requestId = req?.requestId;
  if (typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) fields.requestId = requestId;
  if (['/auth/oidc/login', '/auth/oidc/callback', '/auth/logout', '/api/auth/session', '/api/auth/discovery'].includes(route)) fields.route = route;
  try {
    await logger.event('auth.failure', fields, { level: authFailureLevel(fields), component: 'auth' });
  } catch {
    // Logging must not change the response, suppress the original error, or
    // create an unhandled rejection when an optional/legacy logger fails.
  }
}
