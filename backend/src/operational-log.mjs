// Console-only operational diagnostics. Producers project fields before calling;
// never pass Error objects, provider diagnostics, URLs, payloads or credentials.
export function operationalEvent(logger, type, fields = {}, { level = 'warn', component } = {}) {
  try {
    if (typeof logger?.event === 'function') {
      const pending = logger.event(type, fields, { level, component });
      pending?.catch?.(() => {});
    } else {
      const sink = logger?.[level] || console[level];
      sink.call(logger || console, type, JSON.stringify({ component, ...fields }));
    }
  } catch { /* Diagnostics cannot fail the producer. */ }
}

const INFRASTRUCTURE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EMFILE', 'ENFILE', '08000', '08003', '08006', '53300', '53400', '57P01', '57P02', '57P03', '58000', '58030']);
export function infrastructureErrorCode(error, fallback = 'infrastructure_failed') {
  const code = error?.code ?? error?.cause?.code;
  return INFRASTRUCTURE_CODES.has(code) ? code : fallback;
}
export function operationalId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : null;
}
