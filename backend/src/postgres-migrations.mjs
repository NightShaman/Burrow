import { applyOperatorInstantMigration } from './postgres-operator-backfill.mjs';
import { applyLogicalMemberMigration } from './postgres-logical-metadata-migration.mjs';
import { POSTGRES_LOSSLESS_NATIVE_CATALOGS_SQL } from './postgres-remaining-json.mjs';
import { applyLegacyContinuity } from './postgres-lossless-continuity.mjs';
import { migrationChecksum, migrationLockKey, withPostgresTransaction } from './postgres-foundation.mjs';
import { POSTGRES_APPLICATION_SCHEMA_MANIFEST } from './postgres-application-schema.mjs';

export const POSTGRES_MIGRATIONS = POSTGRES_APPLICATION_SCHEMA_MANIFEST;

const LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS burrow_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;

function validateManifest(migrations) {
  if (!Array.isArray(migrations)) throw new Error('PostgreSQL migrations must be an array');
  const ordered = [...migrations].sort((a, b) => (a?.version ?? 0) - (b?.version ?? 0));
  for (let i = 0; i < ordered.length; i += 1) {
    const migration = ordered[i];
    if (!migration || !Number.isInteger(migration.version) || migration.version < 1) throw new Error('PostgreSQL migration versions must be positive integers');
    if (i && migration.version !== ordered[i - 1].version + 1) throw new Error('PostgreSQL migrations must have contiguous versions starting at 1');
    if (typeof migration.name !== 'string' || migration.name.trim() === '') throw new Error(`Migration ${migration.version} has no name`);
    if (typeof migration.sql !== 'string' || migration.sql.trim() === '') throw new Error(`Migration ${migration.version} has no SQL`);
    const computed = migrationChecksum(migration.sql);
    if (migration.checksum !== undefined && migration.checksum !== computed) throw new Error(`Migration ${migration.version} checksum does not match SQL`);
  }
  if (ordered.length && ordered[0].version !== 1) throw new Error('PostgreSQL migrations must have contiguous versions starting at 1');
  return ordered;
}

/**
 * Apply only pending migrations while holding a transaction advisory lock. Migration
 * Published SQL/checksums are immutable; selected built-in versions have explicit
 * checksum-preserving execution adapters for compatible installation.
 */
export async function migratePostgres(pool, { migrations = POSTGRES_MIGRATIONS, lockNamespace = 'burrow-schema', applicationVersion = null } = {}) {
  const ordered = validateManifest(migrations);
  const highest = ordered.at(-1)?.version || 0;
  if (applicationVersion !== null && (!Number.isInteger(applicationVersion) || applicationVersion < 0 || applicationVersion < highest)) {
    throw new Error('Incompatible PostgreSQL application schema version');
  }
  return withPostgresTransaction(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [migrationLockKey(lockNamespace)]);
    await client.query(LEDGER_SQL);
    const { rows: applied } = await client.query('SELECT version, name, checksum FROM burrow_schema_migrations ORDER BY version');
    const byVersion = new Map();
    for (let i = 0; i < applied.length; i += 1) {
      const row = applied[i];
      const manifest = ordered[row.version - 1];
      if (!Number.isInteger(row.version) || row.version < 1 || !manifest || manifest.version !== row.version || byVersion.has(row.version) || row.version !== i + 1) {
        throw new Error('Incompatible PostgreSQL migration ledger: unknown or gapped applied history');
      }
      byVersion.set(row.version, row);
    }
    for (const migration of ordered) {
      const checksum = migrationChecksum(migration.sql);
      const existing = byVersion.get(migration.version);
      if (existing) {
        if (existing.checksum !== checksum || existing.name !== migration.name) throw new Error(`Incompatible PostgreSQL migration ledger at version ${migration.version}`);
        continue;
      }
      if ([18,26].includes(migration.version) && migration === POSTGRES_MIGRATIONS[migration.version-1]) await applyLegacyContinuity(client, migration);
      else if (migration.version === 38 && migration === POSTGRES_MIGRATIONS[37]) await applyLogicalMemberMigration(client, migration);
      else if (migration.version === 32 && migration === POSTGRES_MIGRATIONS[31]) await client.query(POSTGRES_LOSSLESS_NATIVE_CATALOGS_SQL);
      else if (migration.version === 48 && migration === POSTGRES_MIGRATIONS[47]) await applyOperatorInstantMigration(client);
      else await client.query(migration.sql);
      await client.query('INSERT INTO burrow_schema_migrations(version,name,checksum) VALUES($1,$2,$3)', [migration.version, migration.name, checksum]);
    }
    return { applied: ordered.filter((migration) => !byVersion.has(migration.version)).map((migration) => migration.version), currentVersion: highest };
  });
}

export { LEDGER_SQL };
