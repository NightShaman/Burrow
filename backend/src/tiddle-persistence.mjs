import { readRollingCards, writeRollingCard } from './postgres-rolling-continuity-store.mjs';
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
export function tiddlePersistence({ stores } = {}) {
  if (stores?.metadata) {
    const metadata = stores.metadata;
    const pool = metadata.pool;
    if (!pool?.query) throw new Error('tiddle_metadata_pool_required');
    const rollingScope = key => { const rest = key.slice('rolling-continuity:'.length); const split = rest.indexOf(':'); return [rest.slice(0, split), rest.slice(split + 1)]; };
    const adapter = (client, transactional = false) => ({
      get: key => key.startsWith('rolling-continuity:') ? readRollingCards(client, ...rollingScope(key)).then(cards => ({ cards })) : transactional ? client.query('SELECT value_json FROM settings_meta WHERE key=$1', [key]).then(r => { try { return JSON.parse(r.rows[0]?.value_json || 'null'); } catch { return null; } }) : metadata.get(key),
      set: (key, value, at) => key.startsWith('rolling-continuity:') ? Promise.all(value.cards.map(card => writeRollingCard(client, card, at))) : client.query('INSERT INTO settings_meta(key,value_json,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at', [key, JSON.stringify(value), at]),
      rows: prefix => prefix.startsWith('rolling-continuity:') ? readRollingCards(client, prefix.slice('rolling-continuity:'.length, -1)).then(cards => [...new Set(cards.map(card => card.project))].map(project => ({ key: `rolling-continuity:${cards[0].agentId}:${project}`, value_json: JSON.stringify({ cards: cards.filter(card => card.project === project) }) }))) : client.query('SELECT key,value_json,updated_at FROM settings_meta WHERE starts_with(key,$1) ORDER BY updated_at DESC,key', [prefix]).then(r => r.rows),
      transaction: (agentId, operation) => withPostgresTransaction(pool, async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`tiddle:${agentId}`]);
        return runAsync(operation(adapter(tx, true)));
      }),
      rollingTtlDays: async () => { if (stores.workingMemoryRetention?.read) return (await stores.workingMemoryRetention.read()).rollingContinuityTtlDays; const r = await client.query("SELECT value_json FROM working_memory_retention_settings WHERE owner_id='default'"); return Number(r.rows[0]?.value_json?.rollingContinuityTtlDays || 90); },
      close() {},
    });
    return adapter(pool);
  }
  throw new Error('tiddle_postgres_store_required');
}
