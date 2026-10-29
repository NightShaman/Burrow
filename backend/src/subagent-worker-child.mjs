#!/usr/bin/env node
import { resolveModelConfig } from './config.mjs';
import { PostgresModelSettingsStore } from './postgres-model-settings-store.mjs';
import { settingsKeyFromEnvironment } from './model-settings-store.mjs';
import { readFile } from 'node:fs/promises';
import { runSpawnSubagentChild } from './subagent-worker-runner.mjs';
import { createPostgresPool } from './postgres-foundation.mjs';
import { PostgresSessionStore } from './postgres-session-store.mjs';
import { createReconfigurableOtelRuntime } from './otel-runtime.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HEARTBEAT_INTERVAL_MS = 15_000;

// Also used by process-level transport tests; importing this module must not
// open a database or execute a subagent.
export async function startSubagentChildTelemetry(childArgs = {}) {
  const configuration = childArgs.otelConfiguration;
  if (!childArgs.traceContext || !configuration?.enabled || !(configuration.destinations?.some(destination => destination.enabled && (destination.endpoint || destination.tracesEndpoint || destination.metricsEndpoint)) || configuration.endpoint || configuration.tracesEndpoint || configuration.metricsEndpoint)) return { telemetry: null, telemetryRun: null };
  const telemetry = createReconfigurableOtelRuntime({ tuningEnv: {} });
  await telemetry.apply(configuration);
  const telemetryRun = telemetry.startRun({ runId: childArgs.id, sessionId: childArgs.childSessionId, agentId: childArgs.owner?.agentId, source: 'subagent', parentTraceContext: childArgs.traceContext });
  return { telemetry, telemetryRun };
}

async function main() {
  const payloadPath = process.argv[2];
  if (!payloadPath) throw new Error('payload path is required');
  const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
  const childArgs = payload.args || payload;
  const pool = createPostgresPool();
  const conversationStore = new PostgresSessionStore({ pool });
  if (childArgs.modelConfig?.connectionId) {
    const selected = childArgs.modelConfig;
    childArgs.modelConfig = await resolveModelConfig({
      modelSettings: new PostgresModelSettingsStore({ pool, key: settingsKeyFromEnvironment() }),
      agentId: childArgs.owner?.agentId,
      modelConnectionId: selected.connectionId, model: selected.model,
      temperature: selected.temperature, maxTokens: selected.maxTokens,
      reasoning_effort: selected.extra?.reasoning?.effort || 'off',
    });
  }
  const { telemetry, telemetryRun } = await startSubagentChildTelemetry(childArgs);
  const heartbeat = setInterval(() => {
    process.stdout.write(`${JSON.stringify({ __burrowSubagentProgress: true, phase: 'heartbeat', at: new Date().toISOString() })}\n`);
  }, HEARTBEAT_INTERVAL_MS);
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('subagent_cancelled'));
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  try {
    const result = await runSpawnSubagentChild({
      signal: controller.signal,
      ...childArgs,
      parentExecutionContext: { conversationStore, agentId: childArgs.owner?.agentId, executionBoundaries: childArgs.executionBoundaries || null, parentRunId: childArgs.id, traceContext: telemetryRun?.traceContext || childArgs.traceContext || null, telemetry },
      progress: async (event = {}) => {
        process.stdout.write(`${JSON.stringify({ __burrowSubagentProgress: true, ...event, at: new Date().toISOString() })}\n`);
      },
    });
    telemetry?.endRun(childArgs.id, result);
    process.stdout.write(`${JSON.stringify({ __burrowSubagentResult: true, ok: Boolean(result.ok), result })}\n`);
  } catch (error) {
    telemetry?.endRun(childArgs.id, { ok: false, error: error?.message || String(error) });
    throw error;
  } finally {
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
    clearInterval(heartbeat);
    await telemetry?.shutdown?.();
    await pool.end();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch((error) => {
  const detail = error?.message || String(error);
  process.stdout.write(`${JSON.stringify({ __burrowSubagentResult: true, ok: false, error: detail, result: { ok: false, summary: `Minion child failed: ${detail}`, blockers: [`subagent_child_failed:${detail}`], warnings: [], evidence: [], artifacts: [], changedFiles: [], memoryWrites: [], sideEffectsApplied: false } })}\n`);
  process.exitCode = 1;
});
