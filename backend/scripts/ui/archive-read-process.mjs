import { fork } from 'node:child_process';
import { ARCHIVE_READ_TIMEOUT_MS, archiveReadBudget } from '../../src/postgres-archive-read.mjs';
import { requestReadOwner } from './request-read-owner.mjs';

const CHILD = new URL('./archive-read-process-child.mjs', import.meta.url);
const failure = code => Object.assign(new Error(code), { status: 503, statusCode: 503 });
export function isIsolatedArchiveRead(method, url) {
  if (method !== 'GET') return false;
  return url.pathname === '/api/archive/sessions' || url.pathname.startsWith('/api/archive/sessions/')
    || url.pathname === '/api/archive/runs' || url.pathname.startsWith('/api/archive/runs/')
    || url.pathname === '/api/archive/calendar' && url.searchParams.get('kind') === 'sessions';
}

// Each worker retains its single owner until SQL and pipe output settle, even
// if its HTTP caller has stopped waiting. Its queue/quarantine is lane-local.
function createArchiveReadWorker({ poolConfig, rootDir, childPath, cancelGraceMs }) {
  let child = null, ready = null, active = null, sequence = 0, closed = false, closing;
  let quarantineUntil = 0, resumeTimer;
  const queue = [];
  function settle(job, error, result) {
    if (job.settled) return;
    job.settled = true;
    error ? job.reject(error) : job.resolve(result);
  }
  function finish(job, error, result) {
    if (!job || job.done) return;
    job.done = true; clearTimeout(job.watchdog);
    job.signal.removeEventListener('abort', job.abort);
    job.removeDrain?.();
    if (active === job) active = null;
    const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
    settle(job, error, result); drain();
  }
  function tryFinish(job) {
    if (job.complete && job.header && job.received === job.header.length && !job.paused) {
      finish(job, job.signal.aborted ? job.signal.reason : job.transportError, job.header);
    }
  }
  function start() {
    const current = child = fork(childPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe'], serialization: 'advanced', execArgv: [] });
    let terminal = false, rejectReady;
    const lost = () => {
      if (terminal) return; terminal = true;
      rejectReady?.(failure('archive_reader_unavailable'));
      if (child !== current) return;
      child = null; ready = null;
      if (active) {
        // Every child connection has a startup statement/idle-in-transaction
        // budget, including BEGIN and setup before SET LOCAL. A statement can
        // start late in a request, so quarantine for a *full* server budget
        // after exit, not merely until that request's deadline. This is a
        // conservative normal-PG bound, not a guarantee against a hung server
        // or an unbounded network partition.
        if (active.sent) quarantineUntil = Math.max(quarantineUntil, performance.now() + ARCHIVE_READ_TIMEOUT_MS + cancelGraceMs);
        finish(active, active.signal.aborted ? active.signal.reason : active.transportError || failure('archive_reader_unavailable'));
      }
      drain();
    };
    const terminate = () => {
      // An IPC error is not proof the process or its SQL has stopped.
      if (current.pid && current.exitCode === null && !current.signalCode) current.kill('SIGKILL');
      else lost();
    };
    const send = message => {
      try { current.send(message, error => { if (error) terminate(); }); }
      catch { terminate(); }
    };
    ready = new Promise((resolve, reject) => {
      rejectReady = reject;
      current.on('error', terminate); current.once('exit', lost);
      current.on('message', message => {
        if (child !== current || terminal) return;
        if (message?.type === 'ready') { resolve(); return; }
        if (message?.type === 'init_error') { terminate(); return; }
        const job = active;
        if (!job || !job.sent || message?.id !== job.id) { terminate(); return; }
        if (message.type === 'headers') {
          const result = message.result;
          if (job.header || job.complete || !Number.isInteger(result?.status) || result.status < 100 || result.status > 599
              || !Number.isSafeInteger(result?.length) || result.length < 0) { terminate(); return; }
          job.header = result; job.received = 0;
          try { if (!job.signal.aborted && !job.transportError) job.receive.headers(result); }
          catch (error) { job.transportError = error; job.abort(); }
          send({ type: 'continue', id: job.id });
        } else if (message.type === 'complete') {
          if (!job.header || job.complete) { terminate(); return; }
          job.complete = true; tryFinish(job);
        } else terminate();
      });
    });
    ready.catch(() => {});
    current.stdio[4].on('error', terminate);
    current.stdio[4].on('data', chunk => {
      if (child !== current || terminal) return; // exit can precede closing the old pipe
      const job = active;
      if (!job?.header || job.done) { terminate(); return; }
      job.received += chunk.length;
      if (job.received > job.header.length) { terminate(); return; }
      if (!job.signal.aborted && !job.transportError) {
        try {
          if (job.receive.chunk(chunk) === false) {
            job.paused = true; current.stdio[4].pause();
            job.removeDrain = job.receive.drain(() => {
              if (active !== job || job.done || !job.paused) return;
              job.paused = false; job.removeDrain = null; current.stdio[4].resume(); tryFinish(job);
            });
          }
        } catch (error) { job.transportError = error; job.abort(); }
      }
      tryFinish(job);
    });
    const config = { ...poolConfig, max: 1 };
    if (config.ssl && typeof config.ssl === 'object') {
      // pg may make ssl.key non-enumerable when another pool was created.
      config.ssl = Object.fromEntries(Object.getOwnPropertyNames(config.ssl)
        .filter(key => key !== 'checkServerIdentity').map(key => [key, config.ssl[key]]));
    }
    send({ type: 'init', poolConfig: config, rootDir });
  }
  function drain() {
    if (closed || active || !queue.length) return;
    if (quarantineUntil > performance.now()) {
      clearTimeout(resumeTimer); resumeTimer = setTimeout(drain, quarantineUntil - performance.now()); resumeTimer.unref?.(); return;
    }
    const job = queue.shift(); active = job;
    try { if (!child) start(); }
    catch { child = null; ready = null; finish(job, failure('archive_reader_unavailable')); return; }
    const current = child;
    ready.then(() => {
      if (child !== current || active !== job || job.done) return;
      if (job.signal.aborted) { finish(job, job.signal.reason); return; }
      job.sent = true;
      try {
        current.send({ type: 'read', id: job.id, path: job.path,
          expiresAt: Date.now() + Math.max(0, job.deadline - performance.now()) }, error => { if (error) current.kill('SIGKILL'); });
      } catch { current.kill('SIGKILL'); }
    }).catch(error => { if (active === job) finish(job, error); });
  }
  function read(path, { signal, deadline }, receive) {
    signal.throwIfAborted();
    if (closed) return Promise.reject(failure('archive_reader_closed'));
    return new Promise((resolve, reject) => {
      const job = { id: String(++sequence), path, signal, deadline, receive, resolve, reject, done: false, settled: false };
      job.abort = () => {
        const reason = signal.reason || job.transportError || failure('archive_reader_cancelled');
        // The caller can return immediately; a dispatched owner stays active
        // until the child acknowledges SQL and pipe drain, or has exited.
        settle(job, reason);
        if (active !== job || !job.sent) { finish(job, reason); return; }
        const current = child;
        job.removeDrain?.(); job.removeDrain = null; job.paused = false;
        current?.stdio[4].resume();
        try { current?.send({ type: 'cancel', id: job.id }, () => {}); } catch { current?.kill('SIGKILL'); }
        if (!job.watchdog) {
          job.watchdog = setTimeout(() => { if (active === job) current?.kill('SIGKILL'); }, cancelGraceMs);
          job.watchdog.unref?.();
        }
        tryFinish(job);
      };
      signal.addEventListener('abort', job.abort, { once: true });
      queue.push(job); drain(); if (signal.aborted && !job.done) job.abort();
    });
  }
  return {
    read,
    close() {
      if (closing) return closing;
      closed = true; clearTimeout(resumeTimer);
      for (const job of [...queue]) finish(job, failure('archive_reader_closed'));
      const current = child;
      if (!current || !current.pid || current.exitCode !== null || current.signalCode) return closing = Promise.resolve();
      closing = new Promise(resolve => {
        const timer = setTimeout(() => current.kill('SIGKILL'), cancelGraceMs); timer.unref?.();
        current.once('exit', () => { clearTimeout(timer); resolve(); });
        try { current.send({ type: 'close' }, error => { if (error) current.kill('SIGKILL'); }); }
        catch { current.kill('SIGKILL'); }
      });
      return closing;
    },
  };
}

// Authentication/CORS remain in Core. Calendar discovery cannot hold up a
// foreground list/detail/Proof read (or vice versa). Both children stay lazy;
// their physical pools are one connection each, never four connections total.
export function createArchiveReadProcess({ poolConfig, rootDir, onResult = () => {},
  childPath = CHILD, timeoutMs, cancelGraceMs = 10_000 } = {}) {
  const config = { poolConfig, rootDir, childPath, cancelGraceMs };
  const calendar = createArchiveReadWorker(config), foreground = createArchiveReadWorker(config);
  const workerFor = url => url.pathname === '/api/archive/calendar' && url.searchParams.get('kind') === 'sessions'
    ? calendar : foreground;
  let closing;
  return {
    async route({ req, res, url }) {
      if (!isIsolatedArchiveRead(req.method, url)) return false;
      let owner;
      try {
        owner = requestReadOwner(req, res, { timeoutMs });
        await workerFor(url).read(url.pathname + url.search, owner.options, {
          headers(result) { onResult(res, result.status, result.error); res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': result.length }); },
          chunk: chunk => res.write(chunk), drain: resume => { res.once('drain', resume); return () => res.removeListener('drain', resume); },
        });
        if (!owner.disconnected && !res.destroyed) res.end();
      } catch (error) {
        if (!owner?.disconnected && !res.destroyed) {
          if (res.headersSent) res.destroy();
          else {
            const code = error?.message === 'archive_query_timeout' ? 'archive_query_timeout' : 'archive_reader_unavailable';
            const status = code === 'archive_query_timeout' ? 504 : 503;
            onResult(res, status, code); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: code }));
          }
        }
      } finally { owner?.dispose(); }
      return true;
    },
    async request(path, options = {}) {
      const budget = archiveReadBudget(options), chunks = [];
      try {
        // Invalid paths still reach the child and retain its existing error contract.
        let worker = foreground;
        try { worker = workerFor(new URL(path, 'http://archive-reader.invalid')); } catch {}
        const result = await worker.read(path, budget, { headers() {}, chunk: chunk => { chunks.push(chunk); return true; }, drain() {} });
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result.status >= 400 && body.error !== 'archive_run_not_found') throw Object.assign(new Error(body.error), { statusCode: result.status });
        return body;
      } finally { budget.dispose(); }
    },
    close() {
      return closing ||= Promise.all([calendar.close(), foreground.close()]).then(() => {});
    },
  };
}
