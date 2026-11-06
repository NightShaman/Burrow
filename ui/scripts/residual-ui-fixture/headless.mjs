import { browserPipe } from '../fidgit-settings-fixture/browser-pipe.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const before = process.env.EXPECT_BEFORE === '1';
const evidence = process.env.RESIDUAL_EVIDENCE_DIR ?? '/tmp/smatchet-residual-ui/after';
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'residual-ui-chromium-'));
const server = spawn('python3', ['scripts/residual-ui-fixture/serve.py'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser, pipe;
const observations = [],
  exceptions = [],
  network = [];
try {
  const line = await new Promise((resolve, reject) => {
    server.stdout.once('data', (c) => resolve(String(c)));
    server.once('error', reject);
  });
  const port = /PORT=(\d+)/.exec(line)[1];
  browser = spawn(
    process.env.CHROMIUM_BIN ?? 'chromium',
    [
      '--headless',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-first-run',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] },
  );
  pipe = browserPipe(browser, {
    onEvent: (m) => {
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails);
      if (m.method === 'Network.requestWillBeSent') network.push(m.params.request.url);
    },
  });
  await pipe.ready();
  const { targetId } = await pipe.call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await pipe.call('Target.attachToTarget', { targetId, flatten: true });
  const c = (method, params = {}) => pipe.call(method, params, sessionId);
  await c('Page.enable');
  await c('Runtime.enable');
  await c('Network.enable');
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const evaluate = async (expression) => {
    const r = await c('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 80; i++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timeout ' + expression);
  };
  const click = (label) =>
    evaluate(
      `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}||e.getAttribute('aria-label')===${JSON.stringify(label)});if(!e)throw Error('Missing '+${JSON.stringify(label)});e.click()})()`,
    );
  const screenshot = async (name) => {
    const r = await c('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(evidence, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  const note = async (id) =>
    observations.push({
      id,
      ...(await evaluate(
        `({text:document.body.innerText,loading:document.querySelector('[data-testid=loading]')?.textContent,owner:document.querySelector('[data-testid=owner]')?.textContent,draft:document.querySelector('textarea')?.value,older:window.fixtureEvidence.pending.length,posts:window.fixtureEvidence.requests.filter(r=>r.method==='POST').length,requests:window.fixtureEvidence.requests,errors:window.fixtureEvidence.errors,viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth})`,
      )),
    });
  const nav = async (query) => {
    await c('Page.navigate', { url: `http://127.0.0.1:${port}/?${query}` });
    await wait('!!window.fixtureEvidence && !!document.querySelector("button")');
  };
  const setDraft = (value) =>
    evaluate(
      `(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    );
  for (const mode of ['session', 'agent', 'return']) {
    await nav('chat');
    await wait('document.body.innerText.includes("Load older messages")');
    await click('Load older messages');
    await wait('window.fixtureEvidence.pending.length===1');
    await click(mode === 'agent' ? 'Switch agent' : 'Session B');
    await wait(
      `document.querySelector('[data-testid=owner]').textContent===${JSON.stringify(mode === 'agent' ? 'teal/a' : 'magenta/b')} && document.body.innerText.includes('Load older messages')`,
    );
    if (mode === 'return') {
      await click('Session A');
      await wait(
        `document.querySelector('[data-testid=owner]').textContent==='magenta/a' && document.body.innerText.includes('Load older messages')`,
      );
    }
    await click('Load older messages');
    await new Promise((r) => setTimeout(r, 100));
    await note(mode + '-second-start');
    await screenshot(mode + '-second-start');
    const count = await evaluate('window.fixtureEvidence.pending.length');
    if (count !== (before ? 1 : 2)) throw Error(mode + ' request count ' + count);
    await evaluate(`fixtureReleaseOlder(0,'STALE older result')`);
    await new Promise((r) => setTimeout(r, 100));
    await note(mode + '-old-finished');
    await screenshot(mode + '-old-finished');
    if (!before) {
      if (
        !(await evaluate(
          `document.querySelector('[data-testid=loading]').textContent==='true' && !document.body.innerText.includes('STALE older result')`,
        ))
      )
        throw Error('Stale completion changed active request');
      await evaluate(`fixtureReleaseOlder(1,'CURRENT older result')`);
      await wait(
        `document.body.innerText.includes('CURRENT older result') && document.querySelector('[data-testid=loading]').textContent==='false'`,
      );
      await note(mode + '-completed');
      await screenshot(mode + '-completed');
    }
  }
  for (const newer of [false, true]) {
    await nav('group');
    await wait('!!document.querySelector("textarea")');
    await setDraft('Confirmed group message');
    await click('Send message');
    if (newer) await setDraft('Newer unsent draft');
    await evaluate('fixtureConfirmSend()');
    await wait(
      `document.body.innerText.includes(${JSON.stringify(before ? 'Could not send message' : 'Message sent, but could not refresh group chat')})`,
    );
    await note('group-refresh-failed-' + newer);
    await screenshot('group-refresh-failed-' + newer);
    if (
      !(await evaluate(
        `document.querySelector('textarea').value===${JSON.stringify(newer ? 'Newer unsent draft' : '')} && window.fixtureEvidence.requests.filter(r=>r.method==='POST').length===1`,
      ))
    )
      throw Error('Draft/duplicate regression');
    if (!before) {
      await click('Retry refresh');
      await new Promise((r) => setTimeout(r, 100));
      await evaluate('fixtureRecover()');
      await click('Retry refresh');
      await wait(
        `document.body.innerText.includes('Confirmed group message') && !document.body.innerText.includes('Retry refresh')`,
      );
      await note('group-recovered-' + newer);
      await screenshot('group-recovered-' + newer);
      if (
        !(await evaluate(
          `window.fixtureEvidence.requests.filter(r=>r.method==='POST').length===1 && document.querySelector('textarea').value===${JSON.stringify(newer ? 'Newer unsent draft' : '')}`,
        ))
      )
        throw Error('Retry resent or cleared newer draft');
    }
  }
  await writeFile(
    join(evidence, 'results.json'),
    JSON.stringify({ before, observations, exceptions, network, viewport: [1920, 1200] }, null, 2),
  );
  if (exceptions.length || observations.some((o) => o.errors.length || o.overflow))
    throw Error('Browser exceptions/errors/overflow');
  console.log(
    JSON.stringify({
      before,
      evidence,
      observations: observations.length,
      exceptions: exceptions.length,
      networkOrigins: [
        ...new Set(network.filter((u) => u.startsWith('http')).map((u) => new URL(u).origin)),
      ],
    }),
  );
} finally {
  browser?.kill();
  server.kill();
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
