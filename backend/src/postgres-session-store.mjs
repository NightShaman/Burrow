import { POSTGRES_CONTINUITY_STATE_SCHEMA_SQL } from './postgres-continuity-state-store.mjs';
import { resolveAlbdruckConfig } from './config.mjs';
import { matchesQuery } from './session-search.mjs';
import { closeContinuityOwners } from './postgres-continuity-owner.mjs';
import { randomUUID } from 'node:crypto';
import { closePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';

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

export const POSTGRES_SESSION_FULL_SCHEMA_SQL = POSTGRES_SESSION_SCHEMA_SQL + POSTGRES_SESSION_ARCHIVE_SCHEMA_SQL + POSTGRES_SESSION_LOSSLESS_JSON_SCHEMA_SQL + POSTGRES_SESSION_OPERATOR_LOOKUP_SCHEMA_SQL + POSTGRES_SESSION_ORIGINAL_LOOKUP_SCHEMA_SQL + POSTGRES_SESSION_ORIGINAL_ROWS_SCHEMA_SQL + POSTGRES_SESSION_SEARCH_SCHEMA_SQL + POSTGRES_SESSION_NATIVE_SCHEMA_SQL + POSTGRES_SESSION_METADATA_SCHEMA_SQL + POSTGRES_SESSION_ASCII_SEARCH_SCHEMA_SQL + POSTGRES_CONTINUITY_STATE_SCHEMA_SQL;

const text = (value) => String(value ?? '');
const required = (value, name) => { const result = text(value).trim(); if (!result) throw new Error(`${name} is required`); return result; };
const stamp = () => new Date().toISOString();
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
function rowEntry(row) { return row ? { ...row.entry, sequence: String(row.sequence) } : null; }

export function assertConversationDeletionAllowed(sessionId, metadata = {}) {
  if (['running', 'finalizing'].includes(metadata.continuityHead?.state)) throw new Error('session_retention_active');
  if (metadata.current === true || metadata.currentMain === true || (['main', 'default'].includes(sessionId) && (!metadata.kind || metadata.kind === 'main'))) throw new Error('retention_refused_current_main');
}

/** Staged PostgreSQL authority boundary; callers explicitly own the pool. */
export class PostgresSessionStore {
  constructor({ pool, ownsPool = false, clock = stamp } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('session_postgres_pool_required');
    this.pool = pool; this.ownsPool = ownsPool; this.clock = clock;
  }
  async deleteSession({agentId: rawAgentId, sessionId: rawSessionId} = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const sessionId = required(rawSessionId, 'sessionId');
    return withPostgresTransaction(this.pool, async client => {
      // Lock the authority row before cascaded deletion; active continuity is
      // never eligible even if a retention plan was built before a new run.
      const selected = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sessionId]);
      if (!selected.rows.length) return {deleted:false};
      const active = await client.query('SELECT head_state,queue_status FROM continuity_state WHERE agent_id=$1 AND session_id=$2',[agentId,sessionId]);
      if (['running','finalizing'].includes(active.rows[0]?.head_state) || active.rows[0]?.queue_status==='running') throw new Error('session_retention_active');
      assertConversationDeletionAllowed(sessionId, selected.rows[0].metadata);
      const result = await client.query('DELETE FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2', [agentId, sessionId]);
      return {deleted:result.rowCount === 1};
    });
  }

  async close() { await closeContinuityOwners(this.pool); if (this.ownsPool) await closePostgresPool(this.pool); }

  /** Original JSON is decoded in JS: SQL JSON extraction is not lossless for NUL. */
  async history({ agentId, scope = 'agent', query, cursor = '', pageSize = Math.min(50, resolveAlbdruckConfig().maxPageSize) } = {}) {
    if (!['agent', 'global'].includes(scope) || (scope === 'agent' && (typeof agentId !== 'string' || !agentId.trim()))) throw new Error('albdruck_scope_invalid');
    if (typeof query !== 'string' || !query.trim()) throw new Error('albdruck_query_required');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > resolveAlbdruckConfig().maxPageSize) throw new Error('albdruck_page_size_invalid');
    const binding = JSON.stringify([scope, scope === 'agent' ? agentId : null, query.trim()]);
    let after = null;
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (value.v !== 1 || value.binding !== binding || !Array.isArray(value.key) || value.key.length !== 3 || value.key.some(x => typeof x !== 'string')) throw new Error();
        after = value.key;
      } catch { throw new Error('albdruck_cursor_invalid'); }
    } else if (typeof cursor !== 'string') throw new Error('albdruck_cursor_invalid');
    const compare = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
    const originals = new Map();
    const consider = (row, entry, provenance) => {
      if (entry?.type !== 'message' || entry.metadata?.compressionSummary || !['user','assistant','agent'].includes(entry.role) || typeof entry.content !== 'string') return;
      // The indexed authority carries generated identity separately from original
      // JSON. Do not inject it into entry: exports must retain original bytes.
      const entryId = entry.id || (row.entry_key ? JSON.parse(row.entry_key) : null);
      if (typeof entryId !== 'string' || !entryId) return;
      const key = [row.agent_id, row.session_id, entryId];
      if ((after && compare(key, after) <= 0) || !matchesQuery(entry, query.trim())) return;
      const id = JSON.stringify(key);
      if (!originals.has(id) || provenance.store === 'live' || originals.get(id).item.provenance.store !== 'live') originals.set(id, { key, item: {
        agentId: row.agent_id, sessionId: row.session_id, entryId,
        timestamp: entry.timestamp ?? row.created_at, role: entry.role, content: entry.content,
        sourceRef: { kind: 'conversation_entry', agentId: row.agent_id, sessionId: row.session_id, entryId },
        provenance,
      } });
      // Retain only the smallest page plus lookahead while scanning authority.
      if (originals.size > pageSize + 1) {
        const largest = [...originals.entries()].reduce((a,b) => compare(a[1].key,b[1].key) > 0 ? a : b);
        originals.delete(largest[0]);
      }
    };
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/gu)?.filter(t => t.length >= 3) || [])];
    // OR is intentionally broader than the two-term coverage rule; exact phrase
    // and cross-field matches must not be lost. Final matchesQuery removes noise.
    const grams = terms.map(term => [...new Set(Array.from({ length: term.length - 2 }, (_, i) => term.slice(i, i + 3)))]);
    const candidate = grams.length ? `AND (search_grams IS NULL OR ${grams.map((_, i) => `search_grams @> $${i + 7}::text[]`).join(' OR ')})` : '';
    // One repeatable-read snapshot keeps reset/compaction from hiding a turn during scanning.
    return withPostgresTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      let position = null;
      for (;;) {
        const { rows } = await client.query(`SELECT * FROM conversation_original_rows r
          WHERE ($1::text IS NULL OR agent_id=$1)
          AND ($2::text IS NULL OR (agent_id,session_id,source_store,source_id,ordinal)>($2,$3,$4,$5,$6::bigint))
          ${candidate}
          AND NOT EXISTS (SELECT 1 FROM conversation_original_rows newer
            WHERE newer.agent_id=r.agent_id AND newer.session_id=r.session_id AND newer.entry_key=r.entry_key
            AND (newer.source_store>r.source_store OR
              (newer.source_store=r.source_store AND
                (CASE WHEN r.source_store='live' THEN newer.ordinal>r.ordinal ELSE
                  newer.source_id>r.source_id OR (newer.source_id=r.source_id AND newer.ordinal<r.ordinal) END))))
          ORDER BY agent_id,session_id,source_store,source_id,ordinal LIMIT 256`,
        [scope === 'agent' ? agentId : null, ...(position || [null,null,null,null,null]), ...grams]);
        for (const row of rows) consider(row, row.entry, row.source_store === 'live'
          ? { store: 'live', reset: false }
          : { store: 'archive', reset: row.archive_kind === 'reset', archiveId: row.source_id,
            kind: row.archive_kind, generation: Number(row.generation), archivedAt: row.created_at });
        if (rows.length < 256) break;
        const last = rows.at(-1);
        position = [last.agent_id,last.session_id,last.source_store,last.source_id,String(last.ordinal)];
      }
      const ordered = [...originals.values()].sort((a,b) => compare(a.key,b.key));
      const page = ordered.slice(0,pageSize);
      return { items: page.map(x => x.item), nextCursor: ordered.length > pageSize ? Buffer.from(JSON.stringify({ v: 1, binding, key: page.at(-1).key })).toString('base64url') : null };
    });
  }

  // Shared original-history projection for Dream and conversation context.
  // Live wins over snapshots; snapshot precedence matches resolveOriginal.
  async listOriginalEntries({ agentId: rawAgentId, sessionId: rawSessionId } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const sessionId = required(rawSessionId, 'sessionId');
    return withPostgresTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const entries = []; const seen = new Set(); let position = null;
      for (;;) {
        const { rows } = await client.query(`SELECT source_store,source_id,ordinal,entry,created_at
          FROM conversation_original_rows WHERE agent_id=$1 AND session_id=$2
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
    });
  }

  async resolveOriginal({ agentId, sessionId, entryId }) {
    // Match the lexical JSON spelling, never decoded PostgreSQL text. JSON.stringify
    // safely represents NUL and lone surrogates in the bound lookup key.
    const { rows } = await this.pool.query(`SELECT entry FROM conversation_original_rows
      WHERE agent_id=$1 AND session_id=$2 AND entry_key=$3
      ORDER BY CASE WHEN source_store='live' THEN 0 ELSE 1 END,CASE WHEN source_store='live' THEN ordinal END DESC,source_id DESC,ordinal LIMIT 1`,
    [agentId, sessionId, JSON.stringify(entryId)]);
    return rows[0]?.entry || null;
  }

  async append({ agentId: rawAgentId, sessionId: rawSessionId, entry, idempotencyKey = null } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('session_entry_required');
    const value = { ...entry };
    const entryId = text(value.id).trim() || randomUUID();
    const key = idempotencyKey == null ? (value.metadata?.idempotencyKey || null) : text(idempotencyKey);
    const now = this.clock();
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT(agent_id,session_id) DO NOTHING`, [agentId, sid, now]);
      // Row lock serializes appenders before identity allocation, making commit-order paging complete.
      await client.query('SELECT 1 FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sid]);
      const result = await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at) VALUES($1,$2,$3,$4,$5::json,$6) ON CONFLICT DO NOTHING RETURNING sequence,entry`, [agentId, sid, entryId, key, JSON.stringify(value), now]);
      if (result.rows[0]) {
        await client.query('UPDATE conversation_sessions SET updated_at=$3 WHERE agent_id=$1 AND session_id=$2', [agentId, sid, now]);
        return { ...rowEntry(result.rows[0]), idempotent: false };
      }
      const existing = await client.query(`SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND (entry_id=$3 OR ($4::text IS NOT NULL AND idempotency_key=$4::text)) ORDER BY sequence LIMIT 1`, [agentId, sid, entryId, key]);
      if (!existing.rows[0]) throw new Error('session_entry_conflict');
      return { ...rowEntry(existing.rows[0]), idempotent: true };
    });
  }
  async appendIfAbsent(args = {}) { return this.append(args); }

  async read({ agentId: rawAgentId, sessionId: rawSessionId, limit = 20, after = 0 } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const size = limitValue(limit); const cursor = cursorValue(after);
    const result = await this.pool.query(`SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4`, [agentId, sid, cursor.toString(), size]);
    return result.rows.map(rowEntry);
  }

  async projection({ agentId, sessionId, visibility, limit }) {
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
        if (row.entry.visibility === visibility) matches.push(rowEntry(row));
        if (matches.length === size) break;
      }
      if (result.rows.length < 256) break;
      before = String(result.rows.at(-1).sequence);
    }
    return matches.reverse();
  }

  async page(args = {}) {
    const size = limitValue(args.limit); const cursor = cursorValue(args.after); const agentId = required(args.agentId, 'agentId'); const sid = required(args.sessionId, 'sessionId');
    const result = await this.pool.query(`SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4`, [agentId, sid, cursor.toString(), size + 1]);
    const hasMore = result.rows.length > size; const rows = hasMore ? result.rows.slice(0, size) : result.rows;
    return { entries: rows.map(rowEntry), next: hasMore ? String(rows.at(-1).sequence) : null, hasMore };
  }

  // Indexed candidate pages; final query/ranking/filter semantics stay in JS.
  async searchEvidencePage({ agentId, sessionId, query = '', includeResetHistory = false, after = null, limit = 256 } = {}) {
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/gu)?.filter(t => t.length >= 3) || [])];
    const grams = terms.map(t => [...new Set(Array.from({ length: t.length - 2 }, (_, i) => t.slice(i,i+3)))]);
    const candidate = grams.length ? `AND (r.has_compression_summary OR r.search_grams IS NULL OR ${grams.map((_,i) => `r.search_grams @> $${i+7}::text[]`).join(' OR ')})` : '';
    const { rows } = await this.pool.query(`SELECT r.*, (r.archive_kind='reset' OR r.generation <= COALESCE((SELECT max(a.generation) FROM conversation_archives a WHERE a.agent_id=r.agent_id AND a.session_id=r.session_id AND a.kind='reset'),-1) OR (s.metadata->>'resetAt' IS NOT NULL AND r.created_at<=s.metadata->>'resetAt')) AS reset_archive FROM conversation_original_rows r
      JOIN conversation_sessions s USING(agent_id,session_id)
      WHERE r.agent_id=$1 AND r.session_id=$2
      AND ($3::text IS NULL OR (r.source_store,r.source_id,r.ordinal)>($3,$4,$5::bigint))
      AND (${includeResetHistory ? 'true' : 'false'} OR r.source_store='live' OR (r.archive_kind <> 'reset'
        AND r.generation > COALESCE((SELECT max(a.generation) FROM conversation_archives a
          WHERE a.agent_id=r.agent_id AND a.session_id=r.session_id AND a.kind='reset'),-1)
        AND (s.metadata->>'resetAt' IS NULL OR r.created_at>s.metadata->>'resetAt')))
      AND NOT EXISTS (SELECT 1 FROM conversation_original_rows newer
        WHERE newer.agent_id=r.agent_id AND newer.session_id=r.session_id
        AND newer.entry_key=r.entry_key AND r.has_payload_id
        AND (newer.source_store>r.source_store OR
          (newer.source_store=r.source_store AND
            (CASE WHEN r.source_store='live' THEN newer.ordinal>r.ordinal ELSE
              newer.generation>r.generation OR (newer.generation=r.generation AND
                (newer.source_id>r.source_id OR (newer.source_id=r.source_id AND newer.ordinal>r.ordinal))) END))))
      ${candidate}
      ORDER BY r.source_store,r.source_id,r.ordinal LIMIT $6`,
      [required(agentId,'agentId'),required(sessionId,'sessionId'),...(after || [null,null,null]),limit,...grams]);
    const last = rows.at(-1);
    return { rows, next: rows.length === limit ? [last.source_store,last.source_id,String(last.ordinal)] : null };
  }

  async lastOperatorMessageAt({ agentId: rawAgentId } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    let newest = null;
    const consider = (entry) => {
      if (entry?.type !== 'message' || entry?.role !== 'user') return;
      if (entry?.metadata?.source === 'scheduled' || String(entry?.runId || '').startsWith('scheduled-')) return;
      const at = new Date(entry.ts);
      if (Number.isFinite(at.getTime()) && (!newest || at > newest)) newest = at;
    };
    // Decode lossless JSON in JS; never unpack archive blobs or decode in SQL.
    let position = null;
    for (;;) {
      const { rows } = await this.pool.query(`SELECT session_id,source_store,source_id,ordinal,entry
        FROM conversation_original_rows WHERE agent_id=$1
        AND ($2::text IS NULL OR (session_id,source_store,source_id,ordinal)>($2,$3,$4,$5::bigint))
        ORDER BY session_id,source_store,source_id,ordinal LIMIT 256`,
      [agentId, ...(position || [null,null,null,null])]);
      for (const row of rows) consider(row.entry);
      if (rows.length < 256) break;
      const last = rows.at(-1);
      position = [last.session_id,last.source_store,last.source_id,String(last.ordinal)];
    }
    return newest?.toISOString() || null;
  }

  async listSessions({ agentId: rawAgentId, includeArchived = true } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const result = await this.pool.query(`SELECT session_id,metadata,created_at,updated_at,(SELECT head FROM continuity_state c WHERE c.agent_id=conversation_sessions.agent_id AND c.session_id=conversation_sessions.session_id) AS continuity_head FROM conversation_sessions WHERE agent_id=$1 ${includeArchived ? '' : "AND COALESCE((metadata->>'archived')::boolean,false)=false"} ORDER BY updated_at DESC`, [agentId]);
    return result.rows.map((row) => ({ ...row.metadata, ...(row.continuity_head ? {continuityHead:row.continuity_head} : {}), sessionId: row.session_id, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  // A single statement gives metadata, retained generations and active entries one
  // MVCC snapshot. Reset documents are separate exports, never active history.
  async exportTranscript({ agentId, sessionId } = {}) {
    const result = await this.pool.query(`
      SELECT s.metadata,s.created_at,s.updated_at,
        COALESCE((SELECT json_agg((SELECT COALESCE(json_agg(e.entry ORDER BY e.ordinal),'[]'::json) FROM conversation_archive_entries e WHERE e.agent_id=a.agent_id AND e.session_id=a.session_id AND e.source_id=a.archive_id) ORDER BY a.generation,a.created_at,a.archive_id)
          FROM conversation_archives a WHERE a.agent_id=s.agent_id AND a.session_id=s.session_id
          AND a.kind='compacted' AND a.generation >= COALESCE(
            (s.metadata->>'resetGeneration')::bigint,
            (SELECT max(r.generation)+1 FROM conversation_archives r
              WHERE r.agent_id=s.agent_id AND r.session_id=s.session_id AND r.kind='reset'),0)), '[]'::json) AS history,
        COALESCE((SELECT json_agg(e.entry ORDER BY e.sequence) FROM conversation_entries e
          WHERE e.agent_id=s.agent_id AND e.session_id=s.session_id), '[]'::json) AS entries
      FROM conversation_sessions s WHERE s.agent_id=$1 AND s.session_id=$2`,
    [required(agentId, 'agentId'), required(sessionId, 'sessionId')]);
    const row = result.rows[0];
    if (!row) return null;
    return { schemaVersion: '1', session: { id: sessionId, metadata: { ...row.metadata, createdAt: row.created_at, updatedAt: row.updated_at } }, entries: [...row.history.flat(), ...row.entries] };
  }

  async getMetadata({ agentId: rawAgentId, sessionId: rawSessionId } = {}) {
    const result = await this.pool.query('SELECT metadata,created_at,updated_at FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2', [required(rawAgentId, 'agentId'), required(rawSessionId, 'sessionId')]);
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
    const result = await this.pool.query(`UPDATE conversation_archives SET metadata=metadata || $4::jsonb WHERE agent_id=$1 AND session_id=$2 AND archive_id=$3 RETURNING metadata`, [required(agentId,'agentId'),required(sessionId,'sessionId'),required(archiveId,'archiveId'),JSON.stringify(metadata)]);
    return result.rows[0]?.metadata || null;
  }

  async compact({ agentId: rawAgentId, sessionId: rawSessionId, summary, tailEntries = [] } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId');
    if (!summary || typeof summary !== 'object' || !String(summary.text || '').trim()) throw new Error('session_compaction_summary_required');
    const now = this.clock();
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT DO NOTHING`, [agentId, sid, now]);
      const session = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sid]);
      const prior = session.rows[0]?.metadata || {};
      const old = await client.query('SELECT sequence,entry,entry_id,idempotency_key FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 ORDER BY sequence', [agentId, sid]);
      const archiveId = old.rows.length ? randomUUID() : null;
      const generation = Number(prior.generation || 0) + 1;
      if (archiveId) await client.query('INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)', [agentId, sid, archiveId, generation - 1, 'compacted', JSON.stringify({ ...prior, compressionSummary: summary }), now]);
      if (archiveId) await client.query(`INSERT INTO conversation_archive_entries
        (agent_id,session_id,source_store,source_id,ordinal,entry_key,entry,search_projection,created_at,archive_kind,generation,entry_id,idempotency_key)
        SELECT agent_id,session_id,'archive',$3,sequence,to_json(entry_id)::text,entry,
          COALESCE(burrow_json_member(entry,'content')::text,''),created_at,$4,$5,entry_id,idempotency_key
        FROM conversation_entries WHERE agent_id=$1 AND session_id=$2`, [agentId,sid,archiveId,'compacted',generation-1]);
      await client.query('DELETE FROM conversation_entries WHERE agent_id=$1 AND session_id=$2', [agentId, sid]);
      const summaryEntry = { id: randomUUID(), ts: now, sessionId: sid, type: 'summary', role: null, content: String(summary.text), visibility: 'debug', entersPrompt: false, metadata: { compressionSummary: summary } };
      const retained = (Array.isArray(tailEntries) ? tailEntries : []).map((entry) => ({ ...entry, sessionId: sid, metadata: { ...(entry.metadata || {}) } }));
      for (const entry of [summaryEntry, ...retained]) {
        await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at) VALUES($1,$2,$3,$4::json,$5)', [agentId, sid, text(entry.id).trim() || old.rows.find(row => (entry.sequence && String(row.sequence) === String(entry.sequence)) || JSON.stringify({ ...row.entry, sessionId: sid, metadata: { ...(row.entry.metadata || {}) } }) === JSON.stringify(entry))?.entry_id || randomUUID(), JSON.stringify(entry), now]);
      }
      const next = { ...prior, generation, archived: false, transcriptGeneration: randomUUID(), activeTranscript: 'postgres', archiveId, updatedAt: now, turnCount: 1 + retained.length, chatTurnCount: retained.filter((entry) => entry.type === 'message' && ['user','assistant','agent'].includes(entry.role)).length };
      await client.query('UPDATE conversation_sessions SET metadata=$3::jsonb,updated_at=$4 WHERE agent_id=$1 AND session_id=$2', [agentId, sid, JSON.stringify(next), now]);
      return { archiveId, generation, summaryEntry, retainedCount: retained.length, metadata: next };
    });
  }

  async reset({ agentId: rawAgentId, sessionId: rawSessionId, metadata = {} } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const now = this.clock();
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT DO NOTHING`, [agentId, sid, now]);
      const session = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sid]);
      const prior = session.rows[0]?.metadata || {};
      const rows = await client.query('SELECT entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 ORDER BY sequence', [agentId, sid]);
      const archiveId = rows.rows.length ? randomUUID() : null;
      const generation = Number(prior.generation || 0) + 1;
      if (archiveId) await client.query('INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)', [agentId, sid, archiveId, generation - 1, 'reset', JSON.stringify({ ...prior, ...metadata }), now]);
      if (archiveId) await client.query(`INSERT INTO conversation_archive_entries
        (agent_id,session_id,source_store,source_id,ordinal,entry_key,entry,search_projection,created_at,archive_kind,generation,entry_id,idempotency_key)
        SELECT agent_id,session_id,'archive',$3,sequence,to_json(entry_id)::text,entry,
          COALESCE(burrow_json_member(entry,'content')::text,''),created_at,$4,$5,entry_id,idempotency_key
        FROM conversation_entries WHERE agent_id=$1 AND session_id=$2`, [agentId,sid,archiveId,'reset',generation-1]);
      await client.query('DELETE FROM conversation_entries WHERE agent_id=$1 AND session_id=$2', [agentId, sid]);
      const next = { ...prior, ...metadata, generation, resetGeneration: generation, archived: false, resetAt: now, archiveId, turnCount: 0, chatTurnCount: 0 };
      await client.query('UPDATE conversation_sessions SET metadata=$3::jsonb,updated_at=$4 WHERE agent_id=$1 AND session_id=$2', [agentId, sid, JSON.stringify(next), now]);
      return { ok: true, agentId, sessionId: sid, archiveId, generation, metadata: { ...next, updatedAt: now } };
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
      const sourceRows = await client.query('SELECT entry,entry_id FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 ORDER BY sequence DESC LIMIT $3', [sourceAgent, source, size]);
      const sourceEntries = sourceRows.rows.reverse();
      const entries = sourceEntries.map((row) => row.entry);
      for (const entry of entries) { const value = { ...entry, metadata: { ...(entry.metadata || {}), forkedFrom: source } }; await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at) VALUES($1,$2,$3,$4::json,$5)', [targetAgent, target, text(value.id).trim() || sourceEntries.find(row => row.entry === entry)?.entry_id || randomUUID(), JSON.stringify(value), now]); }
      return { ok: true, sourceAgentId: sourceAgent, targetAgentId: targetAgent, sourceSessionId: source, targetSessionId: target, copiedEntries: entries.length };
    });
  }

  async rename({ agentId: rawAgentId, sessionId: rawSessionId, targetSessionId: rawTarget } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const source = required(rawSessionId, 'sessionId');
    const target = required(rawTarget, 'targetSessionId');
    if (source === target) return { ok: true, agentId, sessionId: source, targetSessionId: target };
    return withPostgresTransaction(this.pool, async (client) => {
      const sourceRow = await client.query('SELECT metadata,created_at,updated_at FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, source]);
      if (!sourceRow.rows[0]) return null;
      const reserved = await client.query('INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT DO NOTHING RETURNING session_id', [agentId, target, JSON.stringify({ ...sourceRow.rows[0].metadata, sessionId: target }), sourceRow.rows[0].created_at, sourceRow.rows[0].updated_at]);
      if (!reserved.rows[0]) throw new Error('rename_target_exists');
      await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at) SELECT agent_id,$3,entry_id,idempotency_key,entry,created_at FROM conversation_entries WHERE agent_id=$1 AND session_id=$2`, [agentId, source, target]);
      await client.query(`INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,metadata,created_at) SELECT agent_id,$3,archive_id,generation,kind,metadata,created_at FROM conversation_archives WHERE agent_id=$1 AND session_id=$2`, [agentId, source, target]);
      await client.query(`INSERT INTO conversation_archive_entries
        (agent_id,session_id,source_store,source_id,ordinal,entry_key,entry,search_projection,created_at,archive_kind,generation,search_grams,entry_id,idempotency_key)
        SELECT agent_id,$3,source_store,source_id,ordinal,entry_key,entry,search_projection,created_at,archive_kind,generation,search_grams,entry_id,idempotency_key
        FROM conversation_archive_entries WHERE agent_id=$1 AND session_id=$2`, [agentId,source,target]);
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

  async listArchives({ agentId: rawAgentId, sessionId: rawSessionId, limit = 100 } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const params = [agentId]; let where = 'agent_id=$1';
    if (rawSessionId != null) { params.push(required(rawSessionId, 'sessionId')); where += ` AND session_id=$${params.length}`; }
    const unbounded = limit === null;
    if (!unbounded) params.push(limitValue(limit));
    const result = await this.pool.query(`SELECT archive_id,session_id,generation,kind,COALESCE((SELECT json_agg(e.entry ORDER BY e.ordinal) FROM conversation_archive_entries e WHERE e.agent_id=conversation_archives.agent_id AND e.session_id=conversation_archives.session_id AND e.source_id=conversation_archives.archive_id),'[]'::json) AS entries,metadata,created_at FROM conversation_archives WHERE ${where} ORDER BY created_at DESC, archive_id DESC${unbounded ? '' : ` LIMIT $${params.length}`}`, params);
    return result.rows.map((row) => ({ archiveId: row.archive_id, sessionId: row.session_id, generation: Number(row.generation), kind: row.kind, entries: row.entries, metadata: row.metadata, createdAt: row.created_at }));
  }

  async readArchive({ agentId: rawAgentId, sessionId: rawSessionId, archiveId } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const id = required(archiveId, 'archiveId');
    const result = await this.pool.query(`SELECT archive_id,session_id,generation,kind,COALESCE((SELECT json_agg(e.entry ORDER BY e.ordinal) FROM conversation_archive_entries e WHERE e.agent_id=conversation_archives.agent_id AND e.session_id=conversation_archives.session_id AND e.source_id=conversation_archives.archive_id),'[]'::json) AS entries,metadata,created_at FROM conversation_archives WHERE agent_id=$1 AND session_id=$2 AND archive_id=$3`, [agentId, sid, id]);
    const row = result.rows[0];
    return row ? { archiveId: row.archive_id, sessionId: row.session_id, generation: Number(row.generation), kind: row.kind, entries: row.entries, metadata: row.metadata, createdAt: row.created_at } : null;
  }
}

export const SESSION_SCHEMA_SQL = POSTGRES_SESSION_FULL_SCHEMA_SQL;
