// CDP pipe transport: one bounded startup handshake, ordinary commands remain 15 seconds.
export function browserPipe(browser, { binary, onEvent = () => {} } = {}) {
  const started = Date.now();
  const diagnostics = {
    binary,
    spawnfile: browser.spawnfile ?? binary,
    spawnargs: browser.spawnargs ?? [],
    pid: browser.pid ?? null,
    lifecycle: [],
    stdout: '',
    stderr: '',
    version: null,
    receivedBytes: 0,
    receivedMessages: 0,
  };
  const pending = new Map();
  let id = 0,
    buffer = '',
    terminal;
  const record = (event, detail = {}) =>
    diagnostics.lifecycle.push({ event, elapsedMs: Date.now() - started, ...detail });
  const input = browser.stdio[3],
    output = browser.stdio[4];
  const snapshot = () => ({
    ...diagnostics,
    lifecycle: [...diagnostics.lifecycle],
    pipes: {
      input: {
        destroyed: input.destroyed,
        writable: input.writable,
        writableEnded: input.writableEnded,
      },
      output: {
        destroyed: output.destroyed,
        readable: output.readable,
        readableEnded: output.readableEnded,
      },
      pendingMethods: [...pending.values()].map((p) => p.method),
    },
  });
  const fail = (error) => {
    terminal ??= error;
    for (const p of pending.values()) p.reject(terminal);
    pending.clear();
  };
  browser.stdout?.on('data', (chunk) => {
    diagnostics.stdout = (diagnostics.stdout + String(chunk)).slice(-65536);
  });
  browser.stderr?.on('data', (chunk) => {
    diagnostics.stderr = (diagnostics.stderr + String(chunk)).slice(-65536);
  });
  browser.on('spawn', () => {
    diagnostics.pid = browser.pid;
    record('spawn');
  });
  browser.on('error', (error) => {
    record('process-error', { error: String(error) });
    fail(error);
  });
  browser.on('exit', (code, signal) => {
    record('exit', { code, signal });
    fail(new Error(`Chromium exited code=${code} signal=${signal}`));
  });
  browser.on('close', (code, signal) => record('close', { code, signal }));
  for (const [name, stream] of [
    ['input', input],
    ['output', output],
  ]) {
    stream.on('error', (error) => {
      record(`${name}-error`, { error: String(error) });
      fail(error);
    });
    stream.on('close', () => {
      record(`${name}-close`);
      fail(new Error(`CDP ${name} pipe closed`));
    });
  }
  output.on('end', () => {
    record('output-end');
    fail(new Error('CDP output pipe ended'));
  });
  output.on('data', (chunk) => {
    diagnostics.receivedBytes += Buffer.byteLength(chunk);
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\0')) >= 0) {
      const raw = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!raw) continue;
      let message;
      try {
        message = JSON.parse(raw);
      } catch (error) {
        record('invalid-message', { error: String(error) });
        fail(new Error('Invalid CDP JSON'));
        return;
      }
      diagnostics.receivedMessages++;
      const p = pending.get(message.id);
      if (p) {
        pending.delete(message.id);
        message.error
          ? p.reject(new Error(JSON.stringify(message.error)))
          : p.resolve(message.result);
      } else if (message.method) onEvent(message);
    }
  });
  const request = (method, params, sessionId, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (terminal) {
        reject(terminal);
        return;
      }
      const key = ++id;
      const timer = setTimeout(() => {
        pending.delete(key);
        record('timeout', { method, timeoutMs });
        reject(new Error(`CDP timeout ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(key, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        input.write(
          JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0',
          (error) => {
            if (error) {
              record('write-error', { error: String(error) });
              fail(error);
            }
          },
        );
      } catch (error) {
        fail(error);
      }
    });
  return {
    snapshot,
    call: (method, params = {}, sessionId) => request(method, params, sessionId, 15000),
    ready: async () => {
      record('handshake-start');
      const version = await request('Browser.getVersion', {}, undefined, 60000);
      if (!version?.product || !version?.protocolVersion)
        throw new Error('Invalid Browser.getVersion readiness response');
      diagnostics.version = version;
      record('handshake-ready');
      return version;
    },
  };
}
