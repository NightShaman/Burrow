// Durable metadata-only completion feed. Explicit operator retention (not age-based)
// is required before pruning: consumers own their independent checkpoints.
export const POSTGRES_AGENT_RUN_FEED_SQL = `
CREATE TABLE agent_run_completions (
  cursor BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source TEXT NOT NULL,
  peer_agent_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('operator','background','agent','mod')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  duration_ms BIGINT NOT NULL CHECK (duration_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('completed','failed','cancelled')),
  UNIQUE (agent_id,run_id)
);
`;
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const cursor = (value) => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
const project = row => ({ cursor: String(row.cursor), agentId: row.agent_id, sessionId: row.session_id, runId: row.run_id,
  source: row.source, origin: row.origin, peerAgentId: row.peer_agent_id || null, startedAt: new Date(row.started_at).toISOString(),
  completedAt: new Date(row.completed_at).toISOString(), durationMs: Number(row.duration_ms), outcome: row.outcome });
export class PostgresAgentRunFeed {
  constructor({ pool } = {}) { if (!pool?.query || !pool?.connect) throw new Error('agent_run_feed_postgres_required'); this.pool = pool; this.listeners = new Set(); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  validate(input) {
    if (!id(input?.agentId) || !id(input?.sessionId) || !id(input?.runId) || !id(input?.source) || (input.peerAgentId != null && !id(input.peerAgentId)) ||
      !['operator','background','agent','mod'].includes(input.origin) || !['completed','failed','cancelled'].includes(input.outcome) ||
      !Number.isSafeInteger(input.durationMs) || input.durationMs < 0 || !Number.isFinite(Date.parse(input.startedAt)) || !Number.isFinite(Date.parse(input.completedAt))) throw new Error('agent_run_feed_input_invalid');
  }
  async insert(client, input) {
      const result = await client.query(`INSERT INTO agent_run_completions
        (agent_id,session_id,run_id,source,origin,peer_agent_id,started_at,completed_at,duration_ms,outcome)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (agent_id,run_id) DO NOTHING RETURNING *`,
      [input.agentId,input.sessionId,input.runId,input.source,input.origin,input.peerAgentId || null,input.startedAt,input.completedAt,input.durationMs,input.outcome]);
      const added = result.rowCount > 0;
      const row = result.rows[0] || (await client.query('SELECT * FROM agent_run_completions WHERE agent_id=$1 AND run_id=$2', [input.agentId,input.runId])).rows[0];
      return { event: project(row), added };
  }
  async recordInTransaction(client, input) {
    this.validate(input);
    // Called inside the continuity state transaction. This lock serializes
    // cursor allocation across sessions and standalone feed writers.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('agent_run_completions_cursor',0))");
    return this.insert(client,input);
  }
  publish(event) {
    if (!event) return;
    setImmediate(() => { for (const listener of this.listeners) { try { listener(event); } catch { /* advisory */ } } });
  }
  async record(input, { notify = true } = {}) {
    this.validate(input);
    const client = await this.pool.connect();
    let receipt;
    try {
      await client.query('BEGIN');
      receipt = await this.recordInTransaction(client, input);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    if (receipt.added && notify) this.publish(receipt.event);
    return receipt;
  }
  async list({ cursor: after = null, limit = 50 } = {}) {
    if ((after !== null && !cursor(after)) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('agent_run_feed_input_invalid');
    const { rows } = await this.pool.query('SELECT * FROM agent_run_completions WHERE cursor > $1::bigint ORDER BY cursor LIMIT $2', [after || '0',limit + 1]);
    const events = rows.slice(0,limit).map(project);
    return { events, nextCursor: events.at(-1)?.cursor || after, hasMore: rows.length > limit };
  }
}
