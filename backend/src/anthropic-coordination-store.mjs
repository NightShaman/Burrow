import { withPostgresTransaction } from './postgres-foundation.mjs';

// Keys must not contain credentials. The service owns the JSON state shape.
function validateKey(key) {
  if (typeof key !== 'string' || !key) throw new TypeError('coordination key must be a non-empty string');
}
function encodeState(state) {
  const json = JSON.stringify(state);
  if (json === undefined) throw new TypeError('coordination state must be JSON serializable');
  return json;
}

export function createPostgresAnthropicCoordinationStore(pool) {
  if (!pool) throw new TypeError('PostgreSQL pool required');
  return {
    async run(key, callback) {
      validateKey(key);
      return withPostgresTransaction(pool, async client => {
        // READ COMMITTED snapshot before waiting: a completed attempt while we
        // wait satisfies this request, even when the clock has not advanced.
        const observed = await client.query('SELECT state_json FROM anthropic_coordination_state WHERE key = $1', [key]);
        const observedGeneration = observed.rows[0]?.state_json?.generation || 0;
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1, 0))", [JSON.stringify(['anthropic-coordination', key])]);
        const { rows } = await client.query('SELECT state_json FROM anthropic_coordination_state WHERE key = $1', [key]);
        const { state, result } = await callback(rows.length ? rows[0].state_json : {}, observedGeneration);
        await client.query('INSERT INTO anthropic_coordination_state(key, state_json) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET state_json = EXCLUDED.state_json', [key, encodeState(state)]);
        return result;
      });
    },
  };
}

export function createMemoryAnthropicCoordinationStore() {
  const states = new Map();
  const tails = new Map();
  return {
    async run(key, callback) {
      validateKey(key);
      const observedGeneration = states.has(key) ? JSON.parse(states.get(key)).generation || 0 : 0;
      const previous = tails.get(key) || Promise.resolve();
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      tails.set(key, gate);
      await previous;
      try {
        const { state, result } = await callback(states.has(key) ? JSON.parse(states.get(key)) : {}, observedGeneration);
        states.set(key, encodeState(state));
        return result;
      } finally {
        if (tails.get(key) === gate) tails.delete(key);
        release();
      }
    },
  };
}
