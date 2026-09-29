import path from 'node:path';
import { withCliPostgres } from './cli-postgres.mjs';
import { latestTraceRun, summarizeTrace } from './trace-summary.mjs';
import { resolveRetentionConfig } from './config.mjs';
import { runRetentionCleanup } from './retention.mjs';

export async function runCliTrace({ rootDir, args = {}, latest = latestTraceRun, summarize = summarizeTrace, ...options } = {}) {
  return withCliPostgres({ rootDir, args, ...options }, async ({ application, runtime }) => {
    const dataRoot = runtime.runtimeState.dataRoot;
    const traceRoot = path.join(runtime.runtimeState.cacheRoot, 'traces');
    const latestRun = args.latest ? await latest({ rootDir: traceRoot }) : null;
    const runId = args.run_id || latestRun?.runId;
    if (!runId) throw new Error('--run-id is required unless --latest finds a trace');
    const summary = await summarize({ rootDir: traceRoot, runId,
      taskStore: application.stores.tasks, conversationStore: application.stores.conversations, agentId: args.agent_id || 'hatchet',
      includeToolOutput: Boolean(args.tool_output) });
    return { ...summary, latest: Boolean(args.latest), dataRoot, traceRoot };
  });
}

export async function runCliRetention({ rootDir, args = {}, cleanup = runRetentionCleanup, ...options } = {}) {
  return withCliPostgres({ rootDir, args, ...options }, async ({ application, runtime }) => cleanup({
    dataRoot: runtime.runtimeState.dataRoot,
    traceRoot: path.join(runtime.runtimeState.cacheRoot, 'traces'),
    taskStore: application.stores.tasks, conversationStore: application.stores.conversations, agentId: args.agent_id || 'hatchet',
    retention: resolveRetentionConfig(runtime.loaded.config), confirm: Boolean(args.confirm),
  }));
}
