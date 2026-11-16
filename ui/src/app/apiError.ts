function sanitize(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(
      /((?:authorization|proxy-authorization|api[-_]?key|access[-_]?token|token|password|secret)\s*[=:]\s*)(?:Bearer\s+)?[^\s,;]+/gi,
      '$1[redacted]',
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]');
}

/** Present the API's diagnostic, never raw response bodies/details or request configuration. */
export function apiErrorMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error) || !cause.message.trim()) return fallback;
  const error = cause as Error & { code?: unknown; status?: unknown };
  const metadata = [
    typeof error.code === 'string' && error.code !== error.message ? sanitize(error.code) : '',
    typeof error.status === 'number' ? `HTTP ${error.status}` : '',
  ].filter(Boolean);
  return `${fallback} ${sanitize(error.message)}${metadata.length ? ` (${metadata.join('; ')})` : ''}`;
}
