// Append-only history ordering: fixed-width UTF-16 units reproduce JS string
// comparison without decoding NUL or lone surrogates into PostgreSQL text.
export const POSTGRES_HISTORY_KEYSET_SQL = String.raw`
CREATE FUNCTION burrow_history_key(value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE i int := 2; n int; c text; code int; result text := '';
BEGIN
 value := btrim(value, E' \t\r\n'); n := length(value)-1;
 IF left(value,1) <> '"' THEN RETURN NULL; END IF;
 WHILE i <= n LOOP
  c := substr(value,i,1);
  IF c = chr(92) THEN
   i := i+1; c := substr(value,i,1);
   IF c = 'u' THEN
    result := result || lower(substr(value,i+1,4)); i := i+5; CONTINUE;
   END IF;
   code := CASE c WHEN 'b' THEN 8 WHEN 'f' THEN 12 WHEN 'n' THEN 10
    WHEN 'r' THEN 13 WHEN 't' THEN 9 ELSE ascii(c) END;
  ELSE code := ascii(c); END IF;
  IF code > 65535 THEN
   code := code-65536;
   result := result || lpad(to_hex(55296+code/1024),4,'0') || lpad(to_hex(56320+code%1024),4,'0');
  ELSE result := result || lpad(to_hex(code),4,'0'); END IF;
  i := i+1;
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION burrow_history_text(value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path FROM CURRENT AS $$ BEGIN RETURN burrow_history_key(to_json(value)::text); END $$;
CREATE INDEX conversation_entries_history_order_idx ON conversation_entries
 (burrow_history_text(agent_id) COLLATE "C",burrow_history_text(session_id) COLLATE "C",burrow_history_key(entry_key) COLLATE "C");
CREATE INDEX conversation_archive_entries_history_order_idx ON conversation_archive_entries
 (burrow_history_text(agent_id) COLLATE "C",burrow_history_text(session_id) COLLATE "C",burrow_history_key(entry_key) COLLATE "C");
CREATE INDEX conversation_entries_entry_key_idx ON conversation_entries(agent_id,session_id,entry_key,sequence DESC);
CREATE INDEX conversation_archive_entries_history_precedence_idx ON conversation_archive_entries
 (agent_id,session_id,entry_key,generation DESC,source_id DESC,ordinal);
`;
