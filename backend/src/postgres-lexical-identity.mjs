// Append-only logical member identity; original JSON bytes remain untouched.
export const POSTGRES_LOGICAL_MEMBER_SQL = String.raw`
CREATE OR REPLACE FUNCTION burrow_json_member(payload json, member text) RETURNS json
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE s bytea := convert_to(payload::text,'UTF8'); i int := 1; start_at int;
 depth int := 0; quoted boolean := false; escaped boolean := false;
 key_start int := 0; wanted boolean := false; c text; result json;
BEGIN
 WHILE i <= octet_length(s) LOOP
  c := chr(get_byte(s,i-1));
  IF quoted THEN
   IF escaped THEN escaped := false;
   ELSIF c = chr(92) THEN escaped := true;
   ELSIF c = '"' THEN
    quoted := false;
    IF depth = 1 AND key_start > 0 THEN
     wanted := burrow_history_key(convert_from(substring(s FROM key_start FOR i-key_start+1),'UTF8')) = burrow_history_text(member);
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
    IF depth = 0 AND start_at IS NOT NULL THEN result := convert_from(substring(s FROM start_at FOR i-start_at),'UTF8')::json; start_at := NULL; END IF;
   ELSIF c = ',' AND depth = 1 THEN
    IF start_at IS NOT NULL THEN result := convert_from(substring(s FROM start_at FOR i-start_at),'UTF8')::json; start_at := NULL; END IF;
    wanted := false;
   END IF;
  END IF;
  i := i+1;
 END LOOP;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION burrow_json_metadata(payload json) RETURNS json[]
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result json[]; nested json;
BEGIN
 result := ARRAY[burrow_json_member(payload,'id'),burrow_json_member(payload,'role'),
 burrow_json_member(payload,'type'),burrow_json_member(payload,'visibility'),
 burrow_json_member(payload,'content'),burrow_json_member(payload,'metadata'),NULL::json];
 nested := result[6];
 IF nested IS NOT NULL THEN result[7] := burrow_json_member(nested,'compressionSummary'); END IF;
 RETURN result;
END $$;
UPDATE conversation_entries SET has_payload_id=NULL WHERE created_at IS NOT NULL;
UPDATE conversation_archive_entries SET has_payload_id=NULL WHERE created_at IS NOT NULL;
`;

// Archive relational IDs are provenance; legacy rows without them stay id-less.
export const POSTGRES_ARCHIVE_RELATIONAL_ID_SQL = String.raw`
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
 IF TG_TABLE_NAME = 'conversation_entries' OR NEW.entry_id IS NOT NULL THEN
  NEW.entry_key := COALESCE(NEW.entry_key,to_json(NEW.entry_id)::text);
 END IF;
 NEW.search_projection := COALESCE(tokens[5]::text,'');
 NEW.has_compression_summary := tokens[7] IS NOT NULL;
 NEW.search_grams := burrow_entry_search_grams(NEW.entry);
 RETURN NEW;
END $$;
UPDATE conversation_entries SET has_payload_id=NULL WHERE created_at IS NOT NULL;
UPDATE conversation_archive_entries SET has_payload_id=NULL WHERE created_at IS NOT NULL;
`;

// Decode only the selected scalar; unrelated metadata is never sanitized.
export const POSTGRES_CATALOG_SCALAR_ID_SQL = String.raw`
CREATE OR REPLACE FUNCTION catalog_identity(payload json, field text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE token json;
BEGIN
 token := burrow_json_member(payload,field);
 RETURN token #>> '{}';
END $$;
`;

export const POSTGRES_LOGICAL_LOOKUP_INDEX_SQL = String.raw`
CREATE INDEX conversation_entries_logical_identity_idx ON conversation_entries
 (agent_id,session_id,burrow_history_key(entry_key),sequence DESC);
CREATE INDEX conversation_archive_entries_logical_identity_idx ON conversation_archive_entries
 (agent_id,session_id,burrow_history_key(entry_key),generation DESC,source_id DESC,ordinal);
`;
