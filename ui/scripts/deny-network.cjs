'use strict';
const deny = () => { throw new Error('UI test isolation: real network denied'); };
for (const name of ['net', 'tls', 'http', 'https', 'dgram']) {
  const mod = require('node:' + name);
  for (const key of ['connect', 'createConnection', 'request', 'get', 'createSocket', 'createServer']) if (key in mod) mod[key] = deny;
}
require('node:net').Socket.prototype.connect = deny;
globalThis.fetch = deny;
require('node:module').syncBuiltinESMExports();
