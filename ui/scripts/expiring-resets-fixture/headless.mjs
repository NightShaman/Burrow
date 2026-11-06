// Owned fixture only: temporary profile/server, CDP over pipe, no live app.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const profile = await mkdtemp(join(homedir(), 'ui-owned-chromium-'));
const server = spawn('python3', ['scripts/expiring-resets-fixture/serve.py']);
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
      '--no-first-run',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const exceptions = [],
    network = [];
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
  await c('Page.navigate', { url: `http://127.0.0.1:${port}/bundle/` });
  const evaluate = async (expression) => {
    const r = await c('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  for (let i = 0; i < 50; i++) {
    if (await evaluate("!!document.querySelector('.models-workspace')")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const click = async (text) => {
    await evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('missing button '+${JSON.stringify(text)});b.click()})()`,
    );
    await sleep(80);
  };
  const out = 'scripts/expiring-resets-fixture/evidence';
  await mkdir(out, { recursive: true });
  const screenshot = async (name) => {
    const { data } = await c('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${out}/${name}.png`, Buffer.from(data, 'base64'));
  };
  const select = async (id) => {
    await evaluate(
      `(()=>{const e=[...document.querySelectorAll('.provider-card-select')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(id)})); if(!e)throw Error('missing provider');e.click()})()`,
    );
    await sleep(100);
  };
  const toggle = () =>
    evaluate("document.querySelector('[aria-describedby=auto-use-expiring-resets-help]').click()");
  const checked = () =>
    evaluate("document.querySelector('[aria-describedby=auto-use-expiring-resets-help]')?.checked");
  const sizes = [
    [1366, 900],
    [1000, 800],
    [480, 900],
  ];
  const overflow = [];
  for (const [width, height] of sizes) {
    await c('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const variant of ['bundle-before', 'bundle']) {
      await c('Page.navigate', { url: `http://127.0.0.1:${port}/${variant}/` });
      await sleep(400);
      await select('Personal ChatGPT');
      await screenshot(`${variant}-${width}-off`);
      if (variant === 'bundle') {
        const dimensions = await evaluate(
          `({width:innerWidth,scroll:document.documentElement.scrollWidth,editor:document.querySelector('.models-editor-column').getBoundingClientRect().toJSON(),toggle:document.querySelector('[aria-describedby=auto-use-expiring-resets-help]').getBoundingClientRect().toJSON()})`,
        );
        overflow.push(dimensions);
        assert(dimensions.scroll <= width, 'page horizontal overflow');
      }
    }
  }
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1366,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await c('Page.navigate', { url: `http://127.0.0.1:${port}/bundle/` });
  await sleep(300);
  await select('Personal ChatGPT');
  assert((await checked()) === false, 'default not off');
  await toggle();
  await sleep(100);
  assert((await checked()) === true, 'toggle did not change');
  await evaluate(
    "document.querySelector('[aria-describedby=auto-use-expiring-resets-help]').focus()",
  );
  await screenshot('enabled-focus-1366');
  await click('Fail next save');
  await click('Save');
  assert(
    (await evaluate('document.body.innerText')).includes('Fixture save failure'),
    'save error absent',
  );
  assert((await checked()) === true, 'failed save lost draft');
  await screenshot('save-error-1366');
  await click('Save');
  await select('Personal ChatGPT');
  assert((await checked()) === true, 'saved enabled policy not rehydrated');
  await toggle();
  await sleep(100);
  await click('Cancel');
  assert(
    await evaluate("!!document.querySelector('[role=alertdialog]')"),
    'dirty toggle navigation not guarded',
  );
  await screenshot('unsaved-1366');
  await click('Discard');
  await select('Personal ChatGPT');
  assert((await checked()) === true, 'discard changed saved policy');
  await toggle();
  await sleep(100);
  await click('Save');
  await select('Personal ChatGPT');
  assert((await checked()) === false, 'saved disabled policy not rehydrated');
  await select('Work ChatGPT');
  assert((await checked()) === true, 'other account policy lost');
  await select('Claude Max');
  assert((await checked()) === undefined, 'Anthropic exposes auto toggle');
  await select('OpenAI API key');
  assert((await checked()) === undefined, 'API key exposes auto toggle');
  await click('Load Balancing');
  await select('OpenAI pool');
  assert((await checked()) === undefined, 'pool exposes auto toggle');
  await screenshot('pool-no-toggle-1366');
  const requests = await evaluate('window.fixtureEvidence.requests');
  assert(requests.length === 3, 'unexpected mocked API calls');
  assert(
    requests.every((r) => r.path === '/api/settings/model-connections'),
    'redemption or other endpoint called',
  );
  assert(
    requests.map((r) => r.body.autoUseExpiringResets).join(',') === 'true,true,false',
    'wrong settings payloads',
  );
  assert(exceptions.length === 0, 'browser exceptions');
  const result = {
    status: 'passed',
    checks: [
      'same-shell before/after 1366/1000/480',
      'default off',
      'enabled focus',
      'mocked save failure retains draft',
      'save/reselect true and false',
      'dirty guard/discard',
      'per-account isolation',
      'no Anthropic/API/LB control',
      'no redemption requests',
      'no horizontal page overflow',
    ],
    overflow,
    requests,
    exceptions,
    network,
  };
  await writeFile(`${out}/browser.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  browser?.kill('SIGTERM');
  server.kill('SIGTERM');
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
