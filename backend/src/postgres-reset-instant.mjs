/** Persistent safe parser for legacy reset metadata; migration 34 drops its temporary parser. */
export const POSTGRES_RESET_INSTANT_SQL = `
CREATE FUNCTION burrow_legacy_instant(value text) RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
BEGIN
 -- Only unambiguous ISO dates/instants are promoted. Relative words such as
 -- 'now' must not silently become the migration execution time.
 IF value !~ '^\\d{4}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}(:?\\d{2})?)?)?$' THEN RETURN NULL; END IF;
 RETURN value::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;
`;
