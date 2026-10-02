import { isTiddleIdentity, readTiddle, writeTiddle, appendTiddle, tiddleRows } from './postgres-tiddle-store.mjs';
import { readRollingCards, writeRollingCard, pruneRollingCards } from './postgres-rolling-continuity-store.mjs';
import { withPostgresTransaction } from './postgres-foundation.mjs';

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
      get: key => isTiddleIdentity(key) ? readTiddle(client,key) : typeof key === 'string' && key.startsWith('rolling-continuity:') ? readRollingCards(client, ...rollingScope(key)).then(cards => ({ cards })) : transactional ? client.query('SELECT value_json::text AS value_json FROM settings_meta WHERE key=$1', [key]).then(r => { try { return JSON.parse(r.rows[0]?.value_json || 'null'); } catch { return null; } }) : metadata.get(key),
      set: (key, value, at) => isTiddleIdentity(key) ? writeTiddle(client,key,value,at) : typeof key === 'string' && key.startsWith('rolling-continuity:') ? Promise.all(value.cards.map(card => writeRollingCard(client, card, at))) : client.query('INSERT INTO settings_meta(key,value_json,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at', [key, JSON.stringify(value), at]),
      rows: prefix => isTiddleIdentity(prefix) ? tiddleRows(client,prefix) : typeof prefix === 'string' && prefix.startsWith('rolling-continuity:') ? readRollingCards(client, prefix.slice('rolling-continuity:'.length, -1)).then(cards => [...new Set(cards.map(card => card.project))].map(project => ({ key: `rolling-continuity:${cards[0].agentId}:${project}`, value_json: JSON.stringify({ cards: cards.filter(card => card.project === project) }) }))) : client.query('SELECT key,value_json::text AS value_json,updated_at FROM settings_meta WHERE starts_with(key,$1) ORDER BY updated_at DESC,key', [prefix]).then(r => r.rows),
      append: (key,item,envelope,at,cutoff) => appendTiddle(client,key,item,envelope,at,cutoff),
      dueIds: at => client.query("SELECT a.id FROM tiddle_envelopes t JOIN agents a ON t.agent_id=a.id AND t.kind='tiddle-pass' AND t.project='' AND t.scope='' WHERE t.kind='tiddle-pass' AND t.next_run_at <= $1 AND a.enabled=TRUE UNION ALL SELECT a.id FROM agents a WHERE a.enabled=TRUE AND NOT EXISTS (SELECT 1 FROM tiddle_envelopes t WHERE t.agent_id=a.id AND t.kind='tiddle-pass' AND t.project='' AND t.scope='' AND t.next_run_at IS NOT NULL)",[at]).then(r=>r.rows.map(r=>r.id)),
      transaction: (agentId, operation) => withPostgresTransaction(pool, async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`tiddle:${agentId}`]);
        const ttl = await adapter(tx, true).rollingTtlDays();
        await pruneRollingCards(tx, agentId, new Date().toISOString(), ttl);
        return runAsync(operation(adapter(tx, true)));
      }),
      rollingTtlDays: async () => { if (stores.workingMemoryRetention?.read) return (await stores.workingMemoryRetention.read()).rollingContinuityTtlDays; const r = await client.query("SELECT value_json FROM working_memory_retention_settings WHERE owner_id='default'"); return Number(r.rows[0]?.value_json?.rollingContinuityTtlDays || 90); },
      close() {},
    });
    return adapter(pool);
  }
  throw new Error('tiddle_postgres_store_required');
}
