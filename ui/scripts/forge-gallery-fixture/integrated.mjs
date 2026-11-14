import { browserPipe } from '../fidgit-settings-fixture/browser-pipe.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const before = process.env.EXPECT_BEFORE === '1';
const evidence = process.env.FORGE_EVIDENCE_DIR ?? 'docs/forge-gallery-20261114';
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'forge-gif-chromium-'));
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
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + expression);
  };
  const set = (selector, value) =>
    evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`,
    );

  const go = async () => {
    await c('Page.navigate', {
      url: 'http://127.0.0.1:5175/scripts/forge-gallery-fixture/index.html?integrated',
    });
    await wait(
      `!![...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.includes('Gallery'))`,
    );
    await evaluate(
      `[...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.includes('Gallery')).click()`,
    );
    await wait(`document.querySelectorAll('.forge-gallery-picture').length===1`);
  };
  const click = (text) =>
    evaluate(
      `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)} || e.querySelector('strong')?.textContent===${JSON.stringify(text)}).click()`,
    );
  await go();
  await click('＋ New folder');
  await set('.forge-gallery-dialog input', 'Browser integration');
  await click('Create folder');
  await wait(`!document.querySelector('[role="dialog"]')`);
  await evaluate(`document.querySelector('.forge-gallery-picture footer button').click()`);
  await wait(`!!document.querySelector('.forge-gallery-dialog select')`);
  await evaluate(
    `(()=>{const e=document.querySelector('.forge-gallery-dialog select');e.value=[...e.options].find(o=>o.text==='Browser integration').value;e.dispatchEvent(new Event('change',{bubbles:true}))})()`,
  );
  await click('Move image');
  await wait(`document.querySelectorAll('.forge-gallery-picture').length===0`);
  await c('Page.reload');
  await wait(
    `!![...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.includes('Gallery'))`,
  );
  await evaluate(
    `[...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.includes('Gallery')).click()`,
  );
  await wait(`!!document.querySelector('.forge-gallery-folder')`);
  await click('Browser integration');
  await wait(`document.querySelectorAll('.forge-gallery-picture').length===1`);
  await wait(`!!document.querySelector('.image-preview-trigger img')`);
  await evaluate(`document.querySelector('.image-preview-trigger').click()`);
  await wait(`!!document.querySelector('.image-viewer img')`);
  const image = await c('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
  await writeFile(join(evidence, 'integrated-viewer.jpg'), Buffer.from(image.data, 'base64'));
  await evaluate(`document.querySelector('[aria-label="Close image viewer"]').click()`);
  await evaluate(`document.querySelector('.forge-gallery-picture footer button').click()`);
  await wait(`!!document.querySelector('.forge-gallery-dialog select')`);
  await set('.forge-gallery-dialog select', '');
  await click('Move image');
  await wait(`document.querySelectorAll('.forge-gallery-picture').length===0`);
  await click('Gallery');
  await wait(`document.querySelectorAll('.forge-gallery-picture').length===1`);
  await writeFile(
    join(evidence, 'integrated-results.json'),
    JSON.stringify(
      {
        errors,
        passed: [
          'real HTTP folder creation',
          'real HTTP image move',
          'reload persistence',
          'artifact viewer',
          'restore root',
        ],
      },
      null,
      2,
    ),
  );
  if (errors.length) throw Error(JSON.stringify(errors));
  console.log('PASS real backend gallery integration');
} finally {
  browser.kill();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
