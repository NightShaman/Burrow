#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runSpawnSubagentChild } from './subagent-worker-runner.mjs';

const HEARTBEAT_INTERVAL_MS = 15_000;

async function main() {
  const payloadPath = process.argv[2];
  if (!payloadPath) throw new Error('payload path is required');
  const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
  const childArgs = payload.args || payload;
  const heartbeat = setInterval(() => {
    process.stdout.write(`${JSON.stringify({ __burrowSubagentProgress: true, phase: 'heartbeat', at: new Date().toISOString() })}\n`);
  }, HEARTBEAT_INTERVAL_MS);
  try {
    const result = await runSpawnSubagentChild({
      ...childArgs,
      progress: async (event = {}) => {
        process.stdout.write(`${JSON.stringify({ __burrowSubagentProgress: true, ...event, at: new Date().toISOString() })}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify({ __burrowSubagentResult: true, ok: Boolean(result.ok), result })}\n`);
  } finally {
    clearInterval(heartbeat);
  }
}

main().catch((error) => {
  const detail = error?.message || String(error);
  process.stdout.write(`${JSON.stringify({ __burrowSubagentResult: true, ok: false, error: detail, result: { ok: false, summary: `Subagent child failed: ${detail}`, blockers: [`subagent_child_failed:${detail}`], warnings: [], evidence: [], artifacts: [], changedFiles: [], memoryWrites: [], sideEffectsApplied: false } })}\n`);
  process.exitCode = 1;
});
