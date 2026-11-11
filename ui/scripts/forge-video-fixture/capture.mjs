import { browserPipe } from '../fidgit-settings-fixture/browser-pipe.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const before = process.env.EXPECT_BEFORE === '1';
const evidence = process.env.FORGE_EVIDENCE_DIR ?? '/tmp/forge-video-evidence';
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'forge-video-chromium-'));
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
  const nav = async (state = '') => {
    await c('Page.navigate', {
      url: `http://127.0.0.1:5174/scripts/forge-video-fixture/index.html?state=${state}`,
    });
    await wait(`!!document.querySelector('[role=tab]')`);
    await evaluate(
      `Array.from(document.querySelectorAll('[role=tab]')).find(e=>e.textContent.includes('Video')).click()`,
    );
    await wait(`!!document.querySelector('select[aria-label="Forge model"] option')`);
    await set(
      'textarea',
      'A magenta dragon turns toward the camera, wings lifting in a smooth loop.',
    );
    await evaluate(
      `(()=>{const e=document.querySelector('.forge-motion-control input');if(e.checked)e.click()})()`,
    );
  };
  const capture = async (name) => {
    await new Promise((r) => setTimeout(r, 100));
    const image = await c('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(join(evidence, name + '.png'), Buffer.from(image.data, 'base64'));
    observations.push({
      name,
      ...(await evaluate(
        `({text:document.body.innerText,requests:window.forgeFixture.requests,model:document.querySelector('select[aria-label="Forge model"]')?.value,refs:Array.from(document.querySelectorAll('.forge-reference-options input')).map(e=>({label:e.getAttribute('aria-label'),checked:e.checked,disabled:e.disabled})),viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth})`,
      )),
    });
  };
  await nav();
  await capture(before ? 'before-video-1920' : 'after-video-1920');
  if (before) {
    await evaluate(
      `Array.from(document.querySelectorAll('[role=tab]')).find(e=>e.textContent.includes('Image')).click()`,
    );
    await wait(`!!document.querySelector('.forge-artifact img')`);
    await capture('before-image-detail-1920');
  }
  if (!before) {
    await evaluate(
      `document.querySelector('input[aria-label="Use Smatchet reference photo"]').click();document.querySelector('input[aria-label="Use operator reference photo"]').click()`,
    );
    await capture('after-references-1920');
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Add Forge image').click()`,
    );
    await wait(
      `!!Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Use as video reference')`,
    );
    await capture('after-image-detail-1920');
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Use as video reference').click()`,
    );
    await wait(`!!document.querySelector('[aria-label="Remove dragon-study.png reference"]')`);
    await capture('after-artifact-reference-1920');
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Add Forge image').click()`,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Use as video reference').click()`,
    );
    await wait(`document.querySelectorAll('.forge-artifact-references li').length===1`);
    await capture('after-artifact-deduplicated-1920');
    await nav('unsupported');
    await wait(`!document.querySelector('.forge-references')`);
    await capture('after-unsupported-1920');
    await nav('error');
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Add Forge image').click()`,
    );
    await wait(
      `!!Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Use as video reference')`,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Use as video reference').click()`,
    );
    await wait(`!!document.querySelector('[aria-label="Remove dragon-study.png reference"]')`);
    await evaluate(
      `document.querySelector('input[aria-label="Use Smatchet reference photo"]').click();document.querySelector('.forge-primary').click()`,
    );
    await wait(`document.body.innerText.includes('Could not start generation')`);
    await capture('after-error-1920');
    await c('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await capture('after-video-900');
    await c('Emulation.setDeviceMetricsOverride', {
      width: 480,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await capture('after-artifact-480');
    await c('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await nav('empty');
    await capture('after-empty-900');
  }
  await writeFile(
    join(evidence, (before ? 'before' : 'after') + '-results.json'),
    JSON.stringify({ errors, observations }, null, 2),
  );
  if (errors.length || observations.some((o) => o.overflow))
    throw Error('Exceptions or horizontal overflow');
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
