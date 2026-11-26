import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizePostgresPool } from './postgres-foundation.mjs';

const jsonValue = value => typeof value === 'string' ? JSON.parse(value) : value;
const iso = value => value instanceof Date ? value.toISOString() : String(value);
function project(row) {
  if (!row) return null;
  return { id: row.id, ownerModId: row.owner_mod_id, agentId: row.agent_id,
    sessionId: row.session_id, conversationId: row.conversation_id,
    resetIdentity: row.reset_identity, originRunId: row.origin_run_id, key: row.key,
    result: jsonValue(row.result), state: row.state, createdAt: iso(row.created_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null, deliveryRunId: row.delivery_run_id, error: row.error };
}

export class PostgresModFollowThroughStore {
  constructor({ pool, maxResultBytes = 64_000 } = {}) {
    if (!pool?.query) throw new Error('mod_follow_through_pool_required');
    this.pool = normalizePostgresPool(pool);
    this.maxResultBytes = maxResultBytes;
    this.listeners = new Set();
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publish() { for (const listener of this.listeners) { try { listener(); } catch { /* advisory */ } } }
  async register({ ownerModId, agentId, sessionId, conversationId, resetIdentity, originRunId, key }) {
    const id = randomUUID();
    const { rows } = await this.pool.query(`INSERT INTO mod_follow_through_returns
      (id,owner_mod_id,agent_id,session_id,conversation_id,reset_identity,origin_run_id,key,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'waiting')
      ON CONFLICT(owner_mod_id,agent_id,session_id,origin_run_id,key) DO NOTHING RETURNING *`,
    [id, ownerModId, agentId, sessionId, conversationId, resetIdentity, originRunId, key]);
    if (rows[0]) return { id: rows[0].id };
    const found = await this.pool.query(`SELECT id,conversation_id,reset_identity FROM mod_follow_through_returns
      WHERE owner_mod_id=$1 AND agent_id=$2 AND session_id=$3 AND origin_run_id=$4 AND key=$5`,
    [ownerModId, agentId, sessionId, originRunId, key]);
    if (!found.rows[0] || found.rows[0].conversation_id !== conversationId || found.rows[0].reset_identity !== resetIdentity) throw new Error('mod_follow_through_registration_conflict');
    return { id: found.rows[0].id };
  }
  async complete({ ownerModId, id, result }) {
    let encoded;
    try { encoded = JSON.stringify(result); } catch { throw new Error('mod_follow_through_result_invalid'); }
    if (encoded === undefined || Buffer.byteLength(encoded) > this.maxResultBytes) throw new Error('mod_follow_through_result_invalid');
    const { rows } = await this.pool.query(`UPDATE mod_follow_through_returns SET result=$3::json,state='ready',completed_at=now()
      WHERE owner_mod_id=$1 AND id=$2 AND state='waiting' RETURNING id`, [ownerModId, id, encoded]);
    if (rows.length) { this.publish(); return { completed: true, replayed: false }; }
    const prior = await this.pool.query('SELECT state,result FROM mod_follow_through_returns WHERE owner_mod_id=$1 AND id=$2', [ownerModId, id]);
    if (!prior.rows[0]) throw new Error('mod_follow_through_not_found');
    if (prior.rows[0].state === 'waiting' || !isDeepStrictEqual(jsonValue(prior.rows[0].result), JSON.parse(encoded))) throw new Error('mod_follow_through_already_completed');
    if (prior.rows[0].state === 'ready') this.publish();
    return { completed: true, replayed: true };
  }
  async getOwned(ownerModId, id) {
    const { rows } = await this.pool.query('SELECT * FROM mod_follow_through_returns WHERE owner_mod_id=$1 AND id=$2', [ownerModId, id]);
    return project(rows[0]);
  }
  async reconcile() {
    // Terminal agent-run evidence is persisted by the normal chat path. No
    // receipt is not evidence the provider didn't run: fence instead of replay.
    await this.pool.query(`UPDATE mod_follow_through_returns r
      SET state=CASE WHEN EXISTS(SELECT 1 FROM agent_run_completions c WHERE c.agent_id=r.agent_id
        AND c.run_id=r.delivery_run_id AND c.outcome='completed') THEN 'delivered' ELSE 'fenced' END,
        error=CASE WHEN EXISTS(SELECT 1 FROM agent_run_completions c WHERE c.agent_id=r.agent_id
        AND c.run_id=r.delivery_run_id AND c.outcome='completed') THEN NULL ELSE 'mod_follow_through_interrupted' END
        WHERE state='delivering'`);
  }
  async claim() {
    const { rows } = await this.pool.query(`UPDATE mod_follow_through_returns SET state='delivering',delivery_run_id='mod-return-' || id::text
      WHERE id=(SELECT id FROM mod_follow_through_returns WHERE state='ready'
        ORDER BY completed_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) AND state='ready' RETURNING *`);
    return project(rows[0]);
  }
  async finish(id, { delivered, error = null }) {
    const result = await this.pool.query(`UPDATE mod_follow_through_returns SET state=$2,error=$3
      WHERE id=$1 AND state='delivering'`, [id, delivered ? 'delivered' : 'fenced', error]);
    if (!result.rowCount) throw new Error('mod_follow_through_delivery_fenced');
  }
}
