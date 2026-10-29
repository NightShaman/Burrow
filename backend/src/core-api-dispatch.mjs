import { constants as bufferConstants, isUtf8 } from 'node:buffer';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { Readable, Writable } from 'node:stream';

// This identity map is deliberately not a request property, Symbol, or header.
// Only Core should import the factory; the child capability receives request(),
// never handleRequest, the factory, or the synthetic request object.
const callers = new WeakMap();
const BASE = 'http://core-api.invalid';
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const INPUT_KEYS = new Set(['method', 'path', 'headers', 'body', 'bodyText', 'bodyBase64']);
const DEFAULT_MAX_RESPONSE_BYTES = 96 * 1024 * 1024;

export function coreApiCaller(req) {
  return req && (typeof req === 'object' || typeof req === 'function') ? callers.get(req) || null : null;
}

function error(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}
function plain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function abortReason(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  return Object.assign(error('ABORT_ERR', { cause: signal.reason }), { name: 'AbortError' });
}
function target(path) {
  if (typeof path !== 'string' || !/^\/api(?:\/|\?|$)/.test(path) ||
      /[\x00-\x20\x7f-\x9f#\\]/.test(path) || /%(?![\da-f]{2})/i.test(path)) {
    throw error('core_api_invalid_path');
  }
  let url;
  try {
    // Namespace validation applies to the pathname, never decoded query data.
    if (/[\x00-\x1f\x7f-\x9f\\]/.test(decodeURIComponent(path.split('?', 1)[0]))) throw new Error();
    url = new URL(path, BASE);
    // Encoded separators must not hide an escape that becomes visible when a
    // route decodes its parameters. Literal encoded ?/# remain parameter data.
    const decoded = decodeURIComponent(url.pathname);
    const decodedUrl = new URL(decoded.replace(/[?#]/g, encodeURIComponent), BASE);
    for (const candidate of [url, decodedUrl]) {
      if (candidate.origin !== BASE || !(candidate.pathname === '/api' || candidate.pathname.startsWith('/api/'))) {
        throw new Error();
      }
    }
  } catch {
    throw error('core_api_invalid_path');
  }
  return { url: url.pathname + url.search, route: url.pathname };
}
function requestHeaders(value = {}) {
  if (!plain(value)) throw error('core_api_invalid_headers');
  const headers = Object.create(null);
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== 'string' && !(Array.isArray(item) && item.every(part => typeof part === 'string'))) {
      throw error('core_api_invalid_headers');
    }
    // Native validation retains its useful ERR_INVALID_HTTP_TOKEN /
    // ERR_INVALID_CHAR codes. Do not filter custom or authentication headers.
    validateHeaderName(name);
    for (const part of Array.isArray(item) ? item : [item]) validateHeaderValue(name, part);
    const key = name.toLowerCase();
    const copy = Array.isArray(item) ? [...item] : item;
    headers[key] = Object.hasOwn(headers, key) ? [].concat(headers[key], copy) : copy;
  }
  return headers;
}
function assertJson(value) {
  // Validate instead of silently dropping undefined/functions or turning NaN
  // into null. Repeated references are fine; cycles and non-JSON objects are not.
  const ancestors = new Set();
  const stack = [{ value }];
  while (stack.length) {
    const entry = stack.pop();
    if (entry.exit) { ancestors.delete(entry.value); continue; }
    const item = entry.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item))) continue;
    if ((!Array.isArray(item) && !plain(item)) || ancestors.has(item)) throw error('core_api_invalid_body');
    ancestors.add(item);
    stack.push({ value: item, exit: true });
    const values = Array.isArray(item) ? Array.from(item) : Object.values(item);
    for (const child of values) stack.push({ value: child });
  }
}
function jsonText(value) {
  assertJson(value);
  try { return JSON.stringify(value); }
  catch (cause) { throw error('core_api_invalid_body', { cause }); }
}
function requestBody(input, headers) {
  const keys = ['body', 'bodyText', 'bodyBase64'].filter(key => Object.hasOwn(input, key));
  if (keys.length > 1) throw error('core_api_conflicting_bodies');
  if (!keys.length) return Buffer.alloc(0);
  let bytes;
  if (keys[0] === 'body') {
    bytes = Buffer.from(jsonText(input.body));
    headers['content-type'] ??= 'application/json; charset=utf-8';
  } else if (keys[0] === 'bodyText') {
    if (typeof input.bodyText !== 'string') throw error('core_api_invalid_body');
    bytes = Buffer.from(input.bodyText);
  } else {
    const value = input.bodyBase64;
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1 ||
        (value.includes('=') && value.length % 4 !== 0)) throw error('core_api_invalid_body');
    bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) throw error('core_api_invalid_body');
  }
  headers['content-length'] ??= String(bytes.length);
  return bytes;
}
function callerBrand(caller, ownerModId) {
  if (ownerModId !== undefined && (typeof ownerModId !== 'string' || !ownerModId)) throw error('core_api_invalid_caller');
  if (caller === undefined || caller === null) return null;
  if (!plain(caller) || typeof caller.agentId !== 'string' || !caller.agentId) throw error('core_api_invalid_caller');
  const snapshot = {};
  for (const key of ['agentId', 'sessionId', 'conversationId', 'runId']) {
    const value = caller[key] ?? null;
    if (value !== null && typeof value !== 'string') throw error('core_api_invalid_caller');
    snapshot[key] = value;
  }
  if (!snapshot.agentId) throw error('core_api_invalid_caller');
  return Object.freeze({ caller: Object.freeze(snapshot), ownerModId: ownerModId ?? null });
}

class ApiRequest extends Readable {
  constructor({ method, url, headers, body }) {
    // Body EOF is not a disconnect. In particular it must not mark chat runs as
    // detached immediately after readJsonBody has consumed their input.
    super({ autoDestroy: false });
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.rawHeaders = Object.entries(headers).flatMap(([name, value]) => [].concat(value).flatMap(part => [name, part]));
    this.httpVersion = '1.1';
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.trailers = Object.create(null);
    this.rawTrailers = [];
    // No loopback, TLS, proxy, or Host authority is impersonated. Authorization
    // of the in-process caller must use coreApiCaller(), not socket metadata.
    this.socket = this.connection = Object.freeze({ remoteAddress: '', encrypted: false });
    this.complete = true; // All request bytes have already arrived in-process.
    this.aborted = false;
    this.bodyBytes = body;
    this.normalClose = false;
  }
  _read() {
    if (this.bodyBytes === null) return;
    const bytes = this.bodyBytes;
    this.bodyBytes = null;
    if (bytes.length) this.push(bytes);
    this.push(null);
  }
  abort(reason) {
    if (!this.aborted) {
      this.aborted = true;
      this.abortReason = reason;
      this.emit('aborted');
    }
    this.destroy(reason);
  }
  closeFromResponse() {
    this.normalClose = true;
    this.destroy();
  }
  _destroy(reason, callback) {
    this.bodyBytes = null;
    if (!this.normalClose && !this.aborted) {
      this.aborted = true;
      this.abortReason = reason || error('core_api_request_closed');
      this.emit('aborted');
    }
    callback(reason);
  }
}

class ApiResponse extends Writable {
  constructor(method, maxBytes, onChunk) {
    super({ autoDestroy: true });
    this.method = method;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this.headerValues = Object.create(null);
    this.headersSent = false;
    this.sentStatusCode = null;
    this.sentHeaders = null;
    this.maxBytes = maxBytes;
    this.admittedBytes = 0;
    this.onChunk = onChunk;
    this.chunks = [];
    this.byteLength = 0;
  }
  get finished() { return this.writableEnded; }
  admit(chunk, encoding) {
    this.flushHeaders();
    if (!this.hasBody()) return Buffer.alloc(0);
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding || 'utf8') :
      Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk.byteLength : null;
    if (size === null) throw error('ERR_INVALID_ARG_TYPE');
    if (this.admittedBytes + size > this.maxBytes) throw error('core_api_response_too_large', { limit: this.maxBytes });
    this.admittedBytes += size;
    return Buffer.from(chunk, typeof chunk === 'string' ? encoding || 'utf8' : undefined);
  }
  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    // Bound the queue even when an observer is slow or a handler ignores
    // Writable backpressure. A mere _write-time check leaves that queue unbound.
    if (this.writableEnded || this.destroyed) return super.write(chunk, encoding, callback);
    try { return super.write(this.admit(chunk, encoding), callback); }
    catch (cause) {
      this.destroy(cause);
      if (callback) queueMicrotask(() => callback(cause));
      return false;
    }
  }
  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; encoding = undefined; }
    else if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (chunk == null || this.writableEnded || this.destroyed) return super.end(chunk, encoding, callback);
    try { return super.end(this.admit(chunk, encoding), callback); }
    catch (cause) {
      this.destroy(cause);
      if (callback) queueMicrotask(() => callback(cause));
      return this;
    }
  }
  setHeader(name, value) {
    if (this.headersSent) throw error('ERR_HTTP_HEADERS_SENT');
    validateHeaderName(name);
    for (const part of Array.isArray(value) ? value : [value]) validateHeaderValue(name, part);
    // Capture scalars, not mutable objects with a later-changing toString().
    this.headerValues[name.toLowerCase()] = Array.isArray(value) ? value.map(part => typeof part === 'number' ? part : String(part)) :
      typeof value === 'number' ? value : String(value);
    return this;
  }
  getHeader(name) { return this.headerValues[String(name).toLowerCase()]; }
  getHeaders() { return Object.assign(Object.create(null), this.headerValues); }
  getHeaderNames() { return Object.keys(this.headerValues); }
  hasHeader(name) { return Object.hasOwn(this.headerValues, String(name).toLowerCase()); }
  removeHeader(name) {
    if (this.headersSent) throw error('ERR_HTTP_HEADERS_SENT');
    delete this.headerValues[String(name).toLowerCase()];
  }
  writeHead(statusCode, statusMessage, headers) {
    if (this.headersSent) throw error('ERR_HTTP_HEADERS_SENT');
    const status = Number(statusCode);
    if (!Number.isInteger(status) || status < 100 || status > 999) throw error('ERR_HTTP_INVALID_STATUS_CODE');
    this.statusCode = status;
    if (typeof statusMessage === 'string') this.statusMessage = statusMessage;
    else headers ??= statusMessage;
    if (Array.isArray(headers)) {
      if (headers.length % 2) throw error('ERR_INVALID_ARG_VALUE');
      const seen = new Set();
      for (let i = 0; i < headers.length; i += 2) {
        const name = headers[i];
        const key = String(name).toLowerCase();
        const value = seen.has(key) ? [].concat(this.getHeader(key), headers[i + 1]) : headers[i + 1];
        this.setHeader(name, value);
        seen.add(key);
      }
    } else if (headers !== undefined && headers !== null) {
      if (!plain(headers)) throw error('ERR_INVALID_ARG_TYPE');
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    }
    this.flushHeaders();
    return this;
  }
  flushHeaders() {
    if (this.headersSent) return;
    if (!Number.isInteger(this.statusCode) || this.statusCode < 100 || this.statusCode > 999) throw error('ERR_HTTP_INVALID_STATUS_CODE');
    this.sentStatusCode = this.statusCode;
    this.sentHeaders = Object.fromEntries(Object.entries(this.headerValues).map(([name, value]) =>
      [name, Array.isArray(value) ? [...value] : value]));
    this.headersSent = true;
  }
  hasBody() { return this.method !== 'HEAD' && this.sentStatusCode >= 200 && ![204, 304].includes(this.sentStatusCode); }
  _write(chunk, encoding, callback) {
    try {
      this.flushHeaders();
      if (!this.hasBody()) { callback(); return; }
      const bytes = chunk; // admit() already took an owned snapshot.
      if (this.byteLength + bytes.length > this.maxBytes) {
        callback(error('core_api_response_too_large', { limit: this.maxBytes }));
        return;
      }
      this.chunks.push(bytes);
      this.byteLength += bytes.length;
      // Copy for the observer: mutating a delivered chunk cannot corrupt the
      // aggregate. Awaiting an observer provides normal Writable backpressure.
      if (this.onChunk) {
        Promise.resolve(this.onChunk(Buffer.from(bytes))).then(() => callback(), callback);
      } else callback();
    } catch (cause) { callback(cause); }
  }
  _final(callback) {
    try { this.flushHeaders(); callback(); }
    catch (cause) { callback(cause); }
  }
  discard() { this.chunks.length = 0; this.onChunk = null; }
  takeBody() {
    const bytes = Buffer.concat(this.chunks, this.byteLength);
    this.discard();
    return bytes;
  }
}

function responseResult(res) {
  const bytes = res.takeBody();
  const headers = Object.fromEntries(Object.entries(res.sentHeaders).map(([name, value]) =>
    [name, Array.isArray(value) ? value.map(String) : String(value)]));
  const type = String(headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  const json = /^(?:application|text)\/(?:[^/]+\+)?json$/.test(type);
  const text = !type || json || type.startsWith('text/') || /\+(?:xml)$/.test(type) ||
    /^(?:application\/(?:x-ndjson|ndjson|(?:x-)?javascript|xml|x-www-form-urlencoded|graphql|(?:x-)?yaml))$/.test(type);
  let body = null;
  let encoding = 'utf8';
  if (bytes.length) {
    if (text && isUtf8(bytes) && (type || !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(bytes.toString('utf8')))) {
      body = bytes.toString('utf8');
      if (json) {
        try {
          const parsed = JSON.parse(body);
          assertJson(parsed); // JSON.parse('1e999') is Infinity, not JSON-safe.
          body = parsed;
          encoding = 'json';
        } catch { /* Invalid/unsafe JSON stays the complete original UTF-8 text. */ }
      }
    } else { body = bytes.toString('base64'); encoding = 'base64'; }
  }
  return { ok: res.sentStatusCode >= 200 && res.sentStatusCode < 400, status: res.sentStatusCode, headers, body, encoding, byteLength: bytes.length };
}

/**
 * Call the very same Core handleRequest(req, res) closure used by HTTP, without
 * fetch, a listener, network traffic, authentication headers, or route copies.
 *
 * request(input, { caller, ownerModId, signal, assertCallerActive, onChunk })
 * always returns a complete JSON-safe aggregate. onChunk(Buffer) is an optional
 * Core-side incremental observer (async observers provide backpressure); it does
 * not turn the child/tool result into a stream. No command or duration policy is
 * imposed. maxResponseBytes defaults to a 96 MiB technical allocation ceiling;
 * exceeding it rejects with core_api_response_too_large, never truncated success.
 *
 * trackRequest(operation, phase) has the background lifecycle's callback shape.
 * The tracked operation waits for BOTH handler settlement and response finish;
 * cancellation rejects the caller promptly but does not untrack/reexecute work
 * or cancel an underlying detached run on the handler's behalf.
 *
 * coreApiCaller(req) returns frozen { caller: { agentId, sessionId,
 * conversationId, runId }, ownerModId } for a caller supplied by Core, else null.
 * assertCallerActive is a synchronous, throwing admission assertion, checked at
 * entry and again immediately before invoking the handler, after tracker delay.
 *
 * Optional onComplete receives only { method, route (no query), status, actor }.
 * It runs after tracked work settles; observer failures cannot change dispatch.
 */
export function createCoreApiDispatcher({ handleRequest, trackRequest, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, onComplete } = {}) {
  if (typeof handleRequest !== 'function') throw error('core_api_handler_required');
  if (trackRequest !== undefined && typeof trackRequest !== 'function') throw error('core_api_invalid_tracker');
  if (onComplete !== undefined && typeof onComplete !== 'function') throw error('core_api_invalid_completion_observer');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > bufferConstants.MAX_LENGTH) {
    throw error('core_api_invalid_response_budget');
  }

  async function request(input, options = {}) {
    if (!plain(input) || Object.keys(input).some(key => !INPUT_KEYS.has(key))) throw error('core_api_invalid_input');
    if (!plain(options)) throw error('core_api_invalid_options');
    const { caller, ownerModId, signal, assertCallerActive, onChunk } = options;
    if ((assertCallerActive !== undefined && typeof assertCallerActive !== 'function') ||
        (onChunk !== undefined && typeof onChunk !== 'function') ||
        (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
          typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) {
      throw error('core_api_invalid_options');
    }
    const assertActive = () => {
      if (signal?.aborted) throw abortReason(signal);
      if (assertCallerActive?.() === false) throw error('core_api_caller_inactive');
    };
    assertActive();
    const method = input.method === undefined ? 'GET' : input.method;
    if (typeof method !== 'string' || !TOKEN.test(method)) throw error('core_api_invalid_method');
    const destination = target(input.path);
    const headers = requestHeaders(input.headers);
    const body = requestBody(input, headers);
    const brand = callerBrand(caller, ownerModId);
    const req = new ApiRequest({ method: method.toUpperCase(), url: destination.url, headers, body });
    const res = new ApiResponse(req.method, maxResponseBytes, onChunk);
    if (brand) callers.set(req, brand);

    let resolveCaller, rejectCaller, resolveResponse, rejectResponse;
    const result = new Promise((resolve, reject) => { resolveCaller = resolve; rejectCaller = reject; });
    const responseDone = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    // It can reject while the actual handler remains detached and running.
    void responseDone.catch(() => {});
    let settled = false;
    let failed = false;
    let failure;
    let completed = false;
    let work;
    const onAbort = () => fail(abortReason(signal));
    const settle = (cause, value, rejected = false) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      res.onChunk = null;
      if (rejected) rejectCaller(cause);
      else resolveCaller(value);
    };
    function fail(cause) {
      if (failed) return;
      failed = true;
      failure = cause;
      settle(cause, undefined, true);
      rejectResponse(cause);
      res.discard();
      req.abort(cause);
      res.destroy(cause);
    }
    const complete = () => {
      if (completed) return;
      completed = true;
      if (!onComplete) return;
      const metadata = Object.freeze({ method: req.method, route: destination.route,
        status: res.sentStatusCode, actor: brand });
      try { Promise.resolve(onComplete(metadata)).catch(() => {}); }
      catch { /* Logging must not change an API result or mask its real error. */ }
    };
    res.once('finish', resolveResponse);
    res.on('error', fail);
    res.once('close', () => {
      if (!res.writableFinished) fail(error('core_api_response_closed'));
      else req.closeFromResponse();
    });
    req.on('error', fail);
    req.once('aborted', () => fail(req.abortReason || error('core_api_request_aborted')));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const dispatch = () => {
      // A tracker must not accidentally dispatch a mutating request twice.
      if (!work) {
        work = (async () => {
          try {
            if (failed) throw failure;
            assertActive();
            await handleRequest(req, res);
            await responseDone;
            if (failed) throw failure;
            const value = responseResult(res);
            settle(null, value);
            return value;
          } catch (cause) { fail(cause); throw cause; }
          finally { complete(); }
        })();
        void work.catch(() => {});
      }
      return work;
    };
    try {
      const tracked = trackRequest ? trackRequest(dispatch, 'core_api') : dispatch();
      void Promise.resolve(tracked).catch(cause => { fail(cause); if (!work) complete(); });
    } catch (cause) { fail(cause); if (!work) complete(); }
    return result;
  }
  return Object.freeze({ request });
}
