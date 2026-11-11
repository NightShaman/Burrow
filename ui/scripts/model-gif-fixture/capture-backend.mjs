import { browserPipe } from '../fidgit-settings-fixture/browser-pipe.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const before = process.env.EXPECT_BEFORE === '1';
const evidence = 'docs/verification/model-gif';
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'model-gif-chromium-'));
const browser = spawn(
  process.env.CHROMIUM_BIN ?? 'chromium',
  [
    '--headless',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-sync',
    '--no-first-run',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] },
);
const errors = [],
  observations = [];
const pipe = browserPipe(browser, {
  onEvent: (m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
  },
});
try {
  await pipe.ready();
  const { targetId } = await pipe.call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await pipe.call('Target.attachToTarget', { targetId, flatten: true });
  const c = (method, params = {}) => pipe.call(method, params, sessionId);
  await c('Page.enable');
  await c('Runtime.enable');
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
    for (let i = 0; i < 120; i++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + expression);
  };
  const click = async (expression) => {
    await wait(`!!(${expression})`);
    await evaluate(`(${expression}).click()`);
  };
  const set = (selector, value) =>
    evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  const capture = async (name) => {
    await new Promise((r) => setTimeout(r, 150));
    const image = await c('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(join(evidence, name + '.png'), Buffer.from(image.data, 'base64'));
    observations.push({
      name,
      ...(await evaluate(
        `({text:document.body.innerText,viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth,selects:[...document.querySelectorAll('select')].map(e=>({label:e.ariaLabel,value:e.value,options:[...e.options].map(o=>o.value)})),fields:[...document.querySelectorAll('input[type="number"]')].map(e=>({label:e.ariaLabel,value:e.value})),outputs:[...document.querySelectorAll('input[aria-label^="Output "]')].map(e=>({label:e.ariaLabel,checked:e.checked,disabled:e.disabled}))})`,
      )),
    });
  };
  await c('Page.navigate', { url: 'http://127.0.0.1:5174/scripts/model-gif-fixture/index.html' });
  await wait(`!!document.querySelector('select[aria-label="Output format"]')`);
  await capture((before ? 'backend-before' : 'backend-after') + '-gif-only-1920');
  if (!before) await wait(`!!document.querySelector('input[aria-label="Frames"]')`);
  const selectModel = async (id) => {
    await set('select[aria-label="Forge model"]', JSON.stringify(['capability-fixture', id]));
    await wait(
      `document.querySelector('select[aria-label="Forge model"]').value===${JSON.stringify(JSON.stringify(['capability-fixture', id]))}`,
    );
  };
  await selectModel('still-only');
  await capture((before ? 'backend-before' : 'backend-after') + '-still-1920');
  await selectModel('mixed-image-gif');
  await capture((before ? 'backend-before' : 'backend-after') + '-mixed-default-1920');
  await set('select[aria-label="Output format"]', 'gif');
  await wait(`!!document.querySelector('input[aria-label="Frames"]')`);
  await capture((before ? 'backend-before' : 'backend-after') + '-mixed-gif-1920');
  await selectModel('gif-only');
  await evaluate('window.forgeFixture.removeGif()');
  await click(`[...document.querySelectorAll('button')].find(e=>e.textContent==='Refresh')`);
  await wait(`!document.querySelector('input[aria-label="Frames"]')`);
  await capture((before ? 'backend-before' : 'backend-after') + '-capability-removed-1920');
  if (
    await evaluate(
      `window.forgeFixture.requests.some(r=>r.path==='/api/forge/jobs' && r.method==='POST')`,
    )
  )
    throw Error('Unexpected generation');
  await writeFile(
    join(evidence, (before ? 'backend-before' : 'backend-after') + '-results.json'),
    JSON.stringify({ errors, observations }, null, 2),
  );
  if (errors.length || observations.some((o) => o.overflow))
    throw Error('Browser exception or overflow');
  console.log(
    JSON.stringify({
      evidence,
      screenshots: observations.map((o) => o.name),
      errors: errors.length,
    }),
  );
} finally {
  browser.kill();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
