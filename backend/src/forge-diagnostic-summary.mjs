// Explicit field allowlist for diagnostics tokens. Forge's public jobs contain prompts,
// provider errors and artifact links; none belongs in a read-only diagnostic feed.
const statuses = new Set(['queued', 'running', 'succeeded', 'failed', 'interrupted']);
const modes = new Set(['image', 'music', 'speech', 'video']);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
export function summarizeForgeJob(job) {
  return {
    id: job.id,
    status: statuses.has(job.status) ? job.status : 'unknown',
    mode: modes.has(job.mode) ? job.mode : null,
    createdAt: date(job.createdAt),
    updatedAt: date(job.updatedAt),
    artifactCount: Number.isSafeInteger(job.artifactCount) && job.artifactCount >= 0 ? job.artifactCount : 0,
  };
}
export async function forgeDiagnosticJobs(pool, { limit = 50, cursor } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== undefined && (!/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))))
    throw Object.assign(new Error('invalid_diagnostics_query'), { statusCode: 400 });
  // Query only records after the cursor; this avoids loading unbounded prompt data.
  const result = await pool.query(`SELECT id, record->>'status' AS status, COALESCE(record->>'mode', CASE WHEN record->>'kind' IN ('image','video') THEN record->>'kind' END) AS mode,
    record->>'createdAt' AS created_at, record->>'updatedAt' AS updated_at,
    CASE WHEN jsonb_typeof(record->'artifacts') = 'array' THEN jsonb_array_length(record->'artifacts') ELSE 0 END AS artifact_count,
    ordinal FROM forge_jobs WHERE ($1::bigint IS NULL OR ordinal < $1::bigint)
    ORDER BY ordinal DESC LIMIT $2`, [cursor || null, limit + 1]);
  const page = result.rows.slice(0, limit);
  return { ok: true, jobs: page.map(row => summarizeForgeJob({ id: row.id, status: row.status, mode: row.mode, createdAt: row.created_at, updatedAt: row.updated_at, artifactCount: Number(row.artifact_count) })), hasMore: result.rows.length > limit, nextCursor: result.rows.length > limit ? String(page.at(-1).ordinal) : null };
}
export async function forgeDiagnosticJob(pool, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw Object.assign(new Error('invalid_diagnostics_query'), { statusCode: 400 });
  const result = await pool.query(`SELECT id, record->>'status' AS status, COALESCE(record->>'mode', CASE WHEN record->>'kind' IN ('image','video') THEN record->>'kind' END) AS mode,
    record->>'createdAt' AS created_at, record->>'updatedAt' AS updated_at,
    CASE WHEN jsonb_typeof(record->'artifacts') = 'array' THEN jsonb_array_length(record->'artifacts') ELSE 0 END AS artifact_count
    FROM forge_jobs WHERE id = $1`, [id]);
  const row = result.rows[0];
  return { ok: true, job: row ? summarizeForgeJob({ id: row.id, status: row.status, mode: row.mode, createdAt: row.created_at, updatedAt: row.updated_at, artifactCount: Number(row.artifact_count) }) : null };
}
export async function postgresDiagnostic(pool) {
  const result = await pool.query("SELECT current_setting('server_version_num') AS server_version_num, EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector_installed");
  return { ok: true, postgres: { reachable: true, serverMajor: Math.floor(Number(result.rows[0].server_version_num) / 10000), vectorInstalled: result.rows[0].vector_installed } };
}
