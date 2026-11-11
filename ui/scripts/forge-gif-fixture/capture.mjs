import { browserPipe } from '../fidgit-settings-fixture/browser-pipe.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const before = process.env.EXPECT_BEFORE === '1';
const evidence = process.env.FORGE_EVIDENCE_DIR ?? '/tmp/forge-gif-evidence';
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
  const nav = async (state = '') => {
    await c('Page.navigate', {
      url: `http://127.0.0.1:5174/scripts/forge-gif-fixture/index.html?state=${state}`,
    });
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
        `({text:document.body.innerText,requests:window.forgeFixture.requests,viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth})`,
      )),
    });
  };
  await nav();
  await capture(before ? 'before-image-1920' : 'after-image-1920');
  if (!before) {
    await set('select[aria-label="Output format"]', 'gif');
    await wait(`!!document.querySelector('input[aria-label="Frames"]')`);
    await capture('after-gif-1920');
    await set('select[aria-label="Forge model"]', JSON.stringify(['fixture', 'still']));
    await wait(
      `document.querySelector('select[aria-label="Forge model"]').value==='["fixture","still"]'`,
    );
    await capture('after-unsupported-1920');
    await nav('error');
    await set('select[aria-label="Output format"]', 'gif');
    await evaluate(`document.querySelector('.forge-primary').click()`);
    await wait(`document.body.innerText.includes('Could not start generation')`);
    await capture('after-error-1920');
    await c('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await capture('after-gif-900');
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
