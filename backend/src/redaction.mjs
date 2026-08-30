const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|API[_-]?KEY|SECRET|PASSWORD|PASS|AUTH)[A-Z0-9_]*)\s*=\s*([^\s'\"]+)/gi;
const AUTH_HEADER = /\b(authorization\s*[:=]\s*)(bearer\s+)?[^\s'\"]+/gi;
const KEY_VALUE_EQUALS = /\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*([^\s'\"]+)/gi;
const KEY_VALUE_FLAG = /(--?(?:api[_-]?key|token|secret|password|passwd))\s+([^\s'\"]+)/gi;
const PROVIDER_KEY_PREFIX = /\b(sk|xox[baprs]|gh[pousr])[-_]([A-Za-z0-9_-]{8,})\b/g;
// An explicit wrapper covers opaque values whose format cannot safely be
// recognized. Keep the wrapper out of every durable/logged projection while
// leaving the raw current turn available to the model for this request.
const SECRET_BLOCK = /<secret(?:\s+[^>]*)?>[\s\S]*?<\/secret>/gi;

export function redactProtectedText(value, protectedValues = []) {
  let text = redactText(value);
  const values = [...new Set((protectedValues || []).map((item) => String(item ?? '')).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const secret of values) text = text.split(secret).join('[redacted]');
  return text;
}

export function redactText(value) {
  return String(value ?? '')
    .replace(SECRET_BLOCK, '<secret>[redacted]</secret>')
    .replace(SECRET_ASSIGNMENT, '$1=[redacted]')
    .replace(AUTH_HEADER, '$1$2[redacted]')
    .replace(KEY_VALUE_EQUALS, '$1=[redacted]')
    .replace(KEY_VALUE_FLAG, '$1 [redacted]')
    .replace(PROVIDER_KEY_PREFIX, '$1-[redacted]');
}

export function redactValue(value, { maxDepth = 12, maxItems = 64, maxKeys = 64 } = {}, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (!value || typeof value !== 'object') return value;
  if (depth >= maxDepth || seen.has(value)) return '[redaction traversal truncated]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = [];
    const count = Math.min(value.length, maxItems);
    for (let index = 0; index < count; index += 1) result.push(redactValue(value[index], { maxDepth, maxItems, maxKeys }, depth + 1, seen));
    if (value.length > count) result.push(`[${value.length - count} items omitted]`);
    return result;
  }
  const result = {};
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (count >= maxKeys) { result.__redactionTruncated = 'keys omitted'; break; }
    count += 1;
    // Redact secret-bearing fields, not ordinary telemetry such as
    // `estimatedTokens` or `contextTokens`.
    if (/^(?:token|api[_-]?key|secret|password|passwd|auth|authorization)$/i.test(key)) result[key] = '[redacted]';
    else result[key] = redactValue(value[key], { maxDepth, maxItems, maxKeys }, depth + 1, seen);
  }
  return result;
}

// Durable metadata and operational receipts are projections, not arbitrary
// object-graph stores. This traversal bounds allocation while it walks: it
// never materializes Object.entries()/Object.keys() for an untrusted object and
// it shares one aggregate character budget across the entire returned graph.
export function boundedRedactedValue(value, {
  maxChars = 64_000,
  maxStringChars = 8_000,
  maxDepth = 8,
  maxItems = 40,
  maxKeys = 60,
} = {}) {
  const state = { remaining: Math.max(0, Number(maxChars) || 0), seen: new WeakSet() };
  const marker = (text) => {
    const available = Math.max(0, Math.min(String(text).length, state.remaining));
    state.remaining -= available;
    return String(text).slice(0, available);
  };
  const visit = (item, depth = 0) => {
    if (item === null || item === undefined || typeof item === 'boolean' || typeof item === 'number') return item;
    if (state.remaining <= 0) return '[metadata budget exhausted]';
    if (typeof item === 'string') {
      const redacted = redactText(item);
      const limit = Math.max(0, Math.min(maxStringChars, state.remaining));
      const kept = redacted.slice(0, limit);
      state.remaining -= kept.length;
      return redacted.length > limit ? `${kept}[${redacted.length - limit} chars omitted]` : kept;
    }
    if (typeof item !== 'object') return marker(String(item));
    if (depth >= maxDepth || state.seen.has(item)) return marker('[metadata traversal truncated]');
    state.seen.add(item);
    if (Array.isArray(item)) {
      const result = [];
      const count = Math.min(item.length, maxItems);
      for (let index = 0; index < count && state.remaining > 0; index += 1) result.push(visit(item[index], depth + 1));
      if (item.length > count) result.push(marker(`[${item.length - count} items omitted]`));
      return result;
    }
    const result = {};
    let count = 0;
    let omitted = false;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (count >= maxKeys || state.remaining <= 0) { omitted = true; break; }
      count += 1;
      const safeKey = String(key).slice(0, 256);
      if (/^(?:token|api[_-]?key|secret|password|passwd|auth|authorization)$/i.test(safeKey)) result[safeKey] = '[redacted]';
      else {
        try { result[safeKey] = visit(item[key], depth + 1); }
        catch { result[safeKey] = '[metadata field unreadable]'; }
      }
    }
    if (omitted) result.__metadataTruncated = marker('keys or aggregate content omitted');
    return result;
  };
  return visit(value);
}

export function truncateText(value, { maxChars = 100_000 } = {}) {
  const text = String(value ?? '');
  if (!Number.isFinite(maxChars) || maxChars < 0 || text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length };
  }
  return { text: text.slice(0, maxChars), truncated: true, originalChars: text.length };
}

export function redactAndTruncateText(value, options = {}) {
  const redacted = redactText(value);
  return truncateText(redacted, options);
}
