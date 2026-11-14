import { browserPipe } from '../fidgit-settings-fixture/browser-pipe.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const before = process.env.EXPECT_BEFORE === '1';
const evidence = process.env.FORGE_EVIDENCE_DIR ?? 'docs/forge-gallery-references-20261114';
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
    const r = await c('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
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
      url: 'http://127.0.0.1:5174/scripts/forge-gallery-fixture/index.html' + query,
    });
    await wait(
      `!![...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.includes('Gallery'))`,
    );
    await evaluate(
      `[...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.includes('Gallery')).click()`,
    );
  };
  const click = (text, selector = 'button') =>
    evaluate(
      `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)} || e.querySelector('strong')?.textContent===${JSON.stringify(text)}).click()`,
    );
  const check = async (expression, message) => {
    if (!(await evaluate(expression))) throw Error(message);
  };
  const capture = async (name) => {
    await new Promise((r) => setTimeout(r, 250));
    const image = await c('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 85,
      captureBeyondViewport: false,
    });
    await writeFile(join(evidence, name + '.jpg'), Buffer.from(image.data, 'base64'));
    const metrics = await evaluate(
      `(()=>{const g=document.querySelector('.forge-gallery'),s=document.querySelector('.forge-gallery-scroll');return {viewer:(()=>{const v=document.querySelector('.image-viewer');return v?{rect:v.getBoundingClientRect().toJSON(),overflow:v.scrollWidth>v.clientWidth,actions:[...v.querySelectorAll('button')].map(b=>({name:b.textContent.trim(),rect:b.getBoundingClientRect().toJSON()}))}:null})(),overflow:document.documentElement.scrollWidth>innerWidth,gallery:g?.getBoundingClientRect().toJSON(),scroll:s?{height:s.clientHeight,total:s.scrollHeight,bottom:s.getBoundingClientRect().bottom}:null}})()`,
    );
    observations.push({ name, ...metrics });
    if (
      (metrics.gallery && metrics.gallery.width < 250) ||
      metrics.overflow ||
      metrics.viewer?.overflow ||
      (metrics.viewer &&
        metrics.viewer.actions.some(
          (b) =>
            b.rect.right > metrics.viewer.rect.right || b.rect.bottom > metrics.viewer.rect.bottom,
        )) ||
      (metrics.gallery && metrics.scroll.bottom > metrics.gallery.bottom + 1)
    )
      throw Error('Overflow ' + JSON.stringify(metrics));
  };
  await nav('?references');
  await wait(`!!document.querySelector('[aria-label="Enlarge Neon skyline.png"]')`);
  await evaluate(`document.querySelector('[aria-label="Enlarge Neon skyline.png"]').click()`);
  await wait(`!!document.querySelector('.image-viewer img')`);
  await capture(before ? 'before-desktop' : 'after-desktop');
  await c('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await capture(before ? 'before-mobile' : 'after-mobile');
  if (!before) {
    await click('Copy reference', '.image-viewer button');
    await wait(
      `document.querySelector('.image-viewer [role="status"]')?.textContent==='Reference copied.'`,
    );
    await click('Attach to conversation', '.image-viewer button');
    await wait(
      `document.querySelector('.image-viewer [role="status"]')?.textContent==='Attached to the current conversation.'`,
    );
    await check(
      `window.galleryRequests.some(r=>r.path==='/api/forge/jobs/job-eligible/attach' && JSON.parse(r.body).artifactId==='eligible' && JSON.parse(r.body).sessionId==='gallery-test')`,
      'Wrong attach identity',
    );
    await capture('attached-mobile');
    await click('Actual size', '.image-viewer button');
    await check(
      `!!document.querySelector('.image-viewer-stage.actual-size')`,
      'Actual size broken',
    );
    await click('Fit to screen', '.image-viewer button');
    await click('Use as video reference', '.image-viewer button');
    await wait(
      `!document.querySelector('.image-viewer') && !!document.querySelector('[aria-label="Remove Neon skyline.png reference"]')`,
    );
    await check(
      `document.querySelector('[role="tab"][aria-selected="true"]').textContent.includes('Video')`,
      'Video tab not selected',
    );
    await capture('video-reference-mobile');
    await click('▧Gallery');
    await wait(`!!document.querySelector('[aria-label="Enlarge Animated skyline.gif"]')`);
    await evaluate(`document.querySelector('[aria-label="Enlarge Animated skyline.gif"]').click()`);
    await check(
      `![...document.querySelectorAll('.image-viewer button')].some(b=>b.textContent==='Use as video reference') && [...document.querySelectorAll('.image-viewer button')].some(b=>b.textContent==='Copy reference')`,
      'GIF eligibility differs',
    );
    await capture('gif-mobile');
    await c('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await wait(`!document.querySelector('.image-viewer')`);
    await check(
      `document.activeElement?.getAttribute('aria-label')==='Enlarge Animated skyline.gif'`,
      'Escape focus not restored',
    );
    await evaluate(
      `document.querySelector('[aria-label="Enlarge Oversized skyline.png"]').click()`,
    );
    await check(
      `document.querySelectorAll('.image-viewer .forge-media-actions button').length===1`,
      'Oversized eligibility differs',
    );
    await capture('oversized-mobile');
    await c('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await wait(`!document.querySelector('.image-viewer')`);
    await wait(`document.querySelector('.forge-gallery video')?.readyState>=2`);
    await capture('gallery-media-mobile');
    await check(
      `document.querySelector('.forge-gallery video').videoWidth>0`,
      'Video failed to render',
    );
    await evaluate(
      `document.querySelector('video').closest('.forge-gallery-media').querySelector('.forge-media-actions button').click()`,
    );
    await wait(`window.galleryRequests.some(r=>r.path==='/api/forge/jobs/job-video/attach')`);
    await check(
      `!document.querySelector('video').closest('.forge-gallery-media').textContent.includes('Copy reference')`,
      'Video incorrectly copyable',
    );
    await nav('?references&attachError');
    await wait(`!!document.querySelector('[aria-label="Enlarge Neon skyline.png"]')`);
    await evaluate(`document.querySelector('[aria-label="Enlarge Neon skyline.png"]').click()`);
    await click('Attach to conversation', '.image-viewer button');
    await wait(`!!document.querySelector('.image-viewer [role="alert"]')`);
    await capture('attach-error-mobile');
    await c('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await capture('attach-error-desktop');
  }

  await writeFile(
    join(evidence, before ? 'before-results.json' : 'results.json'),
    JSON.stringify({ errors, observations }, null, 2),
  );
  if (errors.length) throw Error(JSON.stringify(errors));
  console.log('PASS Gallery viewer capture');
} finally {
  browser.kill();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
