import { createReadStream } from 'node:fs';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { archiveReadCheckpoint } from './archive-read-scope.mjs';

// Legacy traces have no trusted completeness/index marker. Stream the entire
// requested run's individual file, including the final unterminated line. Never
// use events.jsonl as a substitute for the separately persisted streams: the
// writer can stop between those appends, and old traces need not have both.
// Keep the same trim/split/JSON.parse behavior as the full trace reader,
// including rejecting a whitespace-only line inside a file.
export async function readProofTraceJsonl(filePath, visit, { signal, deadline, onBytes } = {}) {
  const options = { signal, deadline };
  archiveReadCheckpoint(options);
  let input;
  let first = true;
  let pending = null;
  let whitespace = null;
  let fragments = [];
  let records = 0;
  const parse = async line => {
    archiveReadCheckpoint(options);
    visit(JSON.parse(line));
    records += 1;
    // JSON.parse and reduction are synchronous; yield periodically even when
    // a large local file is continuously available from the OS cache.
    if (records % 256 === 0) {
      await yieldToLoop();
      archiveReadCheckpoint(options);
    }
  };
  const line = async value => {
    if (first) {
      value = value.trimStart();
      if (!value) return;
      first = false;
    }
    if (!value) return; // split('\n').filter(Boolean)
    if (!value.trim()) { whitespace ||= value; return; }
    if (pending !== null) await parse(pending);
    if (whitespace !== null) await parse(whitespace); // deliberately throws
    whitespace = null;
    pending = value;
  };
  try {
    input = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024, signal });
    for await (const chunk of input) {
      archiveReadCheckpoint(options);
      onBytes?.(Buffer.byteLength(chunk));
      let start = 0;
      for (;;) {
        const end = chunk.indexOf('\n', start);
        if (end < 0) break;
        fragments.push(chunk.slice(start, end));
        await line(fragments.join(''));
        fragments = [];
        start = end + 1;
      }
      if (start < chunk.length) fragments.push(chunk.slice(start));
    }
    if (fragments.length) await line(fragments.join(''));
    if (pending !== null) await parse(pending.trimEnd());
    archiveReadCheckpoint(options);
    return records;
  } catch (error) {
    archiveReadCheckpoint(options);
    if (error?.code === 'ENOENT') return 0;
    throw error;
  } finally {
    input?.destroy();
  }
}
