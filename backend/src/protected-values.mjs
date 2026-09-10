import { randomBytes } from 'node:crypto';

const ENVELOPE_KEY = '$burrowSensitive';
const SENSITIVE_TYPES = new Set(['credential', 'secret', 'token', 'password', 'private-key']);
const text = (value) => String(value ?? '');

function refFor(registry) {
  let ref;
  do { ref = `protected://${randomBytes(18).toString('base64url')}`; } while (registry.has(ref));
  return ref;
}

function protectedLeaf(value, { type, path, registry, protectedValues }) {
  const ref = refFor(registry);
  registry.set(ref, { type, value: text(value) });
  protectedValues.push({ ref, field: path, type });
  return `[protected ${type}: ${ref}]`;
}

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function parseEnvelope(item) {
  if (!isObject(item) || !Object.hasOwn(item, ENVELOPE_KEY)) return null;
  const declaration = item[ENVELOPE_KEY];
  if (!isObject(declaration)) return { malformed: true };
  const type = typeof declaration.type === 'string' ? declaration.type.trim().toLowerCase() : '';
  if (!SENSITIVE_TYPES.has(type) || !Object.hasOwn(declaration, 'value') || !['string', 'number', 'boolean'].includes(typeof declaration.value)) return { malformed: true };
  return { type, value: declaration.value };
}

function containsEnvelope(value) {
  if (parseEnvelope(value)) return true;
  if (Array.isArray(value)) return value.some(containsEnvelope);
  return isObject(value) && Object.values(value).some(containsEnvelope);
}

function normalizeTextBlocks(value) {
  if (!isObject(value) || !Array.isArray(value.content)) return value;
  return {
    ...value,
    content: value.content.map((block) => {
      if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') return block;
      let parsed;
      try { parsed = JSON.parse(block.text); } catch { return block; }
      // Avoid changing ordinary MCP text semantics. JSON text is normalized
      // generically only when it carries Burrow's typed sensitivity contract;
      // known producer adapters below explicitly opt into their JSON shapes.
      return containsEnvelope(parsed) ? { ...block, text: parsed } : block;
    }),
  };
}

function unwrapMcp(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return { value: parsed, wrappers: [] }; }
  }
  const wrappers = [];
  // mcporter versions have emitted either the MCP result directly or one of
  // these documented success wrappers. Do not guess through arbitrary keys.
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isObject(parsed)) break;
    if (Object.keys(parsed).every((key) => ['status', 'result'].includes(key)) && parsed.status === 'ok' && Object.hasOwn(parsed, 'result')) {
      wrappers.push('status.result'); parsed = parsed.result; continue;
    }
    if (Object.keys(parsed).every((key) => ['ok', 'result'].includes(key)) && parsed.ok === true && Object.hasOwn(parsed, 'result')) {
      wrappers.push('ok.result'); parsed = parsed.result; continue;
    }
    break;
  }
  return { value: normalizeTextBlocks(parsed), wrappers };
}

export function credentialProducer({ provider, toolName, mcpArguments }) {
  const providerName = text(provider).trim().toLowerCase();
  const tool = text(toolName).trim().toLowerCase().replace(/-/g, '_');
  if (!providerName.includes('bitwarden')) return null;
  if (tool === 'keychain_get_password') return 'bitwarden-keychain-get-password';
  if (tool === 'keychain_get_item' && mcpArguments?.reveal === true) return 'bitwarden-keychain-get-item-reveal';
  // Retain the older Bitwarden CLI MCP contract while matching it explicitly.
  if (tool === 'get' && text(mcpArguments?.object).trim().toLowerCase() === 'password') return 'bitwarden-password-get';
  return null;
}

const ITEM_KEYS = new Set(['object', 'id', 'organizationId', 'folderId', 'type', 'reprompt', 'name', 'favorite', 'notes', 'login', 'collectionIds', 'revisionDate', 'creationDate', 'deletedDate', 'passwordHistory', 'fields']);
const LOGIN_KEYS = new Set(['username', 'password', 'totp', 'uris']);
const URI_KEYS = new Set(['match', 'uri']);
const FIELD_KEYS = new Set(['name', 'type', 'value', 'linkedId']);
const HISTORY_KEYS = new Set(['password', 'lastUsedDate']);
const PASSWORD_KEYS = new Set(['password', 'secret', 'value', 'text', 'id', 'name', 'username', 'login']);

function mark(path, paths) { paths.add(path); }
function scalarOrNull(value) { return value === null || ['string', 'number', 'boolean'].includes(typeof value); }
function keysAllowed(value, allowed) { return isObject(value) && Object.keys(value).every((key) => allowed.has(key)); }

function itemPaths(item, path, paths) {
  if (!keysAllowed(item, ITEM_KEYS)) return false;
  for (const [key, value] of Object.entries(item)) {
    const child = `${path}.${key}`;
    if (key === 'notes') {
      if (typeof value !== 'string') return false;
      mark(child, paths);
    } else if (key === 'login') {
      if (!keysAllowed(value, LOGIN_KEYS)) return false;
      for (const [loginKey, loginValue] of Object.entries(value)) {
        const loginPath = `${child}.${loginKey}`;
        if (loginKey === 'password' || loginKey === 'totp') {
          if (typeof loginValue !== 'string') return false;
          mark(loginPath, paths);
        } else if (loginKey === 'uris') {
          if (!Array.isArray(loginValue) || !loginValue.every((uri) => keysAllowed(uri, URI_KEYS) && Object.values(uri).every(scalarOrNull))) return false;
        } else if (!scalarOrNull(loginValue)) return false;
      }
    } else if (key === 'fields') {
      if (!Array.isArray(value)) return false;
      for (let index = 0; index < value.length; index += 1) {
        const field = value[index];
        if (!keysAllowed(field, FIELD_KEYS) || !Object.values(field).every(scalarOrNull)) return false;
        if (typeof field.value === 'string') mark(`${child}[${index}].value`, paths);
      }
    } else if (key === 'passwordHistory') {
      if (!Array.isArray(value)) return false;
      for (let index = 0; index < value.length; index += 1) {
        const history = value[index];
        if (!keysAllowed(history, HISTORY_KEYS) || !Object.values(history).every(scalarOrNull) || typeof history.password !== 'string') return false;
        mark(`${child}[${index}].password`, paths);
      }
    } else if (key === 'collectionIds') {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return false;
    } else if (!scalarOrNull(value)) return false;
  }
  return paths.size > 0;
}

function passwordPaths(value, path, paths) {
  if (typeof value === 'string') { mark(path, paths); return true; }
  if (!keysAllowed(value, PASSWORD_KEYS)) return false;
  for (const key of ['password', 'secret', 'value', 'text']) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== 'string') return false;
    mark(`${path}.${key}`, paths);
  }
  if (Object.hasOwn(value, 'login')) {
    if (!keysAllowed(value.login, LOGIN_KEYS)) return false;
    for (const [key, child] of Object.entries(value.login)) {
      if (key === 'password' || key === 'totp') {
        if (typeof child !== 'string') return false;
        mark(`${path}.login.${key}`, paths);
      } else if (key === 'uris') {
        if (!Array.isArray(child) || !child.every((uri) => keysAllowed(uri, URI_KEYS) && Object.values(uri).every(scalarOrNull))) return false;
      } else if (!scalarOrNull(child)) return false;
    }
  }
  for (const [key, child] of Object.entries(value)) if (key !== 'login' && key !== 'password' && !scalarOrNull(child)) return false;
  return paths.size > 0;
}

function parseProducerText(block) {
  if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string' || Object.keys(block).some((key) => !['type', 'text'].includes(key))) return null;
  try { return JSON.parse(block.text); } catch { return block.text; }
}

function credentialShape(value, producer) {
  const paths = new Set();
  const inspect = (payload, path) => producer === 'bitwarden-keychain-get-item-reveal'
    ? itemPaths(payload, path, paths)
    : passwordPaths(payload, path, paths);
  if (typeof value === 'string') return inspect(value, '$') ? { value, paths } : null;
  if (!isObject(value)) return null;

  // MCP content and structuredContent are the only accepted transport fields.
  // Unknown siblings are withheld rather than copied beside a protected leaf.
  if (Object.hasOwn(value, 'content') || Object.hasOwn(value, 'structuredContent')) {
    if (Object.keys(value).some((key) => !['content', 'structuredContent', 'isError'].includes(key)) || (Object.hasOwn(value, 'isError') && value.isError !== false)) return null;
    let normalized = { ...value };
    if (Object.hasOwn(value, 'content')) {
      if (!Array.isArray(value.content) || value.content.length !== 1) return null;
      const payload = parseProducerText(value.content[0]);
      if (payload === null || !inspect(payload, '$.content[0].text')) return null;
      normalized = { ...normalized, content: [{ ...value.content[0], text: payload }] };
    }
    if (Object.hasOwn(value, 'structuredContent') && !inspect(value.structuredContent, '$.structuredContent')) return null;
    return paths.size ? { value: normalized, paths } : null;
  }
  return inspect(value, '$') ? { value, paths } : null;
}

/**
 * Apply the explicit runtime sensitivity envelope recursively. Producers return
 * `{ "$burrowSensitive": { "type": "credential", "value": "..." } }`.
 * A malformed declaration withholds the complete response rather than risking
 * serialization of the declared value.
 */
export function protectToolOutput(value, { registry = new Map(), implicitSensitivePaths = null, implicitType = 'credential' } = {}) {
  const protectedValues = [];
  let malformed = false;
  const visit = (item, path = '$') => {
    const envelope = parseEnvelope(item);
    if (envelope?.malformed) { malformed = true; return null; }
    if (envelope) return protectedLeaf(envelope.value, { type: envelope.type, path, registry, protectedValues });
    if (implicitSensitivePaths?.has(path)) {
      if (!['string', 'number', 'boolean'].includes(typeof item)) { malformed = true; return null; }
      return protectedLeaf(item, { type: implicitType, path, registry, protectedValues });
    }
    if (item === null || item === undefined || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map((child, index) => visit(child, `${path}[${index}]`));
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, `${path}.${key}`)]));
  };
  const safeOutput = visit(value);
  if (malformed) {
    for (const item of protectedValues) registry.delete(item.ref);
    return { safeOutput: null, protectedValues: [], protection: { status: 'withheld', reason: 'malformed_sensitive_response', count: 0 } };
  }
  return {
    safeOutput,
    protectedValues,
    protection: { status: protectedValues.length ? 'protected' : 'clear', count: protectedValues.length, types: [...new Set(protectedValues.map((item) => item.type))] },
  };
}

/** Normalize known MCP wrappers, then apply explicit envelopes or adapters for supported credential producers. */
export function protectMcpOutput(value, { provider = 'tool', toolName = 'result', mcpArguments = {}, registry = new Map() } = {}) {
  const normalized = unwrapMcp(value);
  const producer = credentialProducer({ provider, toolName, mcpArguments });
  const shape = producer ? credentialShape(normalized.value, producer) : { value: normalized.value, paths: null };
  if (producer && !shape) return { safeOutput: null, protectedValues: [], protection: { status: 'withheld', reason: 'malformed_sensitive_response', producer, count: 0, wrappers: normalized.wrappers } };
  const result = protectToolOutput(shape.value, { registry, implicitSensitivePaths: shape.paths });
  return { ...result, protection: { ...result.protection, ...(producer ? { producer } : {}), ...(normalized.wrappers.length ? { wrappers: normalized.wrappers } : {}) } };
}

export function resolveProtectedBindings(bindings, registry = new Map()) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return { env: {}, bindings: [], errors: [] };
  const env = {};
  const accepted = [];
  const errors = [];
  for (const [name, ref] of Object.entries(bindings)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) { errors.push(`protected_binding_name_invalid:${name}`); continue; }
    if (typeof ref !== 'string' || !ref.startsWith('protected://')) { errors.push(`protected_binding_ref_invalid:${name}`); continue; }
    const entry = registry.get(ref);
    if (entry === undefined) { errors.push(`protected_binding_not_found:${name}`); continue; }
    const value = isObject(entry) && Object.hasOwn(entry, 'value') ? entry.value : entry;
    env[name] = text(value);
    accepted.push({ name, ref, ...(isObject(entry) && entry.type ? { type: entry.type } : {}) });
  }
  return { env, bindings: accepted, errors };
}

export const sensitiveValue = (type, value) => ({ [ENVELOPE_KEY]: { type, value } });
export const __test__ = { ENVELOPE_KEY, SENSITIVE_TYPES, unwrapMcp, credentialProducer };
