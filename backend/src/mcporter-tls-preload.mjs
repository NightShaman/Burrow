// Loaded ONLY in the subprocess for one explicitly opted-out HTTPS MCP.
// Redirects dispatch through the origin check again; never relax process TLS
// defaults or agents used by Burrow or by a different MCP connection.
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { urlToHttpOptions } from 'node:url';
import { Agent } from 'undici';

const configured = process.env.BURROW_MCP_TLS_ORIGIN;
const origin = configured ? new URL(configured).origin : null;
if (origin && new URL(origin).protocol === 'https:') {
  const verified = new Agent();
  const unverified = new Agent({ connect: { rejectUnauthorized: false } });
  // A dispatcher, rather than a URL check around fetch(), checks each hop of
  // an automatic redirect as well as OAuth/metadata requests made by mcporter.
  const dispatcher = {
    dispatch(options, handler) {
      return (new URL(String(options.origin)).origin === origin ? unverified : verified).dispatch(options, handler);
    },
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, init) => fetch(input, { ...init, dispatcher });

  // mcporter's SSE fallback uses its node-http1 fetch implementation, not
  // global fetch. Preserve all https.request overloads and callbacks.
  const request = https.request;
  const agent = new https.Agent({ rejectUnauthorized: false });
  https.request = function(input, options, callback) {
    const isUrl = typeof input === 'string' || input instanceof URL;
    const opts = isUrl ? { ...urlToHttpOptions(new URL(input)), ...(typeof options === 'object' ? options : {}) } : { ...input };
    const cb = typeof options === 'function' ? options : callback;
    const host = opts.hostname || opts.host || 'localhost';
    const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const target = new URL(`${opts.protocol || 'https:'}//${authority}${opts.port ? `:${opts.port}` : ''}`);
    if (target.origin === origin) {
      opts.rejectUnauthorized = false;
      opts.agent = agent;
    }
    return request.call(this, opts, cb);
  };
  https.get = function(...args) { const req = https.request(...args); req.end(); return req; };
  syncBuiltinESMExports();
}
