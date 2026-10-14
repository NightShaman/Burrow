// Composition for CLI/manual execution; scheduler itself has no chat back edge.
import { createScheduledJobScheduler } from './scheduled-job-scheduler.mjs';
import { runChatTurnFromBody } from './chat-turn-controller.mjs';
import { createChatTurnRunId } from './chat-turn-run-id.mjs';

export function createRuntimeScheduledJobScheduler(options = {}) {
  return createScheduledJobScheduler({ executeTurn: runChatTurnFromBody, createRunId: createChatTurnRunId, ...options });
}
