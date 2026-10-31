import { POSTGRES_ARCHIVE_DISCOVERY_INDEX_SQL } from './postgres-archive-discovery-indexes.mjs';
import { POSTGRES_ARCHIVE_CHAT_PROJECTION_SQL } from './postgres-archive-chat-projection.mjs';
import { archiveReadQuery, withArchiveRead } from './postgres-archive-read.mjs';
import { projectPendingActions } from './session-entry.mjs';
import { fenceChatInputsForReset } from './postgres-chat-input-store.mjs';
import { matchCompactionOccurrences, COMPACTION_COPY_BATCH_SIZE } from './postgres-compaction.mjs';
import { POSTGRES_COMPACTION_PROJECTIONS_SQL } from './postgres-compaction-projections.mjs';
import { readArchiveTranscriptPage } from './postgres-archive-page.mjs';
import { POSTGRES_ARCHIVE_LEXICAL_SQL, archivePayloadKeySQL, archiveTruthyPayloadSQL } from './postgres-archive-lexical.mjs';
import { POSTGRES_OPERATOR_INSTANT_SQL } from './postgres-operator-instant.mjs';
import { exportSessionRawEvidence } from './session-evidence-export.mjs';
import { POSTGRES_LOGICAL_MEMBER_SQL, POSTGRES_ARCHIVE_RELATIONAL_ID_SQL, POSTGRES_CATALOG_SCALAR_ID_SQL, POSTGRES_LOGICAL_LOOKUP_INDEX_SQL } from './postgres-lexical-identity.mjs';
import { retentionSessionCandidate } from './retention.mjs';
import { POSTGRES_HISTORY_KEYSET_SQL } from './postgres-history-keyset.mjs';
import { POSTGRES_RESET_INSTANT_SQL } from './postgres-reset-instant.mjs';
import { normalizePostgresPool } from './postgres-foundation.mjs';
import { POSTGRES_CONTINUITY_STATE_SCHEMA_SQL } from './postgres-continuity-state-store.mjs';
import { PostgresAgentDeliveryStore, POSTGRES_AGENT_DELIVERY_OWNER_SQL, POSTGRES_AGENT_DELIVERY_SCHEMA_SQL } from './postgres-agent-delivery-store.mjs';
import { resolveAlbdruckConfig } from './config.mjs';
import { matchesQuery } from './session-search.mjs';
import { closeContinuityOwners } from './postgres-continuity-owner.mjs';
import { randomUUID } from 'node:crypto';
import { closePostgresPool, withPostgresTransaction, migrationLockKey } from './postgres-foundation.mjs';

// Caller holds the session row lock: append, compact and delivery share one boundary.
export async function findSessionReplay(client, agentId, sessionId, entryId, key) {
  const { rows } = await client.query(`SELECT sequence,entry FROM (
      SELECT sequence,entry,entry_id,idempotency_key,0 AS priority,0::bigint AS generation FROM conversation_entries WHERE agent_id=$1 AND session_id=$2
      UNION ALL SELECT ordinal,entry,entry_id,idempotency_key,1,generation FROM conversation_archive_entries
      WHERE agent_id=$1 AND session_id=$2 AND archive_kind='compacted'
        AND generation >= COALESCE((SELECT (metadata->>'resetGeneration')::bigint FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2),0)
    ) r
    WHERE (entry_id=$3 OR ($4::text IS NOT NULL AND idempotency_key=$4))
    ORDER BY priority,generation DESC,sequence LIMIT 1`,
    [agentId, sessionId, entryId, key]);
  return rows[0] || null;
}

export const POSTGRES_SESSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_sessions (
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, session_id)
);
CREATE TABLE IF NOT EXISTS conversation_entries (
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sequence BIGINT GENERATED ALWAYS AS IDENTITY,
  entry_id TEXT NOT NULL,
  idempotency_key TEXT,
  entry JSONB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, session_id, sequence),
  UNIQUE (agent_id, session_id, entry_id),
  UNIQUE (agent_id, session_id, idempotency_key),
  FOREIGN KEY (agent_id, session_id) REFERENCES conversation_sessions(agent_id, session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS conversation_entries_session_order_idx ON conversation_entries(agent_id, session_id, sequence);

`;

export const POSTGRES_SESSION_ARCHIVE_SCHEMA_SQL = `
-- Additive authority structures. Archives are immutable generation snapshots;
-- metadata remains scoped by agent so identical session ids cannot cross agents.
CREATE TABLE IF NOT EXISTS conversation_archives (
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  generation BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'archive',
  entries JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, session_id, archive_id),
  FOREIGN KEY (agent_id, session_id) REFERENCES conversation_sessions(agent_id, session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS conversation_archives_session_order_idx ON conversation_archives(agent_id, session_id, created_at DESC);
`;

// v1-v3 schema constants remain immutable for adopted migration checksums.
// PostgreSQL jsonb decodes JSON string escapes into text (rejecting \u0000 and
// malformed surrogate pairs); json retains the original JSON lexical payload.
export const POSTGRES_SESSION_LOSSLESS_JSON_SCHEMA_SQL = `
ALTER TABLE conversation_entries ALTER COLUMN entry TYPE JSON USING entry::json;
ALTER TABLE conversation_archives ALTER COLUMN entries DROP DEFAULT;
ALTER TABLE conversation_archives ALTER COLUMN entries TYPE JSON USING entries::json;
ALTER TABLE conversation_archives ALTER COLUMN entries SET DEFAULT '[]'::json;
`;

export const POSTGRES_SESSION_OPERATOR_LOOKUP_SCHEMA_SQL = `CREATE INDEX IF NOT EXISTS conversation_entries_agent_recent_idx ON conversation_entries(agent_id, created_at DESC, sequence DESC);`;

export const POSTGRES_ARCHIVE_LISTING_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS conversation_sessions_archive_listing_idx
 ON conversation_sessions(agent_id,updated_at DESC,session_id DESC);
CREATE INDEX IF NOT EXISTS conversation_archives_reset_listing_idx
 ON conversation_archives(agent_id,created_at DESC,archive_id DESC) WHERE kind='reset';
`;

// Proof lists use a durable run directory for ordering and hydrate only the
// selected page. Conversation entries remain the detail authority.
export const POSTGRES_ARCHIVE_RUN_INDEX_SQL = String.raw`
CREATE OR REPLACE FUNCTION burrow_proof_json_member(payload json, member text) RETURNS json
LANGUAGE plpgsql IMMUTABLE STRICT AS $proof$
DECLARE s bytea := convert_to(payload::text,'UTF8'); i int := 1; start_at int;
 depth int := 0; quoted boolean := false; escaped boolean := false;
 key_start int := 0; wanted boolean := false; c text;
BEGIN
 WHILE i <= octet_length(s) LOOP
  c := chr(get_byte(s,i-1));
  IF quoted THEN
   IF escaped THEN escaped := false;
   ELSIF c = chr(92) THEN escaped := true;
   ELSIF c = '"' THEN quoted := false; IF depth=1 AND key_start>0 THEN wanted := convert_from(substring(s FROM key_start FOR i-key_start+1),'UTF8')=to_json(member)::text; key_start:=0; END IF;
   END IF;
  ELSE
   IF c='"' THEN quoted:=true; IF depth=1 AND start_at IS NULL THEN key_start:=i; END IF;
   ELSIF c=':' AND depth=1 THEN IF wanted THEN start_at:=i+1; END IF;
   ELSIF c IN ('{','[') THEN depth:=depth+1;
   ELSIF c IN ('}',']') THEN depth:=depth-1; IF depth=0 AND start_at IS NOT NULL THEN RETURN convert_from(substring(s FROM start_at FOR i-start_at),'UTF8')::json; END IF;
   ELSIF c=',' AND depth=1 THEN IF start_at IS NOT NULL THEN RETURN convert_from(substring(s FROM start_at FOR i-start_at),'UTF8')::json; END IF; wanted:=false;
   END IF;
  END IF;
  i:=i+1;
 END LOOP;
 RETURN NULL;
END $proof$;
CREATE OR REPLACE FUNCTION burrow_proof_run_key(payload json) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $proof$
DECLARE token json;
BEGIN token:=burrow_proof_json_member(payload,'runId'::text); RETURN CASE WHEN token IS NULL THEN NULL ELSE encode(convert_to(token::text,'UTF8'),'hex') END; END $proof$;
CREATE OR REPLACE FUNCTION burrow_proof_scalar(payload json, member text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $proof$
DECLARE token json;
BEGIN token:=burrow_proof_json_member(payload,member::text); IF token IS NULL THEN RETURN NULL; END IF; RETURN token::jsonb #>> '{}';
EXCEPTION WHEN OTHERS THEN RETURN NULL; END $proof$;
ALTER TABLE conversation_entries ADD COLUMN IF NOT EXISTS run_key text;
ALTER TABLE conversation_archive_entries ADD COLUMN IF NOT EXISTS run_key text;
CREATE TABLE IF NOT EXISTS conversation_archive_runs (
 agent_id text NOT NULL, session_id text NOT NULL, run_key text NOT NULL, run_id text NOT NULL,
 started_at timestamptz, completed_at timestamptz, last_activity_at timestamptz, sort_timestamp text NOT NULL DEFAULT '',
 PRIMARY KEY(agent_id,session_id,run_key),
 FOREIGN KEY(agent_id,session_id) REFERENCES conversation_sessions(agent_id,session_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE OR REPLACE FUNCTION burrow_project_archive_run_entry() RETURNS trigger LANGUAGE plpgsql AS $tag$
DECLARE token json; rid text; at text; role text; kind text; completed text;
BEGIN
 token := burrow_proof_json_member(NEW.entry,'runId'); NEW.run_key := burrow_proof_run_key(NEW.entry);
 IF NEW.run_key IS NULL THEN RETURN NEW; END IF;
 rid := burrow_proof_scalar(NEW.entry,'runId');
 IF rid IS NULL OR rid = '' THEN RETURN NEW; END IF;
 at := burrow_proof_scalar(NEW.entry,'ts');
 at := COALESCE(NULLIF(at,''),NEW.created_at::text);
 role := burrow_proof_scalar(NEW.entry,'role');
 kind := burrow_proof_scalar(NEW.entry,'type');
 completed := CASE WHEN kind='message' AND role='assistant' THEN at ELSE NULL END;
 INSERT INTO conversation_archive_runs(agent_id,session_id,run_key,run_id,started_at,completed_at,last_activity_at,sort_timestamp)
 VALUES(NEW.agent_id,NEW.session_id,NEW.run_key,rid,at::timestamptz,completed::timestamptz,at::timestamptz,COALESCE(completed,at,''))
 ON CONFLICT(agent_id,session_id,run_key) DO UPDATE SET run_id=EXCLUDED.run_id,
  started_at=CASE WHEN conversation_archive_runs.started_at IS NULL OR EXCLUDED.started_at<conversation_archive_runs.started_at THEN EXCLUDED.started_at ELSE conversation_archive_runs.started_at END,
  completed_at=CASE WHEN EXCLUDED.completed_at IS NULL THEN conversation_archive_runs.completed_at WHEN conversation_archive_runs.completed_at IS NULL OR EXCLUDED.completed_at>conversation_archive_runs.completed_at THEN EXCLUDED.completed_at ELSE conversation_archive_runs.completed_at END,
  last_activity_at=CASE WHEN conversation_archive_runs.last_activity_at IS NULL OR EXCLUDED.last_activity_at>conversation_archive_runs.last_activity_at THEN EXCLUDED.last_activity_at ELSE conversation_archive_runs.last_activity_at END;
 UPDATE conversation_archive_runs SET sort_timestamp=COALESCE(completed_at::text,started_at::text,'')
  WHERE agent_id=NEW.agent_id AND session_id=NEW.session_id AND run_key=NEW.run_key;
 RETURN NEW;
END $tag$;
CREATE OR REPLACE FUNCTION burrow_project_archive_run_evidence() RETURNS trigger LANGUAGE plpgsql AS $tag$
DECLARE item jsonb; rid text; at text; key text;
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.metadata->'runEvidence','[]'::jsonb)) LOOP
  rid := NULLIF(item->>'runId',''); IF rid IS NULL THEN CONTINUE; END IF;
  at := COALESCE(NULLIF(item->>'createdAt',''),NEW.updated_at::text); key := encode(convert_to(to_json(rid)::text,'UTF8'),'hex');
  INSERT INTO conversation_archive_runs(agent_id,session_id,run_key,run_id,started_at,completed_at,last_activity_at,sort_timestamp)
  VALUES(NEW.agent_id,NEW.session_id,key,rid,at::timestamptz,at::timestamptz,at::timestamptz,at)
  ON CONFLICT(agent_id,session_id,run_key) DO UPDATE SET run_id=EXCLUDED.run_id,
   completed_at=COALESCE(conversation_archive_runs.completed_at,EXCLUDED.completed_at),
   last_activity_at=COALESCE(conversation_archive_runs.last_activity_at,EXCLUDED.last_activity_at);
  UPDATE conversation_archive_runs SET sort_timestamp=COALESCE(completed_at::text,started_at::text,'')
   WHERE agent_id=NEW.agent_id AND session_id=NEW.session_id AND run_key=key;
 END LOOP;
 RETURN NEW;
END $tag$;
DROP TRIGGER IF EXISTS burrow_archive_run_evidence ON conversation_sessions;
CREATE TRIGGER burrow_archive_run_evidence AFTER INSERT OR UPDATE OF metadata ON conversation_sessions FOR EACH ROW EXECUTE FUNCTION burrow_project_archive_run_evidence();
WITH projected AS (
 SELECT agent_id,session_id,burrow_proof_run_key(entry) AS run_key,
  burrow_proof_scalar(entry,'runId') AS run_id,
  COALESCE(burrow_proof_scalar(entry,'ts'),created_at::text) AS at,
  burrow_proof_scalar(entry,'type') AS kind,
  burrow_proof_scalar(entry,'role') AS role
 FROM conversation_entries WHERE burrow_proof_run_key(entry) IS NOT NULL
 UNION ALL
 SELECT agent_id,session_id,burrow_proof_run_key(entry),
  burrow_proof_scalar(entry,'runId'),
  COALESCE(burrow_proof_scalar(entry,'ts'),created_at::text),
  burrow_proof_scalar(entry,'type'),burrow_proof_scalar(entry,'role')
 FROM conversation_archive_entries WHERE burrow_proof_run_key(entry) IS NOT NULL
), grouped AS (
 SELECT agent_id,session_id,run_key,max(run_id) AS run_id,min(at::timestamptz) AS started_at,
  max(at::timestamptz) FILTER (WHERE kind='message' AND role='assistant') AS completed_at,max(at::timestamptz) AS last_activity_at
 FROM projected WHERE run_key IS NOT NULL AND run_id IS NOT NULL AND run_id<>'' GROUP BY agent_id,session_id,run_key
) INSERT INTO conversation_archive_runs(agent_id,session_id,run_key,run_id,started_at,completed_at,last_activity_at,sort_timestamp)
 SELECT agent_id,session_id,run_key,run_id,started_at,completed_at,last_activity_at,COALESCE(completed_at::text,started_at::text,'') FROM grouped
 ON CONFLICT(agent_id,session_id,run_key) DO UPDATE SET run_id=EXCLUDED.run_id,started_at=EXCLUDED.started_at,
  completed_at=EXCLUDED.completed_at,last_activity_at=EXCLUDED.last_activity_at,sort_timestamp=EXCLUDED.sort_timestamp;
INSERT INTO conversation_archive_runs(agent_id,session_id,run_key,run_id,started_at,completed_at,last_activity_at,sort_timestamp)
 SELECT s.agent_id,s.session_id,encode(convert_to(to_json(item->>'runId')::text,'UTF8'),'hex'),item->>'runId',(item->>'createdAt')::timestamptz,(item->>'createdAt')::timestamptz,(item->>'createdAt')::timestamptz,COALESCE(item->>'createdAt','')
 FROM conversation_sessions s CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.metadata->'runEvidence','[]'::jsonb)) item
 WHERE NULLIF(item->>'runId','') IS NOT NULL
 ON CONFLICT(agent_id,session_id,run_key) DO NOTHING;
CREATE INDEX IF NOT EXISTS conversation_archive_runs_agent_order_idx ON conversation_archive_runs(agent_id,sort_timestamp DESC,run_id DESC);
CREATE INDEX IF NOT EXISTS conversation_archive_runs_session_order_idx ON conversation_archive_runs(agent_id,session_id,sort_timestamp DESC,run_id DESC);
CREATE INDEX IF NOT EXISTS conversation_entries_run_idx ON conversation_entries(agent_id,run_key,session_id,sequence);
CREATE INDEX IF NOT EXISTS conversation_archive_entries_run_idx ON conversation_archive_entries(agent_id,run_key,session_id,generation DESC,source_id DESC,ordinal);
`;


export const POSTGRES_SESSION_ORIGINAL_LOOKUP_SCHEMA_SQL = `
-- Lexical top-level member scanner: no JSON string is decoded into PostgreSQL text.
CREATE OR REPLACE FUNCTION burrow_json_member(payload json, member text) RETURNS json
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE s text := payload::text; i int := 1; start_at int;
 depth int := 0; quoted boolean := false; escaped boolean := false;
 key_start int := 0; wanted boolean := false; c text;
BEGIN
 WHILE i <= length(s) LOOP
  c := substr(s,i,1);
  IF quoted THEN
   IF escaped THEN escaped := false;
   ELSIF c = chr(92) THEN escaped := true;
   ELSIF c = '"' THEN
    quoted := false;
    IF depth = 1 AND key_start > 0 THEN
     wanted := substr(s,key_start,i-key_start+1) = to_json(member)::text;
     key_start := 0;
    END IF;
   END IF;
  ELSE
   IF c = '"' THEN
    quoted := true;
    IF depth = 1 AND start_at IS NULL THEN key_start := i; END IF;
   ELSIF c = ':' AND depth = 1 THEN
    IF wanted THEN
     start_at := i+1;
     -- Scan the value lexically through the next top-level delimiter.
    END IF;
   ELSIF c IN ('{','[') THEN depth := depth+1;
   ELSIF c IN ('}',']') THEN
    depth := depth-1;
    IF depth = 0 AND start_at IS NOT NULL THEN RETURN substr(s,start_at,i-start_at)::json; END IF;
   ELSIF c = ',' AND depth = 1 THEN
    IF start_at IS NOT NULL THEN RETURN substr(s,start_at,i-start_at)::json; END IF;
    wanted := false;
   END IF;
  END IF;
  i := i+1;
 END LOOP;
 RETURN NULL;
END $$;
`;

// Append-only migration: originals are indexed lexical rows, never jsonb.
// Occurrence keys preserve duplicate IDs and archive order without inventing IDs.
export const POSTGRES_SESSION_ORIGINAL_ROWS_SCHEMA_SQL = `
-- Install the linear byte scanner before backfilling adopted schema 15.
CREATE OR REPLACE FUNCTION burrow_json_member(payload json, member text) RETURNS json
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE s bytea := convert_to(payload::text,'UTF8'); i int := 1; start_at int;
 depth int := 0; quoted boolean := false; escaped boolean := false;
 key_start int := 0; wanted boolean := false; c text;
BEGIN
 WHILE i <= octet_length(s) LOOP
  c := chr(get_byte(s,i-1));
  IF quoted THEN
   IF escaped THEN escaped := false;
   ELSIF c = chr(92) THEN escaped := true;
   ELSIF c = '"' THEN
    quoted := false;
    IF depth = 1 AND key_start > 0 THEN
     wanted := convert_from(substring(s FROM key_start FOR i-key_start+1),'UTF8') = to_json(member)::text;
     key_start := 0;
    END IF;
   END IF;
  ELSE
   IF c = '"' THEN
    quoted := true;
    IF depth = 1 AND start_at IS NULL THEN key_start := i; END IF;
   ELSIF c = ':' AND depth = 1 THEN
    IF wanted THEN
     start_at := i+1;
     -- Scan the value lexically through the next top-level delimiter.
    END IF;
   ELSIF c IN ('{','[') THEN depth := depth+1;
   ELSIF c IN ('}',']') THEN
    depth := depth-1;
    IF depth = 0 AND start_at IS NOT NULL THEN RETURN convert_from(substring(s FROM start_at FOR i-start_at),'UTF8')::json; END IF;
   ELSIF c = ',' AND depth = 1 THEN
    IF start_at IS NOT NULL THEN RETURN convert_from(substring(s FROM start_at FOR i-start_at),'UTF8')::json; END IF;
    wanted := false;
   END IF;
  END IF;
  i := i+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TABLE IF NOT EXISTS conversation_original_rows (
 agent_id text NOT NULL,
 session_id text NOT NULL,
 source_store text NOT NULL CHECK (source_store IN ('live','archive')),
 source_id text NOT NULL,
 ordinal bigint NOT NULL,
 entry_key text,
 entry json NOT NULL,
 search_projection text NOT NULL,
 created_at text NOT NULL,
 archive_kind text,
 generation bigint,
 PRIMARY KEY (agent_id,session_id,source_store,source_id,ordinal),
 FOREIGN KEY (agent_id,session_id) REFERENCES conversation_sessions(agent_id,session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS conversation_original_rows_lookup_idx
 ON conversation_original_rows(agent_id,session_id,entry_key,source_store,source_id DESC,ordinal);
CREATE INDEX IF NOT EXISTS conversation_original_rows_order_idx
 ON conversation_original_rows(agent_id,session_id,source_store,source_id,ordinal);
-- JSON lexical strings are safe PostgreSQL text even when decoded strings are not.
CREATE OR REPLACE FUNCTION burrow_sync_original_rows() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME = 'conversation_entries' THEN
  IF TG_OP <> 'INSERT' THEN
   DELETE FROM conversation_original_rows WHERE agent_id=OLD.agent_id AND session_id=OLD.session_id
    AND source_store='live' AND source_id=OLD.sequence::text;
  END IF;
  IF TG_OP <> 'DELETE' THEN
   INSERT INTO conversation_original_rows
    (agent_id,session_id,source_store,source_id,ordinal,entry_key,entry,search_projection,created_at)
   VALUES (NEW.agent_id,NEW.session_id,'live',NEW.sequence::text,NEW.sequence,
    COALESCE(burrow_json_member(NEW.entry,'id')::text,to_json(NEW.entry_id)::text),NEW.entry,
    COALESCE(burrow_json_member(NEW.entry,'content')::text,''),NEW.created_at);
  END IF;
 ELSE
  IF TG_OP <> 'INSERT' THEN
   DELETE FROM conversation_original_rows WHERE agent_id=OLD.agent_id AND session_id=OLD.session_id
    AND source_store='archive' AND source_id=OLD.archive_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
   INSERT INTO conversation_original_rows
    (agent_id,session_id,source_store,source_id,ordinal,entry_key,entry,search_projection,created_at,archive_kind,generation)
   SELECT NEW.agent_id,NEW.session_id,'archive',NEW.archive_id,e.ordinal,
    burrow_json_member(e.value,'id')::text,e.value,
    COALESCE(burrow_json_member(e.value,'content')::text,''),NEW.created_at,NEW.kind,NEW.generation
   FROM json_array_elements(NEW.entries) WITH ORDINALITY AS e(value,ordinal);
  END IF;
 END IF;
 RETURN NULL;
END $$;
-- The schema runner executes this migration transactionally. Block writers until
-- both backfill and hooks are installed, so no concurrent turn can be omitted.
LOCK TABLE conversation_entries,conversation_archives IN SHARE ROW EXCLUSIVE MODE;
DROP TRIGGER IF EXISTS burrow_original_entries ON conversation_entries;
CREATE TRIGGER burrow_original_entries AFTER INSERT OR UPDATE OR DELETE ON conversation_entries
 FOR EACH ROW EXECUTE FUNCTION burrow_sync_original_rows();
DROP TRIGGER IF EXISTS burrow_original_archives ON conversation_archives;
CREATE TRIGGER burrow_original_archives AFTER INSERT OR UPDATE OR DELETE ON conversation_archives
 FOR EACH ROW EXECUTE FUNCTION burrow_sync_original_rows();
INSERT INTO conversation_original_rows
 (agent_id,session_id,source_store,source_id,ordinal,entry_key,entry,search_projection,created_at)
 SELECT agent_id,session_id,'live',sequence::text,sequence,
 COALESCE(burrow_json_member(entry,'id')::text,to_json(entry_id)::text),entry,
 COALESCE(burrow_json_member(entry,'content')::text,''),created_at FROM conversation_entries
 ON CONFLICT DO NOTHING;
INSERT INTO conversation_original_rows
 (agent_id,session_id,source_store,source_id,ordinal,entry_key,entry,search_projection,created_at,archive_kind,generation)
 SELECT a.agent_id,a.session_id,'archive',a.archive_id,e.ordinal,
 burrow_json_member(e.value,'id')::text,e.value,
 COALESCE(burrow_json_member(e.value,'content')::text,''),a.created_at,a.kind,a.generation
 FROM conversation_archives a CROSS JOIN LATERAL json_array_elements(a.entries) WITH ORDINALITY e(value,ordinal)
 ON CONFLICT DO NOTHING;
`;

// Search is a conservative candidate index; JS remains the matching authority.
// Unsafe/non-ASCII lexical strings bypass filtering, preserving JS Unicode and
// NUL/surrogate semantics without ever decoding the lossless original in SQL.
export const POSTGRES_SESSION_SEARCH_SCHEMA_SQL = `
CREATE OR REPLACE FUNCTION burrow_search_grams(payload text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE decoded text; bytes bytea; grams text[];
BEGIN
 IF payload ~ '[^ -~]' OR strpos(payload,chr(92)||'u') > 0 THEN RETURN NULL; END IF;
 BEGIN decoded := lower((payload::jsonb #>> '{}'));
 EXCEPTION WHEN OTHERS THEN RETURN NULL;
 END;
 -- ASCII only: bytea offsets are constant-time, unlike UTF8 text substr.
 bytes := convert_to(decoded,'UTF8');
 SELECT array_agg(DISTINCT convert_from(substring(bytes FROM n FOR 3),'UTF8')) INTO grams
 FROM generate_series(1,octet_length(bytes)-2) n;
 RETURN COALESCE(grams,ARRAY[]::text[]);
END $$;
CREATE OR REPLACE FUNCTION burrow_entry_search_grams(payload json) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; part text[]; result text[] := ARRAY[]::text[];
BEGIN
 FOREACH k IN ARRAY ARRAY['id','role','type','visibility','content'] LOOP
  part := burrow_search_grams(COALESCE(burrow_json_member(payload,k)::text,'""'));
  IF part IS NULL THEN RETURN NULL; END IF;
  result := result || part;
 END LOOP;
 -- Summary rows are excluded by canonical history. Ordinary metadata does not
 -- contribute to matchesQuery, and must not disable the candidate index.
 RETURN result;
END $$;
ALTER TABLE conversation_original_rows ADD COLUMN IF NOT EXISTS search_grams text[];
CREATE OR REPLACE FUNCTION burrow_project_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.search_grams := burrow_entry_search_grams(NEW.entry); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS burrow_search_projection ON conversation_original_rows;
CREATE TRIGGER burrow_search_projection BEFORE INSERT OR UPDATE ON conversation_original_rows
 FOR EACH ROW EXECUTE FUNCTION burrow_project_search();
UPDATE conversation_original_rows SET search_grams=burrow_entry_search_grams(entry);
CREATE INDEX IF NOT EXISTS conversation_original_rows_search_idx ON conversation_original_rows USING gin(search_grams);
CREATE INDEX IF NOT EXISTS conversation_original_rows_search_fallback_idx ON conversation_original_rows(agent_id)
 WHERE search_grams IS NULL;
`;



// Native archive payloads replace the aggregate blob; live payloads already have
// occurrence granularity. The compatibility view is read-only, not a projection.
export const POSTGRES_SESSION_NATIVE_SCHEMA_SQL = `
LOCK TABLE conversation_entries,conversation_archives,conversation_original_rows IN ACCESS EXCLUSIVE MODE;
DROP TRIGGER burrow_original_entries ON conversation_entries;
DROP TRIGGER burrow_original_archives ON conversation_archives;
ALTER TABLE conversation_original_rows RENAME TO conversation_archive_entries;
DELETE FROM conversation_archive_entries WHERE source_store='live';
ALTER TABLE conversation_archive_entries ADD COLUMN entry_id text;
ALTER TABLE conversation_archive_entries ADD COLUMN idempotency_key text;
UPDATE conversation_archive_entries SET entry_id=NULL;
ALTER TABLE conversation_archive_entries ADD CONSTRAINT native_archive_owner FOREIGN KEY(agent_id,session_id,source_id) REFERENCES conversation_archives(agent_id,session_id,archive_id) ON DELETE CASCADE;
ALTER TABLE conversation_entries ADD COLUMN search_grams text[];
CREATE TRIGGER burrow_native_live_search BEFORE INSERT OR UPDATE ON conversation_entries
 FOR EACH ROW EXECUTE FUNCTION burrow_project_search();
UPDATE conversation_entries SET search_grams=burrow_entry_search_grams(entry);
CREATE INDEX conversation_entries_search_idx ON conversation_entries USING gin(search_grams);
ALTER TABLE conversation_archives DROP COLUMN entries;
CREATE VIEW conversation_original_rows AS
 SELECT agent_id,session_id,'live'::text AS source_store,sequence::text AS source_id,
 sequence AS ordinal,COALESCE(burrow_json_member(entry,'id')::text,to_json(entry_id)::text) AS entry_key,
 entry,COALESCE(burrow_json_member(entry,'content')::text,'') AS search_projection,
 created_at,NULL::text AS archive_kind,NULL::bigint AS generation,search_grams
 FROM conversation_entries
 UNION ALL
 SELECT agent_id,session_id,source_store,source_id,ordinal,entry_key,entry,search_projection,
 created_at,archive_kind,generation,search_grams FROM conversation_archive_entries;
DROP FUNCTION burrow_sync_original_rows();
`;

// Persist lexical metadata once per payload change. Never cast the original to jsonb.
export const POSTGRES_SESSION_METADATA_SCHEMA_SQL = `
-- Extract all required lexical tokens in one byte traversal. First literal key
-- wins, including JSON null; escaped key spellings intentionally do not match.
CREATE OR REPLACE FUNCTION burrow_json_metadata(payload json) RETURNS json[]
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE s bytea := convert_to(payload::text,'UTF8'); i int := 1; n int := octet_length(s);
 depth int := 0; quoted boolean := false; escaped boolean := false; c int;
 key_start int := 0; key_text text; slot int := 0; value_start int;
 nested_key_start int := 0; nested_wanted boolean := false; nested_start int;
 result json[] := array_fill(NULL::json,ARRAY[7]);
BEGIN
 WHILE i <= n LOOP
  c := get_byte(s,i-1);
  IF quoted THEN
   IF escaped THEN escaped := false;
   ELSIF c = 92 THEN escaped := true;
   ELSIF c = 34 THEN
    quoted := false;
    IF key_start > 0 THEN
     key_text := convert_from(substring(s FROM key_start FOR i-key_start+1),'UTF8');
     slot := CASE key_text WHEN '"id"' THEN 1 WHEN '"role"' THEN 2
      WHEN '"type"' THEN 3 WHEN '"visibility"' THEN 4 WHEN '"content"' THEN 5
      WHEN '"metadata"' THEN 6 ELSE 0 END;
     IF slot > 0 AND result[slot] IS NOT NULL THEN slot := 0; END IF;
     key_start := 0;
    ELSIF nested_key_start > 0 THEN
     nested_wanted := convert_from(substring(s FROM nested_key_start FOR i-nested_key_start+1),'UTF8') = '"compressionSummary"' AND result[7] IS NULL;
     nested_key_start := 0;
    END IF;
   END IF;
  ELSE
   IF c = 34 THEN
    quoted := true;
    IF depth = 1 AND value_start IS NULL THEN key_start := i;
    ELSIF depth = 2 AND slot = 6 AND nested_start IS NULL THEN nested_key_start := i; END IF;
   ELSIF c = 58 THEN
    IF depth = 1 AND slot > 0 THEN value_start := i+1;
    ELSIF depth = 2 AND slot = 6 AND nested_wanted THEN nested_start := i+1; END IF;
   ELSIF c IN (123,91) THEN depth := depth+1;
   ELSIF c IN (125,93) THEN
    depth := depth-1;
    IF depth = 1 AND nested_start IS NOT NULL THEN
     result[7] := convert_from(substring(s FROM nested_start FOR i-nested_start),'UTF8')::json;
     nested_start := NULL;
    END IF;
    IF depth = 0 AND value_start IS NOT NULL THEN
     result[slot] := convert_from(substring(s FROM value_start FOR i-value_start),'UTF8')::json;
     value_start := NULL;
    END IF;
   ELSIF c = 44 THEN
    IF depth = 1 THEN
     IF value_start IS NOT NULL THEN result[slot] := convert_from(substring(s FROM value_start FOR i-value_start),'UTF8')::json; END IF;
     value_start := NULL; slot := 0; nested_wanted := false;
    ELSIF depth = 2 AND slot = 6 THEN
     IF nested_start IS NOT NULL THEN result[7] := convert_from(substring(s FROM nested_start FOR i-nested_start),'UTF8')::json; END IF;
     nested_start := NULL; nested_wanted := false;
    END IF;
   END IF;
  END IF;
  i := i+1;
 END LOOP;
 RETURN result;
END $$;
ALTER TABLE conversation_entries ADD COLUMN entry_key text;
ALTER TABLE conversation_entries ADD COLUMN search_projection text;
ALTER TABLE conversation_entries ADD COLUMN has_payload_id boolean;
ALTER TABLE conversation_entries ADD COLUMN has_compression_summary boolean;
ALTER TABLE conversation_archive_entries ADD COLUMN has_payload_id boolean;
ALTER TABLE conversation_archive_entries ADD COLUMN has_compression_summary boolean;
CREATE OR REPLACE FUNCTION burrow_project_native_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tokens json[]; part text[]; grams text[] := ARRAY[]::text[]; k int;
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF OLD.has_payload_id IS NOT NULL AND NEW.entry::text IS NOT DISTINCT FROM OLD.entry::text THEN
   NEW.has_payload_id := OLD.has_payload_id;
   NEW.has_compression_summary := OLD.has_compression_summary;
   NEW.search_projection := OLD.search_projection;
   NEW.search_grams := OLD.search_grams;
   IF TG_TABLE_NAME = 'conversation_entries' THEN
    IF OLD.has_payload_id THEN NEW.entry_key := OLD.entry_key;
    ELSE NEW.entry_key := to_json(NEW.entry_id)::text; END IF;
   ELSE NEW.entry_key := OLD.entry_key; END IF;
   RETURN NEW;
  END IF;
 END IF;
 tokens := burrow_json_metadata(NEW.entry);
 NEW.has_payload_id := tokens[1] IS NOT NULL;
 NEW.entry_key := tokens[1]::text;
 IF TG_TABLE_NAME = 'conversation_entries' THEN
  NEW.entry_key := COALESCE(NEW.entry_key,to_json(NEW.entry_id)::text);
 END IF;
 NEW.search_projection := COALESCE(tokens[5]::text,'');
 NEW.has_compression_summary := tokens[7] IS NOT NULL;
 FOR k IN 1..5 LOOP
  part := burrow_search_grams(COALESCE(tokens[k]::text,'""'));
  IF part IS NULL THEN grams := NULL; EXIT; END IF;
  grams := grams || part;
 END LOOP;
 NEW.search_grams := grams;
 RETURN NEW;
END $$;
DROP TRIGGER burrow_native_live_search ON conversation_entries;
DROP TRIGGER burrow_search_projection ON conversation_archive_entries;
CREATE TRIGGER burrow_native_metadata BEFORE INSERT OR UPDATE ON conversation_entries
 FOR EACH ROW EXECUTE FUNCTION burrow_project_native_metadata();
CREATE TRIGGER burrow_native_metadata BEFORE INSERT OR UPDATE ON conversation_archive_entries
 FOR EACH ROW EXECUTE FUNCTION burrow_project_native_metadata();
-- The new columns are NULL, forcing extraction without modifying payload bytes.
UPDATE conversation_entries SET has_payload_id=NULL;
UPDATE conversation_archive_entries SET has_payload_id=NULL;
CREATE OR REPLACE VIEW conversation_original_rows AS
 SELECT agent_id,session_id,'live'::text AS source_store,sequence::text AS source_id,
 sequence AS ordinal,entry_key,entry,search_projection,created_at,
 NULL::text AS archive_kind,NULL::bigint AS generation,search_grams,has_payload_id,has_compression_summary
 FROM conversation_entries
 UNION ALL
 SELECT agent_id,session_id,source_store,source_id,ordinal,entry_key,entry,search_projection,
 created_at,archive_kind,generation,search_grams,has_payload_id,has_compression_summary
 FROM conversation_archive_entries;
`;

// Appended migration: originals remain json, candidate extraction may decode scalars.
export const POSTGRES_SESSION_ASCII_SEARCH_SCHEMA_SQL = `
CREATE OR REPLACE FUNCTION burrow_search_grams(payload text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE decoded text; runs text[]; bytes bytea; grams text[];
BEGIN
 -- jsonb decoding is confined to an individual string, never the original.
 IF json_typeof(payload::json) <> 'string' THEN RETURN NULL; END IF;
 BEGIN decoded := payload::jsonb #>> '{}';
 EXCEPTION WHEN OTHERS THEN RETURN NULL;
 END;
 -- ECMAScript lowercase introduces ASCII only for U+0130 and U+212A.
 -- The combining dot in U+0130 breaks the ASCII run after i.
 decoded := replace(replace(decoded,chr(304),'i' || chr(775)),chr(8490),'k');
 decoded := translate(decoded,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
 -- Split once, before byte slicing: never build UTF8 fragments across non-ASCII.
 IF octet_length(decoded)=length(decoded) THEN runs := ARRAY[decoded];
 ELSE runs := regexp_split_to_array(decoded COLLATE "C",'[^\\x01-\\x7F]+'); END IF;
 grams := ARRAY[]::text[];
 FOR decoded IN SELECT DISTINCT r FROM unnest(runs) r WHERE octet_length(r)>=3 LOOP
  bytes := convert_to(decoded,'UTF8');
  SELECT array_agg(DISTINCT convert_from(substring(bytes FROM n FOR 3),'UTF8')) INTO runs
  FROM generate_series(1,octet_length(bytes)-2) n;
  grams := grams || runs;
 END LOOP;
 RETURN grams;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION burrow_entry_search_grams(payload json) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item record; tokens json[]; part text[]; result text[] := ARRAY[]::text[];
BEGIN
 IF json_typeof(payload) <> 'object' THEN RETURN NULL; END IF;
 -- json_each decodes keys. Duplicate relevant keys are uncertain (JS last wins,
 -- lexical lookup first wins), so bypass; escaped keys must also bypass.
 IF EXISTS (SELECT 1 FROM json_each(payload) WHERE key IN ('id','role','type','visibility','content') GROUP BY key HAVING count(*)>1) THEN RETURN NULL; END IF;
 tokens := burrow_json_metadata(payload);
 FOR item IN SELECT key,value FROM json_each(payload) WHERE key IN ('id','role','type','visibility','content') LOOP
  IF tokens[array_position(ARRAY['id','role','type','visibility','content'],item.key)] IS NULL THEN RETURN NULL; END IF;
  part := burrow_search_grams(item.value::text);
  IF part IS NULL THEN RETURN NULL; END IF;
  result := result || part;
 END LOOP;
 RETURN ARRAY(SELECT DISTINCT g FROM unnest(result) g);
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION burrow_project_native_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tokens json[]; part text[]; grams text[] := ARRAY[]::text[]; k int;
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF OLD.has_payload_id IS NOT NULL AND NEW.entry::text IS NOT DISTINCT FROM OLD.entry::text THEN
   NEW.has_payload_id := OLD.has_payload_id;
   NEW.has_compression_summary := OLD.has_compression_summary;
   NEW.search_projection := OLD.search_projection;
   NEW.search_grams := OLD.search_grams;
   IF TG_TABLE_NAME = 'conversation_entries' THEN
    IF OLD.has_payload_id THEN NEW.entry_key := OLD.entry_key;
    ELSE NEW.entry_key := to_json(NEW.entry_id)::text; END IF;
   ELSE NEW.entry_key := OLD.entry_key; END IF;
   RETURN NEW;
  END IF;
 END IF;
 tokens := burrow_json_metadata(NEW.entry);
 NEW.has_payload_id := tokens[1] IS NOT NULL;
 NEW.entry_key := tokens[1]::text;
 IF TG_TABLE_NAME = 'conversation_entries' THEN
  NEW.entry_key := COALESCE(NEW.entry_key,to_json(NEW.entry_id)::text);
 END IF;
 NEW.search_projection := COALESCE(tokens[5]::text,'');
 NEW.has_compression_summary := tokens[7] IS NOT NULL;
 NEW.search_grams := burrow_entry_search_grams(NEW.entry);
 RETURN NEW;
END $$;
-- Invalidate the no-payload-change shortcut to recompute existing rows.
UPDATE conversation_entries SET has_payload_id=NULL;
UPDATE conversation_archive_entries SET has_payload_id=NULL;
`;

export const POSTGRES_SESSION_FULL_SCHEMA_SQL = POSTGRES_SESSION_SCHEMA_SQL + POSTGRES_SESSION_ARCHIVE_SCHEMA_SQL + POSTGRES_SESSION_LOSSLESS_JSON_SCHEMA_SQL + POSTGRES_SESSION_OPERATOR_LOOKUP_SCHEMA_SQL + POSTGRES_SESSION_ORIGINAL_LOOKUP_SCHEMA_SQL + POSTGRES_SESSION_ORIGINAL_ROWS_SCHEMA_SQL + POSTGRES_SESSION_SEARCH_SCHEMA_SQL + POSTGRES_SESSION_NATIVE_SCHEMA_SQL + POSTGRES_SESSION_METADATA_SCHEMA_SQL + POSTGRES_SESSION_ASCII_SEARCH_SCHEMA_SQL + POSTGRES_CONTINUITY_STATE_SCHEMA_SQL + POSTGRES_RESET_INSTANT_SQL + POSTGRES_HISTORY_KEYSET_SQL + POSTGRES_LOGICAL_MEMBER_SQL + POSTGRES_ARCHIVE_RELATIONAL_ID_SQL + POSTGRES_CATALOG_SCALAR_ID_SQL + POSTGRES_LOGICAL_LOOKUP_INDEX_SQL + POSTGRES_AGENT_DELIVERY_SCHEMA_SQL + POSTGRES_AGENT_DELIVERY_OWNER_SQL + POSTGRES_OPERATOR_INSTANT_SQL + POSTGRES_ARCHIVE_LISTING_INDEX_SQL + POSTGRES_COMPACTION_PROJECTIONS_SQL + POSTGRES_ARCHIVE_LEXICAL_SQL + POSTGRES_ARCHIVE_CHAT_PROJECTION_SQL + POSTGRES_ARCHIVE_DISCOVERY_INDEX_SQL;

const text = (value) => String(value ?? '');
const required = (value, name) => { const result = text(value).trim(); if (!result) throw new Error(`${name} is required`); return result; };
const stamp = () => new Date().toISOString();
// These are bounded index probes with cold scalar coercion branches. PostgreSQL
// otherwise JIT-compiles every (mostly unexecuted) branch based on conservative
// JSON-function costs; compilation can dwarf the millisecond candidate read.
// Transaction-local only: never change a shared pooled connection's defaults.
function sessionReadQuery(pool, sql, values, { signal, deadline } = {}) {
  if (deadline !== undefined) return archiveReadQuery(pool, sql, values, { signal, deadline });
  return signal ? withPostgresTransaction(pool, client => client.query(sql, values), { signal }) : pool.query(sql, values);
}

// Reset listing counts are advisory metadata unless tied to the exact source
// revisions used by that listing statement. Keep the bounded cache per pool;
// new processes reconstruct on first use, and SQL edits cannot leave it stale.
const resetListingCountsByPool = new WeakMap();
const RESET_LISTING_COUNT_CACHE_LIMIT = 512;

const cursorValue = (value, name = 'after') => {
  if (value === undefined || value === null || value === '') return 0n;
  const result = typeof value === 'bigint' ? value : (typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : (typeof value === 'string' && /^[0-9]+$/.test(value) ? BigInt(value) : null));
  if (result === null || result < 0n) throw new Error(`${name} must be a non-negative integer cursor`);
  return result;
};
const limitValue = (value) => {
  if (value === undefined || value === null || value === '') return 20;
  if ((typeof value === 'number' && Number.isInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value))) return Number(value);
  throw new Error('limit must be a positive integer');
};
// Canonical occurrence precedence: live, generation, source ID, earliest archive ordinal.
function originalNewerSQL(row = 'r', newer = 'newer') {
  return `(${newer}.source_store>${row}.source_store OR
    (${newer}.source_store=${row}.source_store AND
      CASE WHEN ${row}.source_store='live' THEN ${newer}.ordinal>${row}.ordinal ELSE
        ${newer}.generation>${row}.generation OR (${newer}.generation=${row}.generation AND
          (${newer}.source_id>${row}.source_id OR (${newer}.source_id=${row}.source_id AND ${newer}.ordinal<${row}.ordinal))) END))`;
}

// Archive discovery uses catalog rows plus time-indexed native occurrences. The
// generation window and winner probes mirror transcript reconstruction; a stale
// snapshot's timestamp/visibility must not create a ghost conversation day.
function archiveRowsSQL({ occurrences = true } = {}) {
  return `archive_rows AS (
    SELECT s.agent_id,s.session_id AS id,s.session_id,NULL::text AS source_session_id,
      false AS archive_snapshot,s.metadata,s.created_at,s.updated_at,
      ${occurrences ? `COALESCE((s.metadata->>'resetGeneration')::bigint,
        (SELECT max(r.generation)+1 FROM conversation_archives r
          WHERE r.agent_id=s.agent_id AND r.session_id=s.session_id AND r.kind='reset'),0)` : '0::bigint'} AS min_generation,
      NULL::bigint AS max_generation
    FROM conversation_sessions s WHERE s.agent_id=$1
      AND NULLIF(s.metadata->'contextIsolation'->>'historySessionId','') IS NULL
      AND ($2::boolean OR COALESCE((s.metadata->>'archived')::boolean,false)=false)
    UNION ALL
    SELECT a.agent_id,a.archive_id,a.session_id,COALESCE(NULLIF(a.metadata->>'sourceSessionId',''),a.session_id),
      true,a.metadata,a.created_at,a.created_at,
      ${occurrences ? `COALESCE((a.metadata->>'resetGeneration')::bigint,
        (SELECT max(r.generation)+1 FROM conversation_archives r
          WHERE r.agent_id=a.agent_id AND r.session_id=a.session_id AND r.kind='reset' AND r.generation<a.generation),0)` : '0::bigint'},
      a.generation
    FROM conversation_archives a WHERE a.agent_id=$1 AND a.kind='reset'
      AND NULLIF(a.metadata->'contextIsolation'->>'historySessionId','') IS NULL
  )`;
}

function archiveOccurrenceDaysSQL({ start, end, timezone }) {
  const branch = live => `SELECT e.agent_id,e.session_id,'${live ? 'live' : 'archive'}'::text AS source_store,
      ${live ? 'e.sequence::text' : 'e.source_id'} AS source_id,${live ? 'e.sequence' : 'e.ordinal'} AS ordinal,
      e.entry_key,e.has_payload_id,e.entry_id,CASE WHEN e.has_payload_id IS NULL THEN e.entry END AS entry,
      ${live ? 'NULL::bigint' : 'e.generation'} AS generation,${live ? 'NULL::text' : 'e.archive_kind'} AS archive_kind,
      e.archive_chat_at AS occurrence_at
      FROM ${live ? 'conversation_entries' : 'conversation_archive_entries'} e
      WHERE e.agent_id=$1 AND e.archive_chat_projected AND e.archive_chat_visible
        AND e.archive_chat_at>=${start}::timestamptz AND e.archive_chat_at<${end}::timestamptz`;
  const grandfathered = live => `SELECT e.agent_id,e.session_id,'${live ? 'live' : 'archive'}'::text AS source_store,
      ${live ? 'e.sequence::text' : 'e.source_id'} AS source_id,${live ? 'e.sequence' : 'e.ordinal'} AS ordinal,
      e.entry_key,e.has_payload_id,e.entry_id,CASE WHEN e.has_payload_id IS NULL THEN e.entry END AS entry,
      ${live ? 'NULL::bigint' : 'e.generation'} AS generation,${live ? 'NULL::text' : 'e.archive_kind'} AS archive_kind,
      g.instant AS occurrence_at
      FROM ${live ? 'conversation_live_chat_grandfathered' : 'conversation_archive_chat_grandfathered'} g
      JOIN ${live ? 'conversation_entries' : 'conversation_archive_entries'} e ON e.agent_id=g.agent_id AND e.session_id=g.session_id
        AND ${live ? 'e.sequence=g.sequence' : 'e.source_store=g.source_store AND e.source_id=g.source_id AND e.ordinal=g.ordinal'}
      WHERE g.agent_id=$1 AND NOT e.archive_chat_projected AND g.visible
        AND g.instant>=${start}::timestamptz AND g.instant<${end}::timestamptz`;
  // Only the not-yet-checkpointed portion needs a lexical parse. Completed
  // side projections (including invisible/undated ones) are excluded by key.
  // The state, original and side table are all read under one MVCC snapshot.
  const pending = live => {
    const table = live ? 'conversation_entries' : 'conversation_archive_entries';
    const side = live ? 'conversation_live_chat_grandfathered' : 'conversation_archive_chat_grandfathered';
    const keys = live ? ['agent_id','session_id','sequence'] : ['agent_id','session_id','source_store','source_id','ordinal'];
    const checkpoint = live ? ['live_agent','live_session','live_sequence'] : ['archive_agent','archive_session','archive_store','archive_source','archive_ordinal'];
    return `SELECT e.agent_id,e.session_id,'${live ? 'live' : 'archive'}'::text AS source_store,
      ${live ? 'e.sequence::text' : 'e.source_id'} AS source_id,${live ? 'e.sequence' : 'e.ordinal'} AS ordinal,
      e.entry_key,e.has_payload_id,e.entry_id,CASE WHEN e.has_payload_id IS NULL THEN e.entry END AS entry,
      ${live ? 'NULL::bigint' : 'e.generation'} AS generation,${live ? 'NULL::text' : 'e.archive_kind'} AS archive_kind,
      p.instant AS occurrence_at
      FROM (SELECT e.* FROM (SELECT * FROM burrow_archive_chat_backfill state
          WHERE state.id AND NOT state.${live ? 'live_done' : 'archive_done'} OFFSET 0) state
        CROSS JOIN LATERAL (SELECT * FROM ${table} e WHERE e.agent_id=$1 AND NOT e.archive_chat_projected
          AND (e.agent_id>state.${checkpoint[0]} OR (e.agent_id=state.${checkpoint[0]}
            AND (${keys.slice(1).map(key => `e.${key}`).join(',')})>(${checkpoint.slice(1).map(key => `state.${key}`).join(',')}))
            OR (state.${checkpoint[0]} IS NULL AND (e.agent_id,e.session_id)>=($1,'')))
          AND NOT EXISTS (SELECT 1 FROM ${side} g WHERE ${keys.map(key => `g.${key}=e.${key}`).join(' AND ')}) OFFSET 0) e OFFSET 0) e
      CROSS JOIN LATERAL burrow_archive_chat_projection(e.entry,
        COALESCE(e.search_projection,burrow_json_member(e.entry,'content')::text,'')) p
      WHERE p.visible AND p.instant>=${start}::timestamptz AND p.instant<${end}::timestamptz`;
  };
  // Separate indexed probes keep ordinary string-ID candidates on the logical
  // identity index. Only non-string/falsey identity cases need scalar coercion;
  // an absent relational ID never deduplicates unrelated legacy occurrences.
  const identities = [
    `c.payload_key IS NOT NULL AND c.payload_key<>'' AND n.has_payload_id
      AND burrow_history_key(n.entry_key)=c.payload_key`,
    `c.payload_key IS NOT NULL AND n.has_payload_id = true
      AND burrow_history_key(n.entry_key) IS NULL AND ${archivePayloadKeySQL('n')}=c.payload_key`,
    // A v81-grandfathered NULL marker can have a non-null relational entry_key
    // that is NOT the payload ID. Always parse that cold branch independently.
    `c.payload_key IS NOT NULL AND n.has_payload_id IS NULL
      AND ${archivePayloadKeySQL('n')}=c.payload_key`,
    `c.payload_key IS NULL AND NULLIF(c.entry_id,'') IS NOT NULL
      AND n.entry_id<>'' AND n.entry_id=c.entry_id AND NOT ${archiveTruthyPayloadSQL('n')}`,
  ];
  const probes = identities.flatMap(identity => [
    `NOT EXISTS (SELECT 1 FROM conversation_entries n
      WHERE NOT d.archive_snapshot AND n.agent_id=c.agent_id AND n.session_id=c.session_id
        AND ${identity} AND (c.source_store='archive' OR n.sequence<c.ordinal) OFFSET 0)`,
    `NOT EXISTS (SELECT 1 FROM conversation_archive_entries n
      WHERE c.source_store='archive' AND n.agent_id=c.agent_id AND n.session_id=c.session_id
        AND ${identity}
        AND ((d.archive_snapshot AND n.source_id=d.id)
          OR (n.archive_kind='compacted' AND n.generation>=d.min_generation
            AND (d.max_generation IS NULL OR n.generation<=d.max_generation)))
        AND ((d.archive_snapshot AND n.source_id=d.id AND c.source_id<>d.id)
          OR (n.source_id=c.source_id AND n.ordinal<c.ordinal)
          OR ((NOT d.archive_snapshot OR c.source_id<>d.id)
            AND (n.generation>c.generation OR (n.generation=c.generation AND n.source_id>c.source_id)))) OFFSET 0)`,
  ]);
  return `occurrence_windows AS MATERIALIZED (${[branch(true), branch(false), grandfathered(true), grandfathered(false), pending(true), pending(false)].map(sql => `(${sql})`).join(' UNION ALL ')}),
    occurrence_candidates AS MATERIALIZED (
      SELECT e.agent_id,e.session_id,e.source_store,e.source_id,e.ordinal,e.entry_id,e.generation,e.archive_kind,
        to_char(e.occurrence_at AT TIME ZONE ${timezone},'YYYY-MM-DD') AS day,
        ${archivePayloadKeySQL('e')} AS payload_key FROM occurrence_windows e),
    matched_days AS (
      SELECT DISTINCT d.agent_id,d.id,c.day FROM occurrence_candidates c
      JOIN archive_rows d ON d.agent_id=c.agent_id AND d.session_id=c.session_id
        AND ((NOT d.archive_snapshot AND c.source_store='live')
          OR (c.source_store='archive' AND ((d.archive_snapshot AND c.source_id=d.id)
            OR (c.archive_kind='compacted' AND c.generation>=d.min_generation
              AND (d.max_generation IS NULL OR c.generation<=d.max_generation)))))
      WHERE ${probes.join('\n        AND ')}
    )`;
}

function rowEntry(row) { return row ? { ...row.entry, sequence: String(row.sequence) } : null; }
function proofRunKey(entry = {}) {
  const runId = typeof entry?.runId === 'string' ? entry.runId : '';
  return runId ? Buffer.from(JSON.stringify(runId), 'utf8').toString('hex') : null;
}

// Preserve first transcript position while later snapshots replace payloads.
// Relational occurrence IDs keep equal-content id-less messages distinct.
function mergeTranscriptSnapshots(snapshots) {
  const entries = []; const positions = new Map();
  for (const snapshot of snapshots) {
    const seen = new Set();
    for (const occurrence of snapshot) {
      const entry = occurrence.entry;
      const identity = entry?.id ? `payload:${entry.id}` : occurrence.occurrence ? `occurrence:${occurrence.occurrence}` : null;
      if (!identity) { entries.push(entry); continue; }
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (positions.has(identity)) entries[positions.get(identity)] = entry;
      else { positions.set(identity, entries.length); entries.push(entry); }
    }
  }
  return entries;
}

export function assertConversationDeletionAllowed(sessionId, metadata = {}) {
  if (['running', 'finalizing'].includes(metadata.continuityHead?.state)) throw new Error('session_retention_active');
  if (metadata.current === true || metadata.currentMain === true || (['main', 'default'].includes(sessionId) && (!metadata.kind || metadata.kind === 'main'))) throw new Error('retention_refused_current_main');
}

/** Staged PostgreSQL authority boundary; callers explicitly own the pool. */
export class PostgresSessionStore {
  constructor({ pool, ownsPool = false, clock = stamp } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('session_postgres_pool_required');
    this.pool = normalizePostgresPool(pool); this.ownsPool = ownsPool; this.clock = clock; this.proofProjection = null; this.archiveDateProjection = null; this.archiveNativeCatalogTime = null;
  }
  async hasProofProjection(client = this.pool) {
    // Callers already holding a transaction must use that checked-out client.
    // Querying the pool here self-deadlocks when its only connection is the
    // transaction waiting for this capability check to finish.
    // A pending probe belongs to its transaction: sharing it couples unrelated
    // owners' cancellation and can keep a cancelled waiter holding its locks.
    // Only cache a completed boolean; cold callers probe on their own client.
    if (this.proofProjection !== null) return this.proofProjection;
    const result = await client.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='conversation_entries' AND column_name='run_key') AS available`);
    const available = result.rows[0]?.available === true;
    // An older probe must not replace a result already installed by another.
    if (this.proofProjection === null) this.proofProjection = available;
    return available;
  }
  async hasArchiveDateProjection(client = this.pool) {
    if (this.archiveDateProjection !== null) return this.archiveDateProjection;
    const { rows } = await client.query(`SELECT
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='conversation_entries' AND column_name='dream_at') AS available,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='conversation_sessions' AND column_name='updated_at' AND udt_name='timestamptz') AS native_catalog_time`);
    this.archiveNativeCatalogTime = rows[0]?.native_catalog_time === true;
    return this.archiveDateProjection = rows[0]?.available === true;
  }
  get agentDeliveries() { return this.deliveryStore ||= new PostgresAgentDeliveryStore(this.pool); }
  async claimAgentMessageDelivery({ deliveryId, request } = {}) {
    return this.agentDeliveries.claim({ deliveryId: required(deliveryId, 'deliveryId'), request: request && typeof request === 'object' ? request : {} });
  }
  async completeAgentMessageDelivery(args = {}) {
    required(args.deliveryId, 'deliveryId');
    return this.agentDeliveries.complete(args);
  }
  async readAgentMessageDelivery({ deliveryId } = {}) {
    return this.agentDeliveries.read(required(deliveryId, 'deliveryId'));
  }
  async assertAgentMessageDeliveryOwner(args) { return this.agentDeliveries.assertOwner(args); }
  async executeAgentMessageDelivery(args, work) { return this.agentDeliveries.execute(args, work); }

  async deleteSession({agentId: rawAgentId, sessionId: rawSessionId, retentionPolicy = null} = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const sessionId = required(rawSessionId, 'sessionId');
    return withPostgresTransaction(this.pool, async client => {
      // Lock the authority row before cascaded deletion; active continuity is
      // never eligible even if a retention plan was built before a new run.
      const selected = await client.query('SELECT metadata,updated_at FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sessionId]);
      if (!selected.rows.length) return {deleted:false};
      const active = await client.query('SELECT head_state,queue_status FROM continuity_state WHERE agent_id=$1 AND session_id=$2',[agentId,sessionId]);
      if (['running','finalizing'].includes(active.rows[0]?.head_state) || active.rows[0]?.queue_status==='running') throw new Error('session_retention_active');
      assertConversationDeletionAllowed(sessionId, selected.rows[0].metadata);
      const metadata = selected.rows[0].metadata;
      // Retention must re-evaluate age, kind and terminal task ownership under
      // locks, not trust a plan made before a task reopen or metadata edit.
      if (retentionPolicy) {
        const taskStore = { getTask: async taskId => {
          const result = await client.query('SELECT status,metadata_json FROM task_board_tasks WHERE id=$1 FOR UPDATE', [taskId]);
          return result.rows[0] && { status: result.rows[0].status, metadata: result.rows[0].metadata_json };
        } };
        if (!await retentionSessionCandidate({ record: { ...metadata, updatedAt: selected.rows[0].updated_at, id: sessionId }, taskStore, ...retentionPolicy, agentId })) return { deleted: false };
      } else if (metadata.kind === 'task' || (metadata.kind && metadata.kind !== 'main' && !metadata.completedAt)) {
        throw new Error('session_retention_eligibility_required');
      }
      const result = await client.query('DELETE FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2', [agentId, sessionId]);
      return {deleted:result.rowCount === 1};
    });
  }

  async close() { await this.deliveryStore?.close(); await closeContinuityOwners(this.pool); if (this.ownsPool) await closePostgresPool(this.pool); }

  /** Original JSON is decoded in JS: SQL JSON extraction is not lossless for NUL. */
  async history({ agentId, scope = 'agent', query, cursor = '', signal, budgetMs = resolveAlbdruckConfig().historyBudgetMs, pageSize = Math.min(50, resolveAlbdruckConfig().maxPageSize) } = {}) {
    if (!['agent', 'global'].includes(scope) || (scope === 'agent' && (typeof agentId !== 'string' || !agentId.trim()))) throw new Error('albdruck_scope_invalid');
    if (typeof query !== 'string' || !query.trim()) throw new Error('albdruck_query_required');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > resolveAlbdruckConfig().maxPageSize) throw new Error('albdruck_page_size_invalid');
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1) throw new Error('history_budget_invalid');
    const deadline = performance.now() + budgetMs;
    const binding = JSON.stringify([scope, scope === 'agent' ? agentId : null, query.trim()]);
    let after = null;
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (value.v !== 1 || value.binding !== binding || !Array.isArray(value.key) || value.key.length !== 3 || value.key.some(x => typeof x !== 'string')) throw new Error();
        after = value.key;
      } catch { throw new Error('albdruck_cursor_invalid'); }
    } else if (typeof cursor !== 'string') throw new Error('albdruck_cursor_invalid');
    signal?.throwIfAborted();
    const originals = [];
    const sortKey = value => Array.from({ length: value.length }, (_, i) => value.charCodeAt(i).toString(16).padStart(4, '0')).join('');
    const consider = row => {
      const entry = row.entry;
      if (entry?.type !== 'message' || entry.metadata?.compressionSummary || !['user','assistant','agent'].includes(entry.role) || typeof entry.content !== 'string') return;
      const entryId = entry.id || (row.entry_key ? JSON.parse(row.entry_key) : null);
      if (typeof entryId !== 'string' || !entryId || !matchesQuery(entry, query.trim())) return;
      originals.push({ key: [row.agent_id, row.session_id, entryId], item: {
        agentId: row.agent_id, sessionId: row.session_id, entryId,
        timestamp: entry.timestamp ?? entry.ts ?? row.created_at, role: entry.role, content: entry.content,
        sourceRef: { kind: 'conversation_entry', agentId: row.agent_id, sessionId: row.session_id, entryId },
        provenance: row.source_store === 'live' ? { store: 'live', reset: false } :
          { store: 'archive', reset: row.archive_kind === 'reset', archiveId: row.source_id,
            kind: row.archive_kind, generation: Number(row.generation), archivedAt: row.created_at },
      } });
    };
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/gu)?.filter(t => t.length >= 3) || [])];
    // OR is intentionally broader than the two-term coverage rule; exact phrase
    // and cross-field matches must not be lost. Final matchesQuery removes noise.
    const grams = terms.map(term => [...new Set(Array.from({ length: term.length - 2 }, (_, i) => term.slice(i, i + 3)))]);
    const candidate = grams.length ? `AND (search_grams IS NULL OR ${grams.map((_, i) => `search_grams @> $${i + 5}::text[]`).join(' OR ')})` : '';
    // One repeatable-read snapshot keeps reset/compaction from hiding a turn during scanning.
    return withPostgresTransaction(this.pool, async client => {
      signal?.throwIfAborted();
      // Disconnecting the dedicated transaction socket cancels active server work
      // without requiring a second pool connection (which may itself be exhausted).
      const abort = () => { void client.end?.(); };
      signal?.addEventListener('abort', abort, { once: true });
      let expired = false;
      const timer = setTimeout(() => { expired = true; abort(); }, Math.max(1, deadline - performance.now()));
      timer.unref?.();
      try {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SELECT set_config('lock_timeout',$1,true)", [String(Math.min(budgetMs, resolveAlbdruckConfig().historyLockTimeoutMs))]);
        let position = after?.map(sortKey) || null;
        for (;;) {
          signal?.throwIfAborted();
          const remaining = Math.floor(deadline - performance.now());
          if (remaining < 1) throw new Error('history_query_budget_exceeded');
          await client.query("SELECT set_config('statement_timeout',$1,true)", [String(remaining)]);
          const branch = store => `SELECT r.agent_id,r.session_id,'${store}'::text AS source_store,
            ${store === 'live' ? "r.sequence::text AS source_id,r.sequence AS ordinal,r.entry_key,r.entry,r.created_at,NULL::text AS archive_kind,NULL::bigint AS generation" : "r.source_id,r.ordinal,r.entry_key,r.entry,r.created_at,r.archive_kind,r.generation"}
            FROM ${store === 'live' ? 'conversation_entries' : 'conversation_archive_entries'} r
            WHERE ($1::text IS NULL OR agent_id=$1)
            AND ($2::text IS NULL OR
              (burrow_history_text(agent_id) COLLATE "C",burrow_history_text(session_id) COLLATE "C",burrow_history_key(entry_key) COLLATE "C") > ($2,$3,$4))
            AND burrow_history_key(entry_key) IS NOT NULL
            ${candidate}
            AND NOT EXISTS (SELECT 1 FROM conversation_original_rows newer
              WHERE newer.agent_id=r.agent_id AND newer.session_id=r.session_id AND burrow_history_key(newer.entry_key)=burrow_history_key(r.entry_key)
              AND (newer.source_store>'${store}' OR
                (newer.source_store='${store}' AND
                  (CASE WHEN '${store}'='live' THEN newer.ordinal>${store === 'live' ? 'r.sequence' : 'r.ordinal'} ELSE
                    newer.generation>${store === 'live' ? 'NULL::bigint' : 'r.generation'} OR (newer.generation=${store === 'live' ? 'NULL::bigint' : 'r.generation'} AND
                      (newer.source_id>${store === 'live' ? 'r.sequence::text' : 'r.source_id'} OR (newer.source_id=${store === 'live' ? 'r.sequence::text' : 'r.source_id'} AND newer.ordinal<${store === 'live' ? 'r.sequence' : 'r.ordinal'}))) END))))
            ORDER BY burrow_history_text(agent_id) COLLATE "C",burrow_history_text(session_id) COLLATE "C",burrow_history_key(entry_key) COLLATE "C" LIMIT 256`;
          const order = `burrow_history_text(agent_id) COLLATE "C",burrow_history_text(session_id) COLLATE "C",burrow_history_key(entry_key) COLLATE "C"`;
          const { rows } = await client.query(`SELECT * FROM ((${branch('live')}) UNION ALL (${branch('archive')})) candidates ORDER BY ${order} LIMIT 256`,
          [scope === 'agent' ? agentId : null, ...(position || [null,null,null]), ...grams]);
          for (const row of rows) {
            signal?.throwIfAborted();
            consider(row);
            if (originals.length > pageSize) break;
          }
          if (originals.length > pageSize || rows.length < 256) break;
          const last = rows.at(-1);
          position = [last.agent_id,last.session_id,JSON.parse(last.entry_key)].map(sortKey);
        }
        const ordered = originals;
        const page = ordered.slice(0,pageSize);
        return { items: page.map(x => x.item), nextCursor: ordered.length > pageSize ? Buffer.from(JSON.stringify({ v: 1, binding, key: page.at(-1).key })).toString('base64url') : null };
      } catch (error) {
        signal?.throwIfAborted();
        if (expired || error?.code === '57014') throw new Error('history_query_budget_exceeded', { cause: error });
        throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }, { deadline, signal });
  }

  // Dream-only raw chronological timeline. No Albdruck search, logical-key
  // authority reconciliation. Legacy Dream suppressed truthy IDs per session;
  // preserve that acquisition-first rule without authority joins. Equal instants
  // retain deterministic session/store/source/ordinal acquisition order.
  async dreamTimeline({ agentId, since, until, signal } = {}) {
    return withPostgresTransaction(this.pool, async client => {
      signal?.throwIfAborted();
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const abort = () => { void client.end?.(); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const entries = []; const seen = new Map();
        const branch = live => `SELECT agent_id,session_id,'${live ? 'live' : 'archive'}'::text AS source_store,
            ${live ? 'sequence::text' : 'source_id'} AS source_id,${live ? 'sequence' : 'ordinal'} AS ordinal,entry,created_at,entry_key,${live ? 'NULL::bigint' : 'generation'} AS generation
            FROM ${live ? 'conversation_entries' : 'conversation_archive_entries'}
            WHERE agent_id=$1 AND (dream_at BETWEEN $2::timestamptz AND $3::timestamptz OR dream_at IS NULL)`;
        await client.query(`DECLARE dream_timeline NO SCROLL CURSOR FOR
          SELECT r.* FROM ((${branch(true)}) UNION ALL (${branch(false)})) r
          ORDER BY session_id,source_store DESC,
            CASE WHEN source_store='live' THEN ordinal END ASC,
            generation DESC NULLS LAST,source_id DESC,ordinal ASC`,
          [required(agentId,'agentId'),since,until]);
        for (;;) {
          signal?.throwIfAborted();
          const { rows } = await client.query('FETCH FORWARD 256 FROM dream_timeline');
          for (const row of rows) {
            signal?.throwIfAborted();
            let ids = seen.get(row.session_id);
            if (!ids) { ids = new Set(); seen.set(row.session_id, ids); }
            if (row.entry?.id && ids.has(String(row.entry.id))) continue;
            if (row.entry?.id) ids.add(String(row.entry.id));
            entries.push({ ...row.entry, __sessionId: row.session_id, __storedAt: row.created_at });
          }
          if (rows.length < 256) break;
        }
        await client.query('CLOSE dream_timeline');
        // Legacy addEntries used the first truthy ID per session, even when
        // subsequent payloads differed. Id-less occurrences remain separate.
        // JS date parsing matches Dream eligibility for unknown legacy dates.
        const instant = entry => Date.parse(entry.timestamp ?? entry.ts ?? entry.at ?? entry.createdAt ?? entry.__storedAt);
        return entries.sort((a, b) => {
          const left = instant(a), right = instant(b);
          return (Number.isFinite(left) ? left : Infinity) - (Number.isFinite(right) ? right : Infinity) || 0;
        });
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      } finally { signal?.removeEventListener('abort', abort); }
    }, { signal });
  }

  // Shared original-history projection for Dream and conversation context.
  // Live wins over snapshots; snapshot precedence matches resolveOriginal.
  // One stable snapshot, indexed occurrence candidates, bounded transfer batches.
  async dreamWindow({ agentId, since, until, signal } = {}) {
    return withPostgresTransaction(this.pool, async client => {
      signal?.throwIfAborted();
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const abort = () => { void client.end?.(); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        // OFFSET 0 keeps the existence check parameterized by each candidate.
        // Without this fence PostgreSQL can decorrelate it into a merge anti-join,
        // sorting the entire retained authority again for every 256-row page.
        // The authority is deliberately NOT time-filtered: an out-of-window
        // occurrence can still supersede an in-window original.
        const entries = []; let after = null;
        for (;;) {
          signal?.throwIfAborted();
          const branch = live => `SELECT agent_id,session_id,'${live ? 'live' : 'archive'}'::text AS source_store,
            ${live ? 'sequence::text' : 'source_id'} AS source_id,${live ? 'sequence' : 'ordinal'} AS ordinal,entry,created_at,entry_key,${live ? 'NULL::bigint' : 'generation'} AS generation
            FROM ${live ? 'conversation_entries' : 'conversation_archive_entries'}
            WHERE agent_id=$1 AND (dream_at BETWEEN $2::timestamptz AND $3::timestamptz OR dream_at IS NULL)`;
          const { rows } = await client.query(`SELECT r.* FROM ((${branch(true)}) UNION ALL (${branch(false)})) r
            WHERE ($4::text IS NULL OR (session_id,source_store,source_id,ordinal)>($4,$5,$6,$7::bigint))
            AND NOT EXISTS (SELECT 1 FROM conversation_original_rows newer
              WHERE newer.agent_id=r.agent_id AND newer.session_id=r.session_id
              AND burrow_history_key(newer.entry_key)=burrow_history_key(r.entry_key) AND ${originalNewerSQL()} OFFSET 0)
            ORDER BY session_id,source_store,source_id,ordinal LIMIT 256`,
            [required(agentId,'agentId'),since,until,...(after || [null,null,null,null])]);
          for (const row of rows) entries.push({ ...row.entry, __sessionId: row.session_id,
            __storedAt: row.created_at });
          if (rows.length < 256) break;
          const last = rows.at(-1); after = [last.session_id,last.source_store,last.source_id,String(last.ordinal)];
        }
        return entries;
      } finally { signal?.removeEventListener('abort', abort); }
    });
  }

  // Resolve each logical ID through the same indexed precedence as resolveOriginal.
  // LATERAL keeps each probe parameterized, not a retained-history scan.
  async listOriginalEntriesById({ agentId: rawAgentId, sessionId: rawSessionId, entryIds, signal } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const sessionId = required(rawSessionId, 'sessionId');
    if (!Array.isArray(entryIds) || entryIds.some(id => typeof id !== 'string')) throw new TypeError('entry_ids_invalid');
    signal?.throwIfAborted();
    const ids = [...new Set(entryIds)];
    if (!ids.length) return [];
    return withPostgresTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const entries = [];
      for (let offset = 0; offset < ids.length; offset += 256) {
        signal?.throwIfAborted();
        const { rows } = await client.query(`SELECT winner.entry,winner.ordinal,winner.created_at,winner.source_store,winner.source_id
          FROM unnest($3::text[]) AS requested(entry_key)
          CROSS JOIN LATERAL (SELECT entry,ordinal,created_at,source_store,source_id
            FROM conversation_original_rows
            WHERE agent_id=$1 AND session_id=$2 AND burrow_history_key(entry_key)=burrow_history_key(requested.entry_key)
            ORDER BY CASE WHEN source_store='live' THEN 0 ELSE 1 END,
              CASE WHEN source_store='live' THEN ordinal END DESC,generation DESC NULLS LAST,source_id DESC,ordinal LIMIT 1) winner`,
        [agentId, sessionId, ids.slice(offset, offset + 256).map(id => JSON.stringify(id))]);
        for (const row of rows) entries.push({ entry: row.entry, ordinal: BigInt(row.ordinal), createdAt: row.created_at, store: row.source_store, sourceId: row.source_id });
      }
      signal?.throwIfAborted();
      return entries.sort((a,b) => String(a.entry.timestamp ?? a.entry.ts ?? a.createdAt).localeCompare(String(b.entry.timestamp ?? b.entry.ts ?? b.createdAt)) || (a.store === b.store ? (a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : (a.sourceId < b.sourceId ? 1 : a.sourceId > b.sourceId ? -1 : 0)) : a.store === 'archive' ? -1 : 1)).map(row => row.entry);
    }, { signal });
  }

  async sessionSnapshot({ agentId: rawAgentId, sessionId: rawSessionId, signal } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sessionId = required(rawSessionId, 'sessionId');
    return withPostgresTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await client.query('SELECT metadata,created_at,updated_at FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2', [agentId, sessionId]);
      const row = result.rows[0];
      const metadata = row ? { ...row.metadata, createdAt: row.created_at, updatedAt: row.updated_at } : null;
      const entries = []; let after = '0';
      for (;;) {
        signal?.throwIfAborted();
        const page = await client.query('SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND sequence>$3::bigint ORDER BY sequence LIMIT 256', [agentId, sessionId, after]);
        entries.push(...page.rows.map(rowEntry));
        if (page.rows.length < 256) break;
        after = String(page.rows.at(-1).sequence);
      }
      signal?.throwIfAborted();
      return { entries, metadata, pendingActions: projectPendingActions(entries) };
    }, { signal });
  }

  async listOriginalEntries({ agentId: rawAgentId, sessionId: rawSessionId, signal } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const sessionId = required(rawSessionId, 'sessionId');
    return withPostgresTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const entries = []; const seen = new Set(); let position = null;
      for (;;) {
        signal?.throwIfAborted();
        const { rows } = await client.query(`SELECT source_store,source_id,ordinal,entry,created_at
          FROM conversation_original_rows r WHERE agent_id=$1 AND session_id=$2
          AND NOT EXISTS (SELECT 1 FROM conversation_original_rows newer
            WHERE newer.agent_id=r.agent_id AND newer.session_id=r.session_id
            AND burrow_history_key(newer.entry_key)=burrow_history_key(r.entry_key) AND ${originalNewerSQL()})
          AND ($3::text IS NULL OR
            (source_store,source_id,-ordinal)<($3::text,$4::text,-$5::bigint))
          ORDER BY source_store DESC,source_id DESC,ordinal ASC LIMIT 256`,
        [agentId, sessionId, ...(position || [null, null, null])]);
        // source_store DESC puts live before archive. Within a snapshot retain
        // the earliest duplicate occurrence, as resolveOriginal does.
        for (const row of rows) {
          const entry = row.entry;
          if (entry?.id && seen.has(entry.id)) continue;
          if (entry?.id) seen.add(entry.id);
          entries.push({ entry, ordinal: BigInt(row.ordinal), createdAt: row.created_at, store: row.source_store });
        }
        if (rows.length < 256) break;
        const last = rows.at(-1);
        position = [last.source_store, last.source_id, String(last.ordinal)];
      }
      return entries.sort((a,b) => String(a.entry.timestamp ?? a.entry.ts ?? a.createdAt).localeCompare(String(b.entry.timestamp ?? b.entry.ts ?? b.createdAt)) || (a.store === b.store ? (a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0) : a.store === 'archive' ? -1 : 1)).map(row => row.entry);
    }, { signal });
  }

  async resolveOriginal({ agentId, sessionId, entryId }, client = this.pool) {
    // Compare lossless UTF-16 logical keys, including NUL and lone surrogates.
    const { rows } = await client.query(`SELECT entry FROM conversation_original_rows
      WHERE agent_id=$1 AND session_id=$2 AND burrow_history_key(entry_key)=burrow_history_key($3)
      ORDER BY CASE WHEN source_store='live' THEN 0 ELSE 1 END,CASE WHEN source_store='live' THEN ordinal END DESC,generation DESC NULLS LAST,source_id DESC,ordinal LIMIT 1`,
    [agentId, sessionId, JSON.stringify(entryId)]);
    return rows[0]?.entry || null;
  }

  // Caller holds the authority row lock; shared with single append so replay,
  // archive idempotency and run projection remain identical for batch writes.
  async appendLocked(client, { agentId, sid, entry, idempotencyKey, now }) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('session_entry_required');
    const value = { ...entry };
    const entryId = text(value.id).trim() || randomUUID();
    const key = idempotencyKey == null ? (value.metadata?.idempotencyKey || null) : text(idempotencyKey);
    const replay = await findSessionReplay(client, agentId, sid, entryId, key);
    if (replay) return { ...rowEntry(replay), idempotent: true };
    const hasProofProjection = await this.hasProofProjection(client);
    const result = hasProofProjection
      ? await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at,run_key) VALUES($1,$2,$3,$4,$5::json,$6,$7) ON CONFLICT DO NOTHING RETURNING sequence,entry`, [agentId, sid, entryId, key, JSON.stringify(value), now, proofRunKey(value)])
      : await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at) VALUES($1,$2,$3,$4,$5::json,$6) ON CONFLICT DO NOTHING RETURNING sequence,entry`, [agentId, sid, entryId, key, JSON.stringify(value), now]);
    if (result.rows[0]) {
      await client.query('UPDATE conversation_sessions SET updated_at=$3 WHERE agent_id=$1 AND session_id=$2', [agentId, sid, now]);
      if (hasProofProjection && typeof value.runId === 'string' && value.runId) {
        const at = typeof value.ts === 'string' && value.ts ? value.ts : now;
        const completedAt = value.type === 'message' && value.role === 'assistant' ? at : null;
        await client.query(`INSERT INTO conversation_archive_runs(agent_id,session_id,run_key,run_id,started_at,completed_at,last_activity_at,sort_timestamp)
          VALUES($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$5::timestamptz,COALESCE($6,$5))
          ON CONFLICT(agent_id,session_id,run_key) DO UPDATE SET run_id=EXCLUDED.run_id,
            started_at=LEAST(conversation_archive_runs.started_at,EXCLUDED.started_at),
            completed_at=COALESCE(GREATEST(conversation_archive_runs.completed_at,EXCLUDED.completed_at),conversation_archive_runs.completed_at,EXCLUDED.completed_at),
            last_activity_at=GREATEST(conversation_archive_runs.last_activity_at,EXCLUDED.last_activity_at),
            sort_timestamp=COALESCE(GREATEST(conversation_archive_runs.completed_at,EXCLUDED.completed_at)::text,LEAST(conversation_archive_runs.started_at,EXCLUDED.started_at)::text,'')`,
        [agentId, sid, proofRunKey(value), value.runId, at, completedAt]);
      }
      return { ...rowEntry(result.rows[0]), idempotent: false };
    }
    const existing = await client.query(`SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND (entry_id=$3 OR ($4::text IS NOT NULL AND idempotency_key=$4::text)) ORDER BY sequence LIMIT 1`, [agentId, sid, entryId, key]);
    if (!existing.rows[0]) throw new Error('session_entry_conflict');
    return { ...rowEntry(existing.rows[0]), idempotent: true };

  }

  async append({ agentId: rawAgentId, sessionId: rawSessionId, entry, idempotencyKey = null } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('session_entry_required');
    const now = this.clock();
    return withPostgresTransaction(this.pool, async client => {
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT(agent_id,session_id) DO NOTHING`, [agentId, sid, now]);
      // Row lock serializes appenders before identity allocation, making commit-order paging complete.
      await client.query('SELECT 1 FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sid]);
      return this.appendLocked(client, { agentId, sid, entry, idempotencyKey, now });
    });
  }

  async appendBatchIfGeneration({ agentId: rawAgentId, sessionId: rawSessionId, expectedGeneration = 0, signal, entries } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId');
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('session_generation_invalid');
    if (!Array.isArray(entries)) throw new Error('session_entries_required');
    signal?.throwIfAborted();
    const now = this.clock();
    return withPostgresTransaction(this.pool, async client => {
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT(agent_id,session_id) DO NOTHING`, [agentId, sid, now]);
      const session = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sid]);
      const currentGeneration = Number(session.rows[0]?.metadata?.generation || 0);
      if (currentGeneration !== expectedGeneration) throw new Error('session_generation_stale');
      const results = [];
      for (const item of entries) {
        signal?.throwIfAborted();
        results.push(await this.appendLocked(client, { agentId, sid, entry: item?.entry, idempotencyKey: item?.idempotencyKey, now }));
      }
      signal?.throwIfAborted();
      return results;
    }, { signal });
  }
  async appendIfAbsent(args = {}) { return this.append(args); }

  async read({ agentId: rawAgentId, sessionId: rawSessionId, limit = 20, after = 0 , signal, deadline } = {}) {
    const readQuery = (sql, values) => sessionReadQuery(this.pool, sql, values, { signal, deadline });
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const size = limitValue(limit); const cursor = cursorValue(after);
    const result = await readQuery(`SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4`, [agentId, sid, cursor.toString(), size]);
    return result.rows.map(rowEntry);
  }

  async readMessageTail({ agentId: rawAgentId, sessionId: rawSessionId, limit = 200, before = null } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sessionId = required(rawSessionId, 'sessionId');
    const size = limitValue(limit); let cursor = before == null ? null : cursorValue(before).toString();
    const matches = [];
    while (matches.length <= size) {
      const { rows } = await this.pool.query(`SELECT sequence,entry FROM conversation_entries
        WHERE agent_id=$1 AND session_id=$2 AND ($3::bigint IS NULL OR sequence<$3::bigint)
        ORDER BY sequence DESC LIMIT $4`, [agentId, sessionId, cursor, 256]);
      for (const row of rows) {
        if (row.entry.type === 'message') matches.push(rowEntry(row));
        if (matches.length > size) break;
      }
      if (matches.length > size || rows.length < 256) break;
      cursor = String(rows.at(-1).sequence);
    }
    const hasMore = matches.length > size;
    const entries = matches.slice(0, size).reverse();
    return { entries, olderCursor: hasMore ? String(entries[0].sequence) : null };
  }

  async projection({ agentId, sessionId, visibility, limit, predicate = null }) {
    // Never invoke PostgreSQL JSON extraction on the entry: even extracting an
    // unrelated field decodes escaped NUL and fails with 22P05. Scan newest first
    // in bounded batches so the limit applies *after* visibility filtering.
    const aid = required(agentId, 'agentId'); const sid = required(sessionId, 'sessionId');
    const size = limitValue(limit); const matches = []; let before = null;
    while (matches.length < size) {
      const result = await this.pool.query(`SELECT sequence,entry FROM conversation_entries
        WHERE agent_id=$1 AND session_id=$2 AND ($3::bigint IS NULL OR sequence<$3::bigint)
        ORDER BY sequence DESC LIMIT $4`, [aid, sid, before, 256]);
      for (const row of result.rows) {
        if (row.entry.visibility === visibility && (!predicate || predicate(row.entry))) matches.push(rowEntry(row));
        if (matches.length === size) break;
      }
      if (result.rows.length < 256) break;
      before = String(result.rows.at(-1).sequence);
    }
    return matches.reverse();
  }

  async page(args = {}) {
    const size = limitValue(args.limit); const cursor = cursorValue(args.after); const agentId = required(args.agentId, 'agentId'); const sid = required(args.sessionId, 'sessionId');
    const result = await sessionReadQuery(this.pool, `SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4`, [agentId, sid, cursor.toString(), size + 1], args);
    const hasMore = result.rows.length > size; const rows = hasMore ? result.rows.slice(0, size) : result.rows;
    return { entries: rows.map(rowEntry), next: hasMore ? String(rows.at(-1).sequence) : null, hasMore };
  }

  // Indexed candidate pages; final query/ranking/filter semantics stay in JS.
  async searchEvidencePage({ agentId, sessionId, query = '', includeResetHistory = false, after = null, limit = 256 } = {}) {
    // Automatic terse-continuation recall deliberately uses null for no filter.
    query = query ?? '';
    if (typeof query !== 'string') throw new TypeError('query must be a string or null');
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/gu)?.filter(t => t.length >= 3) || [])];
    const grams = terms.map(t => [...new Set(Array.from({ length: t.length - 2 }, (_, i) => t.slice(i,i+3)))]);
    const candidate = grams.length ? `AND (r.has_compression_summary OR r.search_grams IS NULL OR ${grams.map((_,i) => `r.search_grams @> $${i+7}::text[]`).join(' OR ')})` : '';
    const { rows } = await this.pool.query(`SELECT r.*, (r.archive_kind='reset' OR r.generation <= COALESCE((SELECT max(a.generation) FROM conversation_archives a WHERE a.agent_id=r.agent_id AND a.session_id=r.session_id AND a.kind='reset'),-1) OR (s.metadata->>'resetAt' IS NOT NULL AND r.created_at::timestamptz<=burrow_legacy_instant(s.metadata->>'resetAt'))) AS reset_archive FROM conversation_original_rows r
      JOIN conversation_sessions s USING(agent_id,session_id)
      WHERE r.agent_id=$1 AND r.session_id=$2
      AND ($3::text IS NULL OR (r.source_store,r.source_id,r.ordinal)>($3,$4,$5::bigint))
      AND (${includeResetHistory ? 'true' : 'false'} OR r.source_store='live' OR (r.archive_kind <> 'reset'
        AND r.generation > COALESCE((SELECT max(a.generation) FROM conversation_archives a
          WHERE a.agent_id=r.agent_id AND a.session_id=r.session_id AND a.kind='reset'),-1)
        AND (burrow_legacy_instant(s.metadata->>'resetAt') IS NULL OR r.created_at::timestamptz>burrow_legacy_instant(s.metadata->>'resetAt'))))
      AND NOT EXISTS (SELECT 1 FROM conversation_original_rows newer
        WHERE newer.agent_id=r.agent_id AND newer.session_id=r.session_id
        AND burrow_history_key(newer.entry_key)=burrow_history_key(r.entry_key) AND r.has_payload_id
        AND ${originalNewerSQL()})
      ${candidate}
      ORDER BY r.source_store,r.source_id,r.ordinal LIMIT $6`,
      [required(agentId,'agentId'),required(sessionId,'sessionId'),...(after || [null,null,null]),limit,...grams]);
    const last = rows.at(-1);
    return { rows, next: rows.length === limit ? [last.source_store,last.source_id,String(last.ordinal)] : null };
  }

  async lastOperatorMessageAt({ agentId: rawAgentId, signal } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    return withPostgresTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // Adapter-installed v48 can be queried before its durable worker finishes.
      // Only scalar clocks leave PostgreSQL, not historical message bodies.
      const pendingSchema = (await client.query("SELECT to_regclass('burrow_operator_backfill') AS relation")).rows[0]?.relation;
      // Native typed indexes answer the normal hot path in one scalar query.
      // All retained generations count, including reset archives; no canonical
      // identity reconciliation or storage-time substitution is appropriate here.
      const { rows } = await client.query(`SELECT max(at) AS at FROM (
        SELECT max(operator_at) AS at FROM conversation_entries WHERE agent_id=$1 AND operator_at IS NOT NULL
        UNION ALL
        SELECT max(operator_at) AS at FROM conversation_archive_entries WHERE agent_id=$1 AND operator_at IS NOT NULL
      ) latest`, [agentId]);
      let newest = rows[0]?.at == null ? null : new Date(rows[0].at);
      // Only ambiguous legacy timestamps need JS Date semantics. Transfer the
      // scalar, never retained prose/payloads, and bound each batch.
      for (const [table, key] of [['conversation_entries','session_id,sequence'], ['conversation_archive_entries','session_id,source_id,ordinal']]) {
        let after = null;
        for (;;) {
          const archive = table === 'conversation_archive_entries';
          const { rows: legacy } = await client.query(`SELECT ${key},operator_ts_fallback AS ts FROM ${table}
            WHERE agent_id=$1 AND operator_ts_fallback IS NOT NULL
            AND ($2::text IS NULL OR (${key})>${archive ? '($2,$3,$4::bigint)' : '($2,$3::bigint)'})
            ORDER BY ${key} LIMIT 256`, [agentId,...(after || (archive ? [null,null,null] : [null,null]))]);
          for (const row of legacy) {
            const at = new Date(JSON.parse(row.ts));
            if (Number.isFinite(at.getTime()) && (!newest || at > newest)) newest = at;
          }
          if (legacy.length < 256) break;
          const last = legacy.at(-1);
          after = archive ? [last.session_id,last.source_id,String(last.ordinal)] : [last.session_id,String(last.sequence)];
        }
      }
      if (pendingSchema) {
        for (const [table,key] of [['conversation_entries','session_id,sequence'],['conversation_archive_entries','session_id,source_id,ordinal']]) {
          const archive = table === 'conversation_archive_entries';
          let after = null;
          for (;;) {
            const { rows: pending } = await client.query(`SELECT ${key},p.at,p.fallback AS ts FROM ${table} t
              LEFT JOIN LATERAL burrow_operator_projection(t.entry) p ON true
              WHERE agent_id=$1 AND NOT operator_projected
              AND ($2::text IS NULL OR (${key})>${archive ? '($2,$3,$4::bigint)' : '($2,$3::bigint)'})
              ORDER BY ${key} LIMIT 256`,[agentId,...(after || (archive ? [null,null,null] : [null,null]))]);
            for (const row of pending) {
              const at = row.at != null ? new Date(row.at) : row.ts != null ? new Date(JSON.parse(row.ts)) : null;
              if (at && Number.isFinite(at.getTime()) && (!newest || at > newest)) newest = at;
            }
            if (pending.length < 256) break;
            const last = pending.at(-1);
            after = archive ? [last.session_id,last.source_id,String(last.ordinal)] : [last.session_id,String(last.sequence)];
          }
        }
      }
      return newest?.toISOString() || null;
    }, { signal });
  }

  async listSessions({ agentId: rawAgentId, includeArchived = true , signal, deadline } = {}) {
    const readQuery = (sql, values) => sessionReadQuery(this.pool, sql, values, { signal, deadline });
    const agentId = required(rawAgentId, 'agentId');
    const result = await readQuery(`SELECT session_id,metadata,created_at,updated_at,(SELECT head FROM continuity_state c WHERE c.agent_id=conversation_sessions.agent_id AND c.session_id=conversation_sessions.session_id) AS continuity_head FROM conversation_sessions WHERE agent_id=$1 ${includeArchived ? '' : "AND COALESCE((metadata->>'archived')::boolean,false)=false"} ORDER BY updated_at DESC`, [agentId]);
    return result.rows.map((row) => ({ ...row.metadata, ...(row.continuity_head ? {continuityHead:row.continuity_head} : {}), sessionId: row.session_id, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  // A single statement gives metadata, retained generations and active entries one
  // MVCC snapshot. Reset documents are separate exports, never active history.
  async exportRawEvidence({ agentId, sessionId } = {}) {
    return exportSessionRawEvidence({ pool: this.pool, agentId: required(agentId, 'agentId'), sessionId: required(sessionId, 'sessionId') });
  }

  async exportTranscript({ agentId, sessionId } = {}) {
    const result = await this.pool.query(`
      SELECT s.metadata,s.created_at,s.updated_at,
        COALESCE((SELECT json_agg((SELECT COALESCE(json_agg(json_build_object('occurrence',e.entry_id,'entry',e.entry) ORDER BY e.ordinal),'[]'::json) FROM conversation_archive_entries e WHERE e.agent_id=a.agent_id AND e.session_id=a.session_id AND e.source_id=a.archive_id) ORDER BY a.generation,a.archive_id)
          FROM conversation_archives a WHERE a.agent_id=s.agent_id AND a.session_id=s.session_id
          AND a.kind='compacted' AND a.generation >= COALESCE(
            (s.metadata->>'resetGeneration')::bigint,
            (SELECT max(r.generation)+1 FROM conversation_archives r
              WHERE r.agent_id=s.agent_id AND r.session_id=s.session_id AND r.kind='reset'),0)), '[]'::json) AS history,
        COALESCE((SELECT json_agg(json_build_object('occurrence',e.entry_id,'entry',e.entry) ORDER BY e.sequence) FROM conversation_entries e
          WHERE e.agent_id=s.agent_id AND e.session_id=s.session_id), '[]'::json) AS entries
      FROM conversation_sessions s WHERE s.agent_id=$1 AND s.session_id=$2`,
    [required(agentId, 'agentId'), required(sessionId, 'sessionId')]);
    const row = result.rows[0];
    if (!row) return null;
    const entries = mergeTranscriptSnapshots([...row.history, row.entries]);
    return { schemaVersion: '1', session: { id: sessionId, metadata: { ...row.metadata, createdAt: row.created_at, updatedAt: row.updated_at } }, entries };
  }


  // Native Archive detail pages keep retained bodies in PostgreSQL until the
  // bounded canonical page has been selected.
  async readArchiveTranscriptPage(args = {}) {
    return readArchiveTranscriptPage(this.pool, args);
  }

  // Reconstruct a reset's entire conversation without rewriting immutable
  // evidence. The target's generation window, not today's live metadata, owns
  // its history. One statement gives selection and payloads one MVCC snapshot.
  async exportArchiveTranscript({ agentId, sessionId = null, archiveId } = {}) {
    const result = await this.pool.query(`WITH target AS (
      SELECT * FROM conversation_archives WHERE agent_id=$1 AND archive_id=$2
        AND kind='reset' AND ($3::text IS NULL OR session_id=$3)
      ORDER BY created_at DESC,session_id DESC LIMIT 1
    ) SELECT t.archive_id,t.session_id,t.generation,t.metadata,t.created_at,
      COALESCE((SELECT json_agg((SELECT COALESCE(json_agg(
          json_build_object('occurrence',e.entry_id,'entry',e.entry) ORDER BY e.ordinal),'[]'::json)
        FROM conversation_archive_entries e WHERE e.agent_id=a.agent_id
          AND e.session_id=a.session_id AND e.source_id=a.archive_id)
        ORDER BY a.generation,a.archive_id)
        FROM conversation_archives a WHERE a.agent_id=t.agent_id AND a.session_id=t.session_id
          AND a.kind='compacted' AND a.generation<=t.generation
          AND a.generation>=COALESCE((t.metadata->>'resetGeneration')::bigint,
            (SELECT max(r.generation)+1 FROM conversation_archives r
              WHERE r.agent_id=t.agent_id AND r.session_id=t.session_id
                AND r.kind='reset' AND r.generation<t.generation),0)), '[]'::json) AS history,
      COALESCE((SELECT json_agg(json_build_object('occurrence',e.entry_id,'entry',e.entry)
        ORDER BY e.ordinal) FROM conversation_archive_entries e
        WHERE e.agent_id=t.agent_id AND e.session_id=t.session_id AND e.source_id=t.archive_id),
        '[]'::json) AS entries FROM target t`,
    [required(agentId, 'agentId'), required(archiveId, 'archiveId'), sessionId == null ? null : required(sessionId, 'sessionId')]);
    const row = result.rows[0];
    if (!row) return null;
    const entries = mergeTranscriptSnapshots([...row.history, row.entries]);
    return { schemaVersion: '1', archiveId: row.archive_id, sourceSessionId: row.metadata?.sourceSessionId || row.session_id,
      generation: Number(row.generation), createdAt: row.created_at,
      session: { id: row.archive_id, metadata: { ...row.metadata, createdAt: row.created_at, updatedAt: row.created_at, archivedAt: row.created_at, chatTurnCount: null } }, entries };
  }

  async getMetadata({ agentId: rawAgentId, sessionId: rawSessionId, signal, deadline } = {}) {
    const sql = 'SELECT metadata,created_at,updated_at FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2';
    const args = [required(rawAgentId, 'agentId'), required(rawSessionId, 'sessionId')];
    const result = await sessionReadQuery(this.pool, sql, args, { signal, deadline });
    if (!result.rows[0]) return null;
    return { ...result.rows[0].metadata, createdAt: result.rows[0].created_at, updatedAt: result.rows[0].updated_at };
  }

  async writeMetadata({ agentId: rawAgentId, sessionId: rawSessionId, metadata = {} } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const now = this.clock();
    return withPostgresTransaction(this.pool, async (client) => {
      const result = await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4,$4) ON CONFLICT(agent_id,session_id) DO UPDATE SET metadata=$3::jsonb,updated_at=$4 RETURNING created_at,updated_at`, [agentId, sid, JSON.stringify(metadata), now]);
      return { ...metadata, createdAt: result.rows[0].created_at, updatedAt: result.rows[0].updated_at };
    });
  }

  async updateMetadata({ agentId, sessionId, update } = {}) {
    const aid=required(agentId,'agentId'); const sid=required(sessionId,'sessionId');
    if (typeof update !== 'function') throw new TypeError('metadata_update_required');
    return withPostgresTransaction(this.pool,async client=>{
      const now=this.clock();
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT DO NOTHING`,[aid,sid,now]);
      const row=await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE',[aid,sid]);
      const metadata=await update(row.rows[0].metadata);
      await client.query('UPDATE conversation_sessions SET metadata=$3::jsonb,updated_at=$4 WHERE agent_id=$1 AND session_id=$2 AND metadata IS DISTINCT FROM $3::jsonb',[aid,sid,JSON.stringify(metadata),now]);
      return metadata;
    });
  }

  async patchMetadata({ agentId, sessionId, metadata = {} } = {}) {
    const now = this.clock();
    const result = await this.pool.query(`UPDATE conversation_sessions SET metadata=metadata || $3::jsonb,updated_at=$4 WHERE agent_id=$1 AND session_id=$2 RETURNING metadata`, [required(agentId,'agentId'),required(sessionId,'sessionId'),JSON.stringify(metadata),now]);
    return result.rows[0]?.metadata || null;
  }

  async patchArchiveMetadata({ agentId, sessionId, archiveId, metadata = {} } = {}) {
    const result = await this.pool.query(`UPDATE conversation_archives SET metadata=CASE WHEN $4::jsonb ? 'resetGeneration' AND metadata->'resetGeneration' IS DISTINCT FROM $4::jsonb->'resetGeneration' THEN (metadata || $4::jsonb) - 'archiveTranscriptTurnCount' ELSE metadata || $4::jsonb END WHERE agent_id=$1 AND session_id=$2 AND archive_id=$3 RETURNING metadata`, [required(agentId,'agentId'),required(sessionId,'sessionId'),required(archiveId,'archiveId'),JSON.stringify(metadata)]);
    return result.rows[0]?.metadata || null;
  }

  async compact({ agentId: rawAgentId, sessionId: rawSessionId, summary, tailEntries = [], expectedEntries = null, expectedGeneration = null, signal } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId');
    if (!summary || typeof summary !== 'object' || !String(summary.text || '').trim()) throw new Error('session_compaction_summary_required');
    const now = this.clock();
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT DO NOTHING`, [agentId, sid, now]);
      const session = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sid]);
      const prior = session.rows[0]?.metadata || {};
      const old = await client.query('SELECT sequence,entry,entry_id FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 ORDER BY sequence', [agentId, sid]);
      const currentGeneration = Number(prior.generation || 0);
      if (expectedGeneration !== null && expectedGeneration !== undefined && Number(expectedGeneration) !== currentGeneration) {
        return { stale: true, currentEntries: old.rows.map(rowEntry), metadata: prior };
      }
      if (Array.isArray(expectedEntries)) {
        const expectedIds = expectedEntries.map(entry => String(entry?.id || ''));
        const currentIds = old.rows.map(row => String(row.entry?.id || ''));
        if (expectedIds.length !== currentIds.length || expectedIds.some((id, index) => id !== currentIds[index])) {
          return { stale: true, currentEntries: old.rows.map(rowEntry), metadata: prior };
        }
      }
      const archiveId = old.rows.length ? randomUUID() : null;
      const generation = Number(prior.generation || 0) + 1;
      if (archiveId) await client.query('INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)', [agentId, sid, archiveId, generation - 1, 'compacted', JSON.stringify({ ...prior, compressionSummary: summary }), now]);
      const hasProofProjection = await this.hasProofProjection(client);
      const projections = 'entry_key,search_projection,search_grams,has_payload_id,has_compression_summary,operator_at,operator_ts_fallback,operator_projected';
      const runColumn = hasProofProjection ? ',run_key' : '';
      // Copy originals in bounded ordered ranges, including relational identity and
      // projections. Never reserialize payloads or recompute their candidate index.
      for (let offset = 0; offset < old.rows.length; offset += COMPACTION_COPY_BATCH_SIZE) {
        signal?.throwIfAborted();
        const batch = old.rows.slice(offset, offset + COMPACTION_COPY_BATCH_SIZE);
        await client.query(`INSERT INTO conversation_archive_entries
          (agent_id,session_id,source_store,source_id,ordinal,entry,created_at,archive_kind,generation,entry_id,idempotency_key,${projections}${runColumn})
          SELECT agent_id,session_id,'archive',$3,sequence,entry,created_at,'compacted',$4,entry_id,idempotency_key,${projections}${runColumn}
          FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND sequence >= $5::bigint AND sequence <= $6::bigint
          ORDER BY sequence`, [agentId,sid,archiveId,generation-1,String(batch[0].sequence),String(batch.at(-1).sequence)]);
      }
      const retained = Array.isArray(tailEntries) ? tailEntries : [];
      const originals = matchCompactionOccurrences(old.rows, retained, sid);
      await client.query('DELETE FROM conversation_entries WHERE agent_id=$1 AND session_id=$2', [agentId, sid]);
      const summaryEntry = { id: randomUUID(), ts: now, sessionId: sid, type: 'summary', role: null, content: String(summary.text), visibility: 'debug', entersPrompt: false, metadata: { compressionSummary: summary } };
      const insertNew = async entry => {
        const args = [agentId,sid,text(entry.id).trim() || randomUUID(),null,JSON.stringify(entry),now];
        if (hasProofProjection) await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at,run_key) VALUES($1,$2,$3,$4,$5::json,$6,$7)', [...args,proofRunKey(entry)]);
        else await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at) VALUES($1,$2,$3,$4,$5::json,$6)', args);
      };
      await insertNew(summaryEntry);
      for (let offset = 0; offset < retained.length;) {
        signal?.throwIfAborted();
        if (!originals[offset]) {
          await insertNew(retained[offset++]);
          continue;
        }
        // Consecutive matched occurrences share one copy. WITH ORDINALITY keeps
        // arbitrary caller order, and omitted sequence allocates fresh cursors.
        const ordinals = [];
        while (offset < retained.length && originals[offset] && ordinals.length < COMPACTION_COPY_BATCH_SIZE) {
          ordinals.push(String(originals[offset++].sequence));
        }
        await client.query(`INSERT INTO conversation_entries
          (agent_id,session_id,entry_id,idempotency_key,entry,created_at,${projections}${runColumn})
          SELECT e.agent_id,e.session_id,e.entry_id,e.idempotency_key,e.entry,$5,${projections.split(',').map(column => `e.${column}`).join(',')}${hasProofProjection ? ',e.run_key' : ''}
          FROM unnest($4::bigint[]) WITH ORDINALITY AS retained(ordinal,position)
          JOIN conversation_archive_entries e ON e.agent_id=$1 AND e.session_id=$2 AND e.source_store='archive' AND e.source_id=$3 AND e.ordinal=retained.ordinal
          ORDER BY retained.position`, [agentId,sid,archiveId,ordinals,now]);
      }
      const next = { ...prior, generation, archived: false, transcriptGeneration: randomUUID(), activeTranscript: 'postgres', archiveId, updatedAt: now, turnCount: 1 + retained.length, chatTurnCount: retained.filter((entry) => entry.type === 'message' && ['user','assistant','agent'].includes(entry.role)).length };
      await client.query('UPDATE conversation_sessions SET metadata=$3::jsonb,updated_at=$4 WHERE agent_id=$1 AND session_id=$2', [agentId, sid, JSON.stringify(next), now]);
      return { archiveId, generation, summaryEntry, retainedCount: retained.length, metadata: next };
    }, { signal });
  }

  // The named history row is the cross-process family lock. Reservations are
  // durable even before a continuity head exists; an unfinished exchange is not
  // inferred closed merely because its most recent reply returned.
  async prepareA2AHistory({ agentId, sessionId, executionSessionId, sourceAgentId, sourceSessionId, sourceRunId }) {
    if (sessionId === 'default') throw new Error('context_boundary_named_session_required');
    await this.updateMetadata({ agentId, sessionId: executionSessionId, update: metadata => ({
      ...metadata, contextIsolation: { ...metadata.contextIsolation, historySessionId: sessionId },
      a2aExchange: metadata.a2aExchange || { state: 'open', sourceAgentId, sourceSessionId, sourceRunId },
    }) });
    return this.reset({ agentId, sessionId, freshExecutionSessionId: executionSessionId, a2aReservation: true });
  }

  async reset({ agentId: rawAgentId, sessionId: rawSessionId, metadata = {}, freshExecutionSessionId = null, a2aReservation = false } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const now = this.clock();
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [migrationLockKey(`burrow-session-boundary:${JSON.stringify([agentId,sid])}`)]);
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT DO NOTHING`, [agentId, sid, now]);
      const session = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sid]);
      const prior = session.rows[0]?.metadata || {};
      if (freshExecutionSessionId) {
        if (sid === 'default') throw new Error('context_boundary_named_session_required');
        const execution = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, freshExecutionSessionId]);
        const executionMetadata = execution.rows[0]?.metadata;
        if (executionMetadata?.contextIsolation?.historySessionId !== sid) throw new Error('context_history_reset_execution_required');
        // Durable per-execution receipt: retrying any older run must not erase
        // its own projected turns (or a newer run's visible history).
        if (executionMetadata.contextIsolation.historyReset) return { ok: true, replay: true };
        if (a2aReservation) {
          const open = await client.query(`SELECT s.session_id FROM conversation_sessions s
            WHERE s.agent_id=$1 AND s.session_id<>$3 AND s.metadata->'contextIsolation'->>'historySessionId'=$2
            AND s.metadata->'a2aExchange'->>'state'='open'
            AND NOT EXISTS (SELECT 1 FROM continuity_log parent
              WHERE parent.agent_id=s.metadata->'a2aExchange'->>'sourceAgentId'
              AND parent.session_id=s.metadata->'a2aExchange'->>'sourceSessionId'
              AND parent.head->>'runId'=s.metadata->'a2aExchange'->>'sourceRunId'
              AND parent.head->>'state'='completed') LIMIT 1`, [agentId, sid, freshExecutionSessionId]);
          await client.query(`UPDATE conversation_sessions SET metadata=metadata ||
            jsonb_build_object('a2aExchange',metadata->'a2aExchange' || jsonb_build_object('state','open')) WHERE agent_id=$1 AND session_id=$2`, [agentId, freshExecutionSessionId]);
          if (open.rows.length) {
            await client.query(`UPDATE conversation_sessions SET metadata=jsonb_set(metadata,'{contextIsolation,historyReset}','true'::jsonb)
              WHERE agent_id=$1 AND session_id=$2`, [agentId, freshExecutionSessionId]);
            return { ok: true, deferred: true };
          }
        }
        const busy = await client.query(`SELECT s.session_id FROM conversation_sessions s
          LEFT JOIN continuity_state c USING(agent_id,session_id)
          WHERE s.agent_id=$1 AND (s.session_id=$2 OR s.metadata->'contextIsolation'->>'historySessionId'=$2)
          AND (c.head_state IN ('running','finalizing','interrupted') OR c.queue_status IN ('pending','running')
            OR c.manifest->>'status'='interrupted'
            OR (s.metadata->'contextIsolation'->>'historyReset'='true' AND c.head_state IS NULL)) LIMIT 1`, [agentId, sid]);
        if (busy.rows.length) {
          if (!a2aReservation) throw new Error('context_history_reset_busy');
          await client.query(`UPDATE conversation_sessions SET metadata=jsonb_set(metadata,'{contextIsolation,historyReset}','true'::jsonb)
            WHERE agent_id=$1 AND session_id=$2`, [agentId, freshExecutionSessionId]);
          return { ok: true, deferred: true };
        }
        await client.query(`UPDATE conversation_sessions SET metadata=jsonb_set(metadata,'{contextIsolation,historyReset}','true'::jsonb),updated_at=$3
          WHERE agent_id=$1 AND session_id=$2`, [agentId, freshExecutionSessionId, now]);
      }
      // Fence accepted input ownership in the same transaction as archival. A
      // submission racing reset either belongs to this archived generation or
      // the next one; it can never become invisible pending work.
      if ((await client.query("SELECT to_regclass('chat_inputs') AS relation")).rows[0].relation) {
        await fenceChatInputsForReset(client, { agentId, sessionId:sid, generation:Number(prior.resetGeneration || 0), now });
      }
      // Keep the head generation monotonic, but revoke all old ownership and recovery.
      await client.query(`UPDATE continuity_state SET head=(head::jsonb || jsonb_build_object('state','reset','ownerId',NULL))::json,
        head_state='reset',owner_id=NULL,manifest=NULL,queue=NULL,queue_status=NULL,auto_resume=false,queued_at=NULL,updated_at=$3
        WHERE agent_id=$1 AND session_id=$2`, [agentId,sid,now]);
      await client.query(`INSERT INTO continuity_log(agent_id,session_id,head,manifest,queue,created_at)
        SELECT agent_id,session_id,head,manifest,queue,$3 FROM continuity_state WHERE agent_id=$1 AND session_id=$2`, [agentId,sid,now]);
      const rows = await client.query('SELECT entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 ORDER BY sequence', [agentId, sid]);
      const archiveId = rows.rows.length ? randomUUID() : null;
      const generation = Number(prior.generation || 0) + 1;
      // Materialize the reconstructed count once at reset, not on every Archive
      // listing page. This uses the same occurrence identity/window as the legacy
      // listing fallback, including id-less duplicates and compacted overlaps.
      // Canonical counts have the same cold numeric/array coercion branches as
      // Archive discovery. Avoid compiling those branches while holding reset's
      // session lock, and restore this transaction's caller setting afterwards.
      const countJit = archiveId ? (await client.query("SELECT current_setting('jit') AS value")).rows[0].value : null;
      if (archiveId) await client.query('SET LOCAL jit=off');
      const archiveTranscriptTurnCount = archiveId ? Number((await client.query(`
        SELECT count(DISTINCT identity) AS count FROM (
          SELECT COALESCE('payload:' || ${archivePayloadKeySQL('e')},
            'occurrence:' || NULLIF(e.entry_id,''), 'row:' || e.source_id || ':' || e.ordinal::text) AS identity
          FROM conversation_archive_entries e JOIN conversation_archives a
            ON a.agent_id=e.agent_id AND a.session_id=e.session_id AND a.archive_id=e.source_id
          WHERE a.agent_id=$1 AND a.session_id=$2 AND a.kind='compacted'
            AND a.generation<=$3::bigint AND a.generation>=COALESCE($4::bigint,
              (SELECT max(r.generation)+1 FROM conversation_archives r
                WHERE r.agent_id=$1 AND r.session_id=$2 AND r.kind='reset' AND r.generation<$3::bigint),0)
          UNION ALL
          SELECT COALESCE('payload:' || ${archivePayloadKeySQL('e')},
            'occurrence:' || NULLIF(e.entry_id,''), 'row:live:' || e.sequence::text)
          FROM conversation_entries e WHERE e.agent_id=$1 AND e.session_id=$2
        ) occurrences`, [agentId, sid, generation - 1, prior.resetGeneration ?? null])).rows[0].count) : null;
      if (archiveId) await client.query("SELECT set_config('jit',$1,true)", [countJit]);
      if (archiveId) await client.query('INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)', [agentId, sid, archiveId, generation - 1, 'reset', JSON.stringify({ ...prior, ...metadata, sourceSessionId: sid, archivedAt: now, chatTurnCount: null, archiveTranscriptTurnCount }), now]);
      const resetProofColumn = await this.hasProofProjection(client) ? ',run_key' : '';
      if (archiveId) await client.query(`INSERT INTO conversation_archive_entries
        (agent_id,session_id,source_store,source_id,ordinal,entry_key,entry,search_projection,created_at,archive_kind,generation,entry_id,idempotency_key${resetProofColumn})
        SELECT agent_id,session_id,'archive',$3,sequence,to_json(entry_id)::text,entry,
          COALESCE(burrow_json_member(entry,'content')::text,''),created_at,$4,$5,entry_id,idempotency_key${resetProofColumn}
        FROM conversation_entries WHERE agent_id=$1 AND session_id=$2`, [agentId,sid,archiveId,'reset',generation-1]);
      await client.query('DELETE FROM conversation_entries WHERE agent_id=$1 AND session_id=$2', [agentId, sid]);
      const next = { ...prior, ...metadata, generation, resetGeneration: generation, archived: false, resetAt: now, archiveId, turnCount: 0, chatTurnCount: 0 };
      await client.query('UPDATE conversation_sessions SET metadata=$3::jsonb,updated_at=$4 WHERE agent_id=$1 AND session_id=$2', [agentId, sid, JSON.stringify(next), now]);
      return { ok: true, agentId, sessionId: sid, archiveId, generation, metadata: { ...next, updatedAt: now } };
    });
  }

  async createEmpty({ agentId: rawAgent, sessionId: rawSession, operationId: rawOperation } = {}) {
    const agentId = required(rawAgent, 'agentId'), sessionId = required(rawSession, 'sessionId');
    const operationId = required(rawOperation, 'operationId'), now = this.clock();
    return withPostgresTransaction(this.pool, async client => {
      const metadata = { creationOperationId: operationId, generation: 0, turnCount: 0, chatTurnCount: 0 };
      const inserted = await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4,$4) ON CONFLICT DO NOTHING RETURNING session_id`, [agentId,sessionId,JSON.stringify(metadata),now]);
      if (!inserted.rows[0]) {
        const prior = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId,sessionId]);
        if (prior.rows[0]?.metadata?.creationOperationId !== operationId) throw new Error('session_target_exists');
      }
      // Replay never clears messages sent after creation.
      return { ok: true, agentId, sessionId, operationId };
    });
  }

  async fork({ sourceAgentId = null, targetAgentId = null, agentId = null, sourceSessionId: rawSource, targetSessionId: rawTarget, limit = 200 } = {}) {
    const sourceAgent = required(sourceAgentId || agentId, 'sourceAgentId'); const targetAgent = required(targetAgentId || agentId, 'targetAgentId');
    const source = required(rawSource, 'sourceSessionId'); const target = required(rawTarget, 'targetSessionId'); const size = limitValue(limit); const now = this.clock();
    if (sourceAgent === targetAgent && source === target) throw new Error('fork_source_target_same');
    return withPostgresTransaction(this.pool, async (client) => {
      const sourceSession = await client.query('SELECT 1 FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [sourceAgent, source]);
      if (!sourceSession.rows[0]) throw new Error('fork_source_not_found');
      // Reserve the target atomically. A preliminary existence check races with
      // concurrent forks and the old upsert/delete path could overwrite the winner.
      const reservation = await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4,$4) ON CONFLICT(agent_id,session_id) DO NOTHING RETURNING session_id`, [targetAgent, target, JSON.stringify({ forkedFrom: source, forkedAt: now, generation: 0 }), now]);
      if (!reservation.rows[0]) throw new Error('fork_target_exists');
      const sourceRows = await client.query('SELECT entry,entry::text AS raw_entry,entry_id FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 ORDER BY sequence DESC LIMIT $3', [sourceAgent, source, size]);
      const sourceEntries = sourceRows.rows.reverse();
      const entries = sourceEntries.map((row) => row.entry);
      const hasProofProjection = await this.hasProofProjection(client);
      for (const row of sourceEntries) {
        const args=[targetAgent,target,row.entry_id || randomUUID(),row.raw_entry,now];
        if (hasProofProjection) await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at,run_key) VALUES($1,$2,$3,$4::json,$5,$6)', [...args,proofRunKey(row.entry)]);
        else await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at) VALUES($1,$2,$3,$4::json,$5)', args);
      }
      return { ok: true, sourceAgentId: sourceAgent, targetAgentId: targetAgent, sourceSessionId: source, targetSessionId: target, copiedEntries: entries.length };
    });
  }

  async rename({ agentId: rawAgentId, sessionId: rawSessionId, targetSessionId: rawTarget } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const source = required(rawSessionId, 'sessionId');
    const target = required(rawTarget, 'targetSessionId');
    if (source === target) return { ok: true, agentId, sessionId: source, targetSessionId: target };
    return withPostgresTransaction(this.pool, async (client) => {
      const exists = async name => (await client.query('SELECT to_regclass($1) AS relation',[name])).rows[0].relation !== null;
      const sourceRow = await client.query('SELECT metadata,created_at,updated_at FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, source]);
      if (!sourceRow.rows[0]) return null;
      const reserved = await client.query('INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT DO NOTHING RETURNING session_id', [agentId, target, JSON.stringify({ ...sourceRow.rows[0].metadata, sessionId: target }), sourceRow.rows[0].created_at, sourceRow.rows[0].updated_at]);
      if (!reserved.rows[0]) throw new Error('rename_target_exists');
      const hasProofProjection = await this.hasProofProjection(client);
      const runColumn = hasProofProjection ? ',run_key' : '';
      // Owned occurrence payloads and complete mutable projections move together.
      // Copy JSON directly in SQL: parsing/serializing would destroy lexical
      // evidence (duplicate keys, escapes, whitespace and unsafe Unicode).
      const projections = 'entry_key,search_projection,search_grams,has_payload_id,has_compression_summary,operator_at,operator_ts_fallback,operator_projected';
      await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at,${projections}${runColumn})
        SELECT agent_id,$3,entry_id,idempotency_key,entry,created_at,${projections}${runColumn}
        FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 ORDER BY sequence`, [agentId, source, target]);
      await client.query(`INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,metadata,created_at) SELECT agent_id,$3,archive_id,generation,kind,CASE WHEN kind='reset' THEN metadata || jsonb_build_object('sourceSessionId',COALESCE(NULLIF(metadata->>'sourceSessionId',''),session_id)) ELSE metadata END,created_at FROM conversation_archives WHERE agent_id=$1 AND session_id=$2`, [agentId, source, target]);
      await client.query(`INSERT INTO conversation_archive_entries
        (agent_id,session_id,source_store,source_id,ordinal,entry,created_at,archive_kind,generation,entry_id,idempotency_key,${projections}${runColumn})
        SELECT agent_id,$3,source_store,source_id,ordinal,entry,created_at,archive_kind,generation,entry_id,idempotency_key,${projections}${runColumn}
        FROM conversation_archive_entries WHERE agent_id=$1 AND session_id=$2`, [agentId,source,target]);
      // Session metadata's runEvidence trigger may already have inserted a
      // subset. The source directory is authoritative, including runs with no
      // runEvidence and their exact timestamps/sort keys.
      if (hasProofProjection) await client.query(`INSERT INTO conversation_archive_runs
        (agent_id,session_id,run_key,run_id,started_at,completed_at,last_activity_at,sort_timestamp)
        SELECT agent_id,$3,run_key,run_id,started_at,completed_at,last_activity_at,sort_timestamp
        FROM conversation_archive_runs WHERE agent_id=$1 AND session_id=$2
        ON CONFLICT(agent_id,session_id,run_key) DO UPDATE SET run_id=EXCLUDED.run_id,
          started_at=EXCLUDED.started_at,completed_at=EXCLUDED.completed_at,
          last_activity_at=EXCLUDED.last_activity_at,sort_timestamp=EXCLUDED.sort_timestamp`, [agentId,source,target]);
      // Mutable ownership and citations follow the new identity; original JSON
      // entries/archives above remain byte-for-byte lexical evidence.
      if (await exists('chat_inputs')) {
        const running = await client.query("SELECT 1 FROM chat_inputs WHERE agent_id=$1 AND session_id=$2 AND status='running' LIMIT 1",[agentId,source]);
        if (running.rows.length) throw Object.assign(new Error('session_busy_chat_inputs'),{statusCode:409});
        await client.query('UPDATE chat_inputs SET session_id=$3 WHERE agent_id=$1 AND session_id=$2',[agentId,source,target]);
      }
      if (await exists('chat_input_sessions')) await client.query('UPDATE chat_input_sessions SET session_id=$3 WHERE agent_id=$1 AND session_id=$2',[agentId,source,target]);
      if (await exists('conversation_project_bindings')) await client.query('UPDATE conversation_project_bindings SET session_id=$3 WHERE agent_id=$1 AND session_id=$2',[agentId,source,target]);
      if (await exists('working_memory')) await client.query(`UPDATE working_memory SET session_id=$3,conversation_id=CASE WHEN conversation_id=$2 THEN $3 WHEN conversation_id=$1 || ':' || $2 THEN $1 || ':' || $3 ELSE conversation_id END WHERE agent_id=$1 AND session_id=$2`,[agentId,source,target]);
      if (await exists('continuity_handoffs')) {
        const oldId = `continuity:${agentId}:${source}`, newId = `continuity:${agentId}:${target}`;
        // Only the canonical session-derived id changes; arbitrary historical
        // ids stay stable. Never overwrite an existing destination handoff.
        const collision = await client.query(`SELECT 1 FROM continuity_handoffs
          WHERE id=$2 AND EXISTS (SELECT 1 FROM continuity_handoffs WHERE id=$1 AND agent_id=$3 AND session_id=$4)`, [oldId,newId,agentId,source]);
        if (collision.rows[0]) throw new Error('rename_handoff_target_exists');
        await client.query(`UPDATE continuity_handoffs SET session_id=$3,id=CASE WHEN id=$4 THEN $5 ELSE id END
          WHERE agent_id=$1 AND session_id=$2`, [agentId,source,target,oldId,newId]);
      }
      // Steering is a mutable run/input directory with cascading owner FKs.
      // Reserve parents before copying inputs, then source deletion is safe.
      if (await exists('chat_steering_runs')) {
        await client.query(`INSERT INTO chat_steering_runs(agent_id,session_id,run_id,accepting,generation)
          SELECT agent_id,$3,run_id,accepting,generation FROM chat_steering_runs WHERE agent_id=$1 AND session_id=$2`, [agentId,source,target]);
        await client.query(`INSERT INTO chat_steering_inputs
          (agent_id,session_id,run_id,ordinal,input_id,idempotency_key,payload,status,created_at,delivered_at) OVERRIDING SYSTEM VALUE
          SELECT agent_id,$3,run_id,ordinal,input_id,idempotency_key,payload,status,created_at,delivered_at
          FROM chat_steering_inputs WHERE agent_id=$1 AND session_id=$2`, [agentId,source,target]);
      }
      if (await exists('scheduled_jobs')) await client.query('UPDATE scheduled_jobs SET session_id=$3 WHERE agent_id=$1 AND session_id=$2',[agentId,source,target]);
      if (await exists('scheduled_job_runs')) await client.query('UPDATE scheduled_job_runs SET session_id=$3 WHERE agent_id=$1 AND session_id=$2',[agentId,source,target]);
      if (await exists('albdruck_evidence')) await client.query(`UPDATE albdruck_evidence SET source_ref=jsonb_set(source_ref,'{sessionId}',to_jsonb($3::text)) WHERE source_ref->>'agentId'=$1 AND source_ref->>'sessionId'=$2`,[agentId,source,target]);
      const oldRef=`session:${source}:`, newRef=`session:${target}:`;
      for (const table of ['working_memory','continuity_handoffs']) {
        if (!await exists(table)) continue;
        await client.query(`UPDATE ${table} SET source_refs=(SELECT jsonb_agg(CASE WHEN ref.value=$4 THEN $5 WHEN starts_with(ref.value,$2) THEN $3 || substr(ref.value,length($2)+1) ELSE ref.value END ORDER BY ref.ordinality) FROM jsonb_array_elements_text(source_refs) WITH ORDINALITY ref(value,ordinality)) WHERE agent_id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_refs) ref(value) WHERE ref.value=$4 OR starts_with(ref.value,$2))`,[agentId,oldRef,newRef,`session:${source}`,`session:${target}`]);
      }
      // Only rewrite typed mutable identity fields, never prose or historical
      // lexical originals (archive entries, Tiddle history, legacy card JSON).
      const rewriteIdentity = (value, key = '') => {
        if (typeof value === 'string') {
          if (['sessionId','conversationId'].includes(key) && value === source) return target;
          if (key === 'conversationId' && value === `${agentId}:${source}`) return `${agentId}:${target}`;
          if (['project','scope'].includes(key) && value === `conversation:${source}`) return `conversation:${target}`;
          if (['ref','sourceRef','sourceRefs','recentRefs'].includes(key)) {
            if (value === `session:${source}`) return `session:${target}`;
            if (value.startsWith(oldRef)) return newRef + value.slice(oldRef.length);
          }
          return value;
        }
        if (Array.isArray(value)) return value.map(item => rewriteIdentity(item, key));
        if (value && typeof value === 'object') {
          if (value.agentId && value.agentId !== agentId) return value;
          return Object.fromEntries(Object.entries(value).map(([field,item]) => [field,rewriteIdentity(item,field)]));
        }
        return value;
      };
      const rewriteRows = async (sql, params, update) => {
        for (const row of (await client.query(sql, params)).rows) {
          const next = rewriteIdentity(row.payload);
          if (JSON.stringify(next) !== JSON.stringify(row.payload)) await update(row, JSON.stringify(next));
        }
      };
      // Read residue before settings locks: an in-flight pass may already have
      // captured a run even if it has not yet written a preference signal.
      const residueRefs = [];
      if (await exists('tiddle_envelopes')) {
        const residue = await client.query(`SELECT t.value_json AS payload FROM tiddle_entries t JOIN tiddle_envelopes e USING(envelope_id)
          WHERE e.agent_id=$1 AND e.kind='tiddle-residue' AND t.source_sessions @> ARRAY[$2]::text[]`,[agentId,source]);
        for (const row of residue.rows) if (row.payload?.sessionId === source) residueRefs.push(row.payload.ref);
      }
      if (await exists('settings_meta')) {
        // These are the same sorted locks used by the preference writer and
        // purge, including when a metadata row does not yet exist. Never touch
        // the public PREFERENCES document, or rewrite prose / opaque hashes.
        const signalKey = `preference-signals:${agentId}`;
        const auditKey = `preference-audit:${agentId}`;
        const stateKey = `preference-learning:${agentId}`;
        for (const key of [auditKey,stateKey,signalKey].sort()) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`settings-meta:${key}`]);
        }
        const readPreference = async key => {
          const row = (await client.query('SELECT value_json::text AS payload FROM settings_meta WHERE key=$1 FOR UPDATE',[key])).rows[0];
          if (!row) return null;
          let value;
          try { value = JSON.parse(row.payload); } catch { throw new Error('rename_preference_envelope_invalid'); }
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('rename_preference_envelope_invalid');
          return value;
        };
        const audit = await readPreference(auditKey);
        const state = await readPreference(stateKey);
        const envelope = await readPreference(signalKey);
        for (const [value,field] of [[audit,'entries'],[state,'reviewedSignalIds'],[envelope,'signals'],[envelope,'resolvedEvidence'],[envelope,'sessionAliases']]) {
          if (value && Object.hasOwn(value,field) && !Array.isArray(value[field])) throw new Error('rename_preference_envelope_invalid');
        }
        // A source ref is the smallest available rename fence: unlike a bare
        // session alias it does not capture new messages when the old name is
        // reused. Keep every old original, even when no signal existed yet: an
        // extraction already in flight may cite any of them after this commit.
        const oldRefs = new Set();
        // Session names may contain colons; a lexical prefix alone would turn
        // `session:old:child:message:x` into an unrelated renamed citation.
        const preferenceRef = ref => typeof ref === 'string' && (ref === `session:${source}` ||
          ['message:','run:'].some(kind => ref.startsWith(`${oldRef}${kind}`)));
        const rewritePreferenceRef = value => {
          if (Array.isArray(value)) return value.map(rewritePreferenceRef);
          return preferenceRef(value) ? rewriteIdentity(value,'sourceRef') : value;
        };
        const remember = value => {
          if (Array.isArray(value)) { for (const ref of value) remember(ref); return; }
          if (preferenceRef(value)) oldRefs.add(value);
        };
        for (const ref of residueRefs) remember(ref);
        const originals = await client.query('SELECT DISTINCT entry_key,has_payload_id FROM conversation_original_rows WHERE agent_id=$1 AND session_id=$2',[agentId,source]);
        for (const row of originals.rows) {
          try {
            // Dream interpolates the payload id (including undefined/null),
            // rather than the relational fallback for id-less payloads.
            const id = row.has_payload_id ? JSON.parse(row.entry_key) : undefined;
            oldRefs.add(`session:${source}:message:${id}`);
          } catch { throw new Error('rename_preference_source_identity_invalid'); }
        }
        const rewriteItems = (items, evidence = false) => items?.map(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item) || (item.agentId && item.agentId !== agentId)) return item;
          let next = item;
          if (Object.hasOwn(item,'sourceRefs')) {
            remember(item.sourceRefs);
            next = { ...next, sourceRefs: rewritePreferenceRef(item.sourceRefs) };
          }
          if (evidence && Array.isArray(item.evidence)) next = { ...next, evidence: item.evidence.map(entry => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Object.hasOwn(entry,'sourceRef')) return entry;
            remember(entry.sourceRef);
            return { ...entry, sourceRef: rewritePreferenceRef(entry.sourceRef) };
          }) };
          return next;
        });
        const nextAudit = audit && { ...audit, ...(audit.entries ? { entries: rewriteItems(audit.entries) } : {}) };
        const signals = rewriteItems(envelope?.signals, true);
        const resolvedEvidence = rewriteItems(envelope?.resolvedEvidence, true);
        // Flatten historical aliases on subsequent renames. If an old message
        // spelling was reused for a different occurrence, its two owners are
        // indistinguishable; fail closed instead of stealing either identity.
        const aliases = new Map();
        const addAlias = (from,to) => {
          if (from === to) return;
          if (aliases.has(from) && aliases.get(from) !== to) throw new Error('rename_preference_source_alias_conflict');
          aliases.set(from,to);
        };
        for (const alias of envelope?.sessionAliases || []) {
          if (!alias || typeof alias !== 'object' || Array.isArray(alias) || typeof alias.sourceRef !== 'string' || typeof alias.targetRef !== 'string') throw new Error('rename_preference_envelope_invalid');
          addAlias(alias.sourceRef,rewritePreferenceRef(alias.targetRef));
        }
        for (const ref of oldRefs) addAlias(ref,rewriteIdentity(ref,'sourceRef'));
        const nextSignals = {
          ...(envelope || { version: 2, agentId, signals: [] }),
          ...(signals ? { signals } : {}),
          ...(resolvedEvidence ? { resolvedEvidence } : {}),
          ...(aliases.size || envelope?.sessionAliases ? { sessionAliases: [...aliases].map(([sourceRef,targetRef]) => ({ sourceRef,targetRef })) } : {}),
        };
        const writePreference = (key,value) => client.query(`INSERT INTO settings_meta(key,value_json,updated_at) VALUES($1,$2,$3)
          ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`,[key,JSON.stringify(value),this.clock()]);
        if (audit && JSON.stringify(audit) !== JSON.stringify(nextAudit)) await writePreference(auditKey,nextAudit);
        if ((envelope || aliases.size) && JSON.stringify(envelope) !== JSON.stringify(nextSignals)) await writePreference(signalKey,nextSignals);
      }
      if (await exists('rolling_continuity_cards')) {
        await rewriteRows('SELECT project,card_id,card_json AS payload FROM rolling_continuity_cards WHERE agent_id=$1 FOR UPDATE',[agentId],
          (row,json) => client.query('UPDATE rolling_continuity_cards SET card_json=$4::json WHERE agent_id=$1 AND project=$2 AND card_id=$3',[agentId,row.project,row.card_id,json]));
        await client.query('UPDATE rolling_continuity_cards SET project=$3 WHERE agent_id=$1 AND project=$2',[agentId,`conversation:${source}`,`conversation:${target}`]);
      }
      if (await exists('tiddle_envelopes')) {
        await rewriteRows("SELECT envelope_id,value_json AS payload FROM tiddle_envelopes WHERE agent_id=$1 AND kind <> 'tiddle-history' FOR UPDATE",[agentId],
          (row,json) => client.query('UPDATE tiddle_envelopes SET value_json=$2::json WHERE envelope_id=$1',[row.envelope_id,json]));
        await rewriteRows("SELECT t.id,t.value_json AS payload FROM tiddle_entries t JOIN tiddle_envelopes e USING(envelope_id) WHERE e.agent_id=$1 AND e.kind='tiddle-residue' FOR UPDATE OF t",[agentId],
          (row,json) => client.query("UPDATE tiddle_entries SET value_json=$2::json,ref=$2::json->>'ref' WHERE id=$1",[row.id,json]));
        await client.query("UPDATE tiddle_envelopes SET scope=$3 WHERE agent_id=$1 AND kind='tiddle-pass-scope' AND scope=$2",[agentId,`conversation:${source}`,`conversation:${target}`]);
      }
      if (await exists('task_board_tasks')) {
        for (const column of ['metadata_json','execution_json']) {
          await rewriteRows(`SELECT id,${column} AS payload FROM task_board_tasks WHERE COALESCE(${column}->>'agentId',assigned_agent_id)=$1 FOR UPDATE`,[agentId],
            (row,json) => client.query(`UPDATE task_board_tasks SET ${column}=$2::jsonb WHERE id=$1`,[row.id,json]));
        }
      }
      for (const column of ['head','manifest','queue']) {
        await rewriteRows(`SELECT session_id,${column} AS payload FROM continuity_state WHERE agent_id=$1 AND session_id=$2 FOR UPDATE`,[agentId,source],
          (row,json) => client.query(`UPDATE continuity_state SET ${column}=$3::json WHERE agent_id=$1 AND session_id=$2`,[agentId,row.session_id,json]));
      }
      await client.query('UPDATE continuity_state SET session_id=$3 WHERE agent_id=$1 AND session_id=$2',[agentId,source,target]);
      await client.query('UPDATE continuity_log SET session_id=$3 WHERE agent_id=$1 AND session_id=$2',[agentId,source,target]);
      await client.query('DELETE FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2', [agentId, source]);
      return { ok: true, agentId, sessionId: source, targetSessionId: target };
    });
  }

  async archive({ agentId: rawAgentId, sessionId: rawSessionId, archived = true } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const now = this.clock();
    return withPostgresTransaction(this.pool, async (client) => {
      const result = await client.query('UPDATE conversation_sessions SET metadata=jsonb_set(metadata, ARRAY[\'archived\'], $3::jsonb, true),updated_at=$4 WHERE agent_id=$1 AND session_id=$2 RETURNING metadata,created_at,updated_at', [agentId, sid, JSON.stringify(Boolean(archived)), now]);
      if (!result.rows[0]) return null;
      return { ok: true, agentId, sessionId: sid, archived: Boolean(archived), metadata: { ...result.rows[0].metadata, createdAt: result.rows[0].created_at, updatedAt: result.rows[0].updated_at } };
    });
  }

  async listArchiveRunDirectory({ agentId: rawAgentId, sessionId: rawSessionId = null, limit = 100, boundary = null, signal, deadline } = {}) {
    const readQuery = (sql, values) => sessionReadQuery(this.pool, sql, values, { signal, deadline });
    const agentId = required(rawAgentId, 'agentId');
    const sessionId = rawSessionId == null ? null : required(rawSessionId, 'sessionId');
    const size = limitValue(limit);
    if (boundary && (typeof boundary.t !== 'string' || typeof boundary.i !== 'string')) throw new Error('archive_cursor_invalid');
    const { rows } = await readQuery(`SELECT r.agent_id,r.session_id,r.run_id,r.started_at,r.completed_at,r.last_activity_at,r.sort_timestamp,evidence.item AS evidence
      FROM conversation_archive_runs r LEFT JOIN conversation_sessions s ON s.agent_id=r.agent_id AND s.session_id=r.session_id
      LEFT JOIN LATERAL (SELECT item FROM jsonb_array_elements(COALESCE(s.metadata->'runEvidence','[]'::jsonb)) item WHERE item->>'runId'=r.run_id LIMIT 1) evidence ON true
      WHERE r.agent_id=$1 AND ($2::text IS NULL OR r.session_id=$2)
      AND ($2::text IS NOT NULL OR NULLIF(s.metadata->'contextIsolation'->>'historySessionId','') IS NULL)
      AND ($3::text IS NULL OR (r.sort_timestamp,r.agent_id || ':' || r.run_id)<($3,$4))
      ORDER BY r.sort_timestamp DESC,r.agent_id || ':' || r.run_id DESC LIMIT $5`,
    [agentId, sessionId, boundary?.t || null, boundary?.i || null, size + 1]);
    const hasMore = rows.length > size;
    return { rows: (hasMore ? rows.slice(0, size) : rows).map(row => ({
      agentId: row.agent_id, sessionId: row.session_id, runId: row.run_id,
      startedAt: row.started_at?.toISOString?.() || row.started_at || null,
      completedAt: row.completed_at?.toISOString?.() || row.completed_at || null,
      lastActivityAt: row.last_activity_at?.toISOString?.() || row.last_activity_at || null,
      sortTimestamp: row.sort_timestamp, evidence: row.evidence || null,
    })), hasMore };
  }

  async readArchiveRunSources({ agentId: rawAgentId, runs = [], signal, deadline } = {}) {
    const readQuery = (sql, values) => sessionReadQuery(this.pool, sql, values, { signal, deadline });
    const agentId = required(rawAgentId, 'agentId');
    const requested = (Array.isArray(runs) ? runs : []).filter(item => item?.sessionId && item?.runId);
    if (!requested.length) return [];
    const keys = requested.map(item => proofRunKey({ runId: item.runId }));
    const sessions = requested.map(item => String(item.sessionId));
    // A run can straddle any number of compactions and a reset. Fetch only the
    // exact requested (session, run) pairs through the existing run indexes;
    // both stores are read in one statement so compaction cannot hide a row.
    // Do not reserialize the JSON originals or select just the newest snapshot.
    const { rows } = await readQuery(`WITH requested AS MATERIALIZED (
      SELECT DISTINCT session_id,run_key FROM unnest($2::text[],$3::text[]) AS r(session_id,run_key)
      WHERE run_key IS NOT NULL
    ), occurrences AS (
      SELECT e.session_id,e.run_key,e.entry_id,e.entry,e.sequence::text AS sequence,
        1 AS priority,NULL::bigint AS generation,NULL::text AS source_id
      FROM conversation_entries e JOIN requested r USING(session_id,run_key)
      WHERE e.agent_id=$1 AND e.session_id=ANY($2::text[]) AND e.run_key=ANY($3::text[])
      UNION ALL
      SELECT e.session_id,e.run_key,e.entry_id,e.entry,e.ordinal::text AS sequence,
        0 AS priority,e.generation,e.source_id
      FROM conversation_archive_entries e JOIN requested r USING(session_id,run_key)
      WHERE e.agent_id=$1 AND e.session_id=ANY($2::text[]) AND e.run_key=ANY($3::text[])
    ) SELECT * FROM occurrences
      ORDER BY session_id,run_key,priority,generation ASC NULLS FIRST,source_id ASC,sequence::bigint`, [agentId,sessions,keys]);
    const grouped = new Map();
    for (const row of rows) {
      const key = JSON.stringify([row.session_id,row.run_key]);
      let group = grouped.get(key);
      if (!group) { group = { snapshots: [], source: null }; grouped.set(key,group); }
      // Within an archive the earliest duplicate wins; newer generations and
      // source IDs replace it. Live originals take precedence, with a later live
      // sequence winning if legacy payload IDs collide. Id-less retained copies
      // use their relational entry_id; equal-content distinct rows stay distinct.
      const source = row.source_id === null ? `live:${row.sequence}` : `archive:${row.source_id}`;
      if (source !== group.source) { group.snapshots.push([]); group.source = source; }
      group.snapshots.at(-1).push({ entry: rowEntry(row), occurrence: row.entry_id });
    }
    const metadataRows = await readQuery('SELECT session_id,metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=ANY($2::text[])', [agentId,[...new Set(sessions)]]);
    const metadata = new Map(metadataRows.rows.map(row => [row.session_id,row.metadata]));
    return requested.map((item,index) => {
      const group = grouped.get(JSON.stringify([sessions[index],keys[index]]));
      const entries = mergeTranscriptSnapshots(group?.snapshots || []).sort((left,right) => {
        const at = String(left.ts || '').localeCompare(String(right.ts || ''));
        if (at) return at;
        const a = BigInt(left.sequence), b = BigInt(right.sequence);
        return a < b ? -1 : a > b ? 1 : 0;
      });
      const evidence = (Array.isArray(metadata.get(sessions[index])?.runEvidence) ? metadata.get(sessions[index]).runEvidence : []).find(value => value?.runId===item.runId) || null;
      return { sessionId:sessions[index],runId:item.runId,entries,evidence };
    });
  }

  async readArchiveRunSource({ agentId: rawAgentId, sessionId: rawSessionId = null, runId: rawRunId, signal, deadline } = {}) {
    const readQuery = (sql, values) => sessionReadQuery(this.pool, sql, values, { signal, deadline });
    const agentId = required(rawAgentId, 'agentId'); const runId = required(rawRunId, 'runId');
    const sessionId = rawSessionId == null ? null : required(rawSessionId, 'sessionId');
    const key = JSON.stringify(runId);
    const located = await readQuery(`SELECT session_id FROM conversation_archive_runs
      WHERE agent_id=$1 AND run_key=encode(convert_to($2,'UTF8'),'hex') AND ($3::text IS NULL OR session_id=$3)
      ORDER BY sort_timestamp DESC,session_id DESC LIMIT 1`, [agentId, key, sessionId]);
    const sid = located.rows[0]?.session_id;
    if (!sid) return null;
    const [source] = await this.readArchiveRunSources({ agentId, runs: [{ sessionId: sid, runId }], signal, deadline });
    return { sessionId: sid, entries: source.entries, evidence: source.evidence };
  }

  async listArchiveSessions({ agentId: rawAgentId, includeArchived = true, query = '', date = null, month = null, timezone = 'UTC', limit = 100, boundary = null, signal, deadline } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const size = limitValue(limit);
    const search = text(query).trim().toLowerCase();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('archive_date_invalid');
    if (month && !/^\d{4}-\d{2}$/.test(String(month))) throw new Error('archive_month_invalid');
    if (boundary && (typeof boundary.t !== 'string' || typeof boundary.i !== 'string'
      || (boundary.t !== '' && (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/.test(boundary.t)
        || !Number.isFinite(Date.parse(boundary.t.replace(/([+-]\d{2})$/, '$1:00'))))))) throw new Error('archive_cursor_invalid');
    const windowKey = date || (month ? `${month}-01` : null);
    const windowStart = windowKey ? new Date(`${windowKey}T00:00:00Z`) : null;
    const windowEnd = windowStart ? new Date(windowStart) : null;
    if (windowStart) windowStart.setUTCDate(windowStart.getUTCDate() - 1);
    if (windowEnd) date ? windowEnd.setUTCDate(windowEnd.getUTCDate() + 2) : windowEnd.setUTCMonth(windowEnd.getUTCMonth() + 1, 2);
    return withArchiveRead(this.pool, async client => {
    await this.hasArchiveDateProjection(client);
    const sortTime = this.archiveNativeCatalogTime ? 'updated_at' : 'burrow_legacy_instant(updated_at::text)';
    const days = windowKey ? archiveOccurrenceDaysSQL({ start: '$10', end: '$11', timezone: '$6' }) : null;
    let countCache = resetListingCountsByPool.get(this.pool);
    if (!countCache) { countCache = new Map(); resetListingCountsByPool.set(this.pool, countCache); }
    const cacheArg = days ? '$12' : '$10';
    const { rows } = await client.query( `WITH ${archiveRowsSQL()}${days ? `, ${days}` : ''}, bounded AS (
      SELECT *,agent_id || ':' || id AS identity,
        COALESCE(to_char(${sortTime} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'') AS sort_timestamp FROM archive_rows
      WHERE ($3::text='' OR lower(concat_ws(' ',id,session_id,source_session_id,metadata->>'archiveTitle',metadata->>'title',metadata->>'name',metadata->>'summary',metadata->>'archiveSummary')) LIKE '%' || $3 || '%')
      AND (($4::text IS NULL AND $5::text IS NULL)
        OR (($4::text IS NULL OR to_char(burrow_legacy_instant(updated_at::text) AT TIME ZONE $6,'YYYY-MM-DD')=$4)
          AND ($5::text IS NULL OR to_char(burrow_legacy_instant(updated_at::text) AT TIME ZONE $6,'YYYY-MM')=$5))
        ${days ? `OR EXISTS (SELECT 1 FROM matched_days m WHERE m.agent_id=archive_rows.agent_id AND m.id=archive_rows.id
          AND ($4::text IS NULL OR m.day=$4) AND ($5::text IS NULL OR left(m.day,7)=$5))` : ''})
      AND ($7::text IS NULL
        OR ($7::text='' AND ${sortTime} IS NULL AND (agent_id || ':' || id) COLLATE "C"<$8::text COLLATE "C")
        OR ($7::text<>'' AND (${sortTime} IS NULL OR (${sortTime},(agent_id || ':' || id) COLLATE "C")<(NULLIF($7::text,'')::timestamptz,$8::text COLLATE "C"))))
      ORDER BY ${sortTime} DESC NULLS LAST,(agent_id || ':' || id) COLLATE "C" DESC LIMIT $9
    ), reset_versions AS MATERIALIZED (
      -- Include the exact effective window and each contributing source version.
      -- The epoch handles TRUNCATE; changing a prior reset changes min_generation.
      SELECT b.agent_id,b.session_id,b.id,
        jsonb_build_array(b.agent_id,b.session_id,b.id,b.min_generation,b.max_generation,
          (SELECT revision FROM conversation_archive_revision_epoch WHERE singleton),
          (SELECT revision FROM conversation_archive_revisions r WHERE r.agent_id=b.agent_id
            AND r.session_id=b.session_id AND r.scope='source' AND r.source_id=b.id),
          (SELECT COALESCE(jsonb_agg(jsonb_build_array(a.archive_id,a.generation,r.revision)
                ORDER BY a.generation,a.archive_id),'[]'::jsonb)
           FROM conversation_archives a LEFT JOIN conversation_archive_revisions r
             ON r.agent_id=a.agent_id AND r.session_id=a.session_id AND r.scope='source' AND r.source_id=a.archive_id
           WHERE a.agent_id=b.agent_id AND a.session_id=b.session_id AND a.kind='compacted'
             AND a.generation>=b.min_generation AND a.generation<=b.max_generation))::text AS cache_key
      FROM bounded b WHERE b.archive_snapshot
    ), cached_counts AS MATERIALIZED (
      SELECT v.*,cache.turn_count FROM reset_versions v
      LEFT JOIN jsonb_to_recordset(${cacheArg}::jsonb) AS cache(cache_key text,turn_count bigint)
        ON cache.cache_key=v.cache_key
    ), missing AS MATERIALIZED (
      SELECT b.*,v.cache_key FROM bounded b JOIN cached_counts v USING(agent_id,session_id,id)
      WHERE v.turn_count IS NULL
    ), counts AS MATERIALIZED (
      SELECT missing.agent_id,missing.session_id,missing.id,
        (SELECT count(DISTINCT identity COLLATE "C") FROM (
        SELECT COALESCE(
          'p:' || ${archivePayloadKeySQL('e')},
          'o:' || NULLIF(e.entry_id,''),
          'r:' || json_build_array('archive',e.source_store,e.source_id,e.ordinal::text)::text) AS identity
        FROM conversation_archives a JOIN conversation_archive_entries e
          ON e.agent_id=a.agent_id AND e.session_id=a.session_id AND e.source_id=a.archive_id
        WHERE a.agent_id=missing.agent_id AND a.session_id=missing.session_id
          AND ((a.archive_id=missing.id AND a.kind='reset') OR
            (a.kind='compacted' AND a.generation>=missing.min_generation AND a.generation<=missing.max_generation))
      ) occurrences) AS turn_count FROM missing
    ) SELECT bounded.agent_id,bounded.session_id,bounded.id,bounded.source_session_id,
      bounded.archive_snapshot,bounded.created_at,bounded.updated_at,bounded.identity,bounded.sort_timestamp,
      cached_counts.cache_key,
      CASE WHEN archive_snapshot THEN COALESCE(cached_counts.turn_count,counts.turn_count)
      WHEN bounded.metadata->>'turnCount' ~ '^[0-9]+$' THEN (bounded.metadata->>'turnCount')::bigint ELSE 0 END AS turn_count,
      (bounded.metadata - 'runEvidence') AS projected_metadata
      FROM bounded LEFT JOIN counts ON counts.agent_id=bounded.agent_id AND counts.session_id=bounded.session_id AND counts.id=bounded.id
        LEFT JOIN cached_counts ON cached_counts.agent_id=bounded.agent_id AND cached_counts.session_id=bounded.session_id AND cached_counts.id=bounded.id
      ORDER BY ${sortTime} DESC NULLS LAST,identity COLLATE "C" DESC`,
    [...[agentId, Boolean(includeArchived), search, date, month, timezone, boundary?.t ?? null, boundary?.i ?? null, size + 1, windowStart?.toISOString() || null, windowEnd?.toISOString() || null].slice(0, days ? 11 : 9),
      JSON.stringify([...countCache].map(([cache_key, turn_count]) => ({ cache_key, turn_count })))]);
    for (const row of rows) if (row.archive_snapshot && row.cache_key && row.turn_count != null && !countCache.has(row.cache_key)) {
      if (countCache.size >= RESET_LISTING_COUNT_CACHE_LIMIT) countCache.delete(countCache.keys().next().value);
      countCache.set(row.cache_key, Number(row.turn_count));
    }
    const hasMore = rows.length > size;
    return { rows: (hasMore ? rows.slice(0, size) : rows).map(row => ({
      id: row.id, sessionId: row.id, sourceSessionId: row.source_session_id,
      archiveSnapshot: row.archive_snapshot ? 'reset' : null, metadata: row.archive_snapshot
        ? { ...row.projected_metadata, archiveTranscriptTurnCount: Number(row.turn_count), archivedAt: row.created_at, chatTurnCount: null } : row.projected_metadata,
      ...(date ? { matchedDate: String(date) } : {}),
      turnCount: Number(row.turn_count), createdAt: row.created_at, updatedAt: row.updated_at,
      // Exact UTC microseconds survive pg/JS Date's millisecond normalization.
      // Empty sorts strictly after known clocks and is a real cursor position.
      sortTimestamp: row.sort_timestamp, identity: row.identity,
    })), hasMore };
    }, { signal, deadline });
  }

  async listArchiveCalendarDates({ agentId: rawAgentId, month, timezone = 'UTC', signal, deadline } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const monthStart = new Date(`${month}-01T00:00:00Z`);
    const safeStart = new Date(monthStart); safeStart.setUTCDate(safeStart.getUTCDate() - 1);
    const safeEnd = new Date(monthStart); safeEnd.setUTCMonth(safeEnd.getUTCMonth() + 1, 2);
    return withArchiveRead(this.pool, async client => {
    const days = archiveOccurrenceDaysSQL({ start: '$4', end: '$5', timezone: '$3' });
    const { rows } = await client.query( `WITH ${archiveRowsSQL()}, ${days}
      SELECT DISTINCT day FROM (
        SELECT to_char(burrow_legacy_instant(updated_at::text) AT TIME ZONE $3,'YYYY-MM-DD') AS day
          FROM archive_rows WHERE burrow_legacy_instant(updated_at::text)>=$4::timestamptz AND burrow_legacy_instant(updated_at::text)<$5::timestamptz
        UNION ALL SELECT day FROM matched_days
      ) archive_days WHERE day LIKE $6 || '-%' ORDER BY day`,
    [agentId, true, timezone, safeStart.toISOString(), safeEnd.toISOString(), month]);
    return rows.map(row => row.day);
    }, { signal, deadline });
  }

  async listArchives({ agentId: rawAgentId, sessionId: rawSessionId, limit = 100, signal, deadline } = {}) {
    const readQuery = (sql, values) => sessionReadQuery(this.pool, sql, values, { signal, deadline });
    const agentId = required(rawAgentId, 'agentId'); const params = [agentId]; let where = 'agent_id=$1';
    if (rawSessionId != null) { params.push(required(rawSessionId, 'sessionId')); where += ` AND session_id=$${params.length}`; }
    if (rawSessionId == null) where += ` AND NULLIF(metadata->'contextIsolation'->>'historySessionId','') IS NULL`;
    const unbounded = limit === null;
    if (!unbounded) params.push(limitValue(limit));
    const result = await readQuery(`SELECT archive_id,session_id,generation,kind,COALESCE((SELECT json_agg(e.entry ORDER BY e.ordinal) FROM conversation_archive_entries e WHERE e.agent_id=conversation_archives.agent_id AND e.session_id=conversation_archives.session_id AND e.source_id=conversation_archives.archive_id),'[]'::json) AS entries,metadata,created_at FROM conversation_archives WHERE ${where} ORDER BY generation DESC, created_at DESC, archive_id DESC${unbounded ? '' : ` LIMIT $${params.length}`}`, params);
    return result.rows.map((row) => ({ archiveId: row.archive_id, sessionId: row.session_id, generation: Number(row.generation), kind: row.kind, entries: row.entries, metadata: row.metadata, createdAt: row.created_at }));
  }

  async readArchiveById({ agentId: rawAgentId, archiveId, kind = null, signal, deadline } = {}) {
    const readQuery = (sql, values) => sessionReadQuery(this.pool, sql, values, { signal, deadline });
    const agentId = required(rawAgentId, 'agentId'); const id = required(archiveId, 'archiveId');
    const result = await readQuery(`SELECT archive_id,session_id,generation,kind,
      COALESCE((SELECT json_agg(e.entry ORDER BY e.ordinal) FROM conversation_archive_entries e
        WHERE e.agent_id=conversation_archives.agent_id AND e.session_id=conversation_archives.session_id
        AND e.source_id=conversation_archives.archive_id),'[]'::json) AS entries,metadata,created_at
      FROM conversation_archives WHERE agent_id=$1 AND archive_id=$2 AND ($3::text IS NULL OR kind=$3)
      ORDER BY created_at DESC,session_id DESC LIMIT 1`, [agentId, id, kind]);
    const row = result.rows[0];
    return row ? { archiveId: row.archive_id, sessionId: row.session_id, generation: Number(row.generation), kind: row.kind, entries: row.entries, metadata: row.metadata, createdAt: row.created_at } : null;
  }

  async readArchive({ agentId: rawAgentId, sessionId: rawSessionId, archiveId } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const id = required(archiveId, 'archiveId');
    const result = await this.pool.query(`SELECT archive_id,session_id,generation,kind,COALESCE((SELECT json_agg(e.entry ORDER BY e.ordinal) FROM conversation_archive_entries e WHERE e.agent_id=conversation_archives.agent_id AND e.session_id=conversation_archives.session_id AND e.source_id=conversation_archives.archive_id),'[]'::json) AS entries,metadata,created_at FROM conversation_archives WHERE agent_id=$1 AND session_id=$2 AND archive_id=$3`, [agentId, sid, id]);
    const row = result.rows[0];
    return row ? { archiveId: row.archive_id, sessionId: row.session_id, generation: Number(row.generation), kind: row.kind, entries: row.entries, metadata: row.metadata, createdAt: row.created_at } : null;
  }
}

export const SESSION_SCHEMA_SQL = POSTGRES_SESSION_FULL_SCHEMA_SQL;
