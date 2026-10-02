// Legacy key decoding is confined to this one-time import migration.
export const POSTGRES_NATIVE_DREAM_TIDDLE_IDENTITY_SQL = `
CREATE FUNCTION burrow_source_sessions(value json) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
 WITH RECURSIVE nodes(v) AS (
 SELECT regexp_replace(replace(value::text, E'\\\\u0000', E'\\\\ufffd'), E'\\\\\\\\u[dD][89aAbBcCdDeEfF][0-9a-fA-F]{2}', E'\\\\ufffd', 'g')::json UNION ALL
 SELECT child FROM nodes CROSS JOIN LATERAL (
 SELECT value AS child FROM json_each(CASE WHEN json_typeof(v)='object' THEN v ELSE '{}'::json END)
 UNION ALL SELECT value FROM json_array_elements(CASE WHEN json_typeof(v)='array' THEN v ELSE '[]'::json END)
 ) children
 ) SELECT coalesce(array_agg(DISTINCT session_id), ARRAY[]::text[]) FROM (
 SELECT v->>'sessionId' session_id FROM nodes WHERE json_typeof(v)='object' AND json_typeof(v->'sessionId')='string'
 UNION ALL SELECT substring(ref #>> '{}' from '^session:([^:]+):')
 FROM nodes CROSS JOIN LATERAL json_array_elements(CASE WHEN json_typeof(v->'sourceRefs')='array' THEN v->'sourceRefs' ELSE '[]'::json END) ref
 WHERE json_typeof(v)='object' AND json_typeof(ref)='string'
 UNION ALL SELECT substring(v->>'ref' from '^session:([^:]+):') FROM nodes WHERE json_typeof(v)='object' AND json_typeof(v->'ref')='string'
 ) refs WHERE session_id IS NOT NULL
$$;
ALTER TABLE tiddle_envelopes ADD COLUMN envelope_id BIGSERIAL NOT NULL;
ALTER TABLE tiddle_envelopes ADD COLUMN agent_id TEXT;
ALTER TABLE tiddle_envelopes ADD COLUMN project TEXT NOT NULL DEFAULT '';
ALTER TABLE tiddle_envelopes ADD COLUMN kind TEXT;
ALTER TABLE tiddle_envelopes ADD COLUMN scope TEXT NOT NULL DEFAULT '';
UPDATE tiddle_envelopes SET kind=split_part(key,':',1),agent_id=split_part(key,':',2),scope=CASE WHEN split_part(key,':',1) IN ('tiddle-pass-scope','tiddle-pass-receipt') THEN substring(key from length(split_part(key,':',1))+length(split_part(key,':',2))+3) ELSE '' END;
ALTER TABLE tiddle_envelopes ALTER COLUMN agent_id SET NOT NULL;
ALTER TABLE tiddle_envelopes ALTER COLUMN kind SET NOT NULL;
ALTER TABLE tiddle_entries ADD COLUMN envelope_id BIGINT;
UPDATE tiddle_entries t SET envelope_id=e.envelope_id FROM tiddle_envelopes e WHERE t.key=e.key;
ALTER TABLE tiddle_entries DROP COLUMN key;
ALTER TABLE tiddle_envelopes DROP COLUMN key;
ALTER TABLE tiddle_envelopes ADD PRIMARY KEY(envelope_id);
ALTER TABLE tiddle_envelopes ADD UNIQUE(agent_id,project,kind,scope);
ALTER TABLE tiddle_entries ALTER COLUMN envelope_id SET NOT NULL;
ALTER TABLE tiddle_entries ADD FOREIGN KEY(envelope_id) REFERENCES tiddle_envelopes(envelope_id) ON DELETE CASCADE;
CREATE INDEX tiddle_entries_native_order ON tiddle_entries(envelope_id,position,id);
CREATE INDEX tiddle_native_due ON tiddle_envelopes(next_run_at,agent_id) WHERE kind='tiddle-pass';
ALTER TABLE dream_state_envelopes ALTER COLUMN metadata TYPE json USING metadata::json;
ALTER TABLE dream_state_envelopes ADD COLUMN envelope_id BIGSERIAL NOT NULL;
ALTER TABLE dream_state_envelopes ADD COLUMN agent_id TEXT;
ALTER TABLE dream_state_envelopes ADD COLUMN project TEXT NOT NULL DEFAULT '';
ALTER TABLE dream_state_envelopes ADD COLUMN scope TEXT NOT NULL DEFAULT '';
UPDATE dream_state_envelopes SET agent_id=split_part(key,':',2),project=CASE WHEN kind='scope_review' THEN '' ELSE substring(key from length(split_part(key,':',1))+length(split_part(key,':',2))+3) END;
ALTER TABLE dream_state_envelopes ALTER COLUMN agent_id SET NOT NULL;
ALTER TABLE dream_ledger_entries ALTER COLUMN payload TYPE json USING payload::json;
ALTER TABLE dream_ledger_entries ADD COLUMN envelope_id BIGINT;
UPDATE dream_ledger_entries t SET envelope_id=e.envelope_id FROM dream_state_envelopes e WHERE t.key=e.key;
ALTER TABLE dream_ledger_entries DROP COLUMN key;
ALTER TABLE dream_preload_entries ALTER COLUMN payload TYPE json USING payload::json;
ALTER TABLE dream_preload_entries ADD COLUMN envelope_id BIGINT;
UPDATE dream_preload_entries t SET envelope_id=e.envelope_id FROM dream_state_envelopes e WHERE t.key=e.key;
ALTER TABLE dream_preload_entries DROP COLUMN key;
ALTER TABLE dream_scope_review_entries ALTER COLUMN payload TYPE json USING payload::json;
ALTER TABLE dream_scope_review_entries ADD COLUMN envelope_id BIGINT;
UPDATE dream_scope_review_entries t SET envelope_id=e.envelope_id FROM dream_state_envelopes e WHERE t.key=e.key;
ALTER TABLE dream_scope_review_entries DROP COLUMN key;
ALTER TABLE dream_state_envelopes DROP COLUMN key;
ALTER TABLE dream_state_envelopes ADD PRIMARY KEY(envelope_id);
ALTER TABLE dream_state_envelopes ADD UNIQUE(agent_id,project,kind,scope);
ALTER TABLE tiddle_envelopes ADD COLUMN source_sessions TEXT[] GENERATED ALWAYS AS (burrow_source_sessions(value_json::json)) STORED;
CREATE INDEX tiddle_envelopes_source_sessions ON tiddle_envelopes USING gin(source_sessions);
ALTER TABLE tiddle_entries ADD COLUMN source_sessions TEXT[] GENERATED ALWAYS AS (burrow_source_sessions(value_json::json)) STORED;
CREATE INDEX tiddle_entries_source_sessions ON tiddle_entries USING gin(source_sessions);
ALTER TABLE dream_ledger_entries ADD COLUMN source_sessions TEXT[] GENERATED ALWAYS AS (burrow_source_sessions(payload::json)) STORED;
CREATE INDEX dream_ledger_entries_source_sessions ON dream_ledger_entries USING gin(source_sessions);
ALTER TABLE dream_preload_entries ADD COLUMN source_sessions TEXT[] GENERATED ALWAYS AS (burrow_source_sessions(payload::json)) STORED;
CREATE INDEX dream_preload_entries_source_sessions ON dream_preload_entries USING gin(source_sessions);
ALTER TABLE dream_scope_review_entries ADD COLUMN source_sessions TEXT[] GENERATED ALWAYS AS (burrow_source_sessions(payload::json)) STORED;
CREATE INDEX dream_scope_review_entries_source_sessions ON dream_scope_review_entries USING gin(source_sessions);
ALTER TABLE dream_ledger_entries ALTER COLUMN envelope_id SET NOT NULL;
ALTER TABLE dream_ledger_entries ADD FOREIGN KEY(envelope_id) REFERENCES dream_state_envelopes(envelope_id) ON DELETE CASCADE;
ALTER TABLE dream_ledger_entries ADD PRIMARY KEY(envelope_id,position);
ALTER TABLE dream_preload_entries ALTER COLUMN envelope_id SET NOT NULL;
ALTER TABLE dream_preload_entries ADD FOREIGN KEY(envelope_id) REFERENCES dream_state_envelopes(envelope_id) ON DELETE CASCADE;
ALTER TABLE dream_preload_entries ADD PRIMARY KEY(envelope_id,position);
ALTER TABLE dream_scope_review_entries ALTER COLUMN envelope_id SET NOT NULL;
ALTER TABLE dream_scope_review_entries ADD FOREIGN KEY(envelope_id) REFERENCES dream_state_envelopes(envelope_id) ON DELETE CASCADE;
ALTER TABLE dream_scope_review_entries ADD PRIMARY KEY(envelope_id,position);
`;
