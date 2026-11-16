import { createProcessDiagnostics, collectDiagnosticSecrets } from './native-minion-diagnostics.mjs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const failure = (code, message) => Object.assign(new Error(message), { code });
// Only structured protocol classifications cross the error boundary. Never echo messages/data.
export function codexProviderFailure(error) {
  const info = error?.codexErrorInfo;
  const known = { usageLimitExceeded: [429, 'quota_exhausted'], rateLimitExceeded: [429, 'rate_limited'],
    unauthorized: [401, 'authentication_failed'], serverOverloaded: [503, 'provider_overloaded'],
    internalServerError: [500, 'provider_failure'] };
  let pair = typeof info === 'string' ? known[info] : null;
  if (!pair && info && typeof info === 'object') {
    for (const key of ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']) {
      const status = info[key]?.httpStatusCode;
      if ([401, 403, 429].includes(status) || (Number.isInteger(status) && status >= 500 && status <= 599)) pair = [status, `http_${status}`];
    }
  }
  return pair ? { status: pair[0], providerReason: pair[1] } : {};
}
const providerError = (code, message, error) => Object.assign(failure(code, message), codexProviderFailure(error));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Terminal events may arrive before the caller starts awaiting completion.
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const tokensPayload = (tokens) => {
  if (!tokens || typeof tokens.accessToken !== 'string' || !tokens.accessToken
      || typeof tokens.chatgptAccountId !== 'string' || !tokens.chatgptAccountId) {
    throw failure('AUTH_INVALID', 'External ChatGPT tokens require accessToken and chatgptAccountId');
  }
  return { accessToken: tokens.accessToken, chatgptAccountId: tokens.chatgptAccountId,
    ...(tokens.chatgptPlanType == null ? {} : { chatgptPlanType: tokens.chatgptPlanType }) };
};

/** Transport-only stdio app-server client. Runtime integration lives in codex-minion-runner.
 * See docs/codex-minion-client.md for the public contract and protocol sources.
 */
export class CodexMinionClient {
  constructor({ executable = 'codex', cwd, env = process.env, spawnProcess = spawn,
    clientInfo = { name: 'burrow', title: 'Burrow', version: '0.1.0' },
    onActivity = () => {}, refreshAuthTokens, redact = value => value,
    requestTimeoutMs = 15_000, turnTimeoutMs = null,
    refreshTimeoutMs = 8_000, interruptTimeoutMs = 5_000, shutdownTimeoutMs = 1_000,
    maxLineBytes = 8 * 1024 * 1024 } = {}) {
    for (const value of [requestTimeoutMs, refreshTimeoutMs,
      interruptTimeoutMs, shutdownTimeoutMs, maxLineBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Limits must be positive integers');
    }
    if (turnTimeoutMs !== null && (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs <= 0)) {
      throw new TypeError('Optional turn timeout must be null or a positive integer');
    }
    Object.assign(this, { executable, cwd, env, spawnProcess, clientInfo, onActivity,
      refreshAuthTokens, requestTimeoutMs, turnTimeoutMs, refreshTimeoutMs,
      interruptTimeoutMs, shutdownTimeoutMs, maxLineBytes });
    this.diagnosticSecrets = new Set();
    collectDiagnosticSecrets(this.diagnosticSecrets, env);
    this.diagnostics = createProcessDiagnostics(value => {
      for (const secret of [...this.diagnosticSecrets].sort((a, b) => b.length - a.length)) value = value.split(secret).join('[redacted]');
      return redact(value);
    });
    this.stage = 'spawn';
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.closed = false;
  }

  async initialize() {
    if (this.initializing) return this.initializing;
    if (this.closed) throw failure('CLOSED', 'Codex client is closed');
    this.initializing = (async () => {
      try {
        this.proc = this.spawnProcess(this.executable, ['app-server', '--listen', 'stdio://'],
          { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
        this.exit = deferred();
        this.proc.on('error', error => { this.diagnostics.error(error, this.stage); this.fail(failure('PROCESS_ERROR', 'Codex process failed')); });
        this.proc.on('close', (code, signal) => {
          this.diagnostics.close(code, signal);
          this.exited = true;
          this.exit.resolve();
          this.fail(failure('PROCESS_EXIT', 'Codex process closed'));
        });
        this.proc.stdin.on('error', error => { this.diagnostics.error(error, 'input'); this.fail(failure('STDIN_ERROR', 'Codex stdin failed')); });
        this.proc.stdout.on('error', error => { this.diagnostics.error(error, 'output'); this.fail(failure('STDOUT_ERROR', 'Codex stdout failed')); });
        this.proc.stdout.on('data', (chunk) => this.consume(this.decoder.write(chunk)));
        this.proc.stdout.on('end', () => {
          this.consume(this.decoder.end());
          if (!this.closed) this.fail(failure('STDOUT_EOF', 'Codex stdout ended'));
        });
        // Keep sanitized text only; protocol payloads are never diagnostics.
        this.proc.stderr?.setEncoding('utf8');
        this.proc.stderr?.on('data', chunk => this.diagnostics.stderr(chunk));
        this.proc.stderr?.on('error', error => this.diagnostics.error(error, 'stderr'));
        const result = await this.request('initialize', {
          clientInfo: this.clientInfo, capabilities: { experimentalApi: true },
        });
        this.send({ method: 'initialized', params: {} });
        this.ready = true;
        return result;
      } catch (error) {
        if (!this.diagnostics.snapshot().nativeError && !this.diagnostics.snapshot().processError) this.diagnostics.error(error, this.stage);
        this.fail(error?.code ? error : failure('PROCESS_ERROR', 'Could not start Codex'));
        await this.close();
        throw this.fatal;
      }
    })();
    return this.initializing;
  }

  assertReady() {
    if (!this.ready || this.closed) throw failure('NOT_READY', 'Initialize Codex before using this method');
  }
  async login(tokens) {
    this.assertReady();
    collectDiagnosticSecrets(this.diagnosticSecrets, tokens);
    return this.request('account/login/start', { type: 'chatgptAuthTokens', ...tokensPayload(tokens) });
  }
  async startThread(params = {}) {
    this.assertReady();
    return this.request('thread/start', params);
  }
  async resumeThread(threadId, params = {}) {
    this.assertReady();
    return this.request('thread/resume', { ...params, threadId });
  }

  async readThread(threadId) {
    this.assertReady();
    return this.request('thread/read', { threadId, includeTurns: false });
  }

  async readTurn(threadId, turnId) {
    const { thread } = await this.readThread(threadId);
    if (thread?.id !== threadId) throw failure('PROTOCOL_ERROR', 'Invalid checkpoint thread');
    let turn = thread.turns?.find(item => item.id === turnId);
    if (!turn) {
      let cursor;
      const seen = new Set();
      do {
        const page = await this.request('thread/turns/list', { threadId, cursor, limit: 100, itemsView: 'notLoaded' });
        if (!Array.isArray(page.data)) throw failure('PROTOCOL_ERROR', 'Invalid checkpoint turns');
        turn = page.data.find(item => item.id === turnId);
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw failure('PROTOCOL_ERROR', 'Repeated checkpoint cursor');
        seen.add(cursor);
        if (seen.size > 100) throw failure('PROTOCOL_ERROR', 'Checkpoint exceeds limit');
      } while (!turn && cursor);
    }
    // Metadata/legacy responses may omit itemsView; never infer complete history
    // from inline items. Export authoritative persisted items on every read.
    if (turn) {
      const items = [];
      let cursor;
      const seen = new Set();
      do {
        const page = await this.request('thread/items/list', { threadId, turnId, cursor, limit: 100, sortDirection: 'asc' });
        if (!Array.isArray(page.data)) throw failure('PROTOCOL_ERROR', 'Invalid checkpoint items');
        if (page.data.some(entry => entry.turnId !== turnId || !entry.item)) throw failure('PROTOCOL_ERROR', 'Invalid checkpoint item owner');
        items.push(...page.data.map(entry => entry.item));
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw failure('PROTOCOL_ERROR', 'Repeated checkpoint cursor');
        seen.add(cursor);
        if (seen.size > 100 || JSON.stringify(items).length > 1_000_000) throw failure('PROTOCOL_ERROR', 'Checkpoint exceeds limit');
      } while (cursor);
      turn = { ...turn, items, itemsView: 'full' };
    }
    return turn;
  }

  /** Resolves only on turn/completed; only one active turn per client. */
  async startTurn(params, { signal } = {}) {
    this.assertReady();
    if (this.active) throw failure('TURN_ACTIVE', 'A Codex turn is already active');
    if (!params?.threadId) throw new TypeError('threadId is required');
    if (signal?.aborted) throw failure('ABORTED', 'Codex turn cancelled');
    const active = { threadId: params.threadId, done: deferred(), items: new Map(), observed: new Map(), early: [] };
    this.active = active;
    const abort = () => { void this.interrupt().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = this.turnTimeoutMs === null ? null : setTimeout(() => {
      active.done.reject(failure('TURN_TIMEOUT', 'Codex turn timed out'));
      void this.interrupt().catch(() => {});
    }, this.turnTimeoutMs);
    try {
      const result = await this.request('turn/start', params);
      if (!result?.turn?.id) throw failure('PROTOCOL_ERROR', 'Missing Codex turn id');
      active.turnId = result.turn.id;
      active.started?.();
      for (const message of active.early) this.turnEvent(message);
      active.early = [];
      return await active.done.promise;
    } catch (error) {
      // A start RPC failure leaves server state uncertain; do not reuse it.
      if (!active.turnId) this.fail(error);
      error.nativeTurn = { threadId: active.threadId, turnId: active.turnId, observed: [...active.observed.values()] };
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (this.active === active) this.active = null;
    }
  }

  async interrupt() {
    const active = this.active;
    if (!active) return;
    if (active.interrupting) return active.interrupting;
    active.interrupting = (async () => {
      try {
        // Cancellation during turn/start waits for its response, bounded by RPC timeout.
        if (!active.turnId) {
          await this.bounded(new Promise((resolve) => {
            active.started = resolve;
          }), this.interruptTimeoutMs);
        }
        await this.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, this.interruptTimeoutMs);
        await this.bounded(active.done.promise.catch(() => {}), this.interruptTimeoutMs);
      } catch {
        this.fail(failure('INTERRUPT_TIMEOUT', 'Codex cancellation failed or timed out'));
        await this.close();
      }
    })();
    return active.interrupting;
  }

  bounded(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('TIMEOUT', 'Codex operation timed out')), ms);
    })]).finally(() => clearTimeout(timer));
  }
  send(message) {
    if (this.closed || !this.proc) throw failure('CLOSED', 'Codex client is closed');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params, timeout = this.requestTimeoutMs) {
    this.stage = method;
    const id = this.nextId++;
    const done = deferred();
    const timer = setTimeout(() => {
      this.fail(failure('RPC_TIMEOUT', 'Codex request timed out'));
    }, timeout);
    this.pending.set(id, { ...done, timer, method });
    try { this.send({ id, method, params }); }
    catch { this.fail(failure('IPC_ERROR', 'Could not write to Codex')); }
    return done.promise;
  }
  consume(text) {
    if (this.closed) return;
    this.buffer += text;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line) > this.maxLineBytes) return this.fail(failure('PROTOCOL_ERROR', 'Codex message exceeds limit'));
      if (!line.trim()) continue;
      try { this.message(JSON.parse(line)); }
      catch { return this.fail(failure('PROTOCOL_ERROR', 'Invalid Codex JSONL message')); }
      if (this.closed) return;
    }
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes) this.fail(failure('PROTOCOL_ERROR', 'Codex message exceeds limit'));
  }
  message(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
    if (message.method && message.id != null) {
      void this.serverRequest(message);
      return;
    }
    if (message.id != null) {
      const done = this.pending.get(message.id);
      if (!done) return;
      clearTimeout(done.timer);
      this.pending.delete(message.id);
      // Extract only sanitized reason/code; never serialize error.data or auth params.
      if (message.error) {
        this.diagnostics.error(message.error, done.method, 'nativeError');
        done.reject(providerError('RPC_ERROR', 'Codex request rejected', message.error?.data || message.error));
      }
      else if ('result' in message) done.resolve(message.result);
      else done.reject(failure('PROTOCOL_ERROR', 'Invalid Codex response'));
      return;
    }
    if (typeof message.method !== 'string') throw new Error();
    try { Promise.resolve(this.onActivity(message)).catch(() => {}); } catch { /* observer only */ }
    if (this.active && !this.active.turnId) {
      if (this.active.early.length >= 10_000) return this.fail(failure('PROTOCOL_ERROR', 'Too many early Codex events'));
      this.active.early.push(message);
    } else this.turnEvent(message);
  }
  turnEvent({ method, params = {} }) {
    const active = this.active;
    if (!active || params.threadId !== active.threadId) return;
    const turnId = params.turnId ?? params.turn?.id;
    if (turnId !== active.turnId) return;
    if (['item/started', 'item/completed'].includes(method) && params.item?.id) active.observed.set(params.item.id, params.item);
    if (method === 'item/completed' && params.item?.id) active.items.set(params.item.id, params.item);
    if (method === 'error' && params.willRetry !== true) {
      this.diagnostics.error(params.error, 'turn', 'nativeError');
      active.done.reject(providerError('TURN_ERROR', 'Codex turn reported an error', params.error));
    }
    if (method !== 'turn/completed') return;
    if (params.turn.status === 'completed') {
      const items = [...active.items.values()];
      active.done.resolve({ threadId: active.threadId, turnId: active.turnId,
        status: 'completed', items, observed: [...active.observed.values()], text: items.filter((item) => item.type === 'agentMessage').map((item) => item.text).join('\n') });
    } else {
      this.diagnostics.error(params.turn.error, 'turn/completed', 'nativeError');
      active.done.reject(providerError(params.turn.status === 'interrupted' ? 'ABORTED' : 'TURN_FAILED',
      params.turn.status === 'interrupted' ? 'Codex turn cancelled' : 'Codex turn failed', params.turn.error));
    }
  }
  async serverRequest(message) {
    const { id, method, params } = message;
    try {
      if (method !== 'account/chatgptAuthTokens/refresh' || !this.refreshAuthTokens) {
        this.send({ id, error: { code: -32601, message: 'Unsupported client request' } });
        return;
      }
      const tokens = await this.bounded(Promise.resolve().then(() => this.refreshAuthTokens(params)), this.refreshTimeoutMs);
      collectDiagnosticSecrets(this.diagnosticSecrets, tokens);
      this.send({ id, result: tokensPayload(tokens) });
    } catch {
      if (!this.closed) {
        try { this.send({ id, error: { code: -32603, message: 'Token refresh failed' } }); } catch { /* closing */ }
      }
    }
  }
  fail(error) {
    if (this.closed) return;
    if (!this.diagnostics.snapshot().nativeError && !this.diagnostics.snapshot().processError) this.diagnostics.error(error, this.stage);
    this.fatal = error;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.active?.done.reject(error);
    void Promise.resolve().then(() => this.close()).catch(() => {});
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (!this.closed) this.fail(failure('CLOSED', 'Codex client closed'));
      if (!this.proc || this.exited) return;
      this.proc.stdin.end();
      try { await this.bounded(this.exit.promise, this.shutdownTimeoutMs); return; } catch { /* escalate */ }
      this.proc.kill('SIGTERM');
      try { await this.bounded(this.exit.promise, this.shutdownTimeoutMs); return; } catch { /* escalate */ }
      this.proc.kill('SIGKILL');
      try { await this.bounded(this.exit.promise, this.shutdownTimeoutMs); }
      catch { throw failure('CLEANUP_TIMEOUT', 'Codex process did not close after SIGKILL'); }
    })();
    // Internal fire-and-forget cleanup must not cause unhandled rejection.
    this.closing.catch(() => {});
    return this.closing;
  }
}
