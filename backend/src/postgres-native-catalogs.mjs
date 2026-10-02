// Catalog identity is scoped to the owning connection, never a global model/tool name.
export const POSTGRES_NATIVE_CATALOGS_SQL = `
CREATE TABLE model_catalog (
 connection_id TEXT NOT NULL REFERENCES model_connections(id) ON DELETE CASCADE,
 model_id TEXT NOT NULL, metadata JSONB NOT NULL, available BOOLEAN NOT NULL,
 PRIMARY KEY(connection_id,model_id)
);
CREATE TABLE mcp_tool_catalog (
 connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
 tool_name TEXT NOT NULL, metadata JSONB NOT NULL, available BOOLEAN NOT NULL,
 PRIMARY KEY(connection_id,tool_name)
);
INSERT INTO model_catalog SELECT c.id, item->>'id', item, TRUE
 FROM model_connections c CROSS JOIN LATERAL jsonb_array_elements(c.models_json::jsonb) item
 WHERE coalesce(item->>'id','') <> '' ON CONFLICT DO NOTHING;
INSERT INTO mcp_tool_catalog SELECT c.id, item->>'name', item, TRUE
 FROM mcp_connections c CROSS JOIN LATERAL jsonb_array_elements(c.tools_json::jsonb) item
 WHERE coalesce(item->>'name','') <> '' ON CONFLICT DO NOTHING;
INSERT INTO model_catalog SELECT connection_id, model_id, jsonb_build_object('id',model_id), FALSE
 FROM agent_model_selections ON CONFLICT DO NOTHING;
INSERT INTO mcp_tool_catalog SELECT connection_id, tool_name, jsonb_build_object('name',tool_name), FALSE
 FROM agent_mcp_tools ON CONFLICT DO NOTHING;
ALTER TABLE agent_model_selections ADD CONSTRAINT agent_model_catalog_fk
 FOREIGN KEY(connection_id,model_id) REFERENCES model_catalog(connection_id,model_id) ON DELETE NO ACTION;
ALTER TABLE agent_mcp_tools ADD CONSTRAINT agent_mcp_catalog_fk
 FOREIGN KEY(connection_id,tool_name) REFERENCES mcp_tool_catalog(connection_id,tool_name) ON DELETE NO ACTION;
CREATE FUNCTION synchronize_native_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME = 'model_connections' THEN
  UPDATE model_catalog SET available=FALSE WHERE connection_id=NEW.id;
  INSERT INTO model_catalog SELECT NEW.id, item->>'id', item, TRUE
   FROM jsonb_array_elements(NEW.models_json::jsonb) item WHERE coalesce(item->>'id','') <> ''
   ON CONFLICT(connection_id,model_id) DO UPDATE SET metadata=EXCLUDED.metadata,available=TRUE;
 ELSE
  UPDATE mcp_tool_catalog SET available=FALSE WHERE connection_id=NEW.id;
  INSERT INTO mcp_tool_catalog SELECT NEW.id, item->>'name', item, TRUE
   FROM jsonb_array_elements(NEW.tools_json::jsonb) item WHERE coalesce(item->>'name','') <> ''
   ON CONFLICT(connection_id,tool_name) DO UPDATE SET metadata=EXCLUDED.metadata,available=TRUE;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER model_catalog_refresh AFTER INSERT OR UPDATE OF models_json ON model_connections
 FOR EACH ROW EXECUTE FUNCTION synchronize_native_catalog();
CREATE TRIGGER mcp_catalog_refresh AFTER INSERT OR UPDATE OF tools_json ON mcp_connections
 FOR EACH ROW EXECUTE FUNCTION synchronize_native_catalog();
`;
