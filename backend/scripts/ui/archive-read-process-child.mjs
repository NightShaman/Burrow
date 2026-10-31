import { createWriteStream } from 'node:fs';
import { checkServerIdentity } from 'node:tls';
import { EventEmitter } from 'node:events';
import { createPostgresPool } from '../../src/postgres-foundation.mjs';
import { ARCHIVE_READ_TIMEOUT_MS } from '../../src/postgres-archive-read.mjs';
import { PostgresSessionStore } from '../../src/postgres-session-store.mjs';
import { PostgresAgentRegistryStore } from '../../src/postgres-agent-registry.mjs';
import { isChatMessage, summarizeSessionTurns } from '../../src/session-entry.mjs';
import { compactChatTurn } from '../../src/compact-chat-turn.mjs';
import { settingsKeyFromEnvironment } from '../../src/model-settings-store.mjs';
import { resolveRuntimeTracePath } from '../../src/config.mjs';
import { createArchiveAgentContext } from './archive-agent-context.mjs';
import { createArchiveService } from './archive-service.mjs';
import { createSessionRoutes } from './session-routes.mjs';
import { isIsolatedArchiveRead } from './archive-read-process.mjs';

let pool, route, active = null, closing = false;
const output = createWriteStream(null, { fd: 4, autoClose: false });
output.on('error', () => { void close(); });
const send = message => { if (process.connected) process.send(message, () => {}); };
async function close() {
  if (closing) return; closing = true;
  const watchdog = setTimeout(() => process.exit(1), 10_000); watchdog.unref();
  active?.controller.abort(new Error('archive_reader_closed'));
  active?.continue?.(); // no parent may remain to acknowledge headers
  output.destroy(); // unblock a stalled pipe write after parent disconnect
  await active?.settled;
  await pool?.end();
  clearTimeout(watchdog); output.destroy();
  if (process.connected) process.disconnect();
}
process.on('disconnect', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
process.on('message', async message => {
  if (message?.type === 'init' && !pool && !closing) {
    try {
      const config = { ...message.poolConfig, max: 2, statement_timeout: ARCHIVE_READ_TIMEOUT_MS,
        idle_in_transaction_session_timeout: ARCHIVE_READ_TIMEOUT_MS };
      // node-postgres merges URL parameters over config, and PostgreSQL startup
      // options can override individual startup GUCs. Make the bound the final
      // option as well as an explicit parameter, preserving e.g. search_path.
      const limitOptions = `-c statement_timeout=${ARCHIVE_READ_TIMEOUT_MS} -c idle_in_transaction_session_timeout=${ARCHIVE_READ_TIMEOUT_MS}`;
      if (config.connectionString && !config.connectionString.startsWith('/')) {
        const url = new URL(config.connectionString);
        const options = url.searchParams.getAll('options').at(-1) || config.options || '';
        url.searchParams.set('options', `${options} ${limitOptions}`.trim());
        url.searchParams.set('statement_timeout', String(ARCHIVE_READ_TIMEOUT_MS));
        url.searchParams.set('idle_in_transaction_session_timeout', String(ARCHIVE_READ_TIMEOUT_MS));
        config.connectionString = url.href;
      } else config.options = `${config.options || ''} ${limitOptions}`.trim();
      if (config.ssl && typeof config.ssl === 'object' && config.ssl.rejectUnauthorized !== false) {
        const hostname = config.connectionString ? new URL(config.connectionString).hostname.replace(/^\[|\]$/g, '') : config.host;
        config.ssl.checkServerIdentity = (_name, cert) => checkServerIdentity(hostname, cert);
      }
      pool = createPostgresPool({ config, onIdleError: () => {} });
      const conversations = new PostgresSessionStore({ pool });
      const agents = new PostgresAgentRegistryStore({ pool, bootstrapSampleIdentities: false });
      const context = createArchiveAgentContext({ agentsStore: () => agents, rootDir: message.rootDir });
      const service = createArchiveService({ stores: () => ({ conversations }), ...context,
        runtimeTraceRoot: (runtime, sessionId, agentId) => resolveRuntimeTracePath({ ...runtime.runtimeState, sessionId, agentId }),
        settingsKeyFromEnvironment, isChatMessage, compactChatTurn, summarizeSessionTurns,
        boundedInteger: (n, { fallback = 100, min = 1, max = 500 } = {}) => Number.isFinite(Number(n)) ? Math.max(min, Math.min(max, Math.floor(Number(n)))) : fallback,
      });
      route = createSessionRoutes({ ...service, conversationStore: conversations,
        resolveArchiveAgentRuntime: context.resolveAgentRuntime,
        sendJson(res, status, body) { res.result = { status, error: body?.ok === false ? body.error : null, json: JSON.stringify(body, null, 2) }; res.writableFinished = true; },
      });
      send({ type: 'ready' });
    } catch { send({ type: 'init_error' }); void close(); }
    return;
  }
  if (message?.type === 'continue' && active?.id === message.id) { active.continue?.(); return; }
  if (message?.type === 'cancel' && active?.id === message.id) { active.controller.abort(new Error('archive_request_cancelled')); return; }
  if (message?.type === 'close') { void close(); return; }
  if (message?.type !== 'read' || closing || active || !route) return;
  const controller = new AbortController();
  const req = Object.assign(new EventEmitter(), { method: 'GET', signal: controller.signal });
  const res = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false });
  const job = active = { id: message.id, controller };
  job.settled = (async () => {
    try {
      const remaining = Math.max(0, message.expiresAt - Date.now());
      const url = new URL(message.path, 'http://archive-reader.invalid');
      if (!isIsolatedArchiveRead('GET', url)) throw new Error('archive_read_invalid');
      const timer = setTimeout(() => controller.abort(new Error('archive_query_timeout')), remaining); timer.unref?.();
      try { await route({ req, res, url }); }
      finally { clearTimeout(timer); }
      if (!res.result) throw new Error('archive_read_invalid');
    } catch (error) {
      const status = error?.message === 'archive_query_timeout' ? 504
        : error?.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
      res.result = { status, error: String(error?.message || 'archive_read_failed'),
        json: JSON.stringify({ ok: false, error: String(error?.message || 'archive_read_failed') }) };
    } finally {
      try {
        if (closing) return;
        const result = res.result || { status: 500, error: 'archive_read_failed', json: '{"ok":false,"error":"archive_read_failed"}' };
        const bytes = Buffer.from(result.json);
        const continued = new Promise(resolve => { job.continue = resolve; });
        send({ type: 'headers', id: job.id, result: { status: result.status, error: result.error, length: bytes.length } });
        await continued;
        if (closing) return;
        for (let start = 0; start < bytes.length; start += 64 * 1024) {
          await new Promise((resolve, reject) => output.write(bytes.subarray(start, start + 64 * 1024), error => error ? reject(error) : resolve()));
        }
        send({ type: 'complete', id: job.id });
      } catch { process.exitCode = 1; void close(); }
      if (active === job) active = null;
    }
  })();
});
