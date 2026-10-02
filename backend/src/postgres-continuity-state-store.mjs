import { withPostgresTransaction } from './postgres-foundation.mjs';

// Payloads use JSON, not JSONB: objectives, evidence and tool results may contain
// escaped NULs or lone surrogates. Indexed identity/state is kept separately.
export const POSTGRES_CONTINUITY_STATE_SCHEMA_SQL = `
CREATE TABLE continuity_state (
 agent_id text NOT NULL, session_id text NOT NULL,
 head json, manifest json, queue json,
 head_state text, owner_id text, queue_status text, auto_resume boolean,
 queued_at text, updated_at text NOT NULL,
 PRIMARY KEY(agent_id,session_id),
 FOREIGN KEY(agent_id,session_id) REFERENCES conversation_sessions(agent_id,session_id) ON DELETE CASCADE
);
CREATE INDEX continuity_pending_idx ON continuity_state(agent_id,queued_at,session_id)
 WHERE queue_status='pending' AND auto_resume;
CREATE INDEX continuity_active_idx ON continuity_state(agent_id,head_state,queue_status);
CREATE TABLE continuity_log (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 agent_id text NOT NULL, session_id text NOT NULL,
 head json, manifest json, queue json, created_at text NOT NULL,
 FOREIGN KEY(agent_id,session_id) REFERENCES conversation_sessions(agent_id,session_id) ON DELETE CASCADE
);
CREATE INDEX continuity_log_session_idx ON continuity_log(agent_id,session_id,sequence);
INSERT INTO continuity_state
SELECT agent_id,session_id,(metadata->'continuityHead')::json,(metadata->'interruptedRun')::json,(metadata->'recoveryQueue')::json,
 metadata->'continuityHead'->>'state',metadata->'continuityHead'->>'ownerId',metadata->'recoveryQueue'->>'status',
 CASE WHEN metadata->'recoveryQueue'->>'autoResume'='true' THEN true ELSE false END,
 metadata->'recoveryQueue'->>'queuedAt',updated_at
FROM conversation_sessions WHERE metadata ?| ARRAY['continuityHead','interruptedRun','recoveryQueue'];
INSERT INTO continuity_log(agent_id,session_id,head,manifest,queue,created_at)
 SELECT agent_id,session_id,head,manifest,queue,updated_at FROM continuity_state;
UPDATE conversation_sessions SET metadata=metadata-ARRAY['continuityHead','interruptedRun','recoveryQueue']
 WHERE metadata ?| ARRAY['continuityHead','interruptedRun','recoveryQueue'];
`;

const payload = value => value === undefined ? null : JSON.stringify(value);
const stateMetadata = row => ({
 ...(row?.head != null ? { continuityHead: row.head } : {}),
 ...(row?.manifest != null ? { interruptedRun: row.manifest } : {}),
 ...(row?.queue != null ? { recoveryQueue: row.queue } : {}),
});
export function continuityStateStore(store, agentId, clock) {
 return {
  async read(sessionId) {
   const { rows } = await store.pool.query('SELECT head,manifest,queue FROM continuity_state WHERE agent_id=$1 AND session_id=$2',[agentId,sessionId]);
   return stateMetadata(rows[0]);
  },
  async sessions({ pending = false, limit = 100 } = {}) {
   const { rows } = await store.pool.query(`SELECT session_id,head,manifest,queue FROM continuity_state WHERE agent_id=$1
    ${pending ? "AND queue_status='pending' AND auto_resume AND manifest IS NOT NULL" : "AND (head_state IN ('running','finalizing') OR queue_status='running')"}
    ORDER BY queued_at NULLS LAST,session_id ${pending ? 'LIMIT $2' : ''}`,pending ? [agentId,limit] : [agentId]);
   return rows.map(row => ({sessionId:row.session_id,...stateMetadata(row)}));
  },
  async update({ sessionId, update }) {
   return withPostgresTransaction(store.pool,async client => {
    const at=clock();
    // Same lock as session metadata writers: retention stamps and continuity
    // transitions serialize without maintaining a second metadata authority.
    await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT DO NOTHING`,[agentId,sessionId,at]);
    const session=await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE',[agentId,sessionId]);
    const { rows }=await client.query('SELECT head,manifest,queue FROM continuity_state WHERE agent_id=$1 AND session_id=$2',[agentId,sessionId]);
    const before={...session.rows[0].metadata,...stateMetadata(rows[0])};
    const next=await update(before);
    const head=next.continuityHead,manifest=next.interruptedRun,queue=next.recoveryQueue;
    if (payload(head)!==payload(before.continuityHead) || payload(manifest)!==payload(before.interruptedRun) || payload(queue)!==payload(before.recoveryQueue)) {
     await client.query(`INSERT INTO continuity_state(agent_id,session_id,head,manifest,queue,head_state,owner_id,queue_status,auto_resume,queued_at,updated_at)
      VALUES($1,$2,$3::json,$4::json,$5::json,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(agent_id,session_id) DO UPDATE SET head=EXCLUDED.head,manifest=EXCLUDED.manifest,queue=EXCLUDED.queue,head_state=EXCLUDED.head_state,owner_id=EXCLUDED.owner_id,queue_status=EXCLUDED.queue_status,auto_resume=EXCLUDED.auto_resume,queued_at=EXCLUDED.queued_at,updated_at=EXCLUDED.updated_at`,
     [agentId,sessionId,payload(head),payload(manifest),payload(queue),head?.state||null,head?.ownerId||null,queue?.status||null,queue?.autoResume===true,queue?.queuedAt||null,at]);
     await client.query('INSERT INTO continuity_log(agent_id,session_id,head,manifest,queue,created_at) VALUES($1,$2,$3::json,$4::json,$5::json,$6)',[agentId,sessionId,payload(head),payload(manifest),payload(queue),at]);
    }
    const {continuityHead,interruptedRun,recoveryQueue,...metadata}=next;
    await client.query('UPDATE conversation_sessions SET metadata=$3::jsonb,updated_at=$4 WHERE agent_id=$1 AND session_id=$2 AND metadata IS DISTINCT FROM $3::jsonb',[agentId,sessionId,JSON.stringify(metadata),at]);
    return next;
   });
  },
 };
}
