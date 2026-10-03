import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { migrationLockKey } from './postgres-foundation.mjs';

const owners = new WeakMap();
const keyFor = id => migrationLockKey(`burrow-continuity-owner:${id}`);

// A dedicated backend holds the session lock for the runtime lifetime. PostgreSQL,
// not host PIDs or wall-clock guesses, releases it after connection/process loss.
export function continuityOwner(pool, label = 'runtime') {
  let registry = owners.get(pool);
  if (!registry) { registry = new Map(); owners.set(pool, registry); }
  if (registry.has(label)) return registry.get(label);
  const id = randomUUID();
  const client = new pg.Client(pool.options);
  let lost = false;
  client.on('error', () => { lost = true; });
  client.on('end', () => { lost = true; });
  let starting;
  const owner = {
    id,
    async ready() {
      if (lost) throw new Error('continuity_owner_connection_lost');
      starting ||= (async () => {
        await client.connect();
        await client.query('SELECT pg_advisory_lock_shared($1::bigint)', [keyFor(id)]);
      })().catch(error => { lost = true; throw error; });
      await starting;
      await client.query('SELECT 1');
      if (lost) throw new Error('continuity_owner_connection_lost');
    },
    async alive(ownerId) {
      await this.ready();
      const key = BigInt.asUintN(64, BigInt(keyFor(ownerId)));
      const result = await client.query(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=$1::oid AND objid=$2::oid AND objsubid=1 AND granted) AS alive`, [String(key >> 32n), String(key & 0xffffffffn)]);
      return result.rows[0].alive;
    },
    async guard(work, boundaryKey = null) {
      await this.ready();
      const connection = new pg.Client(pool.options);
      connection.on('error', () => {});
      await connection.connect();
      try {
        // Retain liveness while a terminal callback is in flight even if the
        // dedicated heartbeat connection fails. Process loss drops both locks.
        await connection.query('SELECT pg_advisory_lock_shared($1::bigint)', [keyFor(id)]);
        // Reset takes the same boundary before touching session state.
        // Keep it across the callback: its persistence uses separate clients.
        if (boundaryKey) await connection.query('SELECT pg_advisory_lock($1::bigint)', [boundaryKey]);
        await this.ready();
        return await work();
      } finally {
        try { await connection.query('SELECT pg_advisory_unlock_shared($1::bigint)', [keyFor(id)]); }
        finally { await connection.end(); }
      }
    },
    async close() { lost = true; if (starting) { await starting.catch(() => {}); await client.end(); } },
  };
  registry.set(label, owner);
  return owner;
}

export async function closeContinuityOwners(pool) {
  await Promise.all([...(owners.get(pool)?.values() || [])].map(owner => owner.close()));
}
