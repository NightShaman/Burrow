// Isolated Chromium acceptance; serves only synthetic production-component bundles.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const out = process.env.CHAT_PERF_EVIDENCE;
const base = process.env.CHAT_PERF_FIXTURE_URL;
if (!out || !base) throw Error('Set CHAT_PERF_EVIDENCE and CHAT_PERF_FIXTURE_URL');
const profile = await mkdtemp(join(homedir(), 'ui-chat-perf-'));
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

  const baseline = base.includes('bundle-before');
  const counters = () => evaluate('JSON.parse(JSON.stringify(window.chatPerf))');
  const click = (label) =>
    evaluate(
      `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`,
    );
  const capture = async (name) => {
    const geometry = await evaluate(`(() => {
      const e = document.querySelector('.chat-messages');
      return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, clientHeight: e.clientHeight, scrollHeight: e.scrollHeight, scrollTop: e.scrollTop, messages: document.querySelectorAll('.message').length };
    })()`);
    assert.ok(geometry.pageWidth <= geometry.width, 'page overflow');
    assert.ok(geometry.scrollHeight > geometry.clientHeight, 'transcript must scroll');
    const { data } = await c('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 85,
      captureBeyondViewport: false,
    });
    await writeFile(join(out, name + '.jpg'), Buffer.from(data, 'base64'));
    return geometry;
  };
  await c('Page.navigate', { url: base + '/index.html' });
  await wait('document.querySelectorAll(".message").length === 200', '200 mounted messages');
  await sleep(1800);
  const idleStart = await counters();
  await sleep(3300);
  const idleEnd = await counters();
  assert.ok(idleEnd.polls >= idleStart.polls + 2);
  assert.ok(idleEnd.inputs >= idleStart.inputs + 2);
  if (!baseline) {
    assert.equal(idleEnd.markdown, idleStart.markdown, 'idle Markdown parses');
    assert.equal(idleEnd.messages, idleStart.messages, 'idle message renders');
  }
  states.push({
    name: 'idle',
    start: idleStart,
    end: idleEnd,
    geometry: await capture('idle-1920'),
  });
  await click('active');
  await wait('document.body.innerText.includes("Live answer")', 'live recovered answer');
  const activeStart = await counters();
  await sleep(3400);
  const activeEnd = await counters();
  assert.ok(
    activeEnd.reloads >= activeStart.reloads + 2,
    'active reconciliation unchanged cadence',
  );
  if (!baseline) {
    assert.equal(activeEnd.markdown, activeStart.markdown, 'unchanged active Markdown parses');
    assert.equal(activeEnd.messages, activeStart.messages, 'unchanged active message renders');
  }
  states.push({
    name: 'active',
    start: activeStart,
    end: activeEnd,
    geometry: await capture('active-1920'),
  });
  await click('advance');
  await wait('document.body.innerText.includes("Updated live answer")', 'live answer update');
  assert.ok((await counters()).markdown > activeEnd.markdown);
  await click('terminal');
  await wait('document.body.innerText.includes("Synthetic terminal answer")', 'terminal answer');
  await sleep(1200);
  const terminalStart = await counters();
  await sleep(2300);
  const terminalEnd = await counters();
  if (!baseline)
    assert.equal(terminalEnd.reloads, terminalStart.reloads, 'settled terminal reload loop');
  states.push({
    name: 'terminal',
    start: terminalStart,
    end: terminalEnd,
    geometry: await capture('terminal-1920'),
  });
  await click('attachment');
  await wait('document.body.innerText.includes("late.txt")', 'late attachment');
  await click('settled');
  await sleep(1300);
  await click('queue');
  await wait('document.body.innerText.includes("Synthetic queued input")', 'queued input');
  states.push({
    name: 'late-delivery-queue',
    counters: await counters(),
    geometry: await capture('delivery-queue-1920'),
  });
  // Exercise the real scroll-intent/jump interaction without altering app code.
  await evaluate(
    `(() => { const e = document.querySelector('.chat-messages'); e.scrollTop = 0; e.dispatchEvent(new Event('scroll', {bubbles:true})); })()`,
  );
  await wait('document.querySelector(".chat-jump-latest")', 'jump to latest');
  await capture('scrolled-up-1920');
  await evaluate('document.querySelector(".chat-jump-latest").click()');
  await sleep(500);
  assert.ok(
    await evaluate(
      `(() => { const e=document.querySelector('.chat-messages'); return e.scrollHeight-e.scrollTop-e.clientHeight < 80 })()`,
    ),
    'jump returns to bottom',
  );
  await c('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  states.push({ name: 'narrow', geometry: await capture('queue-900') });
  assert.equal(exceptions.length, 0);
  assert.equal(consoleErrors.length, 0);
  assert.ok(
    network.every(
      (url) =>
        url.startsWith(base + '/') ||
        url === new URL('/burrow-logo.png', base).href ||
        url.startsWith('data:'),
    ),
    'unexpected real API network: ' + JSON.stringify(network),
  );
  await writeFile(
    join(out, 'browser-result.json'),
    JSON.stringify({ baseline, states, exceptions, consoleErrors, network }, null, 2),
  );
  console.log(JSON.stringify({ baseline, states }, null, 2));
} finally {
  browser?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  await rm(profile, { recursive: true, force: true });
}
