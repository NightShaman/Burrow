// Real Settings/CSS, synthetic provider data, no live API writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserPipe } from './browser-pipe.mjs';
const before = process.env.EXPECT_BEFORE === '1';
const evidence = process.env.METADATA_EVIDENCE_DIR ?? '/tmp/smatchet-provider-metadata/after';
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'metadata-chromium-'));
const server = spawn('python3', ['scripts/fidgit-settings-fixture/serve.py']);
let browser, pipe;
const errors = [],
  results = [];
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
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] },
  );
  pipe = browserPipe(browser, {
    onEvent: (m) => {
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
    },
  });
  await pipe.ready();
  const { targetId } = await pipe.call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await pipe.call('Target.attachToTarget', { targetId, flatten: true });
  const c = (method, params = {}) => pipe.call(method, params, sessionId);
  const evaluate = async (expression) => {
    const r = await c('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timeout: ' + expression);
  };
  const click = async (text, selector = 'button') => {
    await evaluate(
      `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.click()})()`,
    );
    await new Promise((r) => setTimeout(r, 120));
  };
  await c('Page.enable');
  await c('Runtime.enable');
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1690,
    height: 945,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await c('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await wait('!!window.fixtureSetTab');
  await click('Models');
  await click('Synthetic GoogleGoogle Gemini (Developer API) · 3 models');
  await wait('!!document.querySelector(".model-capability-editor details")');
  assert.equal(
    await evaluate('document.querySelector(".model-capability-editor details").open'),
    false,
  );
  await click('Provider metadata', '.model-capability-editor summary');
  for (const [width, height] of [
    [1690, 945],
    [1910, 1025],
    [1000, 900],
    [390, 900],
  ]) {
    await c('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      'document.querySelector(".model-capability-editor details").scrollIntoView({block:"start"})',
    );
    await new Promise((r) => setTimeout(r, 120));
    const state = await evaluate(
      `(()=>{const fields=[...document.querySelectorAll('.model-capability-editor details textarea')];return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,fields:fields.map(e=>({label:e.closest('label').firstChild.textContent,value:e.value,readOnly:e.readOnly,bg:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color,border:getComputedStyle(e).borderColor,width:e.getBoundingClientRect().width,parent:e.parentElement.clientWidth})),errors:window.fixtureEvidence.errors,writes:window.fixtureEvidence.requests.filter(r=>r.method!=='GET')};})()`,
    );
    assert.equal(state.fields.length, 11);
    assert.equal(state.overflow, false);
    assert.ok(state.fields.every((f) => f.readOnly && f.width <= f.parent + 1));
    assert.equal(state.fields.find((f) => f.label === 'Thinking').value, 'false');
    assert.equal(state.fields.find((f) => f.label === 'Temperature').value, '0');
    assert.equal(state.errors.length, 0);
    assert.equal(state.writes.length, 0);
    if (!before)
      assert.ok(
        state.fields.every((f) => f.bg !== 'rgb(255, 255, 255)' && f.bg !== 'rgba(0, 0, 0, 0)'),
        JSON.stringify(state),
      );
    else assert.equal(state.fields[0].bg, 'rgb(255, 255, 255)');
    const image = await c('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(join(evidence, `metadata-${width}.png`), Buffer.from(image.data, 'base64'));
    await evaluate(
      `(()=>{const e=[...document.querySelectorAll('.model-capability-editor details textarea')].at(-1);e.scrollIntoView({block:'center'});e.focus();})()`,
    );
    const end = await evaluate(
      `(()=>{const e=[...document.querySelectorAll('.model-capability-editor details textarea')].at(-1),r=e.getBoundingClientRect();return {focused:document.activeElement===e,visible:r.top>=0&&r.bottom<=innerHeight,outline:getComputedStyle(e).outlineStyle}})()`,
    );
    assert.equal(end.focused, true);
    assert.equal(end.visible, true);
    assert.equal(end.outline, 'solid');
    results.push({ ...state, end });
  }
  await click('Provider metadata', '.model-capability-editor summary');
  assert.equal(
    await evaluate('document.querySelector(".model-capability-editor details").open'),
    false,
  );
  assert.equal(errors.length, 0);
  await writeFile(
    join(evidence, 'results.json'),
    JSON.stringify({ before, results, errors }, null, 2),
  );
  console.log(
    `Metadata browser checks passed (${before ? 'before reproduction' : 'after fix'}): ${results.length} viewports, read-only values, accordion, scrolling, focus, no writes/errors.`,
  );
} finally {
  browser?.kill();
  server.kill();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
