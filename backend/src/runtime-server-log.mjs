import { promises as fs } from 'node:fs';
import path from 'node:path';
import { boundedRedactedValue } from './redaction.mjs';

const MAX_EVENT_CHARS = 12_000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_BACKUPS = 3;

function text(value) { return String(value ?? '').trim(); }
function bounded(value, limit = 512) { const source = text(value); return source.length <= limit ? source : `${source.slice(0, Math.max(0, limit - 28)).trim()} [truncated]`; }

export function runtimeServerLogPath(runtimeRoot) {
  return path.join(path.resolve(runtimeRoot), 'logs', 'server-events.jsonl');
}

export function createRuntimeServerLogger({ runtimeRoot, service = 'burrow-ui', now = () => new Date() } = {}) {
  const filePath = runtimeServerLogPath(runtimeRoot);
  let queue = Promise.resolve();
  let rotationChecked = false;

  async function rotateIfNeeded() {
    if (rotationChecked) return;
    rotationChecked = true;
    let stat;
    try { stat = await fs.stat(filePath); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (stat.size < MAX_LOG_BYTES) return;
    for (let index = MAX_BACKUPS; index >= 1; index -= 1) {
      const from = `${filePath}.${index}`;
      const to = `${filePath}.${index + 1}`;
      try { await fs.rename(from, to); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    await fs.rename(filePath, `${filePath}.1`);
  }

  function event(type, fields = {}) {
    const entry = {
      at: now().toISOString(), service,
      event: bounded(type, 120) || 'server_event',
      ...boundedRedactedValue(fields, { maxChars: MAX_EVENT_CHARS, maxStringChars: 2_000, maxDepth: 5, maxItems: 20, maxKeys: 30 }),
    };
    queue = queue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await rotateIfNeeded();
      await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    });
    return queue.catch((error) => {
      // Logging must not kill the runtime. stderr remains systemd-visible when
      // durable storage itself is unavailable.
      console.error(`Burrow server log write failed: ${String(error?.message || error)}`);
    });
  }

  async function flush() { await queue; }
  return { filePath, event, flush };
}
