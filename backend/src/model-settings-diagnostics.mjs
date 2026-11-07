import { safeOperationalError } from './runtime-server-log.mjs';

// These are producer-owned whole codes, not a grammar for accepting provider
// prose. The legacy code:status form is accepted only for these exact HTTP
// failures (including OAuth/Google producers that still throw that form).
const MODEL_DIAGNOSTIC_CODES = new Set([
  'model_discovery_failed', 'model_discovery_invalid', 'model_discovery_pagination_invalid', 'model_auth_refresh_failed',
  'model_auth_refresh_invalid_grant', 'model_auth_refresh_token_reused', 'model_auth_refresh_token_expired',
  'model_auth_refresh_token_invalidated', 'model_auth_refresh_token_revoked',
  'model_auth_refresh_missing_access_token', 'model_auth_refresh_provider_unsupported',
  'model_auth_refresh_token_required', 'model_connection_not_found', 'model_connection_auth_required',
  'member_catalog_empty', 'openai_oauth_access_token_required', 'openai_oauth_refresh_token_required',
  'openai_oauth_expires_at_required', 'codex_client_version_npm_failed', 'codex_client_version_github_failed',
  'codex_client_version_npm_invalid', 'codex_client_version_github_invalid', 'models_dev_catalog_failed',
]);

const MODEL_HTTP_FAILURE = /^(model_discovery_failed|model_auth_refresh_failed|codex_client_version_npm_failed|codex_client_version_github_failed|models_dev_catalog_failed):([1-5][0-9]{2})$/;

export function modelSettingsFailureDiagnostic(error, fallback = 'model_catalog_refresh_failed') {
  const diagnostic = safeOperationalError(error, fallback);
  const read = key => { try { return error?.[key]; } catch { return undefined; } };
  const message = read('message');
  const code = [read('errorCode'), read('code'), message].find(value => MODEL_DIAGNOSTIC_CODES.has(value));
  const legacy = typeof message === 'string' && message.length <= 128 ? MODEL_HTTP_FAILURE.exec(message) : null;
  if (code || legacy) diagnostic.errorCode = code || legacy[1];
  if (legacy && diagnostic.upstreamStatus === undefined) diagnostic.upstreamStatus = Number(legacy[2]);
  const status = diagnostic.upstreamStatus ?? diagnostic.httpStatus ?? diagnostic.statusCode ?? diagnostic.status;
  let classification = 'dependency_failure';
  if (status >= 500) classification = 'upstream_5xx';
  else if (status >= 400) classification = 'upstream_4xx';
  else if (diagnostic.errorType === 'TimeoutError' || diagnostic.errorCode === 'mcp_runtime_timeout'
    || /^(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_(?:CONNECT|HEADERS)_TIMEOUT)$/.test(diagnostic.errorCode)) classification = 'dependency_timeout';
  else if (diagnostic.errorType === 'SyntaxError' || /(?:_invalid|_empty|_missing_access_token)$/.test(diagnostic.errorCode)) classification = 'invalid_response';
  else if (diagnostic.errorType === 'AbortError' || ['ABORT_ERR', 'ERR_ABORTED'].includes(diagnostic.errorCode)) classification = 'dependency_aborted';
  else if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET'].includes(diagnostic.errorCode)) classification = 'dependency_unavailable';
  const reauthRequired = ['model_auth_refresh_invalid_grant', 'model_auth_refresh_token_reused', 'model_auth_refresh_token_expired',
    'model_auth_refresh_token_invalidated', 'model_auth_refresh_token_revoked'].includes(diagnostic.errorCode);
  return { ...diagnostic, ...(status === undefined ? {} : { upstreamStatus: status }), classification,
    ...(reauthRequired ? { reauthRequired: true } : {}) };
}

export function modelHttpError(code, status) {
  return Object.assign(new Error(`${code}:${status}`), { code, upstreamStatus: status });
}
