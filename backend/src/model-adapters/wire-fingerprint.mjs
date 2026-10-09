import { createHash } from 'node:crypto';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const fingerprint = (value) => {
  const text = JSON.stringify(value);
  return { sha256: digest(text), bytes: Buffer.byteLength(text) };
};

// Diagnostic index of the exact serialized JSON body, never prompt content.
// Arrays are deliberately complete: trace payload redaction bounds must not
// silently discard the continuation suffix this diagnostic is meant to inspect.
export function wireFingerprint(serializedBody) {
  if (typeof serializedBody !== 'string') return null;
  let body;
  try { body = JSON.parse(serializedBody); } catch { return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const field = Array.isArray(body.input) ? 'input' : Array.isArray(body.messages) ? 'messages' : Array.isArray(body.contents) ? 'contents' : null;
  const { tools, input, messages, contents, ...options } = body;
  return {
    version: 1, algorithm: 'sha256',
    body: { sha256: digest(serializedBody), bytes: Buffer.byteLength(serializedBody) },
    orderedFields: Object.keys(body), options: fingerprint(options),
    tools: fingerprint(tools ?? null), cacheIdentity: fingerprint(body.prompt_cache_key ?? null),
    inputField: field,
    items: field ? body[field].map((item, index) => ({ index, ...fingerprint(item) })) : [],
  };
}
