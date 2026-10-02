import { normalizePostgresPool } from './postgres-foundation.mjs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const API_TOKEN_SCOPES = Object.freeze(['diagnostics:read']);
export const POSTGRES_API_TOKEN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_tokens (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL,
 scopes_json TEXT NOT NULL, expires_at TEXT, last_used_at TEXT, revoked_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_tokens_active_idx ON api_tokens(revoked_at, expires_at);`;
const hash = (v) => createHash('sha256').update(String(v || '')).digest();
const now = () => new Date().toISOString();
const scopes = (v) => { try { const x = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(x) ? x.filter((s) => API_TOKEN_SCOPES.includes(s)) : []; } catch { return []; } };
const record = (r) => r && ({ id:r.id,name:r.name,tokenPrefix:r.token_prefix,scopes:scopes(r.scopes_json),expiresAt:r.expires_at||null,lastUsedAt:r.last_used_at||null,revokedAt:r.revoked_at||null,createdAt:r.created_at,updatedAt:r.updated_at });
export class PostgresApiTokenStore {
 constructor({ pool, clock=now }={}) { if (!pool) throw new Error('pool_required'); this.pool=normalizePostgresPool(pool); this.clock=clock; }
 async create({name,scopes: requested=['diagnostics:read'],expiresAt=null}={}) { const n=String(name||'').trim(); if(!n) throw Object.assign(new Error('api_token_name_required'),{statusCode:400}); const ss=[...new Set(scopes(requested))]; if(!ss.length||ss.length!==(Array.isArray(requested)?requested.length:0)) throw Object.assign(new Error('invalid_api_token_scopes'),{statusCode:400,details:{supported:API_TOKEN_SCOPES}}); let expiry=null; if(expiresAt!==null&&expiresAt!==undefined&&expiresAt!==''){const t=Date.parse(String(expiresAt));if(!Number.isFinite(t)||t<=Date.now()) throw Object.assign(new Error('invalid_api_token_expiry'),{statusCode:400});expiry=new Date(t).toISOString();} const token=`brw_${randomBytes(32).toString('base64url')}`, ts=this.clock(), id=randomUUID(); await this.pool.query('INSERT INTO api_tokens(id,name,token_hash,token_prefix,scopes_json,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)',[id,n,hash(token).toString('hex'),token.slice(0,12),JSON.stringify(ss),expiry,ts]); const {rows}=await this.pool.query('SELECT *,scopes_json::text AS scopes_json FROM api_tokens WHERE id=$1',[id]); return {...record(rows[0]),token}; }
 async list({includeRevoked=true}={}) { const {rows}=await this.pool.query(`SELECT *,scopes_json::text AS scopes_json FROM api_tokens${includeRevoked?'':' WHERE revoked_at IS NULL'} ORDER BY created_at DESC`); return rows.map(record); }
 async revoke(id) { const ts=this.clock(); const {rows}=await this.pool.query('UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,$1),updated_at=$1 WHERE id=$2 RETURNING *,scopes_json::text AS scopes_json',[ts,String(id||'')]); return rows.length ? record(rows[0]) : null; }
 async authenticate(token,{requiredScope}={}) {
  const {rows}=await this.pool.query('SELECT *,scopes_json::text AS scopes_json FROM api_tokens WHERE revoked_at IS NULL');
  const presented=hash(token), current=Date.now();
  for(const row of rows){
   const stored=Buffer.from(row.token_hash,'hex');
   if(stored.length!==presented.length||!timingSafeEqual(stored,presented))continue;
   if(row.expires_at&&Date.parse(row.expires_at)<=current)return null;
   const tokenScopes=scopes(row.scopes_json);
   if(requiredScope&&!tokenScopes.includes(requiredScope))return null;
   const ts=this.clock();
   const claimed=await this.pool.query('UPDATE api_tokens SET last_used_at=$1,updated_at=$1 WHERE id=$2 AND revoked_at IS NULL RETURNING *,scopes_json::text AS scopes_json',[ts,row.id]);
   if(!claimed.rowCount)return null;
   return {...record(row),lastUsedAt:ts};
  }
  return null;
 }
}
