import { diagnosticText } from './native-minion-diagnostics.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';

/** ChildProcess-shaped adapter; private RPC bytes never enter tool evidence. */
export async function openRemoteCodexProcess(controller, targetId, cwd) {
  if (typeof controller?.codexRpc !== 'function') throw new Error('codex_remote_transport_unavailable');
  return openRemoteProcess(controller, targetId, { cwd }, 'codex');
}

export async function openRemoteClaudeProcess(controller, targetId, cwd, { args, token } = {}) {
  if (typeof controller?.codexRpc !== 'function') throw new Error('claude_remote_transport_unavailable');
  return openRemoteProcess(controller, targetId, { cwd, args, token }, 'claude');
}

export async function openRemoteGeminiProcess(controller, targetId, cwd, { args, apiKey } = {}) {
  if (typeof controller?.codexRpc !== 'function') throw new Error('gemini_remote_transport_unavailable');
  return openRemoteProcess(controller, targetId, { cwd, args, apiKey }, 'gemini');
}

async function openRemoteProcess(controller, targetId, options, runtime) {
  const redact = value => {
    for (const secret of [options.token, options.apiKey].filter(Boolean)) value = value.split(secret).join('[redacted]');
    return value;
  };
  const transportError = (stage, error) => Object.assign(new Error(diagnosticText(error?.message, redact) || `${runtime}_remote_${stage}_failed`),
    { code: error?.code == null ? `${runtime}_remote_${stage}_failed` : diagnosticText(String(error.code), redact), stage });
  const operationId = `${runtime}-${randomUUID()}`;
  const rpc = (method, params = {}) => controller.codexRpc({ targetId, method: `${runtime}.${method}`, params: { operationId, ...params } });
  try { await rpc('open', options); } catch (error) { throw transportError('open', error); }
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let closed = false;
  const finish = result => { if (closed) return; closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', result?.exitCode ?? null, result?.signal ?? null); };
  child.stdin = new Writable({ write(data, encoding, callback) {
    // Gateway frames are bounded to 128 KiB; a checkpoint JSONL request may be larger.
    void (async () => {
      let text = data.toString('utf8');
      while (text.length) {
        let end = Math.min(text.length, 16 * 1024);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        await rpc('write', { data: text.slice(0, end) });
        text = text.slice(end);
      }
    })().then(() => callback(), error => callback(transportError('write', error)));
  },
    final(callback) { rpc('close').then(() => { callback(); }, error => { callback(transportError('close', error)); }); } });
  child.kill = signal => { void rpc('close', { signal }).then(() => {}, error => child.emit('error', transportError('close', error))); return true; };
  let started = false;
  child.start = () => { if (started || closed) return; started = true; void (async () => {
    try {
      while (!closed) {
        const result = await rpc('read');
        if (closed) break;
        if (result.data) child.stdout.write(result.data);
        if (result.stderr) child.stderr.write(result.stderr);
        if (result.processError) child.emit('error', transportError('process', { message: result.processError, code: result.code }));
        if (result.done) { finish(result); break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } catch (error) { if (!closed) child.emit('error', transportError('read', error)); }
  })(); };
  return child;
}
