// v74 correctly excluded workflow events but lost v65's authoritative-copy fast
// path. Keep both invariants without rewriting either published migration.
export const POSTGRES_EVENT_OPERATOR_PROJECTION_SQL = `
CREATE OR REPLACE FUNCTION burrow_project_operator_instant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF burrow_history_key(burrow_json_member(burrow_json_member(NEW.entry,'metadata'),'source')::text) = burrow_history_text('workflow-event') THEN
  NEW.operator_at := NULL; NEW.operator_ts_fallback := NULL;
 ELSIF TG_OP = 'INSERT' AND NEW.operator_projected THEN
  RETURN NEW;
 ELSE
  SELECT at,fallback INTO NEW.operator_at,NEW.operator_ts_fallback FROM burrow_operator_projection(NEW.entry);
 END IF;
 NEW.operator_projected := true;
 RETURN NEW;
END $$;
`;
