import { normalizePostgresPool } from './postgres-foundation.mjs';
import { randomUUID } from 'node:crypto';
import { closePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';
import {
  assertConnection, canonicalizeOauthConnection, decrypt, encrypt, normalizeAuth,
  publicConnection, secretPreview, normalizeModels, normalizeReasoningEffort, normalizeTemperature, assertIdentity,
  refreshAnthropicOauth, discoverModels,
} from './model-settings-store.mjs';
import { refreshOpenAiOAuth } from './openai-oauth-login.mjs';

export const POSTGRES_MODEL_SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_identities (
  kind TEXT NOT NULL CHECK (kind IN ('operator', 'agent')),
  id TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS model_connections (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, api_type TEXT NOT NULL, base_url TEXT NOT NULL,
  accepted_input_json TEXT NOT NULL DEFAULT '[]', models_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS model_connections_provider_ci ON model_connections (translate(provider,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'));
CREATE TABLE IF NOT EXISTS model_connection_secrets (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES model_connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL, ciphertext BYTEA NOT NULL, nonce BYTEA NOT NULL, auth_tag BYTEA NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(connection_id, name)
);
CREATE TABLE IF NOT EXISTS model_auth_previews (
  connection_id TEXT PRIMARY KEY REFERENCES model_connections(id) ON DELETE CASCADE,
  value_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_settings_cache (
  cache_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_model_selections (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES model_connections(id) ON DELETE RESTRICT,
  model_id TEXT NOT NULL, reasoning_effort TEXT NOT NULL DEFAULT 'off',
  temperature DOUBLE PRECISION NOT NULL DEFAULT 0.2 CHECK (temperature >= 0 AND temperature <= 2),
  updated_at TEXT NOT NULL
);
`;
const now = () => new Date().toISOString();
const AUTH = 'providerAuth';
const API_KEY = 'apiKey';
const CONNECTION_WRITE_LOCK = 'burrow-model-settings-connection-write';
const IDENTITY_WRITE_LOCK = 'burrow-model-settings-identity-write';
const OAUTH_REFRESH_LOCK = 'burrow-model-settings-oauth-refresh';
const json = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };

export class PostgresModelSettingsStore {
  constructor({ pool, key, ownsPool = false, clock = now, bootstrapSampleIdentities = process.env.BURROW_BOOTSTRAP_SAMPLE_IDENTITIES } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('model_settings_postgres_pool_required');
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('settings_encryption_key_invalid');
    this.pool = normalizePostgresPool(pool); this.key = key; this.ownsPool = ownsPool; this.clock = clock;
    this.bootstrapSampleIdentities = ["1", "true", "yes", "on"].includes(String(bootstrapSampleIdentities ?? "0").trim().toLowerCase());
  }
  async close() { if (this.ownsPool) await closePostgresPool(this.pool); }
  defaultIdentityName(kind) { return this.bootstrapSampleIdentities ? (kind === 'operator' ? 'Rob' : 'Hatchet') : ''; }
  async identitySnapshot(client = this.pool) {
    const [agents, operator] = await Promise.all([
      client.query("SELECT id, name, avatar, updated_at AS \"updatedAt\" FROM chat_identities WHERE kind='agent' ORDER BY CASE id WHEN 'hatchet' THEN 0 ELSE 1 END, id COLLATE \"C\""),
      client.query("SELECT id, name, avatar, updated_at AS \"updatedAt\" FROM chat_identities WHERE kind='operator' AND id='default'")
    ]);
    const listed = agents.rows.slice();
    if (this.bootstrapSampleIdentities && !listed.some((agent) => agent.id === 'hatchet')) listed.unshift({ id: 'hatchet', name: 'Hatchet', avatar: '', updatedAt: null });
    return { operator: operator.rows[0] || { id: 'default', name: this.defaultIdentityName('operator'), avatar: '', updatedAt: null }, agents: listed };
  }
  async identities() { return this.identitySnapshot(); }
  async saveIdentity(input = {}) {
    const identity = assertIdentity(input);
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${IDENTITY_WRITE_LOCK}:${identity.kind}:${identity.id}`]);
      const existing = await client.query('SELECT name, avatar FROM chat_identities WHERE kind=$1 AND id=$2 FOR UPDATE', [identity.kind, identity.id]);
      const name = identity.name === undefined ? (existing.rows[0]?.name || this.defaultIdentityName(identity.kind)) : identity.name;
      const avatar = identity.avatar === undefined ? (existing.rows[0]?.avatar || '') : identity.avatar;
      const timestamp = this.clock();
      await client.query(`INSERT INTO chat_identities (kind,id,name,avatar,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)
        ON CONFLICT(kind,id) DO UPDATE SET name=EXCLUDED.name,avatar=EXCLUDED.avatar,updated_at=EXCLUDED.updated_at`, [identity.kind, identity.id, name, avatar, timestamp]);
      return this.identitySnapshot(client);
    });
  }
  selectSql(where = '') { return `SELECT c.*, c.accepted_input_json::text AS accepted_input_json, c.models_json::text AS models_json, legacy.id AS secret_id, auth.id AS auth_secret_id, p.value_json::text AS auth_preview_json FROM model_connections c LEFT JOIN model_connection_secrets legacy ON legacy.connection_id=c.id AND legacy.name='${API_KEY}' LEFT JOIN model_connection_secrets auth ON auth.connection_id=c.id AND auth.name='${AUTH}' LEFT JOIN model_auth_previews p ON p.connection_id=c.id ${where}`; }
  async list({ agentId = null } = {}) { const r = await this.pool.query(`${this.selectSql()} ORDER BY c.updated_at DESC`); return Promise.all(r.rows.map(async row => { const connection = publicConnection(row); if (agentId) { const native = await this.pool.query('SELECT model_id FROM model_catalog WHERE connection_id=$1 AND available', [row.id]); const ids = new Set(native.rows.map(x => x.model_id)); connection.models = connection.models.filter(x => ids.has(x.id)); } return connection; })); }
  async get(id) { const r = await this.pool.query(`${this.selectSql('WHERE c.id=$1')}`, [id]); return publicConnection(r.rows[0]); }
  async secret(id, name) { const r = await this.pool.query('SELECT * FROM model_connection_secrets WHERE connection_id=$1 AND name=$2', [id, name]); return r.rows[0] ? decrypt(this.key, r.rows[0]) : null; }
  async apiKey(id) { return this.secret(id, API_KEY); }
  async cacheGet(key) {
    const result = await this.pool.query('SELECT value_json::text AS value_json FROM model_settings_cache WHERE cache_key=$1', [String(key)]);
    return result.rows[0] ? json(result.rows[0].value_json, {}) : {};
  }
  async cacheSet(key, value, timestamp = this.clock()) {
    await this.pool.query(`INSERT INTO model_settings_cache(cache_key,value_json,updated_at) VALUES($1,$2,$3)
      ON CONFLICT(cache_key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`, [String(key), JSON.stringify(value ?? {}), timestamp]);
    return value ?? {};
  }
  async auth(id) { const structured = await this.secret(id, AUTH); if (structured) return json(structured, null); const key = await this.apiKey(id); if (!key) return null; const c = await this.get(id); return { type: 'api_key', provider: c?.provider || null, source: 'legacy-api-key', apiKey: key }; }
  async hasAuth(id) { return Boolean(await this.auth(id)); }
  async authWithClient(client, id, provider = null) { const structured = await client.query('SELECT * FROM model_connection_secrets WHERE connection_id=$1 AND name=$2', [id, AUTH]); if (structured.rows[0]) return json(decrypt(this.key, structured.rows[0]), null); const legacy = await client.query('SELECT * FROM model_connection_secrets WHERE connection_id=$1 AND name=$2', [id, API_KEY]); if (!legacy.rows[0]) return null; return { type: 'api_key', provider, source: 'legacy-api-key', apiKey: decrypt(this.key, legacy.rows[0]) }; }
  async saveSecret(client, connectionId, name, value, timestamp) {
    const old = await client.query('SELECT id FROM model_connection_secrets WHERE connection_id=$1 AND name=$2 FOR UPDATE', [connectionId, name]);
    const id = old.rows[0]?.id || randomUUID(); const sealed = encrypt(this.key, id, connectionId, name, value);
    await client.query(`INSERT INTO model_connection_secrets (id,connection_id,name,ciphertext,nonce,auth_tag,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (connection_id,name) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,nonce=EXCLUDED.nonce,auth_tag=EXCLUDED.auth_tag,updated_at=EXCLUDED.updated_at`, [id, connectionId, name, sealed.ciphertext, sealed.nonce, sealed.authTag, timestamp]);
    return id;
  }
  async save(input = {}) {
    const id = String(input.id ?? '').trim() || randomUUID();
    return withPostgresTransaction(this.pool, async (client) => {
      // Serialize all connection writes so provider-label renames cannot deadlock
      // while acquiring locks in opposite (id/provider) orders.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [CONNECTION_WRITE_LOCK]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
      const existing = await client.query('SELECT id,provider FROM model_connections WHERE id=$1 FOR UPDATE', [id]);
      const priorAuth = existing.rows[0] ? await this.authWithClient(client, id, existing.rows[0].provider) : null;
      const supplied = normalizeAuth(input, input.provider); const auth = supplied || priorAuth;
      const connection = canonicalizeOauthConnection(assertConnection(input), auth);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [connection.provider.toLowerCase()]);
      const duplicate = await client.query(`SELECT id FROM model_connections WHERE translate(provider,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=translate($1,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') AND id<>$2 FOR UPDATE`, [connection.provider, id]);
      if (duplicate.rows[0]) throw new Error('provider_label_duplicate');
      const stamp = this.clock();
      const priorRow = existing.rows[0] ? await client.query('SELECT models_json::text AS models_json FROM model_connections WHERE id=$1', [id]) : null;
      const existingModels = normalizeModels(json(priorRow?.rows[0]?.models_json, []), { provider: connection.provider, apiType: connection.apiType });
      const submittedModels = normalizeModels(input.models, { provider: connection.provider, apiType: connection.apiType });
      const priorById = new Map(existingModels.map((model) => [model.id, model]));
      const models = submittedModels.map((model) => { const prior = priorById.get(model.id); return (!prior || model.manual || prior.manual) ? model : normalizeModels([{ ...prior, ...model }], { provider: connection.provider, apiType: connection.apiType })[0]; });
      await client.query(`INSERT INTO model_connections (id,provider,api_type,base_url,accepted_input_json,models_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (id) DO UPDATE SET provider=EXCLUDED.provider,api_type=EXCLUDED.api_type,base_url=EXCLUDED.base_url,accepted_input_json=EXCLUDED.accepted_input_json,models_json=EXCLUDED.models_json,updated_at=EXCLUDED.updated_at`, [id, connection.provider, connection.apiType, connection.baseUrl, JSON.stringify(connection.acceptedInput), JSON.stringify(models), stamp]);
      if (supplied) await this.writeAuth(client, id, supplied, connection.provider, stamp, input.auth === undefined);
      const row = await client.query(this.selectSql('WHERE c.id=$1'), [id]); return publicConnection(row.rows[0]);
    });
  }
  async writeAuth(client, id, auth, provider, stamp, legacy = false) {
    if (auth.type === 'api_key' && legacy) { await this.saveSecret(client, id, API_KEY, auth.apiKey, stamp); await client.query('DELETE FROM model_connection_secrets WHERE connection_id=$1 AND name=$2', [id, AUTH]); await client.query('DELETE FROM model_auth_previews WHERE connection_id=$1', [id]); return; }
    await this.saveSecret(client, id, AUTH, JSON.stringify(auth), stamp);
    await client.query(`INSERT INTO model_auth_previews(connection_id,value_json,updated_at) VALUES($1,$2,$3) ON CONFLICT(connection_id) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`, [id, JSON.stringify(secretPreview(auth, provider)), stamp]);
  }
  async modelSelection(agentId) {
    const agent = String(agentId ?? '').trim();
    if (!agent) throw new Error('agent_id_invalid');
    const result = await this.pool.query('SELECT agent_id,connection_id,model_id,reasoning_effort,temperature,updated_at FROM agent_model_selections WHERE agent_id=$1', [agent]);
    const row = result.rows[0];
    return row ? { agentId: row.agent_id, connectionId: row.connection_id, model: row.model_id, reasoningEffort: row.reasoning_effort, temperature: Number(row.temperature), updatedAt: row.updated_at } : null;
  }
  async saveModelSelection({ agentId, connectionId, model, reasoningEffort = 'off', temperature = undefined } = {}) {
    const agent = String(agentId ?? '').trim();
    if (!agent) throw new Error('agent_id_invalid');
    const id = String(connectionId ?? '').trim();
    const modelId = String(model ?? '').trim();
    return withPostgresTransaction(this.pool, async (client) => {
      const connectionRow = await client.query('SELECT * FROM model_connections WHERE id=$1 FOR SHARE', [id]);
      if (!connectionRow.rows[0]) throw new Error('model_connection_not_found');
      const connectionResult = await client.query(this.selectSql('WHERE c.id=$1'), [id]);
      const connection = publicConnection(connectionResult.rows[0]);
      const native = await client.query('SELECT metadata FROM model_catalog WHERE connection_id=$1 AND model_id=$2 AND available FOR SHARE', [id, modelId]);
      const enabled = native.rows[0]?.metadata?.selected !== false ? native.rows[0]?.metadata : null;
      if (!enabled) throw new Error('model_not_enabled_for_connection');
      if (!await this.authWithClient(client, id, connection.provider)) throw new Error('model_connection_auth_required');
      const effort = normalizeReasoningEffort(reasoningEffort);
      if (enabled.reasoningEfforts?.length && effort !== 'off' && !enabled.reasoningEfforts.includes(effort)) throw new Error('model_reasoning_effort_not_supported');
      let priorResult = await client.query('SELECT agent_id,connection_id,model_id,reasoning_effort,temperature,updated_at FROM agent_model_selections WHERE agent_id=$1 FOR UPDATE', [agent]);
      let prior = priorResult.rows[0];
      if (!prior) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`agent-model-selection:${agent}`]);
        priorResult = await client.query('SELECT agent_id,connection_id,model_id,reasoning_effort,temperature,updated_at FROM agent_model_selections WHERE agent_id=$1 FOR UPDATE', [agent]);
        prior = priorResult.rows[0];
      }
      const selectedTemperature = normalizeTemperature(temperature, prior ? Number(prior.temperature) : 0.2);
      const stamp = this.clock();
      const result = await client.query(`INSERT INTO agent_model_selections (agent_id,connection_id,model_id,reasoning_effort,temperature,updated_at) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT(agent_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,model_id=EXCLUDED.model_id,reasoning_effort=EXCLUDED.reasoning_effort,temperature=EXCLUDED.temperature,updated_at=EXCLUDED.updated_at
        RETURNING agent_id,connection_id,model_id,reasoning_effort,temperature,updated_at`, [agent, connection.id, modelId, effort, selectedTemperature, stamp]);
      const row = result.rows[0];
      return { agentId: row.agent_id, connectionId: row.connection_id, model: row.model_id, reasoningEffort: row.reasoning_effort, temperature: Number(row.temperature), updatedAt: row.updated_at };
    });
  }

  async resolveAuth(id, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
    const connection = await this.get(id);
    if (!connection) throw new Error('model_connection_not_found');
    let auth = await this.auth(id);
    if (!auth) throw new Error('model_connection_auth_required');
    if (auth.type === 'oauth' && Number(auth.expiresAt) <= nowMs + 60_000) {
      // The lock is session-scoped and held on the same pinned client used for
      // the re-read/write. This avoids a max=1 pool deadlock and lets ordinary
      // operator writes proceed until the short persistence transaction.
      const client = await this.pool.connect();
      let locked = false;
      try {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`${OAUTH_REFRESH_LOCK}:${id}`]);
        locked = true;
        const current = await client.query(`${this.selectSql('WHERE c.id=$1')}`, [id]);
        if (!current.rows[0]) throw new Error('model_connection_not_found');
        const currentConnection = publicConnection(current.rows[0]);
        auth = await this.authWithClient(client, id, currentConnection.provider);
        if (!auth) throw new Error('model_connection_auth_required');
        if (auth.type === 'oauth' && Number(auth.expiresAt) <= nowMs + 60_000) {
          const provider = auth.provider || currentConnection.provider;
          const refreshed = /openai/i.test(provider)
            ? await refreshOpenAiOAuth(auth, { fetchImpl, nowMs })
            : /anthropic|claude/i.test(provider)
              ? await refreshAnthropicOauth(auth, { fetchImpl, nowMs })
              : (() => { throw new Error('model_auth_refresh_provider_unsupported'); })();
          await client.query('BEGIN');
          try {
            auth = await this.persistAuthOnClient(client, id, refreshed, this.clock(), auth.refreshToken || null, auth);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
          }
        }
      } finally {
        if (locked) {
          try {
            await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`${OAUTH_REFRESH_LOCK}:${id}`]);
          } catch (error) {
            // An unlock failure means the session may still hold the advisory
            // lock. Destroy it rather than returning a potentially locked
            // client to the pool.
            client.release(error);
            throw error;
          }
        }
        client.release();
      }
    }
    const token = auth.type === 'oauth' ? auth.accessToken : auth.type === 'api_key' ? auth.apiKey : auth.token;
    if (!token) throw new Error('model_connection_auth_required');
    return { type: auth.type || 'api_key', provider: auth.provider || connection.provider, source: auth.source || null, token, expiresAt: auth.expiresAt || null };
  }
  async discoverModels(options = {}) {
    const connection = await this.get(options.id || options.connectionId);
    if (!connection) throw new Error('model_connection_not_found');
    const auth = options.auth || await this.auth(connection.id) || {};
    const token = options.apiKey || auth.apiKey || auth.accessToken || auth.token;
    return discoverModels({ ...options, baseUrl: options.baseUrl || connection.baseUrl, provider: options.provider || connection.provider, apiType: options.apiType || connection.apiType, auth, apiKey: token, fetchImpl: options.fetchImpl || fetch, catalogFetchImpl: options.catalogFetchImpl || options.fetchImpl || fetch, store: options.store || this });
  }

  async persistAuthOnClient(client, id, auth, timestamp = this.clock(), expectedRefreshToken = undefined, expectedAuth = undefined) {
    const row = await client.query('SELECT provider,api_type,base_url FROM model_connections WHERE id=$1 FOR UPDATE', [id]);
    const current = row.rows[0];
    if (!current) throw new Error('model_connection_not_found');
    if (expectedRefreshToken !== undefined) {
      const stored = await this.authWithClient(client, id, current.provider);
      if (stored?.refreshToken !== expectedRefreshToken || (expectedAuth && JSON.stringify(stored) !== JSON.stringify(expectedAuth))) return stored || auth;
    }
    const canonical = canonicalizeOauthConnection({ provider: current.provider, apiType: current.api_type, baseUrl: current.base_url }, auth);
    if (canonical.apiType !== current.api_type) await client.query('UPDATE model_connections SET api_type=$1, updated_at=$2 WHERE id=$3', [canonical.apiType, timestamp, id]);
    await this.writeAuth(client, id, auth, current.provider || auth.provider, timestamp, false);
    return auth;
  }
  async persistAuth(id, auth, timestamp = this.clock(), expectedRefreshToken = undefined, expectedAuth = undefined) {
    return withPostgresTransaction(this.pool, (client) => this.persistAuthOnClient(client, id, auth, timestamp, expectedRefreshToken, expectedAuth));
  }
  async remove(id) { return withPostgresTransaction(this.pool, async (client) => {
    const connectionId = String(id ?? '').trim();
    const locked = await client.query('SELECT id FROM model_connections WHERE id=$1 FOR UPDATE', [connectionId]);
    if (!locked.rows[0]) return false;
    await client.query('DELETE FROM agent_model_selections WHERE connection_id=$1', [connectionId]);
    return (await client.query('DELETE FROM model_connections WHERE id=$1', [connectionId])).rowCount > 0;
  }); }
}
