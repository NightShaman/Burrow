// Immutable legacy schema constants remain TEXT; migration 33 owns the conversion.
// A failed cast aborts the entire migration, preserving every original legacy byte.
export const POSTGRES_REMAINING_JSON_SQL = `
-- Validated preflight: fail transactionally rather than replace invalid legacy text.
DO $$
DECLARE r record; v text;
BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('settings_meta','value_json'),('mod_settings','value_json'),('api_tokens','scopes_json'),
 ('model_connections','accepted_input_json'),('model_connections','models_json'),
 ('mcp_connections','args_json'),('mcp_connections','tools_json'),
 ('model_auth_previews','value_json'),('model_settings_cache','value_json')) AS fields(t,c)
 LOOP
  FOR v IN EXECUTE format('SELECT %I::text FROM %I',r.c,r.t) LOOP
   BEGIN PERFORM v::json;
   EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Invalid legacy JSON in %.%; migration aborted, original text preserved',r.t,r.c;
   END;
  END LOOP;
 END LOOP;
END $$;

DROP TRIGGER model_catalog_refresh ON model_connections;
DROP TRIGGER mcp_catalog_refresh ON mcp_connections;
ALTER TABLE settings_meta ALTER COLUMN value_json DROP DEFAULT;
ALTER TABLE settings_meta ALTER COLUMN value_json TYPE JSON USING value_json::json;
ALTER TABLE mod_settings ALTER COLUMN value_json DROP DEFAULT;
ALTER TABLE mod_settings ALTER COLUMN value_json TYPE JSON USING value_json::json;
ALTER TABLE api_tokens ALTER COLUMN scopes_json DROP DEFAULT;
ALTER TABLE api_tokens ALTER COLUMN scopes_json TYPE JSON USING scopes_json::json;
ALTER TABLE model_connections ALTER COLUMN accepted_input_json DROP DEFAULT;
ALTER TABLE model_connections ALTER COLUMN accepted_input_json TYPE JSON USING accepted_input_json::json;
ALTER TABLE model_connections ALTER COLUMN accepted_input_json SET DEFAULT '[]'::json;
ALTER TABLE model_connections ALTER COLUMN models_json DROP DEFAULT;
ALTER TABLE model_connections ALTER COLUMN models_json TYPE JSON USING models_json::json;
ALTER TABLE model_connections ALTER COLUMN models_json SET DEFAULT '[]'::json;
ALTER TABLE mcp_connections ALTER COLUMN args_json DROP DEFAULT;
ALTER TABLE mcp_connections ALTER COLUMN args_json TYPE JSON USING args_json::json;
ALTER TABLE mcp_connections ALTER COLUMN args_json SET DEFAULT '[]'::json;
ALTER TABLE mcp_connections ALTER COLUMN tools_json DROP DEFAULT;
ALTER TABLE mcp_connections ALTER COLUMN tools_json TYPE JSON USING tools_json::json;
ALTER TABLE mcp_connections ALTER COLUMN tools_json SET DEFAULT '[]'::json;
ALTER TABLE model_auth_previews ALTER COLUMN value_json DROP DEFAULT;
ALTER TABLE model_auth_previews ALTER COLUMN value_json TYPE JSON USING value_json::json;
ALTER TABLE model_settings_cache ALTER COLUMN value_json DROP DEFAULT;
ALTER TABLE model_settings_cache ALTER COLUMN value_json TYPE JSON USING value_json::json;
ALTER TABLE model_catalog ALTER COLUMN metadata TYPE JSON USING metadata::json;
ALTER TABLE mcp_tool_catalog ALTER COLUMN metadata TYPE JSON USING metadata::json;
CREATE OR REPLACE FUNCTION catalog_identity(payload json, field text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE safe text;
BEGIN
 safe := regexp_replace(payload::text, '\\\\u0000|\\\\u[dD][89aAbB][0-9a-fA-F]{2}(?!\\\\u[dD][c-fC-F][0-9a-fA-F]{2})|(?<!\\\\u[dD][89aAbB][0-9a-fA-F]{2})\\\\u[dD][c-fC-F][0-9a-fA-F]{2}', ' ', 'g');
 RETURN safe::json->>field;
END $$;
CREATE OR REPLACE FUNCTION synchronize_native_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME = 'model_connections' THEN
  UPDATE model_catalog SET available=FALSE WHERE connection_id=NEW.id;
  INSERT INTO model_catalog SELECT NEW.id, catalog_identity(item,'id'), item, TRUE
   FROM json_array_elements(NEW.models_json::json) item WHERE coalesce(catalog_identity(item,'id'),'') <> ''
   ON CONFLICT(connection_id,model_id) DO UPDATE SET metadata=EXCLUDED.metadata,available=TRUE;
 ELSE
  UPDATE mcp_tool_catalog SET available=FALSE WHERE connection_id=NEW.id;
  INSERT INTO mcp_tool_catalog SELECT NEW.id, catalog_identity(item,'name'), item, TRUE
   FROM json_array_elements(NEW.tools_json::json) item WHERE coalesce(catalog_identity(item,'name'),'') <> ''
   ON CONFLICT(connection_id,tool_name) DO UPDATE SET metadata=EXCLUDED.metadata,available=TRUE;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER model_catalog_refresh AFTER INSERT OR UPDATE OF models_json ON model_connections
 FOR EACH ROW EXECUTE FUNCTION synchronize_native_catalog();
CREATE TRIGGER mcp_catalog_refresh AFTER INSERT OR UPDATE OF tools_json ON mcp_connections
 FOR EACH ROW EXECUTE FUNCTION synchronize_native_catalog();
`;

// Adopted v32 checksums are unchanged; only pending execution uses lossless JSON.
export const POSTGRES_LOSSLESS_NATIVE_CATALOGS_SQL = `
CREATE OR REPLACE FUNCTION catalog_identity(payload json, field text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE token json;
BEGIN
 token := burrow_json_member(payload,field);
 RETURN token #>> '{}';
END $$;
CREATE TABLE model_catalog (
 connection_id TEXT NOT NULL REFERENCES model_connections(id) ON DELETE CASCADE,
 model_id TEXT NOT NULL, metadata JSON NOT NULL, available BOOLEAN NOT NULL,
 PRIMARY KEY(connection_id,model_id)
);
CREATE TABLE mcp_tool_catalog (
 connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
 tool_name TEXT NOT NULL, metadata JSON NOT NULL, available BOOLEAN NOT NULL,
 PRIMARY KEY(connection_id,tool_name)
);
INSERT INTO model_catalog SELECT c.id, catalog_identity(item,'id'), item, TRUE
 FROM model_connections c CROSS JOIN LATERAL json_array_elements(c.models_json::json) item
 WHERE coalesce(catalog_identity(item,'id'),'') <> '' ON CONFLICT DO NOTHING;
INSERT INTO mcp_tool_catalog SELECT c.id, catalog_identity(item,'name'), item, TRUE
 FROM mcp_connections c CROSS JOIN LATERAL json_array_elements(c.tools_json::json) item
 WHERE coalesce(catalog_identity(item,'name'),'') <> '' ON CONFLICT DO NOTHING;
INSERT INTO model_catalog SELECT connection_id, model_id, json_build_object('id',model_id), FALSE
 FROM agent_model_selections ON CONFLICT DO NOTHING;
INSERT INTO mcp_tool_catalog SELECT connection_id, tool_name, json_build_object('name',tool_name), FALSE
 FROM agent_mcp_tools ON CONFLICT DO NOTHING;
ALTER TABLE agent_model_selections ADD CONSTRAINT agent_model_catalog_fk
 FOREIGN KEY(connection_id,model_id) REFERENCES model_catalog(connection_id,model_id) ON DELETE NO ACTION;
ALTER TABLE agent_mcp_tools ADD CONSTRAINT agent_mcp_catalog_fk
 FOREIGN KEY(connection_id,tool_name) REFERENCES mcp_tool_catalog(connection_id,tool_name) ON DELETE NO ACTION;
CREATE FUNCTION synchronize_native_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME = 'model_connections' THEN
  UPDATE model_catalog SET available=FALSE WHERE connection_id=NEW.id;
  INSERT INTO model_catalog SELECT NEW.id, catalog_identity(item,'id'), item, TRUE
   FROM json_array_elements(NEW.models_json::json) item WHERE coalesce(catalog_identity(item,'id'),'') <> ''
   ON CONFLICT(connection_id,model_id) DO UPDATE SET metadata=EXCLUDED.metadata,available=TRUE;
 ELSE
  UPDATE mcp_tool_catalog SET available=FALSE WHERE connection_id=NEW.id;
  INSERT INTO mcp_tool_catalog SELECT NEW.id, catalog_identity(item,'name'), item, TRUE
   FROM json_array_elements(NEW.tools_json::json) item WHERE coalesce(catalog_identity(item,'name'),'') <> ''
   ON CONFLICT(connection_id,tool_name) DO UPDATE SET metadata=EXCLUDED.metadata,available=TRUE;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER model_catalog_refresh AFTER INSERT OR UPDATE OF models_json ON model_connections
 FOR EACH ROW EXECUTE FUNCTION synchronize_native_catalog();
CREATE TRIGGER mcp_catalog_refresh AFTER INSERT OR UPDATE OF tools_json ON mcp_connections
 FOR EACH ROW EXECUTE FUNCTION synchronize_native_catalog();
`;
