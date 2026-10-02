// Cards retain their complete JSON payload; scope and identity are relational,
// never inferred by LIKE (agent IDs may contain underscores).
export const POSTGRES_ROLLING_CONTINUITY_SCHEMA_SQL = `
CREATE TABLE rolling_continuity_cards (
 agent_id TEXT NOT NULL, project TEXT NOT NULL, card_id TEXT NOT NULL,
 card_json JSONB NOT NULL, updated_at TEXT NOT NULL,
 legacy_source TEXT, legacy_key TEXT, legacy_card_json JSONB,
 legacy_envelope_version JSONB, legacy_envelope_updated_at JSONB, legacy_envelope_agent_id JSONB, legacy_envelope_project JSONB,
 PRIMARY KEY(agent_id,project,card_id)
);
CREATE TABLE rolling_continuity_envelopes (
 legacy_source TEXT NOT NULL, legacy_key TEXT NOT NULL,
 version JSONB, envelope_updated_at JSONB, envelope_agent_id JSONB, envelope_project JSONB,
 extra_metadata JSONB NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(legacy_source,legacy_key)
);
CREATE INDEX rolling_continuity_scope ON rolling_continuity_cards(agent_id,project);
-- Refuse destructive migration of malformed envelopes or unknown envelope fields.
-- The migration runner rolls back the entire migration, including this table.
DO $$
DECLARE r record; e jsonb; c jsonb;
BEGIN
 FOR r IN SELECT key,value_json::text FROM settings_meta WHERE starts_with(key,'rolling-continuity:')
 UNION ALL SELECT key,value_json::text FROM working_memory_meta WHERE starts_with(key,'rolling-continuity:') LOOP
  BEGIN e := r.value_json::jsonb;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid rolling continuity JSON: %',r.key; END;
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR jsonb_typeof(e->'cards') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'invalid rolling continuity envelope: %',r.key;
  END IF;
  FOR c IN SELECT value FROM jsonb_array_elements(e->'cards') LOOP
   IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid rolling continuity card: %',r.key; END IF;
  END LOOP;
 END LOOP;
END $$;
CREATE TEMP TABLE rolling_migration_source ON COMMIT DROP AS
WITH source AS (
 SELECT 'settings_meta' AS origin,key,value_json::jsonb AS envelope,updated_at FROM settings_meta WHERE starts_with(key,'rolling-continuity:')
 UNION ALL
 SELECT 'working_memory_meta',key,value_json::jsonb,updated_at::text FROM working_memory_meta WHERE starts_with(key,'rolling-continuity:')
), cards AS (
 SELECT *,
 COALESCE(NULLIF(card->>'agentId',''),NULLIF(envelope->>'agentId',''),split_part(substr(key,20),':',1)) AS agent,
 COALESCE(NULLIF(card->>'project',''),NULLIF(envelope->>'project',''),substr(substr(key,20),strpos(substr(key,20),':')+1)) AS scope
 FROM source CROSS JOIN LATERAL jsonb_array_elements(envelope->'cards') WITH ORDINALITY AS x(card,ordinality)
), identified AS (
 SELECT *,COALESCE(NULLIF(card->>'id',''),'legacy:'||md5(origin||key||ordinality::text||card::text)) AS original_id FROM cards
), ranked AS (
 SELECT *,row_number() OVER(PARTITION BY agent,scope,original_id ORDER BY origin,key,ordinality) AS occurrence FROM identified
)
SELECT * FROM ranked;
INSERT INTO rolling_continuity_envelopes
SELECT 'settings_meta',key,value_json::jsonb->'version',value_json::jsonb->'updatedAt',value_json::jsonb->'agentId',value_json::jsonb->'project',value_json::jsonb - ARRAY['cards','version','updatedAt','agentId','project'],updated_at FROM settings_meta WHERE starts_with(key,'rolling-continuity:')
UNION ALL SELECT 'working_memory_meta',key,value_json::jsonb->'version',value_json::jsonb->'updatedAt',value_json::jsonb->'agentId',value_json::jsonb->'project',value_json::jsonb - ARRAY['cards','version','updatedAt','agentId','project'],updated_at::text FROM working_memory_meta WHERE starts_with(key,'rolling-continuity:');
DO $$
DECLARE r record; candidate text; suffix bigint;
BEGIN
 FOR r IN SELECT * FROM rolling_migration_source ORDER BY occurrence,origin,key,ordinality LOOP
  candidate := r.original_id;
  suffix := 0;
  IF r.occurrence > 1 THEN
   LOOP
    candidate := 'legacy-migration:' || suffix::text || ':' || r.original_id;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM rolling_migration_source WHERE agent=r.agent AND scope=r.scope AND original_id=candidate)
      AND NOT EXISTS (SELECT 1 FROM rolling_continuity_cards WHERE agent_id=r.agent AND project=r.scope AND card_id=candidate);
    suffix := suffix + 1;
   END LOOP;
  END IF;
  INSERT INTO rolling_continuity_cards(agent_id,project,card_id,card_json,updated_at,legacy_source,legacy_key,legacy_card_json,legacy_envelope_version,legacy_envelope_updated_at,legacy_envelope_agent_id,legacy_envelope_project)
  VALUES(r.agent,r.scope,candidate,r.card || jsonb_build_object('id',candidate,'agentId',r.agent,'project',r.scope),r.updated_at,r.origin,r.key,r.card,r.envelope->'version',r.envelope->'updatedAt',r.envelope->'agentId',r.envelope->'project');
 END LOOP;
END $$;
DELETE FROM settings_meta WHERE starts_with(key,'rolling-continuity:');
DELETE FROM working_memory_meta WHERE starts_with(key,'rolling-continuity:');
`;
export async function readRollingCards(client, agentId, project = null) {
 const result = await client.query('SELECT card_json FROM rolling_continuity_cards WHERE agent_id=$1 AND ($2::text IS NULL OR project=$2) ORDER BY updated_at DESC,card_id', [agentId,project]);
 return result.rows.map(row => row.card_json);
}
export async function writeRollingCard(client, card, at) {
 await client.query(`INSERT INTO rolling_continuity_cards(agent_id,project,card_id,card_json,updated_at) VALUES($1,$2,$3,$4::jsonb,$5)
 ON CONFLICT(agent_id,project,card_id) DO UPDATE SET card_json=EXCLUDED.card_json,updated_at=EXCLUDED.updated_at`,[card.agentId,card.project,card.id,JSON.stringify(card),at]);
}

export function rollingCardActive(card, at) {
 return !card.expiresAt || new Date(card.expiresAt).getTime() >= new Date(at).getTime();
}
