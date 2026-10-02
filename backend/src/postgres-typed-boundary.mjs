/** Append-only conversion of the remaining SQLite-style lifecycle flag. */
export const POSTGRES_TYPED_BOUNDARY_SQL = `
ALTER TABLE mod_lifecycle DROP CONSTRAINT IF EXISTS mod_lifecycle_enabled_check;
ALTER TABLE mod_lifecycle ALTER COLUMN enabled DROP DEFAULT;
ALTER TABLE mod_lifecycle ALTER COLUMN enabled TYPE BOOLEAN USING (enabled = 1);
ALTER TABLE mod_lifecycle ALTER COLUMN enabled SET DEFAULT TRUE;
`;
