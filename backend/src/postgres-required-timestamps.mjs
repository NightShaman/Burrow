/** Migration 35 restores contracts recovered by introspecting a disposable v33 schema.
 * All 64 converted text instant columns had no default; 57 were required.
 * Keep v34 and all earlier migration SQL immutable.
 */
export const POSTGRES_REQUIRED_TIMESTAMPS_SQL = `
CREATE TABLE grandfathered_timestamp_nulls (
 table_name text NOT NULL, column_name text NOT NULL,
 row_identity jsonb NOT NULL,
 PRIMARY KEY(table_name,column_name,row_identity)
);
DO $$
DECLARE c record; identity_columns text[]; identity_expression text;
BEGIN
 FOR c IN SELECT * FROM (VALUES
 ('agent_mcp_tools','created_at'),
 ('agent_mcp_tools','updated_at'),
 ('agent_model_selections','updated_at'),
 ('agent_profile_documents','created_at'),
 ('agent_profile_documents','updated_at'),
 ('agent_skill_assignments','created_at'),
 ('agents','created_at'),
 ('agents','updated_at'),
 ('api_tokens','created_at'),
 ('api_tokens','updated_at'),
 ('burrow_migration_receipts','completed_at'),
 ('chat_identities','created_at'),
 ('chat_identities','updated_at'),
 ('continuity_log','created_at'),
 ('continuity_state','updated_at'),
 ('conversation_archive_entries','created_at'),
 ('conversation_archives','created_at'),
 ('conversation_entries','created_at'),
 ('conversation_project_bindings','created_at'),
 ('conversation_project_bindings','updated_at'),
 ('conversation_sessions','created_at'),
 ('conversation_sessions','updated_at'),
 ('mcp_connection_secrets','created_at'),
 ('mcp_connection_secrets','updated_at'),
 ('mcp_connections','created_at'),
 ('mcp_connections','updated_at'),
 ('mod_installations','installed_at'),
 ('mod_installations','updated_at'),
 ('mod_lifecycle','created_at'),
 ('mod_lifecycle','updated_at'),
 ('mod_secrets','created_at'),
 ('mod_secrets','updated_at'),
 ('mod_settings','created_at'),
 ('mod_settings','updated_at'),
 ('mod_source_secrets','created_at'),
 ('mod_source_secrets','updated_at'),
 ('mod_sources','created_at'),
 ('mod_sources','updated_at'),
 ('model_auth_previews','updated_at'),
 ('model_connection_secrets','created_at'),
 ('model_connection_secrets','updated_at'),
 ('model_connections','created_at'),
 ('model_connections','updated_at'),
 ('model_settings_cache','updated_at'),
 ('rolling_continuity_cards','updated_at'),
 ('rolling_continuity_envelopes','updated_at'),
 ('settings_meta','updated_at'),
 ('skill_global_assignments','created_at'),
 ('skills','created_at'),
 ('skills','updated_at'),
 ('task_board_project_paths','created_at'),
 ('task_board_project_paths','updated_at'),
 ('task_board_projects','created_at'),
 ('task_board_projects','updated_at'),
 ('task_board_tasks','created_at'),
 ('task_board_tasks','updated_at'),
 ('tiddle_envelopes','updated_at')
 ) AS required(table_name,column_name) LOOP
 SELECT array_agg(a.attname ORDER BY k.ordinality) INTO identity_columns
 FROM pg_index i
 CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
 JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
 WHERE i.indrelid=format('%I.%I',current_schema(),c.table_name)::regclass AND i.indisprimary;
 IF identity_columns IS NULL THEN
 RAISE EXCEPTION 'Required timestamp table % has no primary identity',c.table_name;
 END IF;
 -- Serialize only primary-key columns: unrelated JSON may contain NUL or lone
 -- surrogates valid in json/text but not representable in jsonb.
 SELECT string_agg(format('%L, t.%I',name,name), ', ') INTO identity_expression
 FROM unnest(identity_columns) AS keys(name);
 EXECUTE format('INSERT INTO grandfathered_timestamp_nulls SELECT %L,%L,jsonb_build_object(%s) FROM %I t WHERE %I IS NULL',c.table_name,c.column_name,identity_expression,c.table_name,c.column_name);
 IF EXISTS (SELECT 1 FROM grandfathered_timestamp_nulls WHERE table_name=c.table_name AND column_name=c.column_name) THEN
 -- NOT VALID exempts only existing rows from validation, never new inserts or
 -- updates (including unrelated mutations of an invalid historical row).
 EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IS NOT NULL) NOT VALID',c.table_name,c.table_name || '_' || c.column_name || '_required_instant',c.column_name);
 ELSE
 EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET NOT NULL',c.table_name,c.column_name);
 END IF;
 END LOOP;
END $$;
`;
