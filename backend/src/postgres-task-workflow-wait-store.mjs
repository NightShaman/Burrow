import { TaskBoardAuditStore } from './task-board-audit-store.mjs';
import { randomUUID } from 'node:crypto';
import { withPostgresTransaction } from './postgres-foundation.mjs';
import { normalizeWaitTarget, waitId, waitTaskId, waitText, waitRow, lockWaitIdentity, matchTaskWaits } from './task-workflow-wait.mjs';

export class PostgresTaskWorkflowWaitStore {
  constructor({ pool } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('task_workflow_wait_postgres_pool_required');
    this.pool = pool;
    this.audit = new TaskBoardAuditStore({pool});
  }
  async get(id) { return waitRow((await this.pool.query('SELECT * FROM task_workflow_waits WHERE id=$1', [waitId(id)])).rows[0]); }
  async listForTask(taskId, { limit = 50, cursor = null } = {}) {
    taskId = waitTaskId(taskId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('task_workflow_wait_invalid_limit');
    if (cursor !== null) {
      waitId(cursor);
      if (!(await this.pool.query('SELECT id FROM task_workflow_waits WHERE id=$1 AND task_id=$2',[cursor,taskId])).rows.length) throw new Error('task_workflow_wait_invalid_cursor');
    }
    const { rows } = await this.pool.query(`SELECT * FROM task_workflow_waits WHERE task_id=$1 AND ($2::uuid IS NULL OR (registered_at,id)<(SELECT registered_at,id FROM task_workflow_waits WHERE id=$2 AND task_id=$1)) ORDER BY registered_at DESC,id DESC LIMIT $3`, [taskId,cursor,limit+1]);
    return { waits: rows.slice(0,limit).map(waitRow), hasMore: rows.length>limit, nextCursor: rows.length>limit ? rows[limit-1].id : null };
  }
  async register(input = {}, source = {}) {
    const target = normalizeWaitTarget(input), taskId = waitTaskId(input.taskId);
    const checkpoint = waitText(input.checkpoint, 'checkpoint', 20000);
    source = { agentId: waitText(source.agentId, 'agentId'), sessionId: waitText(source.sessionId ?? 'default', 'sessionId'), runId: waitText(source.runId, 'sourceRunId') };
    if (source.sessionId !== 'default') throw new Error('task_workflow_wait_default_session_required');
    return withPostgresTransaction(this.pool, async c => {
      await lockWaitIdentity(c,target.repository,target.runId,target.runAttempt);
      const task = (await c.query('SELECT * FROM task_board_tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
      if (!task) throw new Error('task_not_found');
      const prior = (await c.query(`SELECT * FROM task_workflow_waits WHERE task_id=$1 AND source->>'runId'=$2 AND source->>'agentId'=$3 AND source->>'sessionId'=$4`,[taskId,source.runId,source.agentId,source.sessionId])).rows[0];
      if (prior) {
        if (prior.repository!==target.repository || prior.workflow!==target.workflow || prior.run_id!==target.runId || prior.run_attempt!==target.runAttempt || prior.head_sha!==target.headSha || prior.checkpoint!==checkpoint) throw new Error('task_workflow_wait_registration_conflict');
        return waitRow(prior);
      }
      if (!['todo','in_progress'].includes(task.status) || task.assigned_agent_id!==source.agentId) throw new Error('task_workflow_wait_task_ineligible');
      const execution = task.execution_json;
      if (['running','queued'].includes(execution?.status) && (execution.runId!==source.runId || execution.agentId!==source.agentId || execution.sessionId!==source.sessionId)) throw new Error('task_workflow_wait_source_not_owner');
      if ((await c.query(`SELECT id FROM task_workflow_waits WHERE task_id=$1 AND status IN ('waiting','matched')`,[taskId])).rows.length) throw new Error('task_workflow_wait_active_conflict');
      const id = randomUUID();
      await c.query(`INSERT INTO task_workflow_waits(id,task_id,agent_id,session_id,repository,workflow,run_id,run_attempt,head_sha,checkpoint,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,[id,taskId,source.agentId,source.sessionId,target.repository,target.workflow,target.runId,target.runAttempt,target.headSha,checkpoint,JSON.stringify(source)]);
      await this.audit.append(c,taskId,'workflow_wait_registered',{actor:{type:'agent',id:source.agentId},sessionId:source.sessionId,runId:source.runId,details:{workflowWaitId:id,...target,checkpoint}});
      const early = (await c.query(`SELECT completion FROM github_completion_inbox WHERE repository=$1 AND run_id=$2 AND run_attempt=$3`,[target.repository,target.runId,target.runAttempt])).rows[0];
      if (early) await matchTaskWaits(c,early.completion);
      return waitRow((await c.query('SELECT * FROM task_workflow_waits WHERE id=$1',[id])).rows[0]);
    });
  }
}
