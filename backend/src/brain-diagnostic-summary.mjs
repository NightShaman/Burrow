// Diagnostics-token boundary: select only metadata, never saved text, source refs,
// vectors, legacy snapshots, connection identifiers or provider error payloads.
const failureCodes = new Set([
  'brain_embedding_provider_http_failed', 'brain_embedding_provider_request_failed',
  'brain_embedding_invalid_vector', 'brain_embedding_input_invalid',
  'brain_embedding_connection_missing', 'brain_embedding_provider_unsupported',
  'brain_embedding_api_key_required', 'brain_embedding_invalid_response',
]);
const invalid = () => { throw Object.assign(new Error('invalid_diagnostics_query'), { statusCode: 400 }); };
function agent(value, required = false) {
  if (value === undefined && !required) return null;
  if (typeof value !== 'string' || !value.trim()) invalid();
  return value;
}
function pageOptions({ agentId, limit = 50, cursor }, type, required) {
  const scope = agent(agentId, required);
  if (!Number.isSafeInteger(limit) || limit < 1) invalid();
  let afterAgent = '', afterId = '';
  if (cursor !== undefined && cursor !== null) {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid();
    try {
      const decoded = Buffer.from(cursor, 'base64url');
      if (decoded.toString('base64url') !== cursor) invalid();
      const key = JSON.parse(decoded.toString('utf8'));
      if (key.v !== 1 || key.type !== type || key.agentId !== scope ||
          typeof key.afterAgent !== 'string' || !key.afterAgent ||
          typeof key.id !== 'string' || !key.id ||
          (scope !== null && key.afterAgent !== scope)) invalid();
      afterAgent = key.afterAgent; afterId = key.id;
    } catch { invalid(); }
  }
  return { scope, limit, afterAgent, afterId };
}
function nextCursor(rows, limit, type, scope) {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1];
  return Buffer.from(JSON.stringify({ v: 1, type, agentId: scope, afterAgent: last.agent_id, id: last.id })).toString('base64url');
}
const count = value => String(value ?? '0');
export async function brainDiagnosticSummary(pool, { agentId } = {}) {
  const scope = agent(agentId);
  // One SELECT statement supplies a consistent read snapshot; unlike embeddings.status(),
  // this never reconciles settings or resets vectors/jobs.
  const row = (await pool.query(`SELECT
    (SELECT count(*)::text FROM brain_memories WHERE ($1::text IS NULL OR agent_id=$1) AND deleted_at IS NULL) AS active,
    (SELECT count(*)::text FROM brain_memories WHERE ($1::text IS NULL OR agent_id=$1) AND deleted_at IS NOT NULL) AS deleted,
    (SELECT count(*)::text FROM brain_memories WHERE ($1::text IS NULL OR agent_id=$1) AND operator_owned) AS operator_owned,
    (SELECT count(*)::text FROM brain_memories WHERE ($1::text IS NULL OR agent_id=$1) AND origin='migrated_albdruck') AS migrated,
    (SELECT enabled FROM brain_embedding_settings WHERE singleton) AS enabled,
    (SELECT connection_id IS NOT NULL AND model IS NOT NULL FROM brain_embedding_settings WHERE singleton) AS configured,
    (SELECT generation::text FROM brain_embedding_settings WHERE singleton) AS generation,
    (SELECT count(*)::text FROM brain_embedding_vectors v JOIN brain_memories m USING(agent_id,id)
       WHERE ($1::text IS NULL OR v.agent_id=$1) AND m.deleted_at IS NULL AND v.revision=m.revision
       AND v.generation=(SELECT generation FROM brain_embedding_settings WHERE singleton)) AS indexed,
    (SELECT count(*)::text FROM brain_embedding_jobs WHERE ($1::text IS NULL OR agent_id=$1)) AS pending,
    (SELECT count(*)::text FROM brain_embedding_jobs WHERE ($1::text IS NULL OR agent_id=$1) AND error IS NOT NULL) AS failed`, [scope])).rows[0];
  return { ok: true, scope: { kind: scope === null ? 'global' : 'agent', agentId: scope },
    memories: { active: count(row.active), deleted: count(row.deleted), operatorOwned: count(row.operator_owned), migrated: count(row.migrated) },
    embedding: { enabled: row.enabled === true, configured: row.configured === true, generation: count(row.generation),
      indexed: count(row.indexed), pending: count(row.pending), failed: count(row.failed) } };
}
export async function brainDiagnosticMemories(pool, options = {}) {
  const { scope, limit, afterAgent, afterId } = pageOptions(options, 'memories', true);
  const rows = (await pool.query(`SELECT agent_id,id,revision,operator_owned,origin,legacy_status,created_at,updated_at,deleted_at,
    json_array_length(source_refs) AS source_ref_count FROM brain_memories
    WHERE agent_id=$1 AND (agent_id COLLATE "C", id COLLATE "C") > ($2::text COLLATE "C", $3::text COLLATE "C")
    ORDER BY agent_id COLLATE "C", id COLLATE "C" LIMIT $4::bigint + 1`, [scope, afterAgent, afterId, limit])).rows;
  return { ok: true, scope: { kind: 'agent', agentId: scope }, items: rows.slice(0, limit).map(r => ({
    id: r.id, agentId: r.agent_id, revision: r.revision, operatorOwned: r.operator_owned,
    origin: r.origin, legacyStatus: r.legacy_status, createdAt: r.created_at, updatedAt: r.updated_at,
    deletedAt: r.deleted_at, sourceRefCount: r.source_ref_count,
  })), nextCursor: nextCursor(rows, limit, 'memories', scope) };
}
export async function brainDiagnosticEmbeddingJobs(pool, options = {}) {
  const { scope, limit, afterAgent, afterId } = pageOptions(options, 'embedding-jobs', false);
  const rows = (await pool.query(`SELECT agent_id,id,revision,attempts,next_attempt_at::text AS next_attempt_at,error FROM brain_embedding_jobs
    WHERE ($1::text IS NULL OR agent_id=$1) AND (agent_id COLLATE "C", id COLLATE "C") > ($2::text COLLATE "C", $3::text COLLATE "C")
    ORDER BY agent_id COLLATE "C", id COLLATE "C" LIMIT $4::bigint + 1`, [scope, afterAgent, afterId, limit])).rows;
  return { ok: true, scope: { kind: scope === null ? 'global' : 'agent', agentId: scope }, items: rows.slice(0, limit).map(r => ({
    id: r.id, agentId: r.agent_id, revision: r.revision, attempts: r.attempts,
    nextAttemptAt: ['infinity', '-infinity'].includes(r.next_attempt_at) ? r.next_attempt_at : new Date(r.next_attempt_at).toISOString(), errorCode: failureCodes.has(r.error) ? r.error : null,
  })), nextCursor: nextCursor(rows, limit, 'embedding-jobs', scope) };
}
