export const POSTGRES_AGENT_DELIVERY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_message_deliveries (
  delivery_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('executing','completed')),
  request JSONB NOT NULL,
  result JSONB,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ
);
`;
