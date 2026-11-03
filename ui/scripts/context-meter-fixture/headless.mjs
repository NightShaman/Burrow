// Owned fixture only: temporary profile/server, CDP over pipe, no live app.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const profile = await mkdtemp(join(homedir(), 'ui-owned-chromium-'));
const server = spawn('python3', ['scripts/context-meter-fixture/serve.py']);
let browser;
try {
  const line = await new Promise((resolve, reject) => {
    server.stdout.once('data', (d) => resolve(String(d)));
    server.once('error', reject);
  });
  const port = /PORT=(\d+)/.exec(line)[1];
  browser = spawn(
    'chromium',
    [
      '--headless',
      '--no-sandbox',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      '--no-proxy-server',
      '--no-first-run',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const exceptions = [],
    network = [],
    responses = [];
  let id = 0,
    buffer = '';
  const pending = new Map();
  browser.stdio[4].on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\0')) >= 0) {
      const text = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!text) continue;
      const m = JSON.parse(text);
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params);
      if (m.method === 'Network.requestWillBeSent') network.push(m.params.request.url);
      if (m.method === 'Network.responseReceived')
        responses.push({ url: m.params.response.url, headers: m.params.response.headers });
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    }
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`CDP timeout ${method}`));
      }, 10000);
      pending.set(key, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      browser.stdio[3].write(
        JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0',
      );
    });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const c = (method, params) => call(method, params, sessionId);
  await c('Page.enable');
  await c('Runtime.enable');
  await c('Network.enable');
  await c('Page.navigate', { url: `http://127.0.0.1:${port}` });
  const evaluate = async (expression) => {
    const r = await c('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const wait = async (expression, label, timeout = 3000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await sleep(25);
    }
    throw new Error(`Timeout: ${label}; body=${await evaluate('document.body.innerText')}`);
  };
  const out = new URL('./evidence/', import.meta.url).pathname;
  await mkdir(out, { recursive: true });
  const screenshot = async (name) => {
    const { data } = await c('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(join(out, name + '.png'), Buffer.from(data, 'base64'));
  };
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await wait("!!document.querySelector('.context-usage')", 'fixture ready');
  await screenshot(process.argv[2] || 'after-1920');
  const evidence = await evaluate(
    `({title:document.querySelector('.context-usage').title,rect:document.querySelector('.context-usage').getBoundingClientRect().toJSON(),overflow:document.documentElement.scrollWidth>innerWidth})`,
  );
  await writeFile(
    join(out, (process.argv[2] || 'after-1920') + '.json'),
    JSON.stringify({ evidence, exceptions }, null, 2),
  );
  console.log(JSON.stringify({ evidence, exceptions }));
} finally {
  browser?.kill();
  server.kill();
  await new Promise((r) => setTimeout(r, 200));
  await rm(profile, { recursive: true, force: true });
}
