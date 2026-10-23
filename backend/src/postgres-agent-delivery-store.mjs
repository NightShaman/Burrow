import { createContinuityOwner, continuityOwner } from './postgres-continuity-owner.mjs';
import { withPostgresTransaction } from './postgres-foundation.mjs';

export const POSTGRES_AGENT_DELIVERY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_message_deliveries (
  delivery_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('executing','completed')),
  request JSONB NOT NULL,
  result JSONB,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ
);
`;

// Additive migration: never alter the published v43 schema/checksum.
export const POSTGRES_AGENT_DELIVERY_OWNER_SQL = `
ALTER TABLE agent_message_deliveries ADD COLUMN owner_id TEXT;
ALTER TABLE agent_message_deliveries ADD COLUMN ownership_protocol TEXT;
`;

const PROTOCOL = 'postgres-session-lock-v1';
export function interruptedAgentDelivery(deliveryId, request, error = 'agent_message_delivery_interrupted') {
  return {
    tool: 'agent_send_message', ok: false, deliveryId,
    messageMode: request.messageMode, senderAgentId: request.sender, recipientAgentId: request.recipient,
    sourceSessionId: request.sourceSessionId, targetSessionId: request.targetSessionId,
    autoExecuted: false,
    reply: { ok: false, decision: null, error, content: null, executionOutcome: 'unknown', retryable: false },
  };
}

// A claim owns its own PostgreSQL connection lock, not a timeout or host PID.
// Releasing the operation also releases ownership if terminal persistence fails.
export class PostgresAgentDeliveryStore {
  constructor(pool) { this.pool = pool; this.active = new Map(); }
  async claim({ deliveryId, request }) {
    const owner = createContinuityOwner(this.pool);
    let retained = false;
    try {
      await owner.ready();
      const inserted = await this.pool.query(`INSERT INTO agent_message_deliveries(delivery_id,status,request,owner_id,ownership_protocol)
        VALUES($1,'executing',$2::jsonb,$3,$4) ON CONFLICT DO NOTHING RETURNING delivery_id`,
      [deliveryId, JSON.stringify(request), owner.id, PROTOCOL]);
      if (inserted.rowCount === 1) {
        this.active.set(owner.id, { deliveryId, owner }); retained = true;
        return { execute: true, status: 'executing', result: null, ownerId: owner.id };
      }
      return { execute: false, ...await this.read(deliveryId, request) };
    } finally { if (!retained) await owner.close(); }
  }
  async read(deliveryId, request = null) {
    return withPostgresTransaction(this.pool, async client => {
      const { rows } = await client.query('SELECT status,request,result,owner_id,ownership_protocol FROM agent_message_deliveries WHERE delivery_id=$1 FOR UPDATE', [deliveryId]);
      const row = rows[0];
      if (!row) return null;
      const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort()));
      if (request && canonical(request) !== canonical(row.request)) throw new Error('agent_message_delivery_identity_conflict');
      if (row.status === 'completed') return { status: row.status, result: row.result };
      // An older writer may still be running. Return explicit uncertainty without
      // mutating its claim, adopting it, or waiting indefinitely for unknown ownership.
      if (!row.owner_id || row.ownership_protocol !== PROTOCOL) return {
        status: 'unowned', result: interruptedAgentDelivery(deliveryId, row.request, 'agent_message_delivery_ownership_unknown'),
      };
      if (await continuityOwner(this.pool).alive(row.owner_id)) return { status: 'executing', result: null };
      const result = interruptedAgentDelivery(deliveryId, row.request);
      await client.query(`UPDATE agent_message_deliveries SET status='completed',result=$2::jsonb,completed_at=CURRENT_TIMESTAMP
        WHERE delivery_id=$1 AND status='executing'`, [deliveryId, JSON.stringify(result)]);
      return { status: 'completed', result };
    });
  }
  async assertOwner({ deliveryId, ownerId }) {
    const active = this.active.get(ownerId);
    if (!active || active.deliveryId !== deliveryId) throw new Error('agent_message_delivery_owner_fenced');
    await active.owner.ready();
    const { rows } = await this.pool.query('SELECT status,owner_id FROM agent_message_deliveries WHERE delivery_id=$1', [deliveryId]);
    if (rows[0]?.status !== 'executing' || rows[0]?.owner_id !== ownerId) throw new Error('agent_message_delivery_owner_fenced');
  }
  async execute(args, work) {
    const active = this.active.get(args.ownerId);
    if (!active || active.deliveryId !== args.deliveryId) throw new Error('agent_message_delivery_owner_fenced');
    try {
      // Keep liveness during in-flight work even if the primary owner backend dies.
      return await active.owner.guard(work);
    } finally {
      this.active.delete(args.ownerId);
      await active.owner.close();
    }
  }
  async complete({ deliveryId, ownerId, result }) {
    return withPostgresTransaction(this.pool, async client => {
      const { rows } = await client.query('SELECT status,result,owner_id,ownership_protocol FROM agent_message_deliveries WHERE delivery_id=$1 FOR UPDATE', [deliveryId]);
      const row = rows[0];
      if (!row) throw new Error('agent_message_delivery_claim_missing');
      if (row.status === 'completed') return row.result;
      if (row.owner_id !== ownerId || row.ownership_protocol !== PROTOCOL) throw new Error('agent_message_delivery_owner_fenced');
      const active = this.active.get(ownerId);
      if (!active || active.deliveryId !== deliveryId) throw new Error('agent_message_delivery_owner_fenced');
      await active.owner.ready();
      const updated = await client.query(`UPDATE agent_message_deliveries SET status='completed',result=$2::jsonb,completed_at=CURRENT_TIMESTAMP
        WHERE delivery_id=$1 AND status='executing' AND owner_id=$3 RETURNING result`, [deliveryId, JSON.stringify(result), ownerId]);
      return updated.rows[0].result;
    });
  }
  async close() {
    await Promise.all([...this.active.values()].map(({ owner }) => owner.close()));
    this.active.clear();
  }
}
