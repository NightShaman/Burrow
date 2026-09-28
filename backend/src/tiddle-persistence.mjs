import { openSettingsDatabase, settingsDatabasePath } from './settings-database.mjs';
import { withPostgresTransaction } from './postgres-foundation.mjs';

// Small effect runner lets legacy synchronous readers and async server callers
// execute the same continuity mutations, without maintaining two algorithms.
export function runSync(iterator) {
  let step = iterator.next();
  while (!step.done) { try { step = iterator.next(step.value()); } catch (error) { step = iterator.throw(error); } }
  return step.value;
}
export async function runAsync(iterator) {
  let step = iterator.next();
  while (!step.done) { try { step = iterator.next(await step.value()); } catch (error) { step = iterator.throw(error); } }
  return step.value;
}
export function tiddlePersistence({ stores, databasePath } = {}) {
  if (stores?.metadata) {
    const metadata = stores.metadata;
    const pool = metadata.pool;
    if (!pool?.query) throw new Error('tiddle_metadata_pool_required');
    const adapter = (client, transactional = false) => ({
      get: key => transactional ? client.query('SELECT value_json FROM settings_meta WHERE key=$1', [key]).then(r => { try { return JSON.parse(r.rows[0]?.value_json || 'null'); } catch { return null; } }) : metadata.get(key),
      set: (key, value, at) => client.query('INSERT INTO settings_meta(key,value_json,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at', [key, JSON.stringify(value), at]),
      rows: prefix => client.query('SELECT key,value_json,updated_at FROM settings_meta WHERE starts_with(key,$1) ORDER BY updated_at DESC,key', [prefix]).then(r => r.rows),
      transaction: (agentId, operation) => withPostgresTransaction(pool, async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`tiddle:${agentId}`]);
        return runAsync(operation(adapter(tx, true)));
      }),
      close() {},
    });
    return adapter(pool);
  }
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  const adapter = {
    get: key => { try { return JSON.parse(db.prepare('SELECT value_json FROM settings_meta WHERE key=?').get(key)?.value_json || 'null'); } catch { return null; } },
    set: (key, value, at) => db.prepare('INSERT INTO settings_meta(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').run(key, JSON.stringify(value), at),
    rows: prefix => db.prepare('SELECT key,value_json,updated_at FROM settings_meta WHERE substr(key,1,?)=? ORDER BY updated_at DESC,key').all(prefix.length, prefix),
    transaction: (_agentId, operation) => { db.exec('BEGIN IMMEDIATE'); try { const result = runSync(operation(adapter)); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    close: () => db.close(),
  };
  return adapter;
}
