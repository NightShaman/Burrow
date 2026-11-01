// Owned static server + disposable Chromium profile. Never opens the live UI.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = new URL('.', import.meta.url).pathname;
const out = process.env.NATIVE_FIXTURE_EVIDENCE || join(root, 'evidence');
const profile = await mkdtemp(join(homedir(), 'ui-owned-native-thinking-'));
const server = spawn('python3', [join(root, 'serve.py')]);
let browser, c, evaluate;
const exceptions = [], consoleErrors = [], network = [], responses = [], states = [];
try {
  const line = await new Promise((resolve, reject) => { server.stdout.once('data', data => resolve(String(data))); server.once('error', reject); });
  const port = /PORT=(\d+)/.exec(line)[1];
  browser = spawn('/snap/bin/chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--no-proxy-server', '--no-first-run', '--remote-debugging-pipe', `--user-data-dir=${profile}`], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let id = 0, buffer = ''; const pending = new Map();
  browser.stdio[4].on('data', chunk => {
    buffer += chunk; let index;
    while ((index = buffer.indexOf('\0')) >= 0) {
      const text = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!text) continue;
      const message = JSON.parse(text);
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params);
      if (message.method === 'Network.requestWillBeSent') network.push(message.params.request.url);
      if (message.method === 'Network.responseReceived') responses.push(message.params.response);
      const request = pending.get(message.id);
      if (request) { pending.delete(message.id); message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result); }
    }
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(Error('CDP timeout ' + method)); }, 10000);
    pending.set(key, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    browser.stdio[3].write(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  c = (method, params) => call(method, params, sessionId);
  evaluate = async expression => {
    const result = await c('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (expression, label) => {
    for (let i = 0; i < 120; i++) { if (await evaluate(`Boolean(${expression})`)) return; await sleep(40); }
    throw Error('Timeout ' + label + '\n' + await evaluate('document.body.innerText'));
  };
  const change = async (selector, value) => {
    await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('missing/disabled '+${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await sleep(60);
  };
  const selectLabel = async (label, value) => {
    await evaluate(`(()=>{const e=[...document.querySelectorAll('label')].find(e=>e.textContent.startsWith(${JSON.stringify(label)}))?.querySelector('select');if(!e||e.disabled)throw Error('missing/disabled '+${JSON.stringify(label)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await sleep(60);
  };
  const button = async label => { await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e)throw Error('missing button '+${JSON.stringify(label)});e.click()})()`); await sleep(60); };
  const viewport = async width => { await c('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }); await sleep(80); };
  const shot = async name => { const { data } = await c('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(out, name + '.png'), Buffer.from(data, 'base64')); };
  const capture = async name => {
    if (name.startsWith('minion-')) {
      await evaluate(`document.querySelector('.settings-prototype-overflow')?.scrollIntoView({block:'nearest',inline:'end'})`);
      await sleep(80);
    }
    const geometry = await evaluate(`(()=>{const q=e=>{let r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};const t=document.querySelector('.workspace-toolbar'),tune=document.querySelector('.model-tuning-controls');return{native:!!tune,viewport:innerWidth,scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,toolbar:t?{rect:q(t),scroll:t.scrollWidth,client:t.clientWidth}:null,tune:tune?q(tune):null,controls:[...document.querySelectorAll('.workspace-toolbar label')].map(e=>({label:e.textContent,rect:q(e)})),minion:[...document.querySelectorAll('.settings-overflow-content .field')].map(e=>({label:e.firstChild?.textContent,rect:q(e),control:q(e.querySelector('input,select'))}))}})()`);
    assert.ok(geometry.scroll <= geometry.client + 1, 'page overflow ' + name);
    if (geometry.toolbar && geometry.native) {
      assert.ok(geometry.toolbar.scroll <= geometry.toolbar.client + 1, 'toolbar overflow ' + name);
      for (const control of geometry.controls) assert.ok(control.rect.x >= geometry.toolbar.rect.x - 1 && control.rect.right <= geometry.toolbar.rect.right + 1, 'control clipped ' + name + control.label);
      if (geometry.tune) assert.ok(geometry.tune.y > geometry.controls[0].rect.y, 'native controls did not get a separate line');
    }
    for (const field of geometry.minion) {
      assert.ok(field.control.right <= field.rect.right + (field.label.startsWith('Maximum minion depth') ? 3 : 1), 'minion control overflow ' + name + field.label);
      if (field.label.startsWith('Minion thinking') || field.label.startsWith('Minion reasoning')) {
        assert.ok(field.control.x >= 0 && field.control.right <= geometry.viewport, 'minion field not reachable by scrolling '+name);
        assert.ok(field.control.width >= 145, 'native field cramped '+name);
      }
    }
    await shot(name); states.push({ name, geometry }); console.log('PASS', name);
  };
  await mkdir(out, { recursive: true });
  await c('Page.enable'); await c('Runtime.enable'); await c('Network.enable');
  await viewport(1600); await c('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await wait('!!document.querySelector("#chat-thinking")', 'chat ready');
  assert.equal(await evaluate('window.nativeFixture.evidence.requests.filter(r=>r.method==="PUT").length'), 0);
  assert.equal(await evaluate('document.querySelector("#chat-thinking").value'), '');
  assert.equal(await evaluate(`document.querySelector('[aria-label="Send message"]').disabled`), true);
  await capture('chat-legacy-off-1600');
  await evaluate('window.nativeFixture.evidence.delay=350');
  await change('#chat-thinking', 'adaptive');
  assert.equal(await evaluate('document.querySelector("#chat-thinking").disabled'), true);
  assert.equal(await evaluate(`document.querySelector('[aria-label="Send message"]').disabled`), true);
  await wait('document.querySelector("#chat-thinking").disabled===false', 'accepted mode');
  assert.deepEqual(await evaluate('window.nativeFixture.main()'), { connectionId: 'native', model: 'claude-native-fixture', thinkingMode: 'adaptive', reasoningEffort: 'off', temperature: 0.2 });
  await evaluate('window.nativeFixture.evidence.delay=0');
  await evaluate('document.querySelector("#chat-thinking").focus()');
  await c('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await c('Input.dispatchKeyEvent', {type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.equal(await evaluate('document.activeElement.id'), 'chat-effort');
  assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'solid');

  await change('#chat-effort', 'max'); await wait('window.nativeFixture.main().reasoningEffort==="max"', 'max accepted');
  const before = await evaluate('window.nativeFixture.evidence.requests.filter(r=>r.method==="PUT").length');
  await change('#chat-thinking', 'between_tools');
  assert.equal(await evaluate('document.querySelector("#chat-effort").value'), 'max');
  assert.equal(await evaluate('window.nativeFixture.evidence.requests.filter(r=>r.method==="PUT").length'), before);
  assert.equal(await evaluate(`document.querySelector('[aria-label="Send message"]').disabled`), true);
  await capture('chat-incompatible-pair-1600');
  await change('#chat-effort', 'high'); await wait('window.nativeFixture.main().thinkingMode==="between_tools"', 'pair accepted');
  assert.equal(await evaluate('window.nativeFixture.main().reasoningEffort'), 'high');
  await capture('chat-native-1600');
  for (const width of [1280, 800, 390]) { await viewport(width); await capture('chat-native-' + width); }
  await viewport(1600); await evaluate('window.nativeFixture.evidence.failNext=true');
  await change('#chat-thinking', 'adaptive'); await wait('document.body.innerText.includes("Retry model selection")', 'failed save retry');
  assert.equal(await evaluate('document.querySelector("#chat-thinking").value'), 'adaptive');
  assert.equal(await evaluate(`document.querySelector('[aria-label="Send message"]').disabled`), true);
  await capture('chat-failed-save-1600');
  await button('Retry model selection'); await wait('window.nativeFixture.main().thinkingMode==="adaptive" && !document.querySelector("#chat-thinking").disabled', 'retry accepted');
  await change('#chat-model', 'claude-manual-fixture'); await wait('window.nativeFixture.main().model==="claude-manual-fixture"', 'manual model');
  await change('#chat-thinking', 'enabled'); await wait('window.nativeFixture.main().thinkingMode==="enabled"', 'manual mode');
  await capture('chat-manual-1600');
  await change('#chat-provider', 'OpenAI [Synthetic]'); await wait('!document.querySelector("#chat-thinking")', 'other provider');
  await capture('chat-other-provider-1600');
  await button('Settings'); await wait('!![...document.querySelectorAll("label")].find(e=>e.textContent.startsWith("Minion thinking mode"))', 'minion ready');
  await capture('minion-legacy-off-1600');
  await selectLabel('Minion thinking mode', 'adaptive'); await wait('window.nativeFixture.minion().thinkingMode==="adaptive"', 'minion mode accepted');
  await selectLabel('Minion reasoning effort', 'max'); await wait('window.nativeFixture.minion().reasoningEffort==="max"', 'minion max accepted');
  const minionBefore = await evaluate('window.nativeFixture.evidence.requests.filter(r=>r.method==="PUT").length');
  await selectLabel('Minion thinking mode', 'between_tools');
  assert.equal(await evaluate('window.nativeFixture.evidence.requests.filter(r=>r.method==="PUT").length'), minionBefore);
  await capture('minion-incompatible-pair-1600');
  await selectLabel('Minion reasoning effort', 'high'); await wait('window.nativeFixture.minion().thinkingMode==="between_tools"', 'minion pair accepted');
  for (const width of [1600, 1280, 800, 390]) { await viewport(width); await capture('minion-native-' + width); }
  await viewport(1600); await selectLabel('Default minion provider', ''); await wait('window.nativeFixture.minion()===null', 'inherit accepted');
  assert.deepEqual(await evaluate('window.nativeFixture.evidence.requests.filter(r=>r.method==="PUT").at(-1).body'), { connectionId: null, model: null });
  await capture('minion-inherit-1600');
  const evidence = await evaluate('window.nativeFixture.evidence');
  assert.equal(evidence.attemptedRuns, 0); assert.deepEqual(evidence.unexpected, []); assert.deepEqual(exceptions, []); assert.deepEqual(consoleErrors, []);
  assert.equal(network.filter(url => url.includes('/api/')).length, 0);
  assert.ok(network.every(url => url.startsWith(`http://127.0.0.1:${port}/`) || url.startsWith('data:')), 'external network');
  assert.ok(responses.some(r => Object.entries(r.headers).some(([key, value]) => key.toLowerCase() === 'content-security-policy' && value.includes("connect-src 'none'"))));
  await writeFile(join(out, 'report.json'), JSON.stringify({ root: process.cwd(), states, evidence, exceptions, consoleErrors, network, realApiRequests: 0, externalPageRequests: 0 }, null, 2));
  console.log('PASS', states.length, 'states, no actual API/external requests, zero generation attempts');
} catch (error) {
  if (c) { try { const { data } = await c('Page.captureScreenshot', { format: 'png' }); await writeFile(join(out, 'failure.png'), Buffer.from(data, 'base64')); console.error('STATE', await evaluate('document.body.innerText')); } catch {} }
  throw error;
} finally { browser?.kill(); server.kill(); await new Promise(resolve => setTimeout(resolve, 200)); await rm(profile, { recursive: true, force: true }); }
