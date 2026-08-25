import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const scryptAsync = promisify(scryptCallback);
const gunzipAsync = promisify(gunzip);
const EXPORT_FORMAT = 'burrow-export/v1';
const PASSWORD_MIN_LENGTH = 12;

export const EXPORT_CATEGORIES = Object.freeze([
  { id: 'agents', label: 'Agents and profiles', containsSecrets: false, description: 'Agent registry, complete SQLite profile documents, per-agent Dream settings, and operator identity/avatar.' },
  { id: 'settings', label: 'Settings', containsSecrets: false, description: 'Portable non-secret runtime settings and preferences.' },
  { id: 'model-connections', label: 'Model connections', containsSecrets: true, description: 'Connection metadata and encrypted provider credentials.' },
  { id: 'mcp-connections', label: 'MCP connections', containsSecrets: true, description: 'MCP connection metadata, API keys, and per-agent tool grants.' },
  { id: 'ui-auth', label: 'UI authentication', containsSecrets: true, description: 'UI auth configuration and OIDC/basic credentials.' },
  { id: 'task-board', label: 'Task board and work items', containsSecrets: false, description: 'Projects, tasks, and work-item state.' },
]);

const categoryMap = new Map(EXPORT_CATEGORIES.map((category) => [category.id, category]));
const text = (value) => String(value ?? '').trim();

export function exportCatalog() {
  return { format: EXPORT_FORMAT, passwordMinLength: PASSWORD_MIN_LENGTH, categories: EXPORT_CATEGORIES };
}

export function normalizeExportRequest(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('request_body_object_required'), { statusCode: 400 });
  const categories = [...new Set(Array.isArray(body.categories) ? body.categories.map(text).filter(Boolean) : [])];
  if (!categories.length) throw Object.assign(new Error('export_categories_required'), { statusCode: 400 });
  const unknown = categories.filter((id) => !categoryMap.has(id));
  if (unknown.length) throw Object.assign(new Error('export_category_invalid'), { statusCode: 400, details: { categories: unknown } });
  const includesSecrets = categories.some((id) => categoryMap.get(id).containsSecrets);
  const password = text(body.password);
  if (includesSecrets && password.length < PASSWORD_MIN_LENGTH) throw Object.assign(new Error('export_password_required'), { statusCode: 400, details: { minLength: PASSWORD_MIN_LENGTH } });
  return { categories, includesSecrets, password: includesSecrets ? password : null };
}

function redacted(value, key = '') {
  if (/(authorization|api[-_]?key|token|secret|password|ciphertext|nonce|auth_tag|private)/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redacted(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redacted(entryValue, entryKey)]));
  return value;
}

function keyFromPassword(password, salt) { return scryptAsync(password, salt, 32, { N: 16384, r: 8, p: 1 }); }

export async function encodeExport({ payload, password = null } = {}) {
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(payload), 'utf8'));
  if (!password) return { contentType: 'application/gzip', extension: 'json.gz', body: compressed, encrypted: false };
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await keyFromPassword(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(EXPORT_FORMAT));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const envelope = {
    format: EXPORT_FORMAT,
    encrypted: true,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64url'),
    nonce: nonce.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
    payloadSha256: createHash('sha256').update(ciphertext).digest('hex'),
  };
  const header = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
  return { contentType: 'application/octet-stream', extension: 'hc-export', body: Buffer.concat([header, ciphertext]), encrypted: true };
}

export async function buildExport({ request, data = {}, sourceFiles = {} } = {}) {
  const selected = normalizeExportRequest(request);
  const categories = {};
  for (const id of selected.categories) {
    const value = data[id] ?? sourceFiles[id] ?? null;
    categories[id] = selected.includesSecrets ? value : redacted(value);
  }
  const manifest = {
    format: EXPORT_FORMAT,
    createdAt: new Date().toISOString(),
    categories: selected.categories.map((id) => ({ ...categoryMap.get(id), included: true })),
    redacted: !selected.includesSecrets,
    encrypted: selected.includesSecrets,
  };
  const payload = { manifest, categories };
  const encoded = await encodeExport({ payload, password: selected.password });
  return { ...encoded, manifest, selected };
}


export async function decodeExport(body, { password = null } = {}) {
  if (!Buffer.isBuffer(body) || !body.length) throw Object.assign(new Error('export_payload_required'), { statusCode: 400 });
  let compressed = body;
  let encrypted = false;
  if (body[0] !== 0x1f || body[1] !== 0x8b) {
    const separator = body.indexOf(0x0a);
    if (separator <= 0) throw Object.assign(new Error('export_envelope_invalid'), { statusCode: 400 });
    let envelope;
    try { envelope = JSON.parse(body.subarray(0, separator).toString('utf8')); } catch { throw Object.assign(new Error('export_envelope_invalid'), { statusCode: 400 }); }
    if (envelope.format !== EXPORT_FORMAT || envelope.encrypted !== true || text(password).length < PASSWORD_MIN_LENGTH) throw Object.assign(new Error('import_password_required'), { statusCode: 400, details: { minLength: PASSWORD_MIN_LENGTH } });
    const ciphertext = body.subarray(separator + 1);
    if (createHash('sha256').update(ciphertext).digest('hex') !== envelope.payloadSha256) throw Object.assign(new Error('export_checksum_mismatch'), { statusCode: 400 });
    try {
      const key = await keyFromPassword(text(password), Buffer.from(envelope.salt, 'base64url'));
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64url'));
      decipher.setAAD(Buffer.from(EXPORT_FORMAT)); decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'));
      compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]); encrypted = true;
    } catch { throw Object.assign(new Error('import_password_invalid'), { statusCode: 400 }); }
  }
  let payload;
  try { payload = JSON.parse((await gunzipAsync(compressed)).toString('utf8')); } catch { throw Object.assign(new Error('export_payload_invalid'), { statusCode: 400 }); }
  if (!payload || payload.manifest?.format !== EXPORT_FORMAT || !Array.isArray(payload.manifest.categories) || !payload.categories || typeof payload.categories !== 'object') throw Object.assign(new Error('export_manifest_invalid'), { statusCode: 400 });
  const categories = payload.manifest.categories.map((entry) => entry?.id).filter((id) => categoryMap.has(id));
  if (!categories.length) throw Object.assign(new Error('export_categories_required'), { statusCode: 400 });
  return { payload, encrypted, categories };
}

export function normalizeImportRequest(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('request_body_object_required'), { statusCode: 400 });
  const encoded = text(body.payload || body.export || body.data);
  if (!encoded) throw Object.assign(new Error('export_payload_required'), { statusCode: 400 });
  const binary = Buffer.from(encoded, 'base64');
  if (!binary.length) throw Object.assign(new Error('export_payload_invalid'), { statusCode: 400 });
  const conflictPolicy = text(body.conflictPolicy || 'error').toLowerCase();
  if (!['error', 'skip', 'replace'].includes(conflictPolicy)) throw Object.assign(new Error('import_conflict_policy_invalid'), { statusCode: 400 });
  return { binary, password: text(body.password) || null, confirm: body.confirm === true, conflictPolicy };
}

export const __test__ = { redacted, categoryMap, EXPORT_FORMAT, PASSWORD_MIN_LENGTH };
