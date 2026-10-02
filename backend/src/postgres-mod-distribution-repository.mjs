import { normalizePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';

export const POSTGRES_MOD_DISTRIBUTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mod_sources (
  id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
  mod_id TEXT, mod_name TEXT, latest_version TEXT, archive_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending', error TEXT, last_checked_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mod_source_secrets (
  source_id TEXT PRIMARY KEY REFERENCES mod_sources(id) ON DELETE CASCADE,
  ciphertext BYTEA NOT NULL, nonce BYTEA NOT NULL, auth_tag BYTEA NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mod_installations (
  mod_id TEXT PRIMARY KEY, source_id TEXT REFERENCES mod_sources(id) ON DELETE SET NULL,
  version TEXT, archive_sha256 TEXT, installed_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

const changes = (result) => ({ changes: result.rowCount ?? 0 });
const rows = (result) => result.rows;
const first = (result) => result.rows[0];

export function createPostgresModDistributionRepository({ pool } = {}) {
  if (!pool?.query || !pool?.connect) throw new Error('mod_distribution_postgres_pool_required');
  pool = normalizePostgresPool(pool);

  function make(queryer) {
    const query = (sql, params = []) => queryer.query(sql, params);
    return {
      async close() {},
      async sourceRows() { return rows(await query('SELECT id,url,provider,mod_id,mod_name,latest_version,archive_url,status,error,last_checked_at FROM mod_sources ORDER BY created_at')); },
      async installationRows() { return rows(await query('SELECT mod_id,source_id,version,archive_sha256,installed_at,updated_at FROM mod_installations')); },
      async lifecycleRows() { return rows(await query('SELECT mod_id,enabled,created_at,updated_at FROM mod_lifecycle')); },
      async refreshSettings() { return first(await query("SELECT value_json::text AS value_json FROM settings_meta WHERE key='mod_source_refresh'")); },
      async saveRefreshSettings(value, timestamp) { return changes(await query("INSERT INTO settings_meta (key,value_json,updated_at) VALUES ('mod_source_refresh',$1,$2) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at", [JSON.stringify(value), timestamp])); },
      async sourceCredential(id) { return first(await query('SELECT ciphertext,nonce,auth_tag FROM mod_source_secrets WHERE source_id=$1', [id])); },
      async updateSourceReady(row, timestamp) { return changes(await query("UPDATE mod_sources SET mod_id=$1,mod_name=$2,latest_version=$3,archive_url=$4,status='ready',error=NULL,last_checked_at=$5,updated_at=$5 WHERE id=$6", [row.modId,row.modName,row.latestVersion,row.archiveUrl,timestamp,row.id])); },
      async updateSourceFailed(id, message, timestamp) { return changes(await query("UPDATE mod_sources SET status='failed',error=$1,last_checked_at=$2,updated_at=$2 WHERE id=$3", [message,timestamp,id])); },
      async ensureSource(id,url,timestamp) { await query("INSERT INTO mod_sources (id,url,provider,status,created_at,updated_at) VALUES ($1,$2,$3,'pending',$4,$4) ON CONFLICT(url) DO NOTHING", [id,url,'git',timestamp]); return first(await query('SELECT * FROM mod_sources WHERE url=$1',[url])); },
      async saveCredential(row, encrypted, timestamp) { return changes(await query('INSERT INTO mod_source_secrets (source_id,ciphertext,nonce,auth_tag,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT(source_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,nonce=EXCLUDED.nonce,auth_tag=EXCLUDED.auth_tag,updated_at=EXCLUDED.updated_at', [row.id,encrypted.ciphertext,encrypted.nonce,encrypted.authTag,timestamp])); },
      async removeSource(id) { return changes(await query('DELETE FROM mod_sources WHERE id=$1',[id])); },
      async sourceByMod(id) { return first(await query('SELECT * FROM mod_sources WHERE mod_id=$1 LIMIT 1',[id])); },
      async installationExists(id) { return first(await query('SELECT 1 AS present FROM mod_installations WHERE mod_id=$1',[id])); },
      async lifecycle(id) { return first(await query('SELECT enabled FROM mod_lifecycle WHERE mod_id=$1',[id])); },
      async saveInstallation(source, prepared, version, digest, timestamp) { await query("UPDATE mod_sources SET mod_id=$1,mod_name=$2,latest_version=$3,status='ready',error=NULL,updated_at=$4 WHERE id=$5",[prepared.id,prepared.name,version,timestamp,source.id]); await query('INSERT INTO mod_installations (mod_id,source_id,version,archive_sha256,installed_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT(mod_id) DO UPDATE SET source_id=EXCLUDED.source_id,version=EXCLUDED.version,archive_sha256=EXCLUDED.archive_sha256,installed_at=EXCLUDED.installed_at,updated_at=EXCLUDED.updated_at',[prepared.id,source.id,version,digest,timestamp]); await query('INSERT INTO mod_lifecycle (mod_id,enabled,created_at,updated_at) VALUES ($1,FALSE,$2,$2) ON CONFLICT(mod_id) DO NOTHING',[prepared.id,timestamp]); },
      async setLifecycle(id, enabled, timestamp) { return changes(await query('INSERT INTO mod_lifecycle (mod_id,enabled,created_at,updated_at) VALUES ($1,$2,$3,$3) ON CONFLICT(mod_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=EXCLUDED.updated_at',[id,Boolean(enabled),timestamp])); },
      async previousLifecycle(id) { return first(await query('SELECT enabled FROM mod_lifecycle WHERE mod_id=$1',[id])); },
      async restoreLifecycle(id, previous, timestamp) { return previous ? changes(await query('UPDATE mod_lifecycle SET enabled=$1,updated_at=$2 WHERE mod_id=$3',[previous.enabled,timestamp,id])) : changes(await query('DELETE FROM mod_lifecycle WHERE mod_id=$1',[id])); },
      async uninstallMetadata(id) { const [installation,lifecycle] = await Promise.all([query('SELECT mod_id,source_id,version,archive_sha256,installed_at,updated_at FROM mod_installations WHERE mod_id=$1',[id]),query('SELECT mod_id,enabled,created_at,updated_at FROM mod_lifecycle WHERE mod_id=$1',[id])]); return { installation:first(installation), lifecycle:first(lifecycle) }; },
      async removeMetadata(id) { await query('DELETE FROM mod_installations WHERE mod_id=$1',[id]); await query('DELETE FROM mod_lifecycle WHERE mod_id=$1',[id]); await query('DELETE FROM mcp_connections WHERE id=$1 AND base_url=$2',[`mod.${id}`,`mod://${id}`]); },
      async restoreMetadata(metadata) { if(metadata.installation) await query('INSERT INTO mod_installations (mod_id,source_id,version,archive_sha256,installed_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(mod_id) DO UPDATE SET source_id=EXCLUDED.source_id,version=EXCLUDED.version,archive_sha256=EXCLUDED.archive_sha256,installed_at=EXCLUDED.installed_at,updated_at=EXCLUDED.updated_at',[metadata.installation.mod_id,metadata.installation.source_id,metadata.installation.version,metadata.installation.archive_sha256,metadata.installation.installed_at,metadata.installation.updated_at]); if(metadata.lifecycle) await query('INSERT INTO mod_lifecycle (mod_id,enabled,created_at,updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT(mod_id) DO UPDATE SET enabled=EXCLUDED.enabled,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at',[metadata.lifecycle.mod_id,metadata.lifecycle.enabled,metadata.lifecycle.created_at,metadata.lifecycle.updated_at]); },
      async transaction(callback) { return withPostgresTransaction(pool, (client) => callback(make(client))); },
    };
  }
  return make(pool);
}

export default createPostgresModDistributionRepository;
