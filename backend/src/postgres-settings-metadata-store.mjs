import { normalizePostgresPool } from './postgres-foundation.mjs';
import { isTiddleIdentity, readTiddle, writeTiddle } from './postgres-tiddle-store.mjs';
import { closePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';

export const POSTGRES_SETTINGS_METADATA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings_meta (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();

/** Async settings metadata boundary shared by server consumers; JSON values use the shared metadata contract. */
export class PostgresSettingsMetadataStore {
  constructor({ pool, ownsPool = false, clock = now } = {}) {
    if (!pool?.query) throw new Error('settings_metadata_postgres_pool_required');
    this.pool = normalizePostgresPool(pool);
    this.ownsPool = ownsPool;
    this.clock = clock;
  }
  async close() { if (this.ownsPool) await closePostgresPool(this.pool); }
  async get(key) {
    if (isTiddleIdentity(key)) return readTiddle(this.pool,key);
    const result = await this.pool.query('SELECT value_json::text AS value_json FROM settings_meta WHERE key=$1', [String(key)]);
    if (!result.rows[0]) return null;
    try { return JSON.parse(result.rows[0].value_json); } catch { return null; }
  }
  /** Serialize metadata read/modify/write, including the first insertion. */
  async atomicUpdate(key, update, at = this.clock()) {
    if (isTiddleIdentity(key)) throw new Error('tiddle_native_writer_required');
    const id = String(key);
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`settings-meta:${id}`]);
      const result = await client.query('SELECT value_json::text AS value_json FROM settings_meta WHERE key=$1 FOR UPDATE', [id]);
      let current = null;
      try { current = JSON.parse(result.rows[0]?.value_json || 'null'); } catch {}
      const value = await update(current);
      await client.query(`INSERT INTO settings_meta(key,value_json,updated_at) VALUES($1,$2,$3)
        ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`, [id, JSON.stringify(value), at]);
      return value;
    });
  }
  async set(key, value) {
    if (isTiddleIdentity(key)) { await writeTiddle(this.pool,key,value,this.clock()); return value; }
    const valueJson = JSON.stringify(value);
    await this.pool.query(`INSERT INTO settings_meta(key,value_json,updated_at) VALUES($1,$2,$3)
      ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`, [String(key), valueJson, this.clock()]);
    return value;
  }
}

export default PostgresSettingsMetadataStore;
