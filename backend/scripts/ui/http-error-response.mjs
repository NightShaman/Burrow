import { classifyModelFailure, providerErrorSecrets } from '../../src/model-failure.mjs';

// Only the database credentials used by these handlers, not the credential store.
export function postgresDiagnosticSecrets(config = {}) {
  let password;
  try { password = decodeURIComponent(new URL(config.connectionString).password); } catch {}
  return [config.password, config.connectionString, password,
    ...providerErrorSecrets({ url: config.connectionString }).filter(value => {
      // The database user is identity, not a secret; redacting short usernames
      // corrupts unrelated diagnostic words. Keep password/token URL values.
      try { const user = new URL(config.connectionString).username; return ![user, decodeURIComponent(user)].includes(value); } catch { return true; }
    })].filter(value => typeof value === 'string' && value.length);
}

export function httpFailureResponse(error, { authorized = false } = {}) {
  const message = classifyModelFailure(error).message;
  return { ok: false, error: 'http_request_failed', ...(authorized && message ? { message } : {}) };
}

// Runtime OTLP headers are an explicit credential-bearing configuration, not
// arbitrary objects to flatten. Header values are percent-encoded OTEL syntax.
export function otelDiagnosticSecrets(config = {}) {
  const values = [];
  for (const destination of [config, ...(config.destinations || [])]) {
    for (const key of ['headers', 'tracesHeaders', 'metricsHeaders']) {
      const headers = destination?.[key];
      if (typeof headers !== 'string') continue;
      values.push(headers);
      for (const entry of headers.split(',')) {
        const index = entry.indexOf('=');
        if (index < 0) continue;
        const value = entry.slice(index + 1).trim();
        values.push(value);
        try { values.push(decodeURIComponent(value)); } catch {}
      }
    }
  }
  return values.filter(value => typeof value === 'string' && value.length);
}
