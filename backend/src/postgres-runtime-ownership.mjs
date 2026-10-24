import pg from 'pg';
import { migrationLockKey } from './postgres-foundation.mjs';

// One UI runtime owns all mod dispatchers/receipts in a database. Deliberately
// independent of listener port, runtimeRoot, host PID and connection user.
const runtimeLockKey = migrationLockKey('burrow-ui-runtime-ownership:v1');

/** Dedicated, non-pooled session lock, held until process exit (or test teardown).
 * Like continuity ownership, PostgreSQL releases it on crash/connection loss;
 * unlike per-session continuity claims this excludes the entire UI runtime.
 * Loss is fatal: a live process must never continue dispatching after a successor
 * can acquire the lock and reconcile its jobs. Do not use graceful drain on loss.
 */
export async function acquirePostgresRuntimeOwnership({ pool, config = pool?.options, ClientClass = pg.Client, onLost = () => {
  console.error('Burrow runtime database ownership lost; terminating to fence live work.');
  process.exit(1);
} } = {}) {
  const client = new ClientClass(config);
  let owned = false;
  let closing = false;
  let lost = false;
  const connectionLost = () => {
    if (lost || closing) return;
    lost = true;
    if (owned) onLost();
  };
  client.on('error', connectionLost);
  client.on('end', connectionLost);
  const close = async () => {
    closing = true;
    owned = false;
    await client.end();
  };
  try {
    await client.connect();
    const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [runtimeLockKey]);
    if (!result.rows[0]?.acquired) throw new Error('runtime_database_already_owned: another Burrow UI runtime owns this database (regardless of port)');
    if (lost) throw new Error('runtime_database_ownership_lost');
    owned = true;
    const assertOwned = async () => {
      if (!owned || lost || closing) throw new Error('runtime_database_ownership_lost');
      try { await client.query('SELECT 1'); }
      catch (error) { connectionLost(); throw error; }
      if (lost || closing) throw new Error('runtime_database_ownership_lost');
    };
    return Object.freeze({
      assertOwned,
      async reconcileModJobs(stores) {
        // Only the sole admitted runtime may infer previous runtime jobs dead.
        // No wall-clock timeout or successful HTTP bind constitutes ownership.
        await assertOwned();
        const externalTurns = await stores.externalTurns.interruptIncomplete('core_restart_before_completion');
        await assertOwned();
        const generations = await stores.generations.interruptIncomplete('core_restart_before_completion');
        return { externalTurns, generations };
      },
      // Production retains ownership through drain/store teardown until exit.
      // Explicit close is for callers that have already stopped all owned work.
      close,
    });
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
