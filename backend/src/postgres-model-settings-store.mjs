import { PostgresProviderPoolMetrics } from './postgres-provider-pool-metrics.mjs';
import { normalizePostgresPool } from './postgres-foundation.mjs';
import { randomUUID } from 'node:crypto';
import { closePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';
import {
  assertConnection, canonicalizeOauthConnection, decrypt, encrypt, normalizeAuth, mergeOpenAiOAuthTokens,
  publicConnection, secretPreview, normalizeModels, normalizeReasoningEffort, normalizeTemperature, assertIdentity,
  refreshAnthropicOauth, discoverModels, isProviderPool, assertProviderPoolMembers, providerPoolModels, modelSettingsFailureDiagnostic,
} from './model-settings-store.mjs';
import { refreshOpenAiOAuth } from './openai-oauth-login.mjs';
import { operationalEvent } from './operational-log.mjs';

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
export const POSTGRES_MINION_MODEL_SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_minion_model_selections (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES model_connections(id) ON DELETE RESTRICT,
  model_id TEXT NOT NULL, reasoning_effort TEXT NOT NULL DEFAULT 'off',
  temperature DOUBLE PRECISION NOT NULL DEFAULT 0.2 CHECK (temperature >= 0 AND temperature <= 2),
  updated_at TIMESTAMPTZ NOT NULL
);
`;
export const POSTGRES_PROVIDER_POOL_SCHEMA_SQL = `
ALTER TABLE model_connections ADD COLUMN pool_json JSONB;
CREATE TABLE provider_pool_affinity (
  pool_id TEXT, thread_key TEXT, owner_id TEXT, substitute_id TEXT,
  substitute_until TIMESTAMPTZ, updated_at TIMESTAMPTZ, PRIMARY KEY(pool_id,thread_key)
);
CREATE TABLE provider_pool_health (
  pool_id TEXT, member_id TEXT, cooldown_until TIMESTAMPTZ, last_reason TEXT,
  updated_at TIMESTAMPTZ, PRIMARY KEY(pool_id,member_id)
);
`;
const now = () => new Date().toISOString();
const AUTH = 'providerAuth';
const API_KEY = 'apiKey';
const CONNECTION_WRITE_LOCK = 'burrow-model-settings-connection-write';
const IDENTITY_WRITE_LOCK = 'burrow-model-settings-identity-write';
const OAUTH_REFRESH_LOCK = 'burrow-model-settings-oauth-refresh';
const OAUTH_REFRESH_TIMEOUT_MS = 15_000;

// Cancel the caller's wait, never a refresh which may already have consumed a
// single-use token upstream. Both promise outcomes remain observed after abort.
function waitForAuth(pending, signal) {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

const json = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };

export class PostgresModelSettingsStore {
  constructor({ pool, key, ownsPool = false, clock = now, logger = null, bootstrapSampleIdentities = process.env.BURROW_BOOTSTRAP_SAMPLE_IDENTITIES } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('model_settings_postgres_pool_required');
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('settings_encryption_key_invalid');
    this.pool = normalizePostgresPool(pool); this.key = key; this.ownsPool = ownsPool; this.clock = clock;
    this.logger = logger;
    this.oauthRefreshes = new Map();
    this.providerPoolMetrics = new PostgresProviderPoolMetrics(this.pool);
    this.bootstrapSampleIdentities = ["1", "true", "yes", "on"].includes(String(bootstrapSampleIdentities ?? "0").trim().toLowerCase());
  }
  async close() {
    // A canceled caller may have left a rotation queued for checkout or still
    // committing. Keep the pool available until that owned work finishes.
    while (this.oauthRefreshes.size) await Promise.allSettled([...this.oauthRefreshes.values()]);
    if (this.ownsPool) await closePostgresPool(this.pool);
  }
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
  selectSql(where = '') { return `SELECT c.*, c.pool_json::text AS pool_json, c.accepted_input_json::text AS accepted_input_json, c.models_json::text AS models_json, legacy.id AS secret_id, auth.id AS auth_secret_id, p.value_json::text AS auth_preview_json FROM model_connections c LEFT JOIN model_connection_secrets legacy ON legacy.connection_id=c.id AND legacy.name='${API_KEY}' LEFT JOIN model_connection_secrets auth ON auth.connection_id=c.id AND auth.name='${AUTH}' LEFT JOIN model_auth_previews p ON p.connection_id=c.id ${where}`; }
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
  async hasAuth(id) {
    const connection = await this.get(id);
    if (!isProviderPool(connection || {})) return Boolean(await this.auth(id));
    if (!connection.pool?.enabled) return false;
    const members = await Promise.all(connection.pool.memberConnectionIds.map(memberId => this.get(memberId)));
    try { assertProviderPoolMembers(connection, members.filter(Boolean)); return true; } catch { return false; }
  }
  async authWithClient(client, id, provider = null) { const structured = await client.query('SELECT * FROM model_connection_secrets WHERE connection_id=$1 AND name=$2', [id, AUTH]); if (structured.rows[0]) return json(decrypt(this.key, structured.rows[0]), null); const legacy = await client.query('SELECT * FROM model_connection_secrets WHERE connection_id=$1 AND name=$2', [id, API_KEY]); if (!legacy.rows[0]) return null; return { type: 'api_key', provider, source: 'legacy-api-key', apiKey: decrypt(this.key, legacy.rows[0]) }; }
  async saveSecret(client, connectionId, name, value, timestamp) {
    const old = await client.query('SELECT id FROM model_connection_secrets WHERE connection_id=$1 AND name=$2 FOR UPDATE', [connectionId, name]);
    const id = old.rows[0]?.id || randomUUID(); const sealed = encrypt(this.key, id, connectionId, name, value);
    await client.query(`INSERT INTO model_connection_secrets (id,connection_id,name,ciphertext,nonce,auth_tag,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (connection_id,name) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,nonce=EXCLUDED.nonce,auth_tag=EXCLUDED.auth_tag,updated_at=EXCLUDED.updated_at`, [id, connectionId, name, sealed.ciphertext, sealed.nonce, sealed.authTag, timestamp]);
    return id;
  }
  async save(input = {}, discoveryOptions = {}) {
    // Provider I/O must complete before acquiring connection-write/SQL locks.
    if (isProviderPool(input)) {
      const connection = assertConnection(input);
      if (input.auth || input.apiKey || input.oauthTokens) throw new Error('provider_pool_credentials_forbidden');
      const members = await Promise.all(connection.pool.memberConnectionIds.map(id => this.get(id)));
      assertProviderPoolMembers({ ...connection, id: input.id }, members.filter(Boolean));
      for (const member of members) if (!member.models.length) {
        const models = await this.discoverModels({ ...discoveryOptions, id: member.id, signal: discoveryOptions.signal || AbortSignal.timeout(15_000) });
        if (!models.length) throw new Error('provider_pool_member_catalog_empty');
      }
    }
    const id = String(input.id ?? '').trim() || randomUUID();
    return withPostgresTransaction(this.pool, async (client) => {
      // Serialize all connection writes so provider-label renames cannot deadlock
      // while acquiring locks in opposite (id/provider) orders.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [CONNECTION_WRITE_LOCK]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
      const existing = await client.query('SELECT id,provider FROM model_connections WHERE id=$1 FOR UPDATE', [id]);
      const priorAuth = existing.rows[0] ? await this.authWithClient(client, id, existing.rows[0].provider) : null;
      if (input.oauthTokens !== undefined && (input.auth !== undefined || input.apiKey)) throw new Error('model_oauth_tokens_conflicting_auth');
      const supplied = input.oauthTokens !== undefined
        ? mergeOpenAiOAuthTokens(priorAuth, input.oauthTokens)
        : normalizeAuth(input, input.provider);
      const auth = supplied || priorAuth;
      const connection = canonicalizeOauthConnection(assertConnection(input), auth);
      let poolMembers = [];
      if (isProviderPool(connection)) {
        if (supplied || priorAuth) throw new Error('provider_pool_credentials_forbidden');
        const memberRows = await client.query(this.selectSql('WHERE c.id=ANY($1::text[])'), [connection.pool.memberConnectionIds]);
        poolMembers = connection.pool.memberConnectionIds.map(memberId => memberRows.rows.map(publicConnection).find(member => member.id === memberId)).filter(Boolean);
        assertProviderPoolMembers({ ...connection, id }, poolMembers);
        if (poolMembers.some(member => !member.models.length)) throw new Error('provider_pool_member_catalog_empty');
      }
      // Member credential/API changes must preserve every referencing pool.
      const references = await client.query(this.selectSql("WHERE c.pool_json->'memberConnectionIds' ? $1 AND c.id<>$1"), [id]);
      for (const row of references.rows) {
        const parent = publicConnection(row);
        const rows = await client.query(this.selectSql('WHERE c.id=ANY($1::text[])'), [parent.pool.memberConnectionIds]);
        assertProviderPoolMembers(parent, rows.rows.map(publicConnection).map(member => member.id === id ? { ...connection, id, auth: auth ? secretPreview(auth, connection.provider) : null } : member));
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [connection.provider.toLowerCase()]);
      const duplicate = await client.query(`SELECT id FROM model_connections WHERE translate(provider,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=translate($1,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') AND id<>$2 FOR UPDATE`, [connection.provider, id]);
      if (duplicate.rows[0]) throw new Error('provider_label_duplicate');
      const stamp = this.clock();
      const priorRow = existing.rows[0] ? await client.query('SELECT models_json::text AS models_json FROM model_connections WHERE id=$1', [id]) : null;
      const existingModels = normalizeModels(json(priorRow?.rows[0]?.models_json, []), { provider: connection.provider, apiType: connection.apiType });
      const submittedModels = normalizeModels(input.models, { provider: connection.provider, apiType: connection.apiType });
      const priorById = new Map(existingModels.map((model) => [model.id, model]));
      let models = submittedModels.map((model) => { const prior = priorById.get(model.id); return (!prior || model.manual || prior.manual) ? model : normalizeModels([{ ...prior, ...model }], { provider: connection.provider, apiType: connection.apiType })[0]; });
      // Saves patch catalog entries; omitted/empty lists never erase discovery or
      // models added by a concurrent refresh. Explicit selected:false disables.
      models.push(...existingModels.filter(model => !models.some(item => item.id === model.id)));
      if (isProviderPool(connection)) {
        models = providerPoolModels(poolMembers);
      }
      await client.query(`INSERT INTO model_connections (id,provider,api_type,base_url,accepted_input_json,models_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (id) DO UPDATE SET provider=EXCLUDED.provider,api_type=EXCLUDED.api_type,base_url=EXCLUDED.base_url,accepted_input_json=EXCLUDED.accepted_input_json,models_json=EXCLUDED.models_json,updated_at=EXCLUDED.updated_at`, [id, connection.provider, connection.apiType, connection.baseUrl, JSON.stringify(connection.acceptedInput), JSON.stringify(models), stamp]);
      await client.query('UPDATE model_connections SET pool_json=$2 WHERE id=$1', [id, connection.pool ? JSON.stringify(connection.pool) : null]);
      if (supplied) await this.writeAuth(client, id, supplied, connection.provider, stamp, input.auth === undefined);
      for (const reference of references.rows) {
        const parent = publicConnection(reference);
        const rows = await client.query(this.selectSql('WHERE c.id=ANY($1::text[])'), [parent.pool.memberConnectionIds]);
        const members = parent.pool.memberConnectionIds.map(memberId => rows.rows.map(publicConnection).find(member => member.id === memberId)).filter(Boolean);
        const union = providerPoolModels(members);
        await client.query('UPDATE model_connections SET models_json=$2,updated_at=$3 WHERE id=$1', [parent.id, JSON.stringify(union), stamp]);
      }
      const row = await client.query(this.selectSql('WHERE c.id=$1'), [id]); return publicConnection(row.rows[0]);
    });
  }
  async writeAuth(client, id, auth, provider, stamp, legacy = false) {
    if (auth.type === 'api_key' && legacy) { await this.saveSecret(client, id, API_KEY, auth.apiKey, stamp); await client.query('DELETE FROM model_connection_secrets WHERE connection_id=$1 AND name=$2', [id, AUTH]); await client.query('DELETE FROM model_auth_previews WHERE connection_id=$1', [id]); return; }
    await this.saveSecret(client, id, AUTH, JSON.stringify(auth), stamp);
    await client.query(`INSERT INTO model_auth_previews(connection_id,value_json,updated_at) VALUES($1,$2,$3) ON CONFLICT(connection_id) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`, [id, JSON.stringify(secretPreview(auth, provider)), stamp]);
  }
  async modelSelection(agentId, { minion = false } = {}) {
    const agent = String(agentId ?? '').trim();
    if (!agent) throw new Error('agent_id_invalid');
    const table = minion ? 'agent_minion_model_selections' : 'agent_model_selections';
    const result = await this.pool.query(`SELECT agent_id,connection_id,model_id,reasoning_effort,temperature,updated_at FROM ${table} WHERE agent_id=$1`, [agent]);
    const row = result.rows[0];
    return row ? { agentId: row.agent_id, connectionId: row.connection_id, model: row.model_id, reasoningEffort: row.reasoning_effort, temperature: Number(row.temperature), updatedAt: row.updated_at } : null;
  }
  async clearModelSelection(agentId, { minion = false } = {}) {
    const agent = String(agentId ?? '').trim();
    if (!agent) throw new Error('agent_id_invalid');
    await this.pool.query(`DELETE FROM ${minion ? 'agent_minion_model_selections' : 'agent_model_selections'} WHERE agent_id=$1`, [agent]);
  }
  async saveModelSelection({ agentId, connectionId, model, reasoningEffort = 'off', temperature = undefined, minion = false } = {}) {
    const agent = String(agentId ?? '').trim();
    if (!agent) throw new Error('agent_id_invalid');
    const id = String(connectionId ?? '').trim();
    const modelId = String(model ?? '').trim();
    if (minion && !id && !modelId) {
      await this.pool.query('DELETE FROM agent_minion_model_selections WHERE agent_id=$1', [agent]);
      return null;
    }
    return withPostgresTransaction(this.pool, async (client) => {
      const connectionRow = await client.query('SELECT * FROM model_connections WHERE id=$1 FOR SHARE', [id]);
      if (!connectionRow.rows[0]) throw new Error('model_connection_not_found');
      const connectionResult = await client.query(this.selectSql('WHERE c.id=$1'), [id]);
      const connection = publicConnection(connectionResult.rows[0]);
      const native = await client.query('SELECT metadata FROM model_catalog WHERE connection_id=$1 AND model_id=$2 AND available FOR SHARE', [id, modelId]);
      const enabled = native.rows[0]?.metadata?.selected !== false ? native.rows[0]?.metadata : null;
      if (!enabled) throw new Error('model_not_enabled_for_connection');
      if (isProviderPool(connection)) {
        if (!connection.pool?.enabled) throw new Error('provider_pool_disabled');
      } else if (!await this.authWithClient(client, id, connection.provider)) throw new Error('model_connection_auth_required');
      const effort = normalizeReasoningEffort(reasoningEffort);
      if (enabled.reasoningEfforts?.length && effort !== 'off' && !enabled.reasoningEfforts.includes(effort)) throw new Error('model_reasoning_effort_not_supported');
      const table = minion ? 'agent_minion_model_selections' : 'agent_model_selections';
      let priorResult = await client.query(`SELECT agent_id,connection_id,model_id,reasoning_effort,temperature,updated_at FROM ${table} WHERE agent_id=$1 FOR UPDATE`, [agent]);
      let prior = priorResult.rows[0];
      if (!prior) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`agent-model-selection:${agent}`]);
        priorResult = await client.query(`SELECT agent_id,connection_id,model_id,reasoning_effort,temperature,updated_at FROM ${table} WHERE agent_id=$1 FOR UPDATE`, [agent]);
        prior = priorResult.rows[0];
      }
      const selectedTemperature = normalizeTemperature(temperature, prior ? Number(prior.temperature) : 0.2);
      const stamp = this.clock();
      const result = await client.query(`INSERT INTO ${table} (agent_id,connection_id,model_id,reasoning_effort,temperature,updated_at) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT(agent_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,model_id=EXCLUDED.model_id,reasoning_effort=EXCLUDED.reasoning_effort,temperature=EXCLUDED.temperature,updated_at=EXCLUDED.updated_at
        RETURNING agent_id,connection_id,model_id,reasoning_effort,temperature,updated_at`, [agent, connection.id, modelId, effort, selectedTemperature, stamp]);
      const row = result.rows[0];
      return { agentId: row.agent_id, connectionId: row.connection_id, model: row.model_id, reasoningEffort: row.reasoning_effort, temperature: Number(row.temperature), updatedAt: row.updated_at };
    });
  }

  async resolveAuth(id, { fetchImpl = fetch, nowMs = Date.now(), signal = null } = {}) {
    signal?.throwIfAborted();
    let pending = this.oauthRefreshes.get(id);
    if (!pending) {
      // Register before the first lookup can yield. Concurrent calls share the
      // entire lifecycle, including failure and work queued on a max=1 pool.
      pending = this.resolveAuthUncancelled(id, { fetchImpl, nowMs });
      this.oauthRefreshes.set(id, pending);
      pending.then(() => this.oauthRefreshes.delete(id), error => {
        this.oauthRefreshes.delete(id);
        // The last caller may already have stopped. Retain a safe diagnostic,
        // not an unhandled rejection or raw upstream response/credentials.
        if (this.logger) operationalEvent(this.logger, 'model_auth_refresh_failed', {
          connectionId: id, ...modelSettingsFailureDiagnostic(error),
        }, { component: 'models' });
      });
    }
    return waitForAuth(pending, signal);
  }

  async resolveAuthUncancelled(id, { fetchImpl, nowMs }) {
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
          let refreshed;
          try {
            // Only this exchange owns the network deadline. Neither a stopped
            // run nor background catalog deadline may cancel its token body.
            const signal = AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS);
            refreshed = /openai/i.test(provider)
              ? await refreshOpenAiOAuth(auth, { fetchImpl, nowMs, signal })
              : /anthropic|claude/i.test(provider)
                ? await refreshAnthropicOauth(auth, { fetchImpl, nowMs, signal })
                : (() => { throw new Error('model_auth_refresh_provider_unsupported'); })();
          } catch (error) {
            // An operator may have reauthorized while the provider was failing.
            // A stale failure must not conceal a genuinely newer usable login.
            const saved = await this.authWithClient(client, id, currentConnection.provider);
            const usable = saved?.type === 'oauth'
              ? saved.accessToken && Number(saved.expiresAt) > nowMs + 60_000
              : saved?.type === 'api_key' ? saved.apiKey : saved?.token;
            if (!usable || JSON.stringify(saved) === JSON.stringify(auth)) throw error;
            auth = saved;
          }
          if (refreshed) {
            await client.query('BEGIN');
            try {
              auth = await this.persistAuthOnClient(client, id, refreshed, this.clock(), auth.refreshToken || null, auth);
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK').catch(() => {});
              throw error;
            }
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
  async persistDiscoveredModels(id, discovered, { onlyIfEmpty = false, ticket = null, connection = null } = {}) {
    // An empty upstream snapshot is not evidence that an OAuth account lost all models.
    // Fail the refresh before replacing either its catalog or dependent pool catalogs.
    if (!Array.isArray(discovered) || discovered.length === 0) throw new Error('member_catalog_empty');
    return withPostgresTransaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [CONNECTION_WRITE_LOCK]);
      const result = await client.query(this.selectSql('WHERE c.id=$1'), [id]);
      const member = publicConnection(result.rows[0]);
      if (!member) throw new Error('model_connection_not_found');
      assertProviderPoolMembers({ apiType: member.auth?.provider === 'openai' ? 'openai-lb' : 'anthropic-lb', pool: { memberConnectionIds: [id] } }, [member]);
      if (onlyIfEmpty && member.models.length) return;
      const cacheKey = `model_catalog:${id}`;
      const cached = await client.query('SELECT value_json::text AS value_json FROM model_settings_cache WHERE cache_key=$1', [cacheKey]);
      const state = json(cached.rows[0]?.value_json, {});
      if (ticket && state.ticket !== ticket) return;
      if (connection && (connection.baseUrl !== member.baseUrl || connection.apiType !== member.apiType)) return;
      // Keep explicit choices even while an upstream ID is temporarily absent.
      const choices = { ...state.choices, ...Object.fromEntries(member.models.map(model => [model.id, model.selected])) };
      const prior = new Map(member.models.map(model => [model.id, model]));
      const models = normalizeModels(discovered.map(model => ({ ...prior.get(model.id), ...model, ...(prior.get(model.id)?.manual ? { manual: true } : {}), selected: choices[model.id] ?? true })), { provider: member.provider, apiType: member.apiType });
      for (const model of member.models) if (model.manual && !models.some(item => item.id === model.id)) models.push(model);
      const stamp = this.clock();
      await client.query(`INSERT INTO model_settings_cache(cache_key,value_json,updated_at) VALUES($1,$2,$3)
        ON CONFLICT(cache_key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`, [cacheKey, JSON.stringify({ ...state, choices }), stamp]);
      await client.query('UPDATE model_connections SET models_json=$2,updated_at=$3 WHERE id=$1', [id, JSON.stringify(models), stamp]);
      const refs = await client.query(this.selectSql("WHERE c.pool_json->'memberConnectionIds' ? $1"), [id]);
      for (const row of refs.rows) {
        const parent = publicConnection(row);
        const rows = await client.query(this.selectSql('WHERE c.id=ANY($1::text[])'), [parent.pool.memberConnectionIds]);
        const members = parent.pool.memberConnectionIds.map(id => rows.rows.map(publicConnection).find(member => member.id === id)).filter(Boolean);
        await client.query('UPDATE model_connections SET models_json=$2,updated_at=$3 WHERE id=$1', [parent.id, JSON.stringify(providerPoolModels(members)), stamp]);
      }
    });
  }
  async discoverModels(options = {}) {
    const connection = await this.get(options.id || options.connectionId);
    if (!connection) throw new Error('model_connection_not_found');
    if (isProviderPool(connection)) {
      const members = await Promise.all(connection.pool.memberConnectionIds.map(id => this.get(id)));
      assertProviderPoolMembers(connection, members.filter(Boolean));
      const catalogs = await Promise.all(members.map(async member => {
        const models = await this.discoverModels({ ...options, id: member.id, connectionId: member.id, apiType: member.apiType, baseUrl: member.baseUrl });
        return { ...member, models };
      }));
      return providerPoolModels(catalogs);
    }
    let auth = options.auth || await this.auth(connection.id) || {};
    const resolved = !options.auth && auth.type === 'oauth' ? await this.resolveAuth(connection.id, options) : null;
    if (resolved) auth = await this.auth(connection.id) || auth;
    const token = options.apiKey || resolved?.token || auth.apiKey || auth.accessToken || auth.token;
    const ticket = randomUUID();
    if (auth.type === 'oauth') await withPostgresTransaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [CONNECTION_WRITE_LOCK]);
      await client.query(`INSERT INTO model_settings_cache(cache_key,value_json,updated_at) VALUES($1,$2,$3)
        ON CONFLICT(cache_key) DO UPDATE SET value_json=model_settings_cache.value_json::jsonb || EXCLUDED.value_json::jsonb,updated_at=EXCLUDED.updated_at`, [`model_catalog:${connection.id}`, JSON.stringify({ ticket }), this.clock()]);
    });
    const models = await discoverModels({ ...options, baseUrl: options.baseUrl || connection.baseUrl, provider: options.provider || connection.provider, apiType: options.apiType || connection.apiType, auth, apiKey: token, fetchImpl: options.fetchImpl || fetch, catalogFetchImpl: options.catalogFetchImpl || options.fetchImpl || fetch, store: options.store || this });
    if (auth.type === 'oauth') await this.persistDiscoveredModels(connection.id, models, { ticket, connection });
    return models;
  }

  async refreshOAuthCatalogs(options = {}) {
    if (this.catalogRefresh) return this.catalogRefresh;
    const run = async () => {
      const results = [];
      for (const connection of await this.list()) {
        options.signal?.throwIfAborted();
        if (isProviderPool(connection) || connection.auth?.type !== 'oauth') continue;
        try {
          await this.discoverModels({ ...options, id: connection.id,
            signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
          results.push({ id: connection.id, ok: true });
        } catch (error) {
          // Preserve a bounded diagnostic before this API turns exceptions into
          // !ok. Never return provider responses, parser prose or credentials.
          results.push({ id: connection.id, ok: false, error: modelSettingsFailureDiagnostic(error) });
        }
      }
      return results;
    };
    this.catalogRefresh = run().finally(() => { this.catalogRefresh = null; });
    return this.catalogRefresh;
  }

  async persistAuthOnClient(client, id, auth, timestamp = this.clock(), expectedRefreshToken = undefined, expectedAuth = undefined) {
    const row = await client.query('SELECT provider,api_type,base_url FROM model_connections WHERE id=$1 FOR UPDATE', [id]);
    const current = row.rows[0];
    if (!current) throw new Error('model_connection_not_found');
    if (expectedRefreshToken !== undefined) {
      const stored = await this.authWithClient(client, id, current.provider);
      if (stored?.refreshToken !== expectedRefreshToken) return stored || auth;
      if (expectedAuth && JSON.stringify(stored) !== JSON.stringify(expectedAuth)) {
        if (stored?.type !== 'oauth' || !/openai/i.test(stored.provider || '') || expectedAuth.type !== 'oauth') return stored || auth;
        // A token-only edit can retain the very refresh token this exchange
        // just consumed. Do not discard its replacement: preserve edited
        // fields, but advance that same token lineage to the provider's rotation.
        auth = { ...auth };
        for (const key of new Set([...Object.keys(expectedAuth), ...Object.keys(stored)])) {
          if (key === 'refreshToken' || JSON.stringify(stored[key]) === JSON.stringify(expectedAuth[key])) continue;
          if (Object.hasOwn(stored, key)) auth[key] = stored[key];
          else delete auth[key]; // Access-token edits also clear absent identity claims.
        }
      }
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
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [CONNECTION_WRITE_LOCK]);
    const refs = await client.query("SELECT id FROM model_connections WHERE pool_json->'memberConnectionIds' ? $1 AND id<>$1", [connectionId]);
    if (refs.rows.length) throw new Error('provider_pool_member_in_use');
    const locked = await client.query('SELECT id FROM model_connections WHERE id=$1 FOR UPDATE', [connectionId]);
    if (!locked.rows[0]) return false;
    await client.query('DELETE FROM agent_model_selections WHERE connection_id=$1', [connectionId]);
    await client.query('DELETE FROM agent_minion_model_selections WHERE connection_id=$1', [connectionId]);
    await client.query('DELETE FROM provider_pool_affinity WHERE pool_id=$1', [connectionId]);
    await client.query('DELETE FROM provider_pool_health WHERE pool_id=$1', [connectionId]);
    return (await client.query('DELETE FROM model_connections WHERE id=$1', [connectionId])).rowCount > 0;
  }); }
}
