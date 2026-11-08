// Isolated Chromium acceptance; serves only synthetic production-component bundles.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const out = process.env.RUNTIME_RECOVERY_EVIDENCE;
const base = process.env.RUNTIME_RECOVERY_FIXTURE_URL;
if (!out || !base) throw Error('Set RUNTIME_RECOVERY_EVIDENCE and RUNTIME_RECOVERY_FIXTURE_URL');
const profile = await mkdtemp(join(homedir(), 'ui-provider-error-'));
const exceptions = [],
  consoleErrors = [],
  network = [],
  responses = [],
  states = [];
let browser, c, evaluate;
try {
  browser = spawn(
    '/snap/bin/chromium',
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
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
  let id = 0,
    buffer = '';
  const pending = new Map();
  browser.stdio[4].on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\0')) >= 0) {
      const text = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!text) continue;
      const message = JSON.parse(text);
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
        consoleErrors.push(message.params);
      if (message.method === 'Network.requestWillBeSent') network.push(message.params.request.url);
      if (message.method === 'Network.responseReceived') responses.push(message.params.response);
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        message.error
          ? request.reject(Error(JSON.stringify(message.error)))
          : request.resolve(message.result);
      }
    }
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const key = ++id,
        timer = setTimeout(() => {
          pending.delete(key);
          reject(Error('CDP timeout ' + method));
        }, 10000);
      pending.set(key, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      browser.stdio[3].write(
        JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0',
      );
    });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  c = (method, params) => call(method, params, sessionId);
  evaluate = async (expression) => {
    const result = await c('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const wait = async (expression, label) => {
    for (let i = 0; i < 120; i++) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await sleep(40);
    }
    throw Error('Timeout ' + label + '\n' + (await evaluate('document.body.innerText')));
  };

  await mkdir(out, { recursive: true });
  await c('Page.enable');
  await c('Runtime.enable');
  await c('Network.enable');
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const capture = async (name) => {
    await sleep(100);
    const geometry = await evaluate(`(() => {
      const rect = e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
      return {viewport:{width:innerWidth,height:innerHeight}, pageWidth:document.documentElement.scrollWidth, cards:[...document.querySelectorAll('.model-error-card')].map(e=>({rect:rect(e),width:e.clientWidth,scrollWidth:e.scrollWidth,text:e.innerText})), copy:[...document.querySelectorAll('.model-error-message .copy-message')].map(e=>({rect:rect(e),label:e.getAttribute('aria-label')})), body:document.body.innerText};
    })()`);
    assert.equal(geometry.viewport.width, 1920);
    assert.equal(geometry.viewport.height, 1200);
    assert.ok(geometry.pageWidth <= 1920, 'page overflow ' + name);
    for (const card of geometry.cards) {
      assert.ok(card.scrollWidth <= card.width + 1, 'card overflow ' + name);
      assert.ok(card.rect.x >= 0 && card.rect.right <= 1920, 'card clipped ' + name);
    }
    const { data } = await c('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(join(out, name + '.png'), Buffer.from(data, 'base64'));
    states.push({ name, geometry });
  };
  await c('Page.navigate', { url: base + '/index.html' });
  await wait(
    'document.querySelector("#turns")?.innerText.includes("Before reset")',
    'initial conversation',
  );
  await wait('document.body.innerText.includes("Retry")', 'authentication failure');
  await capture('recovery-auth-error-1920');
  await evaluate('document.querySelector("#older").click()');
  await wait(
    'document.querySelector("#paging").innerText.includes("\\"loading\\":true")',
    'pending older',
  );
  await evaluate('document.querySelector("#reset").click()');
  await wait('document.querySelector("#status").innerText === "Reset confirmed"', 'reset');
  assert.equal(await evaluate('document.querySelector("#turns").innerText'), '');
  await evaluate('document.querySelector("#release").click()');
  await sleep(250);
  assert.equal(await evaluate('document.querySelector("#turns").innerText'), '');
  assert.equal(
    await evaluate('document.querySelector("#paging").innerText'),
    '{"older":false,"loading":false}',
  );
  await evaluate(
    '[...document.querySelectorAll("button")].find(e=>e.textContent==="Retry").click()',
  );
  await wait(
    'document.body.innerText.includes("Effective authentication: Trusted Proxy")',
    'authentication retry recovery',
  );
  await capture('recovery-reset-auth-recovered-1920');
  await evaluate('document.querySelector("#fresh").click()');
  await wait(
    'document.querySelector("#turns").innerText.includes("Fresh conversation")',
    'fresh newest',
  );
  await evaluate('document.querySelector("#older").click()');
  await wait(
    'document.querySelector("#turns").innerText.includes("Fresh older history")',
    'fresh older',
  );
  assert.ok(!(await evaluate('document.querySelector("#turns").innerText')).includes('OBSOLETE'));
  await capture('recovery-fresh-history-1920');
  await writeFile(
    join(out, 'mock-api-calls.json'),
    JSON.stringify(await evaluate('window.recoveryEvidence'), null, 2),
  );
  assert.equal(exceptions.length, 0);
  assert.equal(consoleErrors.length, 0);
  assert.ok(
    network.every((url) => url.startsWith(base + '/') || url.startsWith('data:')),
    'unexpected network',
  );
  await writeFile(
    join(out, 'browser-result.json'),
    JSON.stringify(
      {
        states,
        exceptions,
        consoleErrors,
        network,
        responses: responses.map((r) => ({ url: r.url, status: r.status })),
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS real useChatSession reset/pending older/fresh history and Authentication failed-load Retry recovery at 1920x1200',
  );
} finally {
  browser?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  await rm(profile, { recursive: true, force: true });
}
