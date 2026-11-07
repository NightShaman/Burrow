import { POSTGRES_SESSION_RECALL_NONBLOCKING_SQL } from './postgres-session-recall-nonblocking.mjs';
import { POSTGRES_SESSION_RETRIEVAL_SQL } from './postgres-session-retrieval.mjs';
import { POSTGRES_SESSION_RECALL_REPAIRS_SQL } from './postgres-session-recall-repairs.mjs';
import { POSTGRES_DREAM_WINDOW_SQL } from './postgres-dream-window.mjs';
import { POSTGRES_RESET_PROJECTIONS_SQL } from './postgres-reset-projections.mjs';
import { POSTGRES_CHAT_RESULT_PROJECTION_SQL } from './postgres-chat-result-projection.mjs';
import { POSTGRES_ARCHIVE_DISCOVERY_INDEX_SQL } from './postgres-archive-discovery-indexes.mjs';
import { POSTGRES_ARCHIVE_CHAT_PROJECTION_SQL } from './postgres-archive-chat-projection.mjs';
import { POSTGRES_COMPACTION_PROJECTIONS_SQL } from './postgres-compaction-projections.mjs';
import { POSTGRES_ARCHIVE_LEXICAL_SQL } from './postgres-archive-lexical.mjs';
import { POSTGRES_OPERATOR_INSTANT_SQL } from './postgres-operator-instant.mjs';
import { POSTGRES_LOGICAL_MEMBER_SQL, POSTGRES_ARCHIVE_RELATIONAL_ID_SQL, POSTGRES_CATALOG_SCALAR_ID_SQL, POSTGRES_LOGICAL_LOOKUP_INDEX_SQL } from './postgres-lexical-identity.mjs';
import { POSTGRES_HISTORY_KEYSET_SQL } from './postgres-history-keyset.mjs';
import { POSTGRES_RESET_INSTANT_SQL } from './postgres-reset-instant.mjs';
import { POSTGRES_CONTINUITY_STATE_SCHEMA_SQL } from './postgres-continuity-state-store.mjs';
import { POSTGRES_AGENT_DELIVERY_OWNER_SQL, POSTGRES_AGENT_DELIVERY_SCHEMA_SQL } from './postgres-agent-delivery-store.mjs';

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

export const POSTGRES_SESSION_FULL_SCHEMA_SQL = POSTGRES_SESSION_SCHEMA_SQL + POSTGRES_SESSION_ARCHIVE_SCHEMA_SQL + POSTGRES_SESSION_LOSSLESS_JSON_SCHEMA_SQL + POSTGRES_SESSION_OPERATOR_LOOKUP_SCHEMA_SQL + POSTGRES_SESSION_ORIGINAL_LOOKUP_SCHEMA_SQL + POSTGRES_SESSION_ORIGINAL_ROWS_SCHEMA_SQL + POSTGRES_SESSION_SEARCH_SCHEMA_SQL + POSTGRES_SESSION_NATIVE_SCHEMA_SQL + POSTGRES_SESSION_METADATA_SCHEMA_SQL + POSTGRES_SESSION_ASCII_SEARCH_SCHEMA_SQL + POSTGRES_CONTINUITY_STATE_SCHEMA_SQL + POSTGRES_RESET_INSTANT_SQL + POSTGRES_HISTORY_KEYSET_SQL + POSTGRES_LOGICAL_MEMBER_SQL + POSTGRES_ARCHIVE_RELATIONAL_ID_SQL + POSTGRES_CATALOG_SCALAR_ID_SQL + POSTGRES_LOGICAL_LOOKUP_INDEX_SQL + POSTGRES_AGENT_DELIVERY_SCHEMA_SQL + POSTGRES_AGENT_DELIVERY_OWNER_SQL + POSTGRES_OPERATOR_INSTANT_SQL + POSTGRES_ARCHIVE_LISTING_INDEX_SQL + POSTGRES_COMPACTION_PROJECTIONS_SQL + POSTGRES_ARCHIVE_LEXICAL_SQL + POSTGRES_ARCHIVE_CHAT_PROJECTION_SQL + POSTGRES_ARCHIVE_DISCOVERY_INDEX_SQL + POSTGRES_CHAT_RESULT_PROJECTION_SQL + POSTGRES_RESET_PROJECTIONS_SQL + POSTGRES_DREAM_WINDOW_SQL + POSTGRES_SESSION_RETRIEVAL_SQL + POSTGRES_SESSION_RECALL_REPAIRS_SQL + POSTGRES_SESSION_RECALL_NONBLOCKING_SQL;
