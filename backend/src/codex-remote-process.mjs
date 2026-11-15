import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';

/** ChildProcess-shaped adapter; private RPC bytes never enter tool evidence. */
export async function openRemoteCodexProcess(controller, targetId, cwd) {
  if (typeof controller?.codexRpc !== 'function') throw new Error('codex_remote_transport_unavailable');
  const operationId = `codex-${randomUUID()}`;
  const rpc = (method, params = {}) => controller.codexRpc({ targetId, method: `codex.${method}`, params: { operationId, ...params } });
  await rpc('open', { cwd });
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let closed = false;
  const finish = result => { if (closed) return; closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', result?.exitCode ?? null, result?.signal ?? null); };
  child.stdin = new Writable({ write(data, encoding, callback) { rpc('write', { data: data.toString('utf8') }).then(() => callback(), () => callback(new Error('codex_remote_write_failed'))); },
    final(callback) { rpc('close').then(() => { callback(); }, () => { callback(new Error('codex_remote_close_failed')); }); } });
  child.kill = signal => { void rpc('close', { signal }).then(() => {}, () => child.emit('error', new Error('codex_remote_close_failed'))); return true; };
  child.start = () => { void (async () => {
    try {
      while (!closed) {
        const result = await rpc('read');
        if (closed) break;
        if (result.data) child.stdout.write(result.data);
        if (result.done) { finish(result); break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } catch { if (!closed) child.emit('error', new Error('codex_remote_read_failed')); }
  })(); };
  return child;
}
