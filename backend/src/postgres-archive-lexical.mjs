// Additive Archive read projection. JSON values stay lexical: JSONB / json_each
// would decode NUL or lone-surrogate object keys and reject supported history.
// Tokenize strings and punctuation in PostgreSQL's regex engine rather than
// visiting every byte of a potentially large retained message in PL/pgSQL.
export const POSTGRES_ARCHIVE_LEXICAL_SQL = String.raw`
CREATE FUNCTION burrow_json_members(payload json, members text[]) RETURNS json[]
LANGUAGE plpgsql IMMUTABLE STRICT AS $archive$
DECLARE source text := payload::text; result json[] := array_fill(NULL::json,ARRAY[cardinality(members)]);
 keys text[]; part text; matched text[]; depth int := 0; cursor_at int := 1;
 value_at int; wanted int; key_index int; expecting_key boolean := true;
BEGIN
 SELECT array_agg(burrow_history_text(member) ORDER BY ordinal) INTO keys
 FROM unnest(members) WITH ORDINALITY m(member,ordinal);
 FOR matched IN SELECT regexp_matches(source,'"(?:[^"\\]|\\.)*"|[^"{}\[\]:,]+|[{}\[\]:,]','g') LOOP
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
    result[wanted] := substring(source FROM value_at FOR cursor_at-value_at)::json;
    value_at := NULL; wanted := NULL;
   END IF;
  ELSIF part=',' AND depth=1 THEN
   IF value_at IS NOT NULL THEN
    result[wanted] := substring(source FROM value_at FOR cursor_at-value_at)::json;
    value_at := NULL;
   END IF;
   wanted := NULL; key_index := NULL; expecting_key := true;
  END IF;
  cursor_at := cursor_at+length(part);
 END LOOP;
 RETURN result;
END $archive$;
CREATE FUNCTION burrow_archive_fields(payload json) RETURNS json[]
LANGUAGE plpgsql IMMUTABLE STRICT AS $archive$
DECLARE fields json[]; nested json[];
BEGIN
 fields := burrow_json_members(payload,ARRAY['id','timestamp','ts','at','createdAt',
   'role','type','visibility','entersPrompt','metadata']);
 IF fields[10] IS NOT NULL THEN
  nested := burrow_json_members(fields[10],ARRAY['attachments']);
 END IF;
 -- Only attachment presence/length is needed: do not retain other metadata.
 fields[10] := nested[1];
 RETURN fields;
END $archive$;
CREATE FUNCTION burrow_archive_instant(token json) RETURNS timestamptz
LANGUAGE plpgsql STABLE STRICT AS $archive$
DECLARE value text;
BEGIN
 value := token #>> '{}';
 IF value ~ '^\d{4}-\d{2}-\d{2}$' THEN value := value || 'T00:00:00Z';
 ELSIF value !~ '(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN RETURN NULL; END IF;
 RETURN burrow_legacy_instant(value);
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $archive$;
-- Live entry_id is already unique per session. Archive copies have no such
-- uniqueness: both fallback precedence and reset-target probes need this key.
CREATE INDEX conversation_archive_entries_occurrence_lookup_idx ON conversation_archive_entries
 (agent_id,session_id,entry_id,generation DESC,source_id DESC,ordinal) WHERE entry_id<>'';
CREATE INDEX conversation_archive_entries_occurrence_source_idx ON conversation_archive_entries
 (agent_id,session_id,entry_id,source_id,ordinal) WHERE entry_id<>'';
`;

// Only trim the four JSON whitespace characters outside a lexical token.
// Keep burrow_json_members lossless: its returned bytes match the individual
// scanner, and neither this trim nor any comparison changes quoted contents.
const archiveTrimTokenSQL = text => `btrim(${text},E' \\t\\r\\n')`;

// fields: [id,timestamp,ts,at,createdAt,role,type,visibility,entersPrompt,attachments].
export function archiveOccurrenceTokenSQL(alias) {
  return `COALESCE(NULLIF(${archiveTrimTokenSQL(`${alias}.fields[2]::text`)},'null'),
    NULLIF(${archiveTrimTokenSQL(`${alias}.fields[3]::text`)},'null'),
    NULLIF(${archiveTrimTokenSQL(`${alias}.fields[4]::text`)},'null'),
    NULLIF(${archiveTrimTokenSQL(`${alias}.fields[5]::text`)},'null'))`;
}

// JavaScript's String(number), not a JSON numeric spelling (1, 1.0 and "1"
// share a truthy payload identity). Only individual safe numeric tokens decode.
export function archiveNumberTextSQL(token) {
  // PostgreSQL deliberately avoids shortest decimal midpoint spellings (1e23),
  // whereas JS chooses them. Find the shortest rounded significant decimal that
  // reads back to the same IEEE-754 value, then apply ECMAScript's exponent cutoffs.
  return `(SELECT CASE WHEN number IS NOT NULL THEN CASE WHEN number=0 THEN '0'
      WHEN abs(number)>=0.000001 AND abs(number)<1e21 THEN
        CASE WHEN position('.' IN decimal::text)>0 THEN rtrim(rtrim(decimal::text,'0'),'.') ELSE decimal::text END
      ELSE (CASE WHEN number<0 THEN '-' ELSE '' END) || left(digits,1)
        || CASE WHEN length(digits)>1 THEN '.' || substring(digits FROM 2) ELSE '' END
        || 'e' || CASE WHEN exponent>=0 THEN '+' ELSE '' END || exponent::text END
    WHEN pg_input_is_valid(raw,'numeric') THEN CASE WHEN abs(raw::numeric)<1 THEN '0'
      WHEN left(raw,1)='-' THEN '-Infinity' ELSE 'Infinity' END
    WHEN raw ~ '[eE]-' THEN '0' WHEN left(raw,1)='-' THEN '-Infinity' ELSE 'Infinity' END
    FROM (SELECT *,rtrim(regexp_replace(replace(abs(decimal)::text,'.',''),'^0+',''),'0') AS digits,
        CASE WHEN decimal<>0 THEN floor(log(abs(decimal)))::int ELSE 0 END AS exponent
      FROM (SELECT *,CASE WHEN number<>0 THEN (
          SELECT rounded FROM (SELECT p,round(number::text::numeric,
            p-1-floor(log(abs(number::text::numeric)))::int) AS rounded FROM generate_series(1,17) p) choices
          WHERE CASE WHEN pg_input_is_valid(rounded::text,'double precision') THEN rounded::text::double precision=number ELSE false END
          ORDER BY p LIMIT 1) ELSE 0::numeric END AS decimal
        FROM (SELECT raw,CASE WHEN pg_input_is_valid(raw,'double precision') THEN raw::double precision END AS number
          FROM (SELECT ${archiveTrimTokenSQL(`(${token})::text`)} AS raw OFFSET 0) numeric_token) parsed_number) shortest) formatted_number)`;
}

export function archiveTruthyNumberSQL(token) {
  const raw = archiveTrimTokenSQL(`(${token})::text`);
  return `(CASE WHEN pg_input_is_valid(${raw},'double precision') THEN ${raw}::double precision<>0
    WHEN pg_input_is_valid(${raw},'numeric') THEN abs(${raw}::numeric)>=1
    ELSE ${raw} !~ '[eE]-' END)`;
}

export function archiveLeafStringKeySQL(token) {
  return `CASE json_typeof(${token})
    WHEN 'string' THEN burrow_history_key((${token})::text)
    WHEN 'number' THEN burrow_history_text(${archiveNumberTextSQL(token)})
    WHEN 'boolean' THEN burrow_history_text(${archiveTrimTokenSQL(`(${token})::text`)})
    WHEN 'object' THEN burrow_history_text('[object Object]') ELSE '' END`;
}

// Lossless UTF-16 String(value) key. Arrays use recursive Array#join semantics:
// null/empty children are blank, each array-level separator is still visible.
// Never decode a retained object/string into jsonb (NUL and lone surrogates).
export function archiveStringKeySQL(token) {
  return `(CASE WHEN json_typeof(${token})='array' THEN (
    WITH RECURSIVE parts(value,path,separator) AS (
      SELECT ${token},ARRAY[]::bigint[],false
      UNION ALL SELECT child.value,parts.path || child.ordinal,child.ordinal>1 FROM parts
        CROSS JOIN LATERAL json_array_elements(CASE WHEN json_typeof(parts.value)='array' THEN parts.value ELSE '[]'::json END)
          WITH ORDINALITY child(value,ordinal)
    ) SELECT COALESCE(string_agg((CASE WHEN separator THEN '002c' ELSE '' END) ||
      ${archiveLeafStringKeySQL('parts.value')},'' ORDER BY path),'') FROM parts
    ) ELSE ${archiveLeafStringKeySQL(token)} END)`;
}

export function archivePayloadKeySQL(alias, { projected = false } = {}) {
  // Presence is not truthiness. Falsey IDs use relational occurrence identity;
  // legacy archive rows without either identity remain distinct occurrences.
  const token = `(CASE WHEN ${alias}.has_payload_id THEN ${alias}.entry_key::json
    WHEN ${alias}.has_payload_id IS NULL THEN ${projected ? `${alias}.fields[1]` : `burrow_json_member(${alias}.entry,'id')`} END)`;
  return `(SELECT CASE json_typeof(id_token)
    WHEN 'string' THEN NULLIF(burrow_history_key(id_token::text),'')
    WHEN 'number' THEN NULLIF(burrow_history_text(${archiveNumberTextSQL('id_token')}),burrow_history_text('0'))
    WHEN 'boolean' THEN CASE WHEN ${archiveTrimTokenSQL('id_token::text')}='true' THEN burrow_history_text('true') END
    WHEN 'array' THEN ${archiveStringKeySQL('id_token')}
    WHEN 'object' THEN burrow_history_text('[object Object]') END
    FROM (SELECT ${token} AS id_token OFFSET 0) payload_token)`;
}

// For a blank Array#toString, every level must be a singleton (or empty),
// ending in null/blank text. Stripping only edge brackets preserves commas or
// objects from every non-singleton case, hence they cannot be mistaken as blank.
export function archiveArrayLeafSQL(token) {
  return `regexp_replace(regexp_replace(${archiveTrimTokenSQL(`(${token})::text`)},
    '^(\\[[ \\t\\r\\n]*)+','','g'),'([ \\t\\r\\n]*\\])+$','','g')`;
}

export function archiveTruthyPayloadSQL(alias, { projected = false } = {}) {
  const token = `(CASE WHEN ${alias}.has_payload_id THEN ${alias}.entry_key::json
    WHEN ${alias}.has_payload_id IS NULL THEN ${projected ? `${alias}.fields[1]` : `burrow_json_member(${alias}.entry,'id')`} END)`;
  return `(SELECT COALESCE((CASE json_typeof(id_token)
    WHEN 'string' THEN burrow_history_key(id_token::text)<>''
    WHEN 'number' THEN ${archiveTruthyNumberSQL('id_token')}
    WHEN 'boolean' THEN ${archiveTrimTokenSQL('id_token::text')}='true'
    WHEN 'null' THEN false ELSE id_token IS NOT NULL END),false)
    FROM (SELECT ${token} AS id_token OFFSET 0) payload_token)`;
}

// A lexical blank-string test is linear in the regex engine. Converting the
// entire content to a UTF-16 key character-by-character is unnecessary: only
// ECMAScript TrimString whitespace (including escaped spellings) can be blank.
export function archiveNonblankStringSQL(token) {
  const whitespace = '\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  const blank = String.raw`^"([${whitespace}]|\\([tnrf]|u(000[9a-d]|0020|00a0|1680|200[0-9a]|2028|2029|202f|205f|3000|feff)))*"$`;
  return `${archiveTrimTokenSQL(`(${token})::text`)} !~* '${blank}'`;
}

export function archiveVisibleMessageSQL(alias) {
  const attachments = `${alias}.fields[10]`;
  const content = `COALESCE(NULLIF(${alias}.search_projection,''),'null')::json`;
  const leaf = archiveArrayLeafSQL(content);
  const visibleContent = `(CASE json_typeof(${content})
    WHEN 'string' THEN ${archiveNonblankStringSQL(content)}
    WHEN 'number' THEN ${archiveTruthyNumberSQL(content)}
    WHEN 'boolean' THEN ${archiveTrimTokenSQL(`(${content})::text`)}='true'
    WHEN 'object' THEN true
    WHEN 'array' THEN CASE WHEN ${leaf} IN ('','null') THEN false
      WHEN left(${leaf},1)='"' THEN ${archiveNonblankStringSQL(leaf)} ELSE true END
    ELSE false END)`;
  const role = archiveArrayLeafSQL(`${alias}.fields[6]`);
  return `burrow_history_key(${alias}.fields[7]::text)=burrow_history_text('message')
    AND burrow_history_key(${role}) IN (burrow_history_text('user'),burrow_history_text('assistant'),burrow_history_text('agent'))
    AND burrow_history_key(${alias}.fields[8]::text)=burrow_history_text('chat')
    AND ${archiveTrimTokenSQL(`${alias}.fields[9]::text`)}='true'
    AND (${visibleContent}
      OR CASE WHEN json_typeof(${attachments})='array' THEN json_array_length(${attachments})>0 ELSE false END)`;
}
