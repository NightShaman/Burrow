// Composition for CLI/manual execution; scheduler itself has no chat back edge.
import { createScheduledJobScheduler } from './scheduled-job-scheduler.mjs';
import { runChatTurnFromBody } from './chat-turn-controller.mjs';
import { createBoardTaskExecutor } from './task-execution.mjs';
import { createChatTurnRunId } from './chat-turn-run-id.mjs';

export function createRuntimeScheduledJobScheduler(options = {}) {
  const executeTask = createBoardTaskExecutor({ withTaskBoard: fn => fn(options.stores?.tasks), resolveAgentRuntime: options.resolveAgentRuntime, createChatTurnRunId, runChatTurnFromBody: options.executeTurn || runChatTurnFromBody, projectRoot: options.rootDir, postgresApplication: { stores: options.stores } });
  return createScheduledJobScheduler({ executeTurn: runChatTurnFromBody, createRunId: createChatTurnRunId, executeTask, ...options });
}
