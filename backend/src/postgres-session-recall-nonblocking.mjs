// Additive v96. Published v93–95 SQL remains byte immutable. No source scan.
export const POSTGRES_SESSION_RECALL_NONBLOCKING_SQL = String.raw`
CREATE OR REPLACE FUNCTION burrow_json_members(payload json, members text[]) RETURNS json[]
LANGUAGE plpgsql IMMUTABLE STRICT AS $archive$
DECLARE source text := payload::text; bytes bytea := convert_to(source,'UTF8'); result json[] := array_fill(NULL::json,ARRAY[cardinality(members)]);
 keys text[]; part text; matched text[]; depth int := 0; cursor_at int := 1;
 value_at int; wanted int; key_index int; expecting_key boolean := true;
BEGIN
 SELECT array_agg(burrow_history_text(member) ORDER BY ordinal) INTO keys
 FROM unnest(members) WITH ORDINALITY m(member,ordinal);
 FOR matched IN SELECT regexp_matches(source,'"[^"\\]*(?:\\.[^"\\]*)*"|[^"{}\[\]:,]+|[{}\[\]:,]','g') LOOP
  part := matched[1];
  IF left(part,1)='"' THEN
   IF depth=1 AND expecting_key THEN
    key_index := array_position(keys,burrow_history_key(part));
   END IF;
  ELSIF part=':' AND depth=1 THEN
   wanted := key_index; key_index := NULL; expecting_key := false;
   IF wanted IS NOT NULL THEN value_at := cursor_at+1; END IF;
  ELSIF part IN ('{','[') THEN depth := depth+1;
  ELSIF part IN ('}',']') THEN
   depth := depth-1;
   IF depth=0 AND value_at IS NOT NULL THEN
    result[wanted] := convert_from(substring(bytes FROM value_at FOR cursor_at-value_at),'UTF8')::json;
    value_at := NULL; wanted := NULL;
   END IF;
  ELSIF part=',' AND depth=1 THEN
   IF value_at IS NOT NULL THEN
    result[wanted] := convert_from(substring(bytes FROM value_at FOR cursor_at-value_at),'UTF8')::json;
    value_at := NULL;
   END IF;
   wanted := NULL; key_index := NULL; expecting_key := true;
  END IF;
  cursor_at := cursor_at+octet_length(part);
 END LOOP;
 RETURN result;
END $archive$;

CREATE OR REPLACE FUNCTION burrow_recall_project(payload json) RETURNS TABLE(
 haystack text,content_key text,grams text[],rank_weight int,role text,summary boolean,eligible boolean,
 ts_key text,entry_at timestamptz,ts_fallback text,logical_key text)
LANGUAGE plpgsql STABLE AS $recall$
DECLARE fields json[]; nested json[]; meta json; summary_token json; summary_text json; at_token json; value text; lower_content text; lower_summary text;
BEGIN
 fields:=burrow_json_members(payload,ARRAY['id','role','type','visibility','content','metadata','entersPrompt','ts']);
 meta:=fields[6]; nested:=burrow_json_members(meta,ARRAY['compressionSummary']); summary_token:=nested[1];
 summary:=burrow_recall_truthy(summary_token);
 nested:=burrow_json_members(summary_token,ARRAY['text']); summary_text:=nested[1];
 role:=burrow_recall_string(fields[2]);
 eligible:=summary OR (
  (fields[3] IS NULL OR json_typeof(fields[3])='null' OR burrow_recall_key(fields[3]::text)=burrow_history_text('message'))
  AND role IN (burrow_history_text('user'),burrow_history_text('assistant'),burrow_history_text('agent'))
  AND (fields[4] IS NULL OR json_typeof(fields[4])='null' OR burrow_recall_key(fields[4]::text)=burrow_history_text('chat'))
  AND (fields[7] IS NULL OR btrim(fields[7]::text,E' \t\r\n') IN ('null','true')));
 IF eligible THEN
 lower_content:=burrow_recall_lower(burrow_recall_string(fields[5]));
 lower_summary:=burrow_recall_lower(burrow_recall_string(summary_text));
 haystack:=burrow_recall_lower(burrow_recall_string(fields[1])) || '000a' ||
   burrow_recall_lower(burrow_recall_string(fields[2])) || '000a' ||
   burrow_recall_lower(burrow_recall_string(fields[3])) || '000a' ||
   burrow_recall_lower(burrow_recall_string(fields[4])) || '000a' ||
   lower_content || '000a' || lower_summary;
 content_key:=CASE WHEN burrow_recall_truthy(summary_text) THEN lower_summary ELSE lower_content END;
 grams:=burrow_recall_grams(haystack);
 role:=burrow_recall_string(fields[2]);
 rank_weight:=burrow_recall_weight(content_key,CASE WHEN json_typeof(fields[2])='string' THEN role ELSE '' END);
 eligible:=eligible AND NOT (replace(burrow_recall_text(lower_content),chr(383),'s')
  ~ '(^|[^a-z0-9_])(no (recorded|prior-session) (decision|evidence)|available prior-session history)([^a-z0-9_]|$)');
 ELSE
  -- Ineligible occurrences still shadow older logical IDs. Never omit them.
  haystack:=''; content_key:=''; grams:=ARRAY[]::text[]; rank_weight:=1;
 END IF;
 -- Public source IDs and precedence use the existing stored logical mapping.
 logical_key:=NULLIF(burrow_recall_key(fields[1]::text),'');
 at_token:=fields[8]; ts_key:=burrow_recall_string(at_token);
 ts_fallback:=CASE WHEN at_token IS NOT NULL THEN at_token::text END;
 IF json_typeof(at_token)='string' THEN
  BEGIN value:=at_token #>> '{}'; EXCEPTION WHEN OTHERS THEN value:=NULL; END;
  IF value ~ '^\d{4}-\d{2}-\d{2}$' THEN value:=value||'T00:00:00Z'; END IF;
  IF value ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$' THEN
   entry_at:=burrow_legacy_instant(value);
   IF entry_at IS NOT NULL THEN ts_fallback:=NULL; END IF;
  END IF;
 END IF;
 RETURN NEXT;
END $recall$;
`;
