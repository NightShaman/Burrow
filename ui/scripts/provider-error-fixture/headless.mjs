// Isolated Chromium acceptance; serves only synthetic production-component bundles.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const out = process.env.PROVIDER_ERROR_EVIDENCE;
const base = process.env.PROVIDER_ERROR_FIXTURE_URL;
if (!out || !base) throw Error('Set PROVIDER_ERROR_EVIDENCE and PROVIDER_ERROR_FIXTURE_URL');
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
  const navigate = async (revision, state) => {
    await c('Page.navigate', { url: base + '/' + revision + '/index.html?state=' + state });
    await wait('!!document.querySelector(".composer-wrap")', 'fixture ready');
    await sleep(100);
  };
  for (const state of ['provider', 'partial', 'side', 'long', 'success']) {
    await navigate('before', state);
    await capture('before-' + state + '-1920x1200');
  }
  for (const state of ['provider', 'fallback', 'partial', 'side', 'local', 'long', 'success']) {
    await navigate('after', state);
    const failed = state !== 'success';
    assert.equal(
      await evaluate('document.querySelectorAll(".model-error-card").length'),
      failed ? 1 : 0,
    );
    if (failed) {
      assert.equal(
        await evaluate('document.querySelectorAll(".model-error-message .copy-message").length'),
        1,
      );
      if (!['fallback', 'local'].includes(state))
        assert.ok(
          (await evaluate('document.querySelector(".model-error-card").innerText')).includes(
            'The usage limit has been reached',
          ),
        );
      if (state === 'local')
        assert.ok(
          (await evaluate('document.querySelector(".model-error-card").innerText')).includes(
            'The runtime received an invalid model result.',
          ),
        );
      if (state === 'fallback')
        assert.ok(
          (await evaluate('document.querySelector(".model-error-card").innerText')).includes(
            'HTTP 429',
          ),
        );
      await evaluate('document.querySelector(".model-error-message .copy-message").focus()');
      assert.equal(await evaluate('document.activeElement.className'), 'copy-message');
      await c('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: '\r',
        unmodifiedText: '\r',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await c('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await wait(
        'document.querySelector(".model-error-message .copy-message").textContent.includes("Copied")',
        'keyboard copy',
      );
      const copied = await evaluate('window.providerErrorEvidence.copied[0]');
      assert.ok(copied.includes('Run status: failed'));
      assert.ok(copied.includes('Recovery 1: exhausted'));
      if (state !== 'local') assert.ok(copied.includes('HTTP status: 429'));
      if (state === 'partial')
        assert.ok(copied.includes('The genuine partial answer remains available.'));
      states.push({ name: 'copy-' + state, copied });
    }
    if (state === 'side')
      assert.ok((await evaluate('document.body.innerText')).includes('Side question'));
    if (state === 'long')
      assert.equal(await evaluate('document.querySelectorAll("script:not([src])").length'), 0);
    await capture('after-' + state + '-1920x1200');
  }
  await c('Page.reload', { ignoreCache: true });
  await wait('!!document.querySelector(".composer-wrap")', 'reloaded history');
  await navigate('after', 'provider');
  await c('Page.reload', { ignoreCache: true });
  await wait('!!document.querySelector(".model-error-card")', 'reloaded terminal');
  assert.ok(
    (await evaluate('document.querySelector(".model-error-card").innerText')).includes(
      'The usage limit has been reached',
    ),
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
    'PASS 1920x1200 before/after provider, fallback, partial, side, local, long, success; keyboard Copy + details; no overflow/exceptions/external requests',
  );
} finally {
  browser?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  await rm(profile, { recursive: true, force: true });
}
