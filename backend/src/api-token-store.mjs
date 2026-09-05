import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { openSettingsDatabase } from './settings-database.mjs';

export const API_TOKEN_SCOPES = Object.freeze(['diagnostics:read']);
const TOKEN_PREFIX = 'brw_';

function now() { return new Date().toISOString(); }
function hashToken(token) { return createHash('sha256').update(String(token || '')).digest(); }
function parseScopes(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { parsed = []; }
  }
  return Array.isArray(parsed) ? parsed.filter((scope) => API_TOKEN_SCOPES.includes(scope)) : [];
}
function publicRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: parseScopes(row.scopes_json),
    expiresAt: row.expires_at || null,
    lastUsedAt: row.last_used_at || null,
    revokedAt: row.revoked_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ApiTokenStore {
  constructor({ databasePath, clock = now } = {}) {
    this.db = openSettingsDatabase({ databasePath });
    this.clock = clock;
  }

  close() { this.db.close(); }

  create({ name, scopes = ['diagnostics:read'], expiresAt = null } = {}) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) throw Object.assign(new Error('api_token_name_required'), { statusCode: 400 });
    const normalizedScopes = [...new Set(parseScopes(scopes))];
    if (!normalizedScopes.length || normalizedScopes.length !== (Array.isArray(scopes) ? scopes.length : 0)) {
      throw Object.assign(new Error('invalid_api_token_scopes'), { statusCode: 400, details: { supported: API_TOKEN_SCOPES } });
    }
    let normalizedExpiry = null;
    if (expiresAt !== null && expiresAt !== undefined && expiresAt !== '') {
      const time = Date.parse(String(expiresAt));
      if (!Number.isFinite(time) || time <= Date.now()) throw Object.assign(new Error('invalid_api_token_expiry'), { statusCode: 400 });
      normalizedExpiry = new Date(time).toISOString();
    }
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const createdAt = this.clock();
    const row = {
      id: randomUUID(), name: normalizedName, tokenHash: hashToken(token).toString('hex'), tokenPrefix: token.slice(0, 12),
      scopesJson: JSON.stringify(normalizedScopes), expiresAt: normalizedExpiry, createdAt,
    };
    this.db.prepare(`INSERT INTO api_tokens (id,name,token_hash,token_prefix,scopes_json,expires_at,last_used_at,revoked_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,NULL,NULL,?,?)`).run(row.id, row.name, row.tokenHash, row.tokenPrefix, row.scopesJson, row.expiresAt, row.createdAt, row.createdAt);
    return { ...publicRecord(this.db.prepare('SELECT * FROM api_tokens WHERE id=?').get(row.id)), token };
  }

  list({ includeRevoked = true } = {}) {
    const where = includeRevoked ? '' : ' WHERE revoked_at IS NULL';
    return this.db.prepare(`SELECT * FROM api_tokens${where} ORDER BY created_at DESC`).all().map(publicRecord);
  }

  revoke(id) {
    const updatedAt = this.clock();
    const result = this.db.prepare('UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,?),updated_at=? WHERE id=?').run(updatedAt, updatedAt, String(id || ''));
    return result.changes > 0 ? publicRecord(this.db.prepare('SELECT * FROM api_tokens WHERE id=?').get(String(id))) : null;
  }

  authenticate(token, { requiredScope } = {}) {
    const presented = hashToken(token);
    const current = Date.now();
    for (const row of this.db.prepare('SELECT * FROM api_tokens WHERE revoked_at IS NULL').all()) {
      const stored = Buffer.from(row.token_hash, 'hex');
      if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) continue;
      if (row.expires_at && Date.parse(row.expires_at) <= current) return null;
      const scopes = parseScopes(row.scopes_json);
      if (requiredScope && !scopes.includes(requiredScope)) return null;
      const lastUsedAt = this.clock();
      this.db.prepare('UPDATE api_tokens SET last_used_at=?,updated_at=? WHERE id=?').run(lastUsedAt, lastUsedAt, row.id);
      return { ...publicRecord(row), lastUsedAt };
    }
    return null;
  }
}
