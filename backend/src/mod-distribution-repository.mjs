import { openSettingsDatabase } from './settings-database.mjs';

/** Async SQLite persistence boundary for mod distribution. */
export function createModDistributionRepository({ databasePath }) {
  const db = openSettingsDatabase({ databasePath });
  const query = (sql, params = []) => db.prepare(sql).all(...params);
  const one = (sql, params = []) => db.prepare(sql).get(...params);
  const exec = (sql, params = []) => db.prepare(sql).run(...params);
  return {
    async close() { db.close(); },
    async sourceRows() { return query('SELECT id,url,provider,mod_id,mod_name,latest_version,archive_url,status,error,last_checked_at FROM mod_sources ORDER BY created_at'); },
    async installationRows() { return query('SELECT mod_id,source_id,version,archive_sha256,installed_at,updated_at FROM mod_installations'); },
    async lifecycleRows() { return query('SELECT mod_id,enabled,created_at,updated_at FROM mod_lifecycle'); },
    async refreshSettings() { return one("SELECT value_json FROM settings_meta WHERE key='mod_source_refresh'"); },
    async saveRefreshSettings(value, timestamp) { return exec(`INSERT INTO settings_meta (key,value_json,updated_at) VALUES ('mod_source_refresh',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`, [JSON.stringify(value), timestamp]); },
    async sourceCredential(id) { return one('SELECT ciphertext,nonce,auth_tag FROM mod_source_secrets WHERE source_id=?', [id]); },
    async updateSourceReady(row, timestamp) { return exec("UPDATE mod_sources SET mod_id=?,mod_name=?,latest_version=?,archive_url=?,status='ready',error=NULL,last_checked_at=?,updated_at=? WHERE id=?", [row.modId,row.modName,row.latestVersion,row.archiveUrl,timestamp,timestamp,row.id]); },
    async updateSourceFailed(id, message, timestamp) { return exec("UPDATE mod_sources SET status='failed',error=?,last_checked_at=?,updated_at=? WHERE id=?", [message,timestamp,timestamp,id]); },
    async ensureSource(id,url,timestamp) { await exec(`INSERT INTO mod_sources (id,url,provider,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?) ON CONFLICT(url) DO NOTHING`, [id,url,'git',timestamp,timestamp]); return one('SELECT * FROM mod_sources WHERE url=?',[url]); },
    async saveCredential(row, encrypted, timestamp) { return exec(`INSERT INTO mod_source_secrets (source_id,ciphertext,nonce,auth_tag,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag,updated_at=excluded.updated_at`, [row.id,encrypted.ciphertext,encrypted.nonce,encrypted.authTag,timestamp,timestamp]); },
    async removeSource(id) { return exec('DELETE FROM mod_sources WHERE id=?',[id]); },
    async sourceByMod(id) { return one('SELECT * FROM mod_sources WHERE mod_id=? LIMIT 1',[id]); },
    async installationExists(id) { return one('SELECT 1 AS present FROM mod_installations WHERE mod_id=?',[id]); },
    async lifecycle(id) { return one('SELECT enabled FROM mod_lifecycle WHERE mod_id=?',[id]); },
    async saveInstallation(source, prepared, version, digest, timestamp) { await exec('UPDATE mod_sources SET mod_id=?,mod_name=?,latest_version=?,status=\'ready\',error=NULL,updated_at=? WHERE id=?',[prepared.id,prepared.name,version,timestamp,source.id]); await exec(`INSERT INTO mod_installations (mod_id,source_id,version,archive_sha256,installed_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(mod_id) DO UPDATE SET source_id=excluded.source_id,version=excluded.version,archive_sha256=excluded.archive_sha256,installed_at=excluded.installed_at,updated_at=excluded.updated_at`,[prepared.id,source.id,version,digest,timestamp,timestamp]); await exec(`INSERT INTO mod_lifecycle (mod_id,enabled,created_at,updated_at) VALUES (?,0,?,?) ON CONFLICT(mod_id) DO NOTHING`,[prepared.id,timestamp,timestamp]); },
    async setLifecycle(id, enabled, timestamp) { return exec(`INSERT INTO mod_lifecycle (mod_id,enabled,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(mod_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`,[id,enabled?1:0,timestamp,timestamp]); },
    async previousLifecycle(id) { return one('SELECT enabled FROM mod_lifecycle WHERE mod_id=?',[id]); },
    async restoreLifecycle(id, previous, timestamp) { return previous ? exec('UPDATE mod_lifecycle SET enabled=?,updated_at=? WHERE mod_id=?',[previous.enabled,timestamp,id]) : exec('DELETE FROM mod_lifecycle WHERE mod_id=?',[id]); },
    async uninstallMetadata(id) { return { installation: one('SELECT mod_id,source_id,version,archive_sha256,installed_at,updated_at FROM mod_installations WHERE mod_id=?',[id]), lifecycle: one('SELECT mod_id,enabled,created_at,updated_at FROM mod_lifecycle WHERE mod_id=?',[id]) }; },
    async removeMetadata(id) { await exec('DELETE FROM mod_installations WHERE mod_id=?',[id]); await exec('DELETE FROM mod_lifecycle WHERE mod_id=?',[id]); await exec('DELETE FROM mcp_connections WHERE id=? AND base_url=?',[`mod.${id}`,`mod://${id}`]); },
    async restoreMetadata(metadata) { if(metadata.installation) await exec('INSERT OR REPLACE INTO mod_installations (mod_id,source_id,version,archive_sha256,installed_at,updated_at) VALUES (?,?,?,?,?,?)',[metadata.installation.mod_id,metadata.installation.source_id,metadata.installation.version,metadata.installation.archive_sha256,metadata.installation.installed_at,metadata.installation.updated_at]); if(metadata.lifecycle) await exec('INSERT OR REPLACE INTO mod_lifecycle (mod_id,enabled,created_at,updated_at) VALUES (?,?,?,?)',[metadata.lifecycle.mod_id,metadata.lifecycle.enabled,metadata.lifecycle.created_at,metadata.lifecycle.updated_at]); },
    async transaction(callback) { db.exec('BEGIN IMMEDIATE'); try { const result=await callback(this); db.exec('COMMIT'); return result; } catch(error) { db.exec('ROLLBACK'); throw error; } },
  };
}
export default createModDistributionRepository;
