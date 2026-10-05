const assert = require('node:assert/strict');
for (const key of Object.keys(process.env)) assert(!/DATABASE|^PG|TOKEN|SECRET|PASSWORD/i.test(key));
for (const fn of [() => require('node:net').connect(1), () => require('node:http').get('http://127.0.0.1'), () => require('node:https').get('https://example.invalid'), () => fetch('https://example.invalid')]) assert.throws(fn, /real network denied/);
require('node:fs').writeFileSync(require('node:path').join(process.env.HOME, 'owned-sentinel'), 'fixture');
console.log('PASS: inherited sensitive env absent; socket/http/https/fetch denied; isolated home writable');
