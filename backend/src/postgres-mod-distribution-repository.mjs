import { normalizePostgresPool, postgresTransactionContext, withPostgresTransaction } from './postgres-foundation.mjs';

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
      async installationOperation(id) { return first(await query("SELECT value_json FROM settings_meta WHERE key=$1", [`mod_install_operation:${id}`]))?.value_json ?? null; },
      async lifecycle(id) { return first(await query('SELECT enabled FROM mod_lifecycle WHERE mod_id=$1',[id])); },
      async saveInstallation(source, prepared, version, digest, timestamp, operationId = null) { if (queryer === pool) return withPostgresTransaction(pool, client => make(client).saveInstallation(source, prepared, version, digest, timestamp, operationId)); await query("UPDATE mod_sources SET mod_id=$1,mod_name=$2,latest_version=$3,status='ready',error=NULL,updated_at=$4 WHERE id=$5",[prepared.id,prepared.name,version,timestamp,source.id]); await query('INSERT INTO mod_installations (mod_id,source_id,version,archive_sha256,installed_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT(mod_id) DO UPDATE SET source_id=EXCLUDED.source_id,version=EXCLUDED.version,archive_sha256=EXCLUDED.archive_sha256,installed_at=EXCLUDED.installed_at,updated_at=EXCLUDED.updated_at',[prepared.id,source.id,version,digest,timestamp]); await query('INSERT INTO mod_lifecycle (mod_id,enabled,created_at,updated_at) VALUES ($1,FALSE,$2,$2) ON CONFLICT(mod_id) DO NOTHING',[prepared.id,timestamp]); if (operationId) await query("INSERT INTO settings_meta(key,value_json,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at", [`mod_install_operation:${prepared.id}`, JSON.stringify(operationId), timestamp]); },
      async setLifecycle(id, enabled, timestamp) { return changes(await query('INSERT INTO mod_lifecycle (mod_id,enabled,created_at,updated_at) VALUES ($1,$2,$3,$3) ON CONFLICT(mod_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=EXCLUDED.updated_at',[id,Boolean(enabled),timestamp])); },
      async previousLifecycle(id) { return first(await query('SELECT enabled FROM mod_lifecycle WHERE mod_id=$1',[id])); },
      async restoreLifecycle(id, previous, timestamp) { return previous ? changes(await query('UPDATE mod_lifecycle SET enabled=$1,updated_at=$2 WHERE mod_id=$3',[previous.enabled,timestamp,id])) : changes(await query('DELETE FROM mod_lifecycle WHERE mod_id=$1',[id])); },
      async uninstallMetadata(id) { const [installation,lifecycle] = await Promise.all([query('SELECT mod_id,source_id,version,archive_sha256,installed_at,updated_at FROM mod_installations WHERE mod_id=$1',[id]),query('SELECT mod_id,enabled,created_at,updated_at FROM mod_lifecycle WHERE mod_id=$1',[id])]); const connection = first(await query('SELECT * FROM mcp_connections WHERE id=$1 AND base_url=$2',[`mod.${id}`,`mod://${id}`]));
        const catalog = connection ? rows(await query('SELECT * FROM mcp_tool_catalog WHERE connection_id=$1',[connection.id])) : [];
        const grants = connection ? rows(await query('SELECT * FROM agent_mcp_tools WHERE connection_id=$1',[connection.id])) : [];
        const secrets = connection ? rows(await query('SELECT * FROM mcp_connection_secrets WHERE connection_id=$1',[connection.id])).map(row => ({ ...row, ciphertext: row.ciphertext.toString('base64'), nonce: row.nonce.toString('base64'), auth_tag: row.auth_tag.toString('base64') })) : [];
        return { installation:first(installation), lifecycle:first(lifecycle), connection, catalog, grants, secrets }; },
      async removeMetadata(id) { await query('DELETE FROM mod_installations WHERE mod_id=$1',[id]); await query('DELETE FROM mod_lifecycle WHERE mod_id=$1',[id]); await query('DELETE FROM mcp_connections WHERE id=$1 AND base_url=$2',[`mod.${id}`,`mod://${id}`]); },
      async restoreMetadata(metadata) {
        if (metadata.connection) {
          const c = metadata.connection;
          await query(`INSERT INTO mcp_connections(id,name,transport,connection_kind,base_url,command,args_json,lifecycle,enabled,tools_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,[c.id,c.name,c.transport,c.connection_kind,c.base_url,c.command,typeof c.args_json === 'string' ? c.args_json : JSON.stringify(c.args_json),c.lifecycle,c.enabled,typeof c.tools_json === 'string' ? c.tools_json : JSON.stringify(c.tools_json),c.created_at,c.updated_at]);
          for (const s of metadata.secrets || []) await query('INSERT INTO mcp_connection_secrets(id,connection_id,name,ciphertext,nonce,auth_tag,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING',[s.id,s.connection_id,s.name,Buffer.from(s.ciphertext,'base64'),Buffer.from(s.nonce,'base64'),Buffer.from(s.auth_tag,'base64'),s.created_at,s.updated_at]);
          for (const row of metadata.catalog || []) await query('INSERT INTO mcp_tool_catalog(connection_id,tool_name,metadata,available) VALUES($1,$2,$3,$4) ON CONFLICT(connection_id,tool_name) DO UPDATE SET metadata=EXCLUDED.metadata,available=EXCLUDED.available',[row.connection_id,row.tool_name,JSON.stringify(row.metadata),row.available]);
          for (const g of metadata.grants || []) await query('INSERT INTO agent_mcp_tools(agent_id,connection_id,tool_name,enabled,created_at,updated_at) SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS(SELECT 1 FROM agents WHERE id=$1) ON CONFLICT(agent_id,connection_id,tool_name) DO NOTHING',[g.agent_id,g.connection_id,g.tool_name,g.enabled,g.created_at,g.updated_at]);
        }
 if(metadata.installation) await query('INSERT INTO mod_installations (mod_id,source_id,version,archive_sha256,installed_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(mod_id) DO UPDATE SET source_id=EXCLUDED.source_id,version=EXCLUDED.version,archive_sha256=EXCLUDED.archive_sha256,installed_at=EXCLUDED.installed_at,updated_at=EXCLUDED.updated_at',[metadata.installation.mod_id,metadata.installation.source_id,metadata.installation.version,metadata.installation.archive_sha256,metadata.installation.installed_at,metadata.installation.updated_at]); if(metadata.lifecycle) await query('INSERT INTO mod_lifecycle (mod_id,enabled,created_at,updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT(mod_id) DO UPDATE SET enabled=EXCLUDED.enabled,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at',[metadata.lifecycle.mod_id,metadata.lifecycle.enabled,metadata.lifecycle.created_at,metadata.lifecycle.updated_at]); },
      async transaction(callback) { return withPostgresTransaction(queryer === pool ? pool : postgresTransactionContext(queryer), (client) => callback(make(client))); },
    };
  }
  return make(pool);
}

export default createPostgresModDistributionRepository;
