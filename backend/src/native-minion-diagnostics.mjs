// Diagnostic text only: never serialize native events, stacks or tool payloads.
export function diagnosticText(value, redact = value => value) {
  if (typeof value !== 'string') return '';
  return redact(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .split(/\r?\n/).filter(line => !/[{}]|^[\s]*[\[]|tool[_ -]?(use|result|payload)|parameters\s*[:=]/i.test(line))
    .join(' ').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 2000);
}

export function collectDiagnosticSecrets(secrets, values) {
  for (const [key, value] of Object.entries(values || {})) {
    if (/token|secret|api_?key|password|authorization/i.test(key) && typeof value === 'string' && value) secrets.add(value);
  }
}

export function createProcessDiagnostics(redact = value => value) {
  let stderr = '', line = '', dropping = false;
  const details = { stage: 'process', exitCode: null, signal: null };
  const text = value => diagnosticText(value, redact);
  return {
    stderr(chunk) {
      for (const part of String(chunk).split(/(?<=\n)/)) {
        if (!dropping) line += part;
        if (line.length > 32768) { line = ''; dropping = true; }
        if (part.endsWith('\n')) {
          if (!dropping) stderr = (stderr + ' ' + text(line)).slice(-8000);
          line = ''; dropping = false;
        }
      }
    },
    error(error, stage = 'process', field = 'processError') {
      details.stage = text(error?.stage) || stage;
      if (text(error?.message)) details[field] = text(error.message);
      if (typeof error?.code === 'string' || typeof error?.code === 'number') details.code = text(String(error.code));
    },
    close(code, signal) { details.exitCode = code ?? null; details.signal = signal || null; },
    snapshot() { return { ...details, stderr: text(stderr + ' ' + (dropping ? '' : line)) }; },
  };
}

export function attachDiagnostics(result, diagnostics) {
  result.diagnostics = { ...result.diagnostics, ...diagnostics };
  const detail = [diagnostics.nativeError, diagnostics.processError, diagnostics.stderr,
    ...(diagnostics.exitCode != null || diagnostics.signal ? [`Process exit: ${diagnostics.exitCode ?? 'none'}${diagnostics.signal ? ` (${diagnostics.signal})` : ''}.`] : [])].filter(Boolean).join(' ');
  if (detail) result.summary += ` ${detail}`;
}
