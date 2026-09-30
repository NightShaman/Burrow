import { randomBytes, pbkdf2Sync, createHmac, createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import pg from 'pg';
import { readFile, stat, open, rename, unlink } from 'node:fs/promises';
import { postgresLifecycleConfig } from './postgres-lifecycle-bootstrap.mjs';

const marker = 'burrow managed operator read-only v1';
export const quoteIdentifier = (s) => `"${String(s).replaceAll('"', '""')}"`;
export const quoteLiteral = (s) => `'${String(s).replaceAll("'", "''")}'`;
export function accessRole(name) {
  if (!/^[a-z][a-z0-9_]{0,46}$/.test(name || '')) throw new Error('name must be lowercase letters, digits or underscores (1–47 ASCII characters, starting with a letter; PostgreSQL identifiers are limited to 63 bytes including burrow_operator_)');
  return `burrow_operator_${name}`;
}
export function managedAccessConnection(env = process.env) {
  const config = postgresLifecycleConfig({ env });
  if (config.mode !== 'managed') throw new Error('postgres-access requires managed PostgreSQL mode');
  return { host: config.socketDir, port: 5432, database: 'postgres', user: userInfo().username };
}
function credentials() {
  const password = randomBytes(32).toString('base64url');
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(clientKey).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  return { password, verifier: `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}` };
}

/** Prepend an exact-role rule before initdb's local trust. Retain it after revoke:
 * removing it would reintroduce trust if a role is recreated outside this tool.
 * The transaction advisory lock serializes all managed access writers.
 */
async function enforceSocketPassword(client, role) {
  const file = (await client.query('SHOW hba_file')).rows[0].hba_file;
  const rule = `local all ${role} scram-sha-256`;
  const original = await readFile(file, 'utf8');
  if (!original.startsWith(`${rule}\n`)) {
    const metadata = await stat(file);
    const temporary = `${file}.burrow-${process.pid}-${randomBytes(8).toString('hex')}`;
    let handle;
    try {
      handle = await open(temporary, 'wx', metadata.mode & 0o777);
      await handle.chmod(metadata.mode & 0o777);
      await handle.writeFile(`${rule}\n${original}`);
      await handle.sync();
      await handle.close(); handle = null;
      await rename(temporary, file);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
  const invalid = await client.query('SELECT error FROM pg_hba_file_rules WHERE error IS NOT NULL');
  if (invalid.rows.length) throw new Error('Managed access HBA contains invalid rules; repair the file before retrying');
  const before = (await client.query('SELECT pg_conf_load_time()::text AS loaded')).rows[0].loaded;
  const reload = await client.query('SELECT pg_reload_conf() AS reloaded');
  if (!reload.rows[0]?.reloaded) throw new Error('Managed access HBA reload was refused; retry before using credentials');
  // SIGHUP is asynchronous. Poll the loaded file timestamp before committing roles.
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    const after = (await client.query('SELECT pg_conf_load_time()::text AS loaded')).rows[0].loaded;
    if (String(after) !== String(before)) return;
    // pg_reload_conf may already have been processed before the timestamp query.
    if (attempt === 5) {
      await client.query('SELECT pg_reload_conf()');
    }
  }
  throw new Error('Managed access HBA reload confirmation timed out; retry before using credentials');
}

/** Client must be the managed cluster owner. No lifecycle or network configuration changes. */
export async function administerManagedAccess(client, { action, name } = {}) {
  if (!['create', 'rotate', 'revoke', 'list'].includes(action)) throw new Error('action must be create, rotate, revoke or list');
  const role = action === 'list' ? null : accessRole(name);
  const id = role && quoteIdentifier(role);
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL standard_conforming_strings = on");
    await client.query("SELECT pg_advisory_xact_lock(712903418)");
    if (action === 'list') {
      const result = await client.query("SELECT rolname AS username, rolcanlogin AS login FROM pg_roles WHERE rolname LIKE 'burrow_operator_%' AND shobj_description(oid, 'pg_authid') = $1 ORDER BY rolname", [marker]);
      await client.query('COMMIT');
      return { roles: result.rows };
    }
    const existing = (await client.query("SELECT oid, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname=$1", [role])).rows[0];
    if (action === 'create' ? existing : !existing || existing.marker !== marker) throw new Error('role already exists or is not a managed operator role');
    await enforceSocketPassword(client, role);
    let password;
    if (action === 'create' || action === 'rotate') {
      const secret = credentials(); password = secret.password;
      await client.query(`${action === 'create' ? 'CREATE' : 'ALTER'} ROLE ${id} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(secret.verifier)}`);
    }
    if (action === 'create') {
      await client.query(`COMMENT ON ROLE ${id} IS ${quoteLiteral(marker)}`);
      await client.query(`GRANT CONNECT ON DATABASE postgres TO ${id}`);
      // Only public application tables, not cluster-wide predefined reader roles.
      await client.query(`GRANT USAGE ON SCHEMA public TO ${id}`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${id}`);
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${id}`);
      await client.query(`ALTER ROLE ${id} SET default_transaction_read_only = on`);
      const unsafe = await client.query(`SELECT
        has_schema_privilege($1, 'public', 'CREATE') OR EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
          AND (has_table_privilege($1,c.oid,'INSERT') OR has_table_privilege($1,c.oid,'UPDATE')
            OR has_table_privilege($1,c.oid,'DELETE') OR has_table_privilege($1,c.oid,'TRUNCATE'))
        ) AS unsafe`, [role]);
      if (unsafe.rows[0]?.unsafe) throw new Error('PUBLIC grants permit writes; refusing reader provisioning');
    }
    if (action === 'revoke') {
      // DROP OWNED also drops objects: refuse ownership rather than risking source data.
      const owned = await client.query("SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1 AND deptype='o' LIMIT 1", [existing.oid]);
      if (owned.rows.length) throw new Error('operator role owns objects; refusing destructive revoke');
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM ${id}`);
      await client.query(`DROP OWNED BY ${id} RESTRICT`);
      await client.query(`DROP ROLE ${id}`);
    }
    await client.query('COMMIT');
    if (action === 'rotate' || action === 'revoke') {
      try {
        const terminated = await client.query('SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE usename=$1 AND pid <> pg_backend_pid()', [role]);
        if (terminated.rows.some(row => !row.terminated)) throw new Error('termination refused');
      } catch {
        return { action, username: role, ...(password ? { password } : {}), committed: true, warning: 'Credential change committed, but existing session termination failed. Retry termination as owner; the returned password is active.' };
      }
    }
    return { action, username: role, ...(password ? { password } : {}) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    // Never surface SQL/query details or credentials in CLI errors.
    if (!error.code && !error.query) throw error;
    throw new Error(`Managed access ${action} failed (PostgreSQL ${/^[A-Z0-9]{5}$/.test(error.code || '') ? error.code : 'operation error'}); transaction rolled back. Check owner permissions and server logs.`);
  }
}

export async function runCliPostgresAccess(args, { env = process.env } = {}) {
  const allowed = new Set(['_', 'root', 'json', 'name']);
  if (Object.keys(args).some((key) => !allowed.has(key)) || args._.length !== 2) throw new Error('Usage: burrow postgres-access create|rotate|revoke|list [--name NAME] [--json]');
  const connection = managedAccessConnection(env);
  const client = new pg.Client(connection);
  try {
    await client.connect();
    const result = await administerManagedAccess(client, { action: args._[1], name: args.name });
    return { ...result, connection: { host: connection.host, port: connection.port, database: connection.database }, warning: result.warning || 'Dedicated operator roles require SCRAM on the private socket. Owner trust is unchanged; no remote listener was enabled.' };
  } catch (error) {
    if (!error.code || error.message.startsWith('Managed access') || error.message.startsWith('action must') || error.message.startsWith('name must')) throw error;
    throw new Error('Managed PostgreSQL access unavailable; server must already be running under this OS account');
  } finally { await client.end().catch(() => {}); }
}
