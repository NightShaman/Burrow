import { randomUUID } from 'node:crypto';
// Shared strict boundary for persisted, exact-attempt task workflow waits.
export function waitText(value, field, max = 255, pattern) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || (pattern && !pattern.test(value))) throw new Error(`task_workflow_wait_invalid_${field}`);
  return value;
}
export const waitId = value => waitText(value, 'id', 36, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const waitTaskId = value => waitText(value, 'taskId', 96, /^[A-Za-z0-9._-]+$/);
export function normalizeWaitTarget(input) {
  const repository = waitText(input.repository, 'repository', 255, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).toLowerCase();
  const workflow = waitText(input.workflow, 'workflow');
  const runId = waitText(input.runId, 'runId', 128, /^[0-9]+$/);
  if (!/[1-9]/.test(runId)) throw new Error('task_workflow_wait_invalid_runId');
  const runAttempt = input.runAttempt;
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1 || runAttempt > 2147483647) throw new Error('task_workflow_wait_invalid_runAttempt');
  const headSha = waitText(input.headSha, 'headSha', 64, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i).toLowerCase();
  return { repository, workflow, runId: runId.replace(/^0+/, ''), runAttempt, headSha };
}
export function waitRow(r) {
  if (!r) return null;
  const iso = v => v == null ? null : new Date(v).toISOString();
  return { id: r.id, taskId: r.task_id, agentId: r.agent_id, sessionId: r.session_id, repository: r.repository, workflow: r.workflow, runId: r.run_id, runAttempt: r.run_attempt, headSha: r.head_sha, checkpoint: r.checkpoint, status: r.status, reasonCode: r.reason_code, reason: r.reason, registeredAt: iso(r.registered_at), matchedAt: iso(r.matched_at), resumedAt: iso(r.resumed_at), finishedAt: iso(r.finished_at), source: r.source, trigger: r.trigger, continuation: r.continuation, outcome: r.outcome };
}
// Same key and transaction scope for registration and verified ingestion.
export async function lockWaitIdentity(client, repository, runId, runAttempt) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['task-workflow-wait', repository, runId, runAttempt])]);
}
export async function matchTaskWaits(client, completion) {
  const { rows } = await client.query(`SELECT * FROM task_workflow_waits WHERE status='waiting' AND repository=$1 AND workflow=$2 AND run_id=$3 AND run_attempt=$4 AND head_sha=$5 FOR UPDATE`, [completion.repository, completion.workflow, completion.runId, completion.runAttempt, completion.headSha]);
  for (const w of rows) {
    const id = randomUUID();
    const trigger = { id, ...completion };
    await client.query(`INSERT INTO github_completion_events(id,watch_id,repository,workflow,run_id,run_attempt,head_sha,conclusion,url,completed_at,agent_id,session_id,instruction,chat_run_id,task_wait_id,task_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$2,$15)`, [id,w.id,completion.repository,completion.workflow,completion.runId,completion.runAttempt,completion.headSha,completion.conclusion,completion.url,completion.completedAt,w.agent_id,w.session_id,w.checkpoint,`event-${id}`,w.task_id]);
    await client.query(`UPDATE task_workflow_waits SET status='matched',reason_code='exact_completion_matched',reason='Exact workflow run and attempt completed',matched_at=now(),trigger=$2::jsonb WHERE id=$1`, [w.id,JSON.stringify(trigger)]);
  }
  return rows.map(w => w.id);
}
