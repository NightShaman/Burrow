import { randomUUID } from 'node:crypto';
import { withPostgresTransaction } from './postgres-foundation.mjs';

export const POSTGRES_LIVE_RUN_STEERING_SQL = `
CREATE TABLE chat_steering_runs (
 agent_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL,
 accepting BOOLEAN NOT NULL DEFAULT TRUE, generation BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY(agent_id,session_id,run_id),
 FOREIGN KEY(agent_id,session_id) REFERENCES conversation_sessions(agent_id,session_id) ON DELETE CASCADE
);
CREATE TABLE chat_steering_inputs (
 agent_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL,
 ordinal BIGINT GENERATED ALWAYS AS IDENTITY,
 input_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload JSON NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','delivered','follow_up')),
 created_at TIMESTAMPTZ NOT NULL, delivered_at TIMESTAMPTZ,
 PRIMARY KEY(agent_id,session_id,run_id,input_id),
 UNIQUE(agent_id,session_id,run_id,idempotency_key),
 FOREIGN KEY(agent_id,session_id,run_id) REFERENCES chat_steering_runs(agent_id,session_id,run_id) ON DELETE CASCADE
);
`;
const identity = ({ agentId, sessionId, runId }) => {
  if (![agentId,sessionId,runId].every(x => typeof x === 'string' && x.length)) throw Object.assign(new Error('steering_identity_required'), { statusCode: 400 });
  return [agentId,sessionId,runId];
};
const view = row => ({ id: row.input_id, status: row.status, ...row.payload, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at, deliveredAt: row.delivered_at instanceof Date ? row.delivered_at.toISOString() : row.delivered_at });
async function event(client, ids, input, status, now) {
  const entry = { id: randomUUID(), sessionId: ids[1], runId: ids[2], timestamp: now, type: 'event', role: null, content: `User steering ${status}.`, entersPrompt: false, visibility: 'public', metadata: { steering: { ...input, status } } };
  await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at) VALUES($1,$2,$3,$4::json,$5)`, [ids[0],ids[1],entry.id,JSON.stringify(entry),now]);
}
export class PostgresLiveRunSteering {
  constructor({ pool, clock = () => new Date().toISOString() }) { this.pool = pool; this.clock = clock; }
  async open(args) {
    const ids = identity(args), now = this.clock();
    await withPostgresTransaction(this.pool, async client => {
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}',$3,$3) ON CONFLICT DO NOTHING`, [ids[0],ids[1],now]);
      await client.query('SELECT 1 FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', ids.slice(0,2));
      const opened = await client.query(`INSERT INTO chat_steering_runs(agent_id,session_id,run_id,generation) SELECT $1,$2,$3,COALESCE((metadata->>'resetGeneration')::bigint,0) FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 ON CONFLICT DO NOTHING RETURNING run_id`, ids);
      if (!opened.rows.length) throw Object.assign(new Error('chat_run_id_already_used'), { statusCode: 409 });
    });
  }
  async lock(client, ids) {
    // Same session lock as transcript append: commit ordering and reset safety.
    const session = await client.query("SELECT COALESCE((metadata->>'resetGeneration')::bigint,0) AS generation FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE", ids.slice(0,2));
    const { rows } = await client.query('SELECT accepting,generation FROM chat_steering_runs WHERE agent_id=$1 AND session_id=$2 AND run_id=$3 FOR UPDATE', ids);
    if (!rows.length) throw Object.assign(new Error('chat_run_not_found'), { statusCode: 404 });
    return { ...rows[0], reset: String(rows[0].generation) !== String(session.rows[0]?.generation) };
  }
  async submit(args) {
    const ids = identity(args), { idempotencyKey, message, attachments = [] } = args;
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw Object.assign(new Error('idempotency_key_required'), { statusCode: 400 });
    const payload = { message, attachments };
    return withPostgresTransaction(this.pool, async client => {
      const run = await this.lock(client, ids);
      if (run.reset) throw Object.assign(new Error('chat_run_session_reset'), { statusCode: 409 });
      const prior = await client.query('SELECT * FROM chat_steering_inputs WHERE agent_id=$1 AND session_id=$2 AND run_id=$3 AND idempotency_key=$4', [...ids,idempotencyKey]);
      if (prior.rows.length) {
        if (JSON.stringify(prior.rows[0].payload) !== JSON.stringify(payload)) throw Object.assign(new Error('steering_idempotency_conflict'), { statusCode: 409 });
        return view(prior.rows[0]);
      }
      const now = this.clock(), id = randomUUID(), status = run.accepting ? 'pending' : 'follow_up';
      const { rows } = await client.query(`INSERT INTO chat_steering_inputs(agent_id,session_id,run_id,input_id,idempotency_key,payload,status,created_at) VALUES($1,$2,$3,$4,$5,$6::json,$7,$8) RETURNING *`, [...ids,id,idempotencyKey,JSON.stringify(payload),status,now]);
      const input = view(rows[0]);
      // Durable user transcript is append-only. Pending/follow-up is not ambient
      // next-turn input; only delivered provider turns enter future prompt replay.
      const entry = { id, sessionId: ids[1], runId: ids[2], timestamp: now, type: 'event', role: 'user', content: message, entersPrompt: false, visibility: 'chat', metadata: { steering: input } };
      await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at) VALUES($1,$2,$3,$4::json,$5)`, [ids[0],ids[1],id,JSON.stringify(entry),now]);
      await event(client, ids, input, status, now);
      return input;
    });
  }
  async list(args) {
    const ids = identity(args);
    const run = await this.pool.query('SELECT 1 FROM chat_steering_runs WHERE agent_id=$1 AND session_id=$2 AND run_id=$3', ids);
    if (!run.rows.length) throw Object.assign(new Error('chat_run_not_found'), { statusCode: 404 });
    const { rows } = await this.pool.query('SELECT * FROM chat_steering_inputs WHERE agent_id=$1 AND session_id=$2 AND run_id=$3 ORDER BY ordinal', ids);
    return rows.map(view);
  }
  async boundary(args, { terminal = false, finish = false, project = null, precedingAssistant = null } = {}) {
    const ids = identity(args);
    return withPostgresTransaction(this.pool, async client => {
      const run = await this.lock(client, ids);
      finish ||= run.reset;
      const { rows } = await client.query(`SELECT * FROM chat_steering_inputs WHERE agent_id=$1 AND session_id=$2 AND run_id=$3 AND status='pending' ORDER BY ordinal`, ids);
      const now = this.clock(), status = finish ? 'follow_up' : 'delivered';
      if (!finish && rows.length && precedingAssistant) {
        const entry = { id: randomUUID(), sessionId: ids[1], runId: ids[2], timestamp: now, type: 'message', role: 'assistant', content: precedingAssistant, visibility: 'chat', entersPrompt: true, metadata: { steeringContinuation: true } };
        await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at) VALUES($1,$2,$3,$4::json,$5)`, [ids[0],ids[1],entry.id,JSON.stringify(entry),now]);
      }
      for (const row of rows) {
        await client.query(`UPDATE chat_steering_inputs SET status=$5,delivered_at=$6 WHERE agent_id=$1 AND session_id=$2 AND run_id=$3 AND input_id=$4`, [...ids,row.input_id,status,finish ? null : now]);
        const providerMessages = !finish ? (project ? project(view(row)) : [{ role: 'user', content: row.payload.message }]) : null;
        row.providerMessages = providerMessages;
        if (!finish) {
          const delivered = { id: randomUUID(), sessionId: ids[1], type: 'message', role: 'user', content: row.payload.message,
            timestamp: now, runId: ids[2], visibility: 'debug', entersPrompt: true, metadata: { steering: { id: row.input_id, runId: ids[2], status }, providerTurn: { version: 1, messages: providerMessages } } };
          await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at) VALUES($1,$2,$3,$4::json,$5)`, [ids[0],ids[1],delivered.id,JSON.stringify(delivered),now]);
        }
        if (!run.reset) await event(client, ids, view(row), status, now);
      }
      if (finish || (terminal && !rows.length)) await client.query('UPDATE chat_steering_runs SET accepting=FALSE WHERE agent_id=$1 AND session_id=$2 AND run_id=$3', ids);
      return finish ? [] : rows.map(row => ({ ...view({ ...row, status, delivered_at: now }), providerMessages: row.providerMessages }));
    });
  }
}
