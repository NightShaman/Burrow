import { archiveOccurrenceTokenSQL, archiveVisibleMessageSQL } from './postgres-archive-lexical.mjs';

// Additive v88: future structured assistant terminals are operator-visible even
// when empty and excluded from model context. Existing history/payloads and the
// v81/v82 published SQL stay untouched. Pre-v2 rows keep their old projection.
export const POSTGRES_CHAT_RESULT_PROJECTION_SQL = `
CREATE OR REPLACE FUNCTION burrow_archive_chat_projection(payload json, search_projection text)
 RETURNS TABLE(visible boolean,instant timestamptz) LANGUAGE sql STABLE AS $chat_result$
 SELECT COALESCE((${archiveVisibleMessageSQL('p')}) OR (
   burrow_history_key(p.fields[7]::text)=burrow_history_text('message')
   AND burrow_history_key(p.fields[6]::text)=burrow_history_text('assistant')
   AND burrow_history_key(p.fields[8]::text)=burrow_history_text('chat')
   AND btrim(p.result_fields[1]::text,E' \\t\\r\\n')='2'
   AND burrow_history_key(p.result_fields[2]::text) IN (
     burrow_history_text('completed'),burrow_history_text('failed'),
     burrow_history_text('cancelled'),burrow_history_text('superseded'))
 ),false),
 CASE WHEN json_typeof((${archiveOccurrenceTokenSQL('p')})::json)='string'
   THEN burrow_archive_instant((${archiveOccurrenceTokenSQL('p')})::json) END
 FROM (SELECT burrow_archive_fields(payload) AS fields,search_projection,
   burrow_json_members(burrow_json_member(payload,'metadata'),ARRAY['chatResultVersion','terminalStatus']) AS result_fields OFFSET 0) p
$chat_result$;
`;
