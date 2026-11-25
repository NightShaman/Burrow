import { normalizeWaitTarget, waitTaskId, waitText } from './task-workflow-wait.mjs';

const targetProperties = {
  taskId: { type: 'string', description: 'Existing task assigned to this agent, in To Do or In Progress.' },
  repository: { type: 'string', description: 'Exact GitHub owner/repository.' },
  workflow: { type: 'string', description: 'Exact workflow name from workflow_run.name, not the YAML filename.' },
  runId: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Exact intended GitHub Actions run ID, not a Burrow run ID.' },
  runAttempt: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Exact intended attempt. No wildcard or next-run matching.' },
  headSha: { type: 'string', pattern: '^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$', description: 'Exact intended workflow commit SHA.' },
  checkpoint: { type: 'string', minLength: 1, maxLength: 20000, description: 'Saved progress and what to do next on the original task. Do not include credentials.' },
};
export const taskWorkflowWaitToolSchemas = [
  { type: 'function', function: {
    name: 'tasks_wait_for_workflow',
    description: 'Persist a checkpoint on an existing task and resume that same task once its exact GitHub workflow run/attempt/commit completes. Requires the configured signed webhook; no polling or standing watch is created. Finish the current turn after registration instead of waiting. Matching completion, even failure, is data—not proof that publication succeeded. Registration is durable across restart and idempotent for this source run.',
    parameters: { type: 'object', additionalProperties: false, properties: { ...targetProperties, reason: { type: 'string' } }, required: Object.keys(targetProperties) },
  } },
  { type: 'function', function: {
    name: 'tasks_list_workflow_waits',
    description: 'Read saved workflow checkpoints, exact triggers, skip reasons and canonical continuation outcomes for one existing task. Follow nextCursor with the same task. A resumed wait is an admitted continuation, not proof of success.',
    parameters: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string' }, reason: { type: 'string' } }, required: ['taskId'] },
  } },
];

export async function executeTaskWorkflowWaitTool({ tool, arguments: args = {}, agentId, sessionId, runId, store, tasks, receiverSettings } = {}) {
  try {
    if (!store || !tasks) throw new Error('task_workflow_wait_store_required');
    if (tool === 'tasks_list_workflow_waits') {
      const taskId = waitTaskId(args.taskId);
      if (!await tasks.getTask(taskId)) throw new Error('task_not_found');
      return { tool, ok: true, ...await store.listForTask(taskId, { ...(args.limit == null ? {} : { limit: args.limit }), cursor: args.cursor || null }), error: null };
    }
    if (tool !== 'tasks_wait_for_workflow') throw new Error('task_workflow_wait_tool_invalid');
    normalizeWaitTarget(args);
    waitTaskId(args.taskId);
    waitText(args.checkpoint, 'checkpoint', 20000);
    if (!agentId || !sessionId || !runId) throw new Error('task_workflow_wait_source_required');
    if (receiverSettings) {
      const receiver = await receiverSettings.read();
      if (!receiver.ready) throw new Error(`task_workflow_wait_webhook_${receiver.readiness || 'unavailable'}`);
    }
    const wait = await store.register(args, { agentId, sessionId, runId });
    // Commit precedes wake. Admission retries already belong to the existing
    // event runner; a missed local wake cannot erase a persisted checkpoint.
    try { Promise.resolve(store.wake?.()).catch(() => {}); } catch { /* durable */ }
    return { tool, ok: true, wait, error: null };
  } catch (error) {
    return { tool, ok: false, error: error?.message || 'task_workflow_wait_failed' };
  }
}
