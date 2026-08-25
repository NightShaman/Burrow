#!/usr/bin/env node
/**
 * Isolated native Chat Completions continuation reproduction.
 *
 * Runs the actual runtime orchestrator and model adapter against a deterministic
 * in-process provider stub. It never reads production config, opens a listener,
 * calls the network, or writes outside a private temporary directory.
 *
 * Run with:
 *   node --expose-gc --max-old-space-size=512 scripts/oom-native-continuation-repro.mjs
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { runPlainModelTurn } from '../src/runtime-orchestrator.mjs';
import { createOpenAICompatibleModelAdapter } from '../src/model-adapter.mjs';
import { createTraceLogger } from '../src/trace-logger.mjs';

const iterations = Number(process.env.BURROW_OOM_REPRO_ITERATIONS || 120);
const fileBytes = Number(process.env.BURROW_OOM_REPRO_FILE_BYTES || 48 * 1024);
const callsPerIteration = Number(process.env.BURROW_OOM_REPRO_CALLS_PER_ITERATION || 4);
const gcInterval = Number(process.env.BURROW_OOM_REPRO_GC_INTERVAL || 16);
const maxPostGcHeapMiB = Number(process.env.BURROW_OOM_REPRO_MAX_HEAP_MIB || 256);

if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000) throw new Error('BURROW_OOM_REPRO_ITERATIONS must be 1..1000');
if (!Number.isInteger(fileBytes) || fileBytes < 1 || fileBytes > 512 * 1024) throw new Error('BURROW_OOM_REPRO_FILE_BYTES must be 1..524288');
if (!Number.isInteger(callsPerIteration) || callsPerIteration < 1 || callsPerIteration > 16) throw new Error('BURROW_OOM_REPRO_CALLS_PER_ITERATION must be 1..16');
if (!Number.isInteger(gcInterval) || gcInterval < 1 || gcInterval > iterations) throw new Error('BURROW_OOM_REPRO_GC_INTERVAL must be 1..iterations');
if (typeof global.gc !== 'function') throw new Error('run with --expose-gc so retained heap can be measured');

function mib(value) { return Math.round((value / 1024 / 1024) * 10) / 10; }
function heap(stage, { collect = false } = {}) {
  if (collect) global.gc();
  const usage = process.memoryUsage();
  return { stage, collected: collect, heapUsedMiB: mib(usage.heapUsed), heapTotalMiB: mib(usage.heapTotal), rssMiB: mib(usage.rss), externalMiB: mib(usage.external) };
}
function providerResponse(message) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ index: 0, message }], usage: { prompt_tokens: 100 } }) };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'burrow-oom-native-repro-'));
const samples = [heap('before-setup', { collect: true })];
try {
  for (let index = 0; index < iterations; index += 1) {
    for (let call = 0; call < callsPerIteration; call += 1) {
      await fs.writeFile(path.join(root, `fixture-${index}-${call}.txt`), `fixture ${index}-${call}\n${'x'.repeat(fileBytes - 20)}\n`, 'utf8');
    }
  }
  samples.push(heap('after-fixtures', { collect: true }));

  let calls = 0;
  const adapter = createOpenAICompatibleModelAdapter({
    config: { baseUrl: 'http://in-process.invalid/v1', model: 'oom-repro' },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const isContinuation = calls > 0;
      const index = calls;
      calls += 1;
      if (index < iterations) {
        assert.equal(Array.isArray(body.messages), true, 'must use Chat Completions messages');
        if (isContinuation) {
          const serialized = JSON.stringify(body.messages);
          assert.ok(serialized.length < 140_000, `continuation ${index} provider transcript exceeded bound: ${serialized.length}`);
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: Array.from({ length: callsPerIteration }, (_, call) => ({ id: `read-${index}-${call}`, type: 'function', function: { name: 'files_read', arguments: JSON.stringify({ filePath: path.join(root, `fixture-${index}-${call}.txt`) }) } })) } }], usage: { prompt_tokens: 100 } }) };
      }
      return providerResponse({ role: 'assistant', content: 'Controlled native continuation reproduction complete.' });
    },
  });

  const persistedTraceLogger = createTraceLogger({ rootDir: path.join(root, 'traces'), runId: 'native-continuation-repro' });
  const traceLogger = {
    ...persistedTraceLogger,
    event: async (kind, payload) => {
      if (kind === 'runtime-heap-stage' && payload?.stage === 'chat-tool-loop-after-model-response') {
        const modelCall = calls;
        samples.push(heap(`after-model-${modelCall}`));
        if (modelCall % gcInterval === 0) samples.push(heap(`after-model-${modelCall}-post-gc`, { collect: true }));
      }
      return persistedTraceLogger.event(kind, payload);
    },
  };
  const result = await runPlainModelTurn({
    prompt: {
      text: 'Read each fixture in order, then summarize.',
      modelMessages: [
        { role: 'system', content: `Stable controlled contract.\n${'s'.repeat(40_000)}` },
        { role: 'user', content: 'Read each fixture in order, then summarize.' },
      ],
    },
    message: 'controlled reproduction',
    workspaceRoot: root,
    rootDir: root,
    modelAdapter: adapter,
    enableChatToolLoop: true,
    stopOnNoProgress: false,
    traceLogger,
  });

  samples.push(heap('after-turn', { collect: true }));
  assert.equal(calls, iterations + 1, JSON.stringify({ model: result.model, loop: result.chatToolLoop }, null, 2));
  assert.equal(result.chatToolLoop.iterations.length, 64, 'receipt history must remain bounded');
  assert.equal(result.chatToolLoop.toolResults.length, Math.min(256, iterations * callsPerIteration), 'tool receipt history must retain only its configured 256-entry capacity');
  assert.equal(result.answerText, 'Controlled native continuation reproduction complete.');
  const final = samples.at(-1);
  assert.ok(final.heapUsedMiB <= maxPostGcHeapMiB, `retained heap ${final.heapUsedMiB} MiB exceeds ${maxPostGcHeapMiB} MiB after ${iterations} native continuations`);
  console.log(JSON.stringify({ ok: true, root, iterations, callsPerIteration, gcInterval, fileBytes, calls, final, peakHeapMiB: Math.max(...samples.map((sample) => sample.heapUsedMiB)), peakPostGcHeapMiB: Math.max(...samples.filter((sample) => sample.collected).map((sample) => sample.heapUsedMiB)), samples }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
