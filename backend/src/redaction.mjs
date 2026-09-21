// Redaction is boundary-driven. Free-form prose is not a credential schema: words
// such as "token" and "password" are ordinary conversation and must not cause
// destructive rewriting. Secrets are removed when a producer marks them, when a
// structured field is known to be sensitive, or when an exact protected value is
// supplied by the credential/tool boundary.
const SECRET_BLOCK = /<secret(?:\s+[^>]*)?>[\s\S]*?<\/secret>/gi;
const SENSITIVE_FIELD = /^(?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|secret|client[_-]?secret|password|passwd|credential|credentials|private[_-]?key|auth|authorization)$/i;

function isSensitiveField(key) {
  return SENSITIVE_FIELD.test(String(key || ''));
}

export function redactProtectedText(value, protectedValues = []) {
  let text = redactText(value);
  const values = [...new Set((protectedValues || []).map((item) => String(item ?? '')).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const secret of values) text = text.split(secret).join('[redacted]');
  return text;
}

/**
 * Redact only Burrow's explicit free-text sensitivity envelope. This function
 * deliberately does not guess credentials from prose or token-looking syntax.
 */
export function redactText(value) {
  return String(value ?? '').replace(SECRET_BLOCK, '<secret>[redacted]</secret>');
}

export function redactValue(value, { maxDepth = 12, maxItems = 64, maxKeys = 64, protectedValues = [] } = {}, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactProtectedText(value, protectedValues);
  if (!value || typeof value !== 'object') return value;
  if (depth >= maxDepth || seen.has(value)) return '[redaction traversal truncated]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = [];
    const count = Math.min(value.length, maxItems);
    for (let index = 0; index < count; index += 1) result.push(redactValue(value[index], { maxDepth, maxItems, maxKeys, protectedValues }, depth + 1, seen));
    if (value.length > count) result.push(`[${value.length - count} items omitted]`);
    return result;
  }
  const result = {};
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (count >= maxKeys) { result.__redactionTruncated = 'keys omitted'; break; }
    count += 1;
    if (isSensitiveField(key)) result[key] = '[redacted]';
    else result[key] = redactValue(value[key], { maxDepth, maxItems, maxKeys, protectedValues }, depth + 1, seen);
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
  protectedValues = [],
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
      const redacted = redactProtectedText(item, protectedValues);
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
      if (isSensitiveField(safeKey)) result[safeKey] = '[redacted]';
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

/** Redact a serialized structured payload without applying credential regexes to prose leaves. */
export function redactStructuredJsonText(value, options = {}) {
  const source = String(value ?? '');
  try { return JSON.stringify(redactValue(JSON.parse(source), options)); }
  catch { return redactProtectedText(source, options.protectedValues || []); }
}

export function truncateText(value, { maxChars = 100_000 } = {}) {
  const text = String(value ?? '');
  if (!Number.isFinite(maxChars) || maxChars < 0 || text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length };
  }
  return { text: text.slice(0, maxChars), truncated: true, originalChars: text.length };
}

export function redactAndTruncateText(value, options = {}) {
  const redacted = redactProtectedText(value, options.protectedValues || []);
  return truncateText(redacted, options);
}
