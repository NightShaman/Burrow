import { browserPipe } from '../fidgit-settings-fixture/browser-pipe.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const before = process.env.EXPECT_BEFORE === '1';
const evidence = process.env.FORGE_EVIDENCE_DIR ?? 'docs/forge-gallery-followup-20261114';
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

  const nav = async (query = '') => {
    await c('Page.navigate', {
      url: 'http://127.0.0.1:5175/scripts/forge-gallery-fixture/index.html' + query,
    });
    await wait(
      `!![...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.includes('Gallery'))`,
    );
    await evaluate(
      `[...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.includes('Gallery')).click()`,
    );
  };
  const click = (text) =>
    evaluate(
      `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)} || e.querySelector('strong')?.textContent===${JSON.stringify(text)}).click()`,
    );
  const capture = async (name) => {
    await new Promise((r) => setTimeout(r, 250));
    const image = await c('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 85,
      captureBeyondViewport: false,
    });
    await writeFile(join(evidence, name + '.jpg'), Buffer.from(image.data, 'base64'));
    const metrics = await evaluate(
      `(()=>{const g=document.querySelector('.forge-gallery'),s=document.querySelector('.forge-gallery-scroll');return {overflow:document.documentElement.scrollWidth>innerWidth,gallery:g?.getBoundingClientRect().toJSON(),scroll:s?{height:s.clientHeight,total:s.scrollHeight,bottom:s.getBoundingClientRect().bottom}:null}})()`,
    );
    observations.push({ name, ...metrics });
    if (
      (metrics.gallery && metrics.gallery.width < 250) ||
      metrics.overflow ||
      (metrics.gallery && metrics.scroll.bottom > metrics.gallery.bottom + 1)
    )
      throw Error('Overflow ' + JSON.stringify(metrics));
  };
  await nav('?integrated');
  await wait(`!!document.querySelector('[aria-label="Delete disposable-delete-video.mp4"]')`);
  await wait(`!!document.querySelector('video')`);
  await capture('integrated-desktop');
  await evaluate(
    `document.querySelector('[aria-label="Delete disposable-delete-video.mp4"]').click()`,
  );
  await wait(`!!document.querySelector('[role="alertdialog"]')`);
  await capture('delete-confirm-desktop');
  await click('Cancel');
  await evaluate(
    `document.querySelector('[aria-label="Delete disposable-delete-video.mp4"]').click()`,
  );
  await wait(`!!document.querySelector('[role="alertdialog"]')`);
  await evaluate(
    `document.querySelector('.confirm-dialog-actions .danger, .confirm-dialog-actions button:last-child').click()`,
  );
  await wait(`!document.querySelector('[aria-label="Delete disposable-delete-video.mp4"]')`);
  if (
    !(await evaluate(`!!document.querySelector('[aria-label="Delete disposable-keep-video.mp4"]')`))
  )
    throw Error('Sibling disappeared');
  await nav('?integrated');
  await wait(`!!document.querySelector('[aria-label="Delete disposable-keep-video.mp4"]')`);
  if (
    await evaluate(`!!document.querySelector('[aria-label="Delete disposable-delete-video.mp4"]')`)
  )
    throw Error('Delete did not persist');
  await c('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await capture('integrated-mobile');
  await evaluate(
    `document.querySelector('[aria-label="Delete disposable-delete-image.svg"]').click()`,
  );
  await wait(`!!document.querySelector('[role="alertdialog"]')`);
  await capture('delete-confirm-mobile');
  await click('Cancel');
  await writeFile(
    join(evidence, 'results.json'),
    JSON.stringify({ errors, observations }, null, 2),
  );
  if (errors.length) throw Error(JSON.stringify(errors));
  console.log('PASS integrated gallery video/deletion/cancel/siblings/reload/responsive');
} finally {
  browser.kill();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
