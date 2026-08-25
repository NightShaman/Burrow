import { createHash } from 'node:crypto';

const SENSITIVE_KEY = /(?:token|secret|password|passwd|api[_-]?key|authorization|credential)/i;
const text = (value) => String(value ?? '');

function refFor({ provider = 'tool', toolName = 'result', path = '', value = '' } = {}) {
  const digest = createHash('sha256').update(`${provider}\u0000${toolName}\u0000${path}\u0000${value}`).digest('hex').slice(0, 20);
  return `protected://${digest}`;
}

function protectedLeaf(value, { provider, toolName, path, registry, protectedValues }) {
  const ref = refFor({ provider, toolName, path, value: text(value) });
  registry.set(ref, text(value));
  protectedValues.push({ ref, field: path });
  return `[protected value: ${ref}]`;
}

/**
 * Removes secret-bearing values from a tool result while retaining opaque,
 * one-turn references that a later tool can consume without the model ever
 * receiving the value. MCP servers may return arbitrary JSON, so normal
 * detection is key-based; secret-returning operations may opt into semantic
 * protection where the protocol uses generic fields such as content[].text.
 */
export function protectToolOutput(value, { provider = 'tool', toolName = 'result', registry = new Map(), isSecretPath = null } = {}) {
  const protectedValues = [];
  const visit = (item, key = '', path = '$') => {
    if (item === null || item === undefined) return item;
    if (typeof item !== 'object') {
      if (item === '' || !(SENSITIVE_KEY.test(key) || isSecretPath?.({ key, path, value: item }) === true)) return item;
      return protectedLeaf(item, { provider, toolName, path, registry, protectedValues });
    }
    if (Array.isArray(item)) return item.map((child, index) => visit(child, key, `${path}[${index}]`));
    return Object.fromEntries(Object.entries(item).map(([childKey, child]) => [childKey, visit(child, childKey, `${path}.${childKey}`)]));
  };
  return { safeOutput: visit(value), protectedValues };
}

/** Bitwarden's `get object=password` returns the secret in content[].text. */
export function protectMcpOutput(value, { provider = 'tool', toolName = 'result', mcpArguments = {}, registry = new Map() } = {}) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return protectToolOutput(value, { provider, toolName, registry }); }
  }
  const bitwardenPasswordGet = /bitwarden/i.test(String(provider))
    && String(toolName) === 'get'
    && String(mcpArguments?.object || '').toLowerCase() === 'password';
  return protectToolOutput(parsed, {
    provider,
    toolName,
    registry,
    isSecretPath: bitwardenPasswordGet ? ({ path }) => /^\$\.content\[\d+\]\.text$/.test(path) : null,
  });
}

export function resolveProtectedBindings(bindings, registry = new Map()) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return { env: {}, bindings: [], errors: [] };
  const env = {};
  const accepted = [];
  const errors = [];
  for (const [name, ref] of Object.entries(bindings)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) { errors.push(`protected_binding_name_invalid:${name}`); continue; }
    if (typeof ref !== 'string' || !ref.startsWith('protected://')) { errors.push(`protected_binding_ref_invalid:${name}`); continue; }
    const value = registry.get(ref);
    if (value === undefined) { errors.push(`protected_binding_not_found:${name}`); continue; }
    env[name] = value;
    accepted.push({ name, ref });
  }
  return { env, bindings: accepted, errors };
}

export const __test__ = { SENSITIVE_KEY };
