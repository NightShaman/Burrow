// Separate evidence surface: never JSON.parse payload text or deduplicate occurrences.
// Caller must supply the already-authorized agent/session scope and store pool.
export async function exportSessionRawEvidence({ pool, agentId, sessionId } = {}) {
  if (!pool?.query || !String(agentId || '').trim() || !String(sessionId || '').trim()) throw new Error('raw_evidence_scope_required');
  const { rows } = await pool.query(`
    SELECT * FROM (SELECT 'active' AS source_kind, '' AS source_id, sequence::text AS ordinal, entry::text AS raw_json
      FROM conversation_entries WHERE agent_id=$1 AND session_id=$2
    UNION ALL
    SELECT 'archive', source_id, ordinal::text, entry::text
      FROM conversation_archive_entries WHERE agent_id=$1 AND session_id=$2
    -- Keep the public ordinal textual (large ordinals are not JS numbers), but
    -- order by its database integer value so 10 follows 9 rather than 1.
     ) evidence ORDER BY source_kind, source_id, ordinal::bigint`, [agentId, sessionId]);
  return { format: 'burrow-session-raw-evidence/v1', agentId, sessionId,
    contract: 'Stored JSON payload text; all occurrences including reset archives; not a normalized active transcript or original transport bytes.',
    occurrences: rows.map(({ source_kind, source_id, ordinal, raw_json }) => ({ sourceKind: source_kind, sourceId: source_id, ordinal, rawJson: raw_json })) };
}
