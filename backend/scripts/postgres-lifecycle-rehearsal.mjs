#!/usr/bin/env node
/* Opt-in, disposable PostgreSQL lifecycle rehearsal. Never points at production. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createPostgresPool, closePostgresPool } from '../src/postgres-foundation.mjs';
import { migratePostgres } from '../src/postgres-migrations.mjs';

const exec = promisify(execFile);
const docker = (...args) => exec('sudo', ['-n', 'docker', ...args], { maxBuffer: 8 * 1024 * 1024 });
const { Pool } = pg;
const NAME = `burrow-pg-rehearsal-${process.pid}-${Date.now()}`;
const IMAGE = 'pgvector/pgvector:pg17';
let container;
let dumpDir;

const migrations = [
  { version: 1, name: 'vector-and-sample', sql: `CREATE EXTENSION IF NOT EXISTS vector; CREATE TABLE rehearsal_items (id integer PRIMARY KEY, embedding vector(3) NOT NULL); INSERT INTO rehearsal_items VALUES (1, '[1,2,3]');` },
  { version: 2, name: 'checkpoint', sql: `CREATE TABLE rehearsal_checkpoint (id integer PRIMARY KEY, note text NOT NULL); INSERT INTO rehearsal_checkpoint VALUES (1, 'persisted');` },
];
const badMigration = { version: 3, name: 'deliberately-rolled-back', sql: `CREATE TABLE rehearsal_should_rollback (id integer); SELECT definitely_missing_rehearsal_function();` };
const futureMigration = { version: 3, name: 'future-schema', sql: `CREATE TABLE rehearsal_future (id integer PRIMARY KEY);` };

function assert(condition, message) { if (!condition) throw new Error(message); }
function baseConfig(port, database = 'postgres') {
  return { host: '127.0.0.1', port, database, user: 'postgres', password: undefined, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000 };
}
async function sql(port, statement, database = 'postgres') {
  const pool = new Pool(baseConfig(port, database));
  try { return await pool.query(statement); } finally { await pool.end(); }
}
async function waitForPostgres(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await sql(port, 'SELECT 1'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  throw new Error('PostgreSQL did not become ready');
}
async function portForContainer() {
  const { stdout } = await docker('port', NAME, '5432/tcp');
  const match = stdout.match(/127\.0\.0\.1:(\d+)/) || stdout.match(/0\.0\.0\.0:(\d+)/);
  if (!match) throw new Error(`Could not determine loopback port: ${stdout}`);
  return Number(match[1]);
}
async function run() {
  if (process.env.BURROW_POSTGRES_LIFECYCLE_REHEARSAL !== '1') {
    console.log('Skipped: set BURROW_POSTGRES_LIFECYCLE_REHEARSAL=1 to run the disposable Docker rehearsal.');
    return;
  }
  dumpDir = await mkdtemp(join(tmpdir(), 'burrow-pg-rehearsal-'));
  await docker('pull', IMAGE);
  await docker('run', '-d', '--name', NAME, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-p', '127.0.0.1::5432', IMAGE);
  container = NAME;
  let port = await portForContainer();
  await waitForPostgres(port);
  const pool = createPostgresPool({ config: baseConfig(port) });
  try {
    // Two callers contend on the same transaction-scoped advisory lock. Exactly one applies each pending migration.
    const concurrent = await Promise.all([migratePostgres(pool, { migrations }), migratePostgres(pool, { migrations })]);
    assert(concurrent.flatMap((result) => result.applied).sort().join(',') === '1,2', `concurrent migration result was ${JSON.stringify(concurrent)}`);
    assert((await migratePostgres(pool, { migrations })).applied.length === 0, 'repeat migration was not pending-only');
    const extension = await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    assert(extension.rows.length === 1, 'pgvector extension is unavailable');
    assert((await pool.query('SELECT count(*)::int AS count FROM rehearsal_items')).rows[0].count === 1, 'migration data missing');

    await assertRejects(migratePostgres(pool, { migrations: [...migrations, badMigration] }), 'deliberate migration failure');
    assert((await pool.query("SELECT to_regclass('rehearsal_should_rollback') AS name")).rows[0].name === null, 'failed migration DDL was not rolled back');
    assert((await pool.query('SELECT max(version)::int AS version FROM burrow_schema_migrations')).rows[0].version === 2, 'failed migration changed ledger');

    await migratePostgres(pool, { migrations: [...migrations, futureMigration] });
    await assertRejects(migratePostgres(pool, { migrations }), 'future schema detection');
    assert((await pool.query("SELECT to_regclass('rehearsal_future') AS name")).rows[0].name === 'rehearsal_future', 'future migration was not applied');

    const dumpPath = join(dumpDir, 'rehearsal.sql');
    await docker('exec', NAME, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--file=/tmp/burrow-rehearsal.sql');
    await docker('cp', `${NAME}:/tmp/burrow-rehearsal.sql`, dumpPath);
    await sql(port, 'CREATE DATABASE rehearsal_restore');
    await docker('cp', dumpPath, `${NAME}:/tmp/burrow-rehearsal.sql`);
    await docker('exec', NAME, 'psql', '-U', 'postgres', '-d', 'rehearsal_restore', '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/burrow-rehearsal.sql');
    const restored = await sql(port, "SELECT count(*)::int AS count FROM rehearsal_items", 'rehearsal_restore');
    assert(restored.rows[0].count === 1, 'restored database data mismatch');

    await pool.end();
    await docker('restart', NAME);
    port = await portForContainer();
    await waitForPostgres(port);
    const afterRestart = await sql(port, "SELECT note FROM rehearsal_checkpoint WHERE id = 1");
    assert(afterRestart.rows[0].note === 'persisted', 'data did not survive restart');
    console.log(`PostgreSQL lifecycle rehearsal passed (PG17/pgvector, loopback port ${port}).`);
  } finally {
    await closePostgresPool(pool).catch(() => {});
  }
}
async function assertRejects(promise, label) {
  try { await promise; } catch { return; }
  throw new Error(`${label} unexpectedly succeeded`);
}
try { await run(); } finally {
  if (container) await docker('rm', '-f', container).catch(() => {});
  if (dumpDir) await rm(dumpDir, { recursive: true, force: true }).catch(() => {});
}
