import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { importSettingsDatabase } from './postgres-settings-import.mjs';
import { importAuxiliaryDatabase } from './postgres-auxiliary-import.mjs';
import { importConversationSessions } from './postgres-conversation-import.mjs';
import { withPostgresTransaction, postgresTransactionContext } from './postgres-foundation.mjs';

const text = (v, name) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`${name}_required`); return v; };

async function filesUnder(input) {
  const root = path.resolve(text(input, 'source_path'));
  await fs.stat(root).catch(() => { throw new Error(`missing_configured_path:${input}`); });
  const files = [];
  async function visit(file) {
    const s = await fs.lstat(file);
    if (s.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name));
    else if (s.isFile()) files.push(file);
    else throw new Error(`unsupported_source_entry:${path.relative(root, file)}`);
  }
  await visit(root);
  return { root, files };
}
async function fingerprint(manifest) {
  const hash = createHash('sha256');
  for (const item of manifest) {
    const { root, files } = await filesUnder(item.path);
    if ((await fs.stat(root)).isFile()) {
      for (const suffix of ['-wal']) {
        const sidecar = root + suffix;
        try { await fs.stat(sidecar); files.push(sidecar); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    for (const file of files.sort()) {
      hash.update(JSON.stringify([item.name, root, path.relative(root, file)]));
      const contentHash = createHash('sha256');
      for await (const chunk of createReadStream(file)) contentHash.update(chunk);
      hash.update(contentHash.digest());
    }
  }
  return hash.digest('hex');
}
function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('migration_manifest_required');
  const allowed = new Set(['migrationId', 'settings', 'auxiliary', 'forge', 'continuity', 'conversations']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unknown_manifest_field:${key}`);
  const migrationId = text(input.migrationId || 'burrow-postgres-cutover-v1', 'migrationId');
  const settings = input.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings_source_required');
  const out = [{ name: 'settings', path: text(settings.path || settings.databasePath, 'settings_path'), kind: 'settings' }];
  const auxiliary = input.auxiliary || (input.forge || input.continuity ? { forge: input.forge, continuity: input.continuity } : null);
  if (auxiliary !== null) {
    if (!auxiliary || typeof auxiliary !== 'object' || Array.isArray(auxiliary)) throw new Error('invalid_auxiliary_source');
    for (const key of Object.keys(auxiliary)) if (!['path','databasePath','forge','continuity'].includes(key)) throw new Error(`unknown_auxiliary_field:${key}`);
    const p = auxiliary.path || auxiliary.databasePath;
    if (p) out.push({ name: 'auxiliary', path: text(p, 'auxiliary_path'), kind: 'auxiliary' });
    else {
      if (auxiliary.forge) out.push({ name: 'forge', path: text(auxiliary.forge.path || auxiliary.forge.databasePath, 'forge_path'), kind: 'auxiliary' });
      if (auxiliary.continuity) out.push({ name: 'continuity', path: text(auxiliary.continuity.path || auxiliary.continuity.databasePath, 'continuity_path'), kind: 'auxiliary' });
      if (out.length === 1) throw new Error('auxiliary_path_required');
    }
  }
  if (!Array.isArray(input.conversations)) throw new Error('conversations_manifest_required');
  const conversations = input.conversations.map((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`invalid_conversation_manifest:${i}`);
    for (const key of Object.keys(c)) if (!['agentId','rootDir'].includes(key)) throw new Error(`unknown_conversation_field:${key}`);
    const agentId = text(c.agentId, `conversation_agent_id:${i}`); const rootDir = text(c.rootDir, `conversation_root_dir:${i}`);
    return { agentId, rootDir };
  });
  return { migrationId, settings, auxiliary, conversations, sources: out };
}

/** Execute every import on one pinned client. Importers use savepoints through the transaction facade. */
export async function runPostgresCutover(pool, manifestInput) {
  const manifest = normalize(manifestInput);
  const before = await fingerprint([...manifest.sources, ...manifest.conversations.map(c => ({ name: `conversation:${c.agentId}`, path: path.join(c.rootDir, 'sessions') }))]);
  return withPostgresTransaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('burrow-cutover',0))");
    const prior = await client.query('SELECT fingerprint,manifest,result FROM burrow_migration_receipts WHERE migration_id=$1 FOR UPDATE', [manifest.migrationId]);
    if (prior.rowCount) {
      if (prior.rows[0].fingerprint !== before) throw new Error('migration_receipt_source_changed');
      return { ...prior.rows[0].result, repeated: true };
    }
    const facade = postgresTransactionContext(client);
    const result = {};
    result.settings = await importSettingsDatabase(facade, manifest.settings.path || manifest.settings.databasePath);
    result.auxiliary = [];
    for (const source of manifest.sources.filter(s => s.kind === 'auxiliary')) result.auxiliary.push(await importAuxiliaryDatabase(facade, source.path));
    result.conversations = [];
    for (const conversation of manifest.conversations) result.conversations.push(await importConversationSessions(facade, conversation));
    const after = await fingerprint([...manifest.sources, ...manifest.conversations.map(c => ({ name: `conversation:${c.agentId}`, path: path.join(c.rootDir, 'sessions') }))]);
    if (before !== after) throw new Error('source_changed_during_migration');
    await client.query('INSERT INTO burrow_migration_receipts(migration_id,manifest,fingerprint,completed_at,result) VALUES($1,$2::jsonb,$3,$4,$5::jsonb)', [manifest.migrationId, JSON.stringify(manifestInput), before, new Date().toISOString(), JSON.stringify(result)]);
    return result;
  });
}
export default runPostgresCutover;
