import { randomUUID } from 'node:crypto';

// Intentionally independent of connection FKs: deleting a credential/account must
// not erase historical measurements. No provider payloads or error text belong here.
export const POSTGRES_PROVIDER_POOL_METRICS_SQL = `
CREATE TABLE provider_pool_requests (
 id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, model TEXT NOT NULL, run_id TEXT,
 started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMPTZ,
 outcome TEXT CHECK(outcome IN ('success','failed','cancelled')),
 duration_ms DOUBLE PRECISION, error_kind TEXT,
 CHECK ((finished_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX provider_pool_requests_finished ON provider_pool_requests(finished_at) WHERE finished_at IS NOT NULL;
CREATE TABLE provider_pool_attempts (
 request_id TEXT NOT NULL REFERENCES provider_pool_requests(id) ON DELETE CASCADE,
 attempt INTEGER NOT NULL, member_id TEXT NOT NULL, provider_request_id TEXT,
 duration_ms DOUBLE PRECISION NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('success','failed','cancelled')),
 status INTEGER, error_kind TEXT, input_tokens BIGINT CHECK(input_tokens >= 0),
 output_tokens BIGINT CHECK(output_tokens >= 0), cached_tokens BIGINT CHECK(cached_tokens >= 0),
 PRIMARY KEY(request_id,attempt)
);
`;

const token = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export function poolAttemptUsage(usage) {
  return { inputTokens: token(usage?.input_tokens ?? usage?.prompt_tokens),
    outputTokens: token(usage?.output_tokens ?? usage?.completion_tokens),
    cachedTokens: token(usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens) };
}

export class PostgresProviderPoolMetrics {
  constructor(pool) { this.pool = pool; }
  async start({poolId, model, runId}) {
    const id = randomUUID();
    await this.pool.query('INSERT INTO provider_pool_requests(id,pool_id,model,run_id) VALUES($1,$2,$3,$4)', [id,poolId,model,String(runId || '').slice(0,256) || null]);
    return id;
  }
  async attempt(id, a) {
    await this.pool.query(`INSERT INTO provider_pool_attempts(request_id,attempt,member_id,provider_request_id,duration_ms,outcome,status,error_kind,input_tokens,output_tokens,cached_tokens)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [id,a.attempt,a.memberId,a.providerRequestId || null,a.durationMs,a.outcome,a.status || null,a.errorKind || null,a.inputTokens,a.outputTokens,a.cachedTokens]);
  }
  async finish(id, {outcome,durationMs,errorKind}) {
    await this.pool.query('UPDATE provider_pool_requests SET finished_at=CURRENT_TIMESTAMP,outcome=$2,duration_ms=$3,error_kind=$4 WHERE id=$1 AND finished_at IS NULL', [id,outcome,durationMs,errorKind || null]);
  }
  async summary() {
    const {rows} = await this.pool.query(`WITH windows AS (SELECT * FROM (VALUES ('24h', INTERVAL '24 hours'),('7d',INTERVAL '7 days')) AS v(key,span)),
    requests AS (SELECT w.key, count(r.id)::int requests,
      count(r.id) FILTER(WHERE outcome='success')::int successes,
      count(r.id) FILTER(WHERE outcome='failed')::int failures,
      count(r.id) FILTER(WHERE outcome='cancelled')::int cancellations,
      coalesce(sum(r.duration_ms),0)::float8 duration_ms
      FROM windows w LEFT JOIN provider_pool_requests r ON r.finished_at >= CURRENT_TIMESTAMP-w.span AND r.finished_at <= CURRENT_TIMESTAMP GROUP BY w.key),
    attempts AS (SELECT w.key,count(a.request_id)::int attempts,count(*) FILTER(WHERE a.attempt>1)::int retries,
      sum(a.input_tokens)::float8 input_tokens,sum(a.output_tokens)::float8 output_tokens,sum(a.cached_tokens)::float8 cached_tokens,
      count(a.input_tokens)::int input_known,count(a.output_tokens)::int output_known,count(a.cached_tokens)::int cached_known,
      count(*) FILTER(WHERE a.input_tokens IS NOT NULL AND a.cached_tokens IS NOT NULL)::int cache_known,
      sum(a.input_tokens) FILTER(WHERE a.cached_tokens IS NOT NULL)::float8 cache_input,
      sum(a.cached_tokens) FILTER(WHERE a.input_tokens IS NOT NULL)::float8 cache_cached
      FROM windows w LEFT JOIN provider_pool_requests r ON r.finished_at >= CURRENT_TIMESTAMP-w.span AND r.finished_at <= CURRENT_TIMESTAMP
      LEFT JOIN provider_pool_attempts a ON a.request_id=r.id GROUP BY w.key)
    SELECT * FROM requests JOIN attempts USING(key)`);
    return {ok:true,windows:Object.fromEntries(rows.map(r => [r.key, {
      requests:r.requests, successes:r.successes, failures:r.failures,cancellations:r.cancellations,
      attempts:r.attempts,retries:r.retries,
      inputTokens:r.input_tokens,outputTokens:r.output_tokens,cachedTokens:r.cached_tokens,
      cachePercent:r.cache_input > 0 ? 100*r.cache_cached/r.cache_input : null,
      errorPercent:r.requests ? 100*r.failures/r.requests : null,
      durationMs:r.duration_ms,
      coverage:{inputAttempts:r.input_known,outputAttempts:r.output_known,cachedAttempts:r.cached_known,cacheAttempts:r.cache_known,cacheInputTokens:r.cache_input}
    }]))};
  }
}
