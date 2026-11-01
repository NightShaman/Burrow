// Null is the legacy inference path. In particular, do not backfill old rows
// to 'default': an explicit provider default has different behavior.
export const POSTGRES_ANTHROPIC_THINKING_SQL = `
ALTER TABLE agent_model_selections ADD COLUMN thinking_mode TEXT
  CHECK (thinking_mode IN ('default','disabled','adaptive','enabled','between_tools'));
ALTER TABLE agent_minion_model_selections ADD COLUMN thinking_mode TEXT
  CHECK (thinking_mode IN ('default','disabled','adaptive','enabled','between_tools'));
`;
