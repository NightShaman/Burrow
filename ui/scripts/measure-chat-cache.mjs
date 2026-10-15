// Synthetic local-only workload. Run: node --expose-gc scripts/measure-chat-cache.mjs
// No API calls, live transcripts or browser storage are used.
import { createServer } from 'vite';
import { performance } from 'node:perf_hooks';
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { readConversationCache, writeConversationCache } = await server.ssrLoadModule('/src/features/chat/chatConversationCache.ts');
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  for (const count of [24, 100, 500]) {
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const cache = Object.fromEntries(Array.from({ length: count }, (_, session) => [`a:s${session}`, Array.from({ length: 40 }, (_, turn) => ({ role: turn % 2 ? 'assistant' : 'user', runId: `r${session}-${turn}`, content: `${session}:${turn}:` + 'x'.repeat(1024) }))]));
    global.gc?.();
    const heapDelta = process.memoryUsage().heapUsed - heapBefore;
    let raw = null;
    const storage = { getItem: () => raw, setItem: (_key, value) => { raw = value; } };
    writeConversationCache(cache, undefined, storage); // same full persisted baseline for both implementations
    const write = [], read = [], lookup = [], renderRead = [];
    for (let i = 0; i < 9; i++) {
      let start = performance.now(); writeConversationCache(cache, 'a:s0', storage); write.push(performance.now() - start);
      start = performance.now(); readConversationCache(storage); read.push(performance.now() - start);
      start = performance.now(); for (let j = 0; j < 1000; j++) { const turns = cache[`a:s${j % count}`]; if (!turns) throw Error('lost session'); } lookup.push((performance.now() - start) / 1000);
      // Current eager useRef(readConversationCache()) repeats this on every render.
      start = performance.now(); for (let j = 0; j < 10; j++) readConversationCache(storage); renderRead.push((performance.now() - start) / 10);
    }
    console.log(JSON.stringify({ sessions: count, turns: count * 40, heapDeltaBytes: heapDelta, fullJsonBytes: Buffer.byteLength(JSON.stringify(cache)), persistedBytes: Buffer.byteLength(raw ?? ''), writeMedianMs: +median(write).toFixed(3), persistedReadMedianMs: +median(read).toFixed(3), navigationLookupMedianMs: +median(lookup).toFixed(6), repeatedRenderReadMedianMs: +median(renderRead).toFixed(3) }));
  }
} finally { await server.close(); }
