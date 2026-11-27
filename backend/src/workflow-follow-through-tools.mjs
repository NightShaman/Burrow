import { taskWorkflowWaitToolSchemas } from './task-workflow-wait-tools.mjs';
import { normalizeWaitTarget, waitId, waitText } from './task-workflow-wait.mjs';
import { continuityStateStore } from './postgres-continuity-state-store.mjs';

export const WORKFLOW_FOLLOW_THROUGH_TOOLS = ['workflow_wait', 'workflow_wait_status'];
const properties = Object.fromEntries(Object.entries(taskWorkflowWaitToolSchemas[0].function.parameters.properties).filter(([key]) => key !== 'taskId'));
properties.checkpoint = { ...properties.checkpoint, description: 'Saved progress and next action for the authorized work. Do not include credentials.' };
export const workflowFollowThroughToolSchemas = [
  { type: 'function', function: { name: 'workflow_wait',
    description: 'Continue authorized work when one exact GitHub workflow run, attempt and commit completes. No task, standing watch or GitHub poll. Save a credential-free checkpoint including intended outcome, scope, proof to check, and next action. A signed completion resumes work off-chat; only the final outcome or genuine blocker returns to this conversation. Finish this turn after registration. A workflow conclusion is not outcome verification.',
    parameters: { type: 'object', additionalProperties: false, properties, required: Object.keys(properties).filter(key => key !== 'reason') } } },
  { type: 'function', function: { name: 'workflow_wait_status',
    description: 'Read one of your board-free workflow waits by its saved receipt ID, including the exact completion and terminal outcome when available. This is diagnostics, not a polling mechanism.',
    parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id'] } } },
];

export function workflowOrigin(session, sessionId) {
  if (!session?.createdAt || session.archived || session.deleted) return null;
  return { conversationId: String(session.conversationId || sessionId), resetIdentity: `${Number(session.resetGeneration || 0)}:${new Date(session.createdAt).toISOString()}` };
}

export async function executeWorkflowFollowThroughTool({ tool, args = {}, agentId, context, receiverSettings }) {
  try {
    const workflows = context?.stores?.workflowFollowThrough;
    const conversations = context?.stores?.conversations;
    if (!agentId || !workflows) throw new Error('workflow_follow_through_unavailable');
    if (tool === 'workflow_wait_status') {
      const wait = await workflows.getOwned({ id: waitId(args.id), agentId });
      if (!wait) throw new Error('workflow_follow_through_not_found');
      return { tool, ok: true, wait, error: null };
    }
    if (tool !== 'workflow_wait') throw new Error('workflow_follow_through_invalid_tool');
    normalizeWaitTarget(args);
    waitText(args.checkpoint, 'checkpoint', 20000);
    const sessionId = context?.sessionId, runId = context?.parentRunId;
    const handoff = context?.workflowFollowThrough;
    if (!conversations || !sessionId || !runId || (!handoff && !Number.isSafeInteger(context?.followThroughOrigin?.resetGeneration))) throw new Error('workflow_follow_through_source_required');
    context.abortSignal?.throwIfAborted();
    if (receiverSettings) {
      const receiver = await receiverSettings.read();
      if (!receiver.ready) throw new Error(`workflow_follow_through_webhook_${receiver.readiness || 'unavailable'}`);
    } else throw new Error('workflow_follow_through_webhook_unavailable');
    const { continuityHead } = await continuityStateStore(conversations, agentId).read(sessionId);
    if (continuityHead?.runId !== runId || continuityHead.state !== 'running') throw new Error('workflow_follow_through_source_inactive');
    const session = await conversations.getMetadata({ agentId, sessionId: handoff?.sessionId || sessionId });
    const origin = workflowOrigin(session, handoff?.sessionId || sessionId);
    if (!origin || (handoff ? handoff.agentId !== agentId || handoff.executionRunId !== runId || handoff.executionSessionId !== sessionId || origin.resetIdentity !== handoff.resetIdentity || origin.conversationId !== handoff.conversationId
      : Number(session.resetGeneration || 0) !== context.followThroughOrigin.resetGeneration)) throw new Error('workflow_follow_through_origin_changed');
    context.abortSignal?.throwIfAborted();
    const wait = await workflows.register(args, { agentId, sessionId: handoff?.sessionId || sessionId,
      ...origin, runId: handoff?.source.runId || runId, ...(handoff ? { handoffId: handoff.id, executionRunId: runId, executionSessionId: sessionId } : {}) });
    return { tool, ok: true, wait, error: null };
  } catch (error) {
    return { tool, ok: false, error: error?.message || 'workflow_follow_through_failed' };
  }
}
