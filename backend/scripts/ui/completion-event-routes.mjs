import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_WEBHOOK_BYTES = 256 * 1024;
const CONCLUSIONS = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40,64}$/i;
const RUN_ID = /^[1-9][0-9]*$/;
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parts = ISO_TIME.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second, , zoneHour, zoneMinute] = parts;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days &&
    Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60 &&
    (zoneHour === undefined || (Number(zoneHour) <= 23 && Number(zoneMinute) < 60)) &&
    Number.isFinite(Date.parse(value));
}

function invalid() { throw new Error('completion_event_invalid_input'); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function runId(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) invalid();
  if (typeof value !== 'number' && typeof value !== 'string') invalid();
  const id = String(value);
  if (!RUN_ID.test(id) || id.length > 128) invalid();
  return id;
}
function completionFromPayload(payload) {
  const repository = payload.repository?.full_name;
  const run = payload.workflow_run;
  if (!object(payload.repository) || !object(run) || typeof repository !== 'string' || repository.length > 255 || !REPOSITORY.test(repository)) invalid();
  const id = runId(run.id);
  if (run.repository !== undefined && (!object(run.repository) || run.repository.full_name !== repository)) invalid();
  if (payload.workflow !== undefined && (!object(payload.workflow) || payload.workflow.name !== run.name)) invalid();
  if (run.status !== 'completed' || typeof run.name !== 'string' || !run.name.trim() || run.name !== run.name.trim() || run.name.length > 255 ||
    !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || run.run_attempt > 2147483647 ||
    typeof run.head_sha !== 'string' || !SHA.test(run.head_sha) || !CONCLUSIONS.has(run.conclusion) ||
    run.html_url !== `https://github.com/${repository}/actions/runs/${id}` ||
    !validTimestamp(run.updated_at)) invalid();
  return { repository, workflow: run.name, runId: id, runAttempt: run.run_attempt, headSha: run.head_sha,
    conclusion: run.conclusion, url: run.html_url, completedAt: new Date(run.updated_at).toISOString() };
}
function signatureValid(header, secret, raw) {
  if (typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const received = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(received, expected);
}
async function readRaw(req) {
  const length = req.headers?.['content-length'];
  if (length !== undefined && Number(length) > MAX_WEBHOOK_BYTES) throw Object.assign(new Error('completion_event_too_large'), { statusCode: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_WEBHOOK_BYTES) throw Object.assign(new Error('completion_event_too_large'), { statusCode: 413 });
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
function errorResponse(error) {
  if (error?.message === 'completion_event_secret_unavailable') return [503, 'completion_event_webhook_unavailable'];
  if (error?.statusCode === 413 || error?.message === 'completion_event_too_large') return [413, 'completion_event_too_large'];
  if (error?.message === 'completion_event_conflict') return [409, 'completion_event_conflict'];
  if (error?.message === 'agent_disabled') return [409, 'agent_disabled'];
  if (error?.message === 'agent_not_found') return [404, 'agent_not_found'];
  if (error?.message === 'invalid_json') return [400, 'invalid_json'];
  if (/^completion_event_invalid_[A-Za-z]+$/.test(error?.message ?? '')) return [400, error.message];
  return [500, 'completion_event_internal_error'];
}
function watchBody(value) {
  if (!object(value)) invalid();
  const { id, repository, workflow, agentId, sessionId = 'ci-releases', instruction, enabled = true } = value;
  if (id !== undefined && (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) invalid();
  if (typeof repository !== 'string' || repository.length > 255 || !REPOSITORY.test(repository) ||
    typeof workflow !== 'string' || !workflow.trim() || workflow !== workflow.trim() || workflow.length > 255 ||
    typeof agentId !== 'string' || !agentId.trim() || agentId !== agentId.trim() || agentId.length > 255 ||
    typeof sessionId !== 'string' || !sessionId.trim() || sessionId !== sessionId.trim() || sessionId.length > 255 ||
    typeof instruction !== 'string' || !instruction.trim() || instruction !== instruction.trim() || instruction.length > 20000 ||
    typeof enabled !== 'boolean') invalid();
  return { ...(id === undefined ? {} : { id }), repository, workflow, agentId, sessionId, instruction, enabled };
}

// The parent must call handle({ webhookOnly: true }) before UI authorization, and
// handle() without that flag only after UI authorization. No other route bypasses it.
export function createCompletionEventRoutes({ store, readJsonBody, sendJson, resolveAgentRuntime, wake, getWebhookSecret, receiverSettings } = {}) {
  return async function handle({ req, res, url, webhookOnly = false } = {}) {
    const path = url.pathname;
    const webhook = req.method === 'POST' && path === '/api/events/github';
    if (webhookOnly && !webhook) return false;
    if (!webhookOnly && webhook) return false;
    if (!webhook && !(path === '/api/events/settings' && ['GET', 'POST'].includes(req.method)) && !(path === '/api/events/watches' && ['GET', 'POST'].includes(req.method)) &&
      !(req.method === 'DELETE' && /^\/api\/events\/watches\/[^/]+$/.test(path)) &&
      !(req.method === 'GET' && path === '/api/events')) return false;
    try {
      if (webhook) {
        const secret = await getWebhookSecret();
        if (typeof secret !== 'string' || !secret) { sendJson(res, 503, { ok: false, error: 'completion_event_webhook_unavailable' }); return true; }
        const raw = await readRaw(req);
        if (!signatureValid(req.headers?.['x-hub-signature-256'], secret, raw)) { sendJson(res, 401, { ok: false, error: 'completion_event_unauthorized' }); return true; }
        let payload;
        try { payload = JSON.parse(raw.toString('utf8')); } catch { invalid(); }
        if (!object(payload)) invalid();
        if (req.headers?.['x-github-event'] === 'ping') { sendJson(res, 200, { ok: true }); return true; }
        if (req.headers?.['x-github-event'] !== 'workflow_run' || payload.action !== 'completed') { sendJson(res, 202, { ok: true, events: [], accepted: 0, duplicates: 0 }); return true; }
        const events = await store.accept(completionFromPayload(payload));
        const accepted = events.filter(row => row.accepted === true).length;
        if (accepted) {
          // Acceptance is durable before waking; never wait for model execution.
          try { Promise.resolve(wake()).catch(() => {}); } catch { /* polling can still claim durable events */ }
        }
        sendJson(res, 202, { ok: true, events: events.map(({ id, accepted }) => ({ id, accepted })), accepted, duplicates: events.length - accepted });
        return true;
      }
      if (path === '/api/events/settings') {
        const settings = req.method === 'POST' ? await receiverSettings.save(await readJsonBody(req)) : await receiverSettings.read();
        sendJson(res, 200, { ok: true, settings });
        return true;
      }
      if (path === '/api/events/watches') {
        if (req.method === 'GET') sendJson(res, 200, { ok: true, watches: await store.listWatches() });
        else {
          const watch = watchBody(await readJsonBody(req));
          const runtime = await resolveAgentRuntime(watch.agentId);
          if (!runtime) throw new Error('agent_not_found');
          if (runtime.enabled === false || runtime.agent?.enabled === false) throw new Error('agent_disabled');
          sendJson(res, 200, { ok: true, watch: await store.saveWatch(watch) });
        }
        return true;
      }
      if (req.method === 'DELETE') {
        const id = path.slice('/api/events/watches/'.length);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) invalid();
        const deleted = await store.deleteWatch(id);
        sendJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { ok: false, error: 'completion_event_watch_not_found' });
        return true;
      }
      const agentId = url.searchParams.get('agentId') ?? undefined;
      const rawLimit = url.searchParams.get('limit');
      if (agentId !== undefined && (!agentId.trim() || agentId.length > 255 || agentId !== agentId.trim())) invalid();
      if (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) invalid();
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit > 500) invalid();
      sendJson(res, 200, { ok: true, events: await store.list({ agentId, limit }) });
      return true;
    } catch (error) {
      const [status, code] = errorResponse(error);
      sendJson(res, status, { ok: false, error: code });
      return true;
    }
  };
}
