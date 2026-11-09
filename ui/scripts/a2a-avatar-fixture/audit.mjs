// Isolated real transcript/CSS browser checks. Uses no live API or provider data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserPipe } from '../fidgit-settings-fixture/browser-pipe.mjs';
const root = process.env.A2A_EVIDENCE_DIR ?? '/tmp/smatchet-a2a-avatar';
const origin = process.env.A2A_FIXTURE_URL ?? 'http://127.0.0.1:8798';
const profile = await mkdtemp(join(tmpdir(), 'a2a-avatar-browser-'));
const errors = [];
const browser = spawn(
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
const pipe = browserPipe(browser, {
  onEvent: (m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
  },
});
const results = [];
try {
  await pipe.ready();
  const { targetId } = await pipe.call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await pipe.call('Target.attachToTarget', { targetId, flatten: true });
  const c = (method, params = {}) => pipe.call(method, params, sessionId);
  const evaluate = async (expression) => {
    const r = await c('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await c('Page.enable');
  await c('Runtime.enable');
  for (const stage of ['before', 'after']) {
    await mkdir(join(root, 'evidence', stage), { recursive: true });
    for (const width of [1850, 1024, 390]) {
      await c('Emulation.setDeviceMetricsOverride', {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const fallback of [false, true]) {
        await c('Page.navigate', { url: `${origin}/${stage}/${fallback ? '?fallback' : ''}` });
        let state;
        for (let i = 0; i < 100; i++) {
          state = await evaluate(
            `(()=>{const avatars=[...document.querySelectorAll('.message-avatar')];if(avatars.length!==2)return null;return {avatars:avatars.map(e=>({text:e.textContent,src:e.querySelector('img')?.getAttribute('src'),loaded:!!e.querySelector('img')?.naturalWidth,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})),sides:[...document.querySelectorAll('article.message')].map(e=>e.className),overflow:document.documentElement.scrollWidth>innerWidth,labels:[...document.querySelectorAll('.message-content > small')].map(e=>e.textContent)}})()`,
          );
          if (state && state.avatars[1].loaded) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.ok(state, 'Transcript rendered');
        if (stage === 'after' && !fallback)
          assert.ok(state.avatars[0].loaded, 'Known sender image loaded');
        else {
          assert.ok(!state.avatars[0].src);
          assert.equal(state.avatars[0].text, fallback ? 'U' : 'S');
        }
        assert.ok(state.avatars[1].loaded, 'Recipient portrait preserved');
        assert.equal(state.sides[0], 'message operator');
        assert.equal(state.sides[1], 'message agent');
        assert.equal(state.overflow, false);
        assert.equal(state.avatars[0].width, state.avatars[1].width);
        const { data } = await c('Page.captureScreenshot', { format: 'png' });
        await writeFile(
          join(root, 'evidence', stage, `${fallback ? 'fallback' : 'known'}-${width}.png`),
          Buffer.from(data, 'base64'),
        );
        results.push({ stage, width, fallback, ...state });
      }
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(root, 'browser-results.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(
    'PASS: before/after, 3 widths, known and unknown senders; portraits loaded, alignment preserved, no horizontal overflow/runtime errors.',
  );
} finally {
  await pipe.call('Browser.close').catch(() => {});
  browser.kill();
  await rm(profile, { recursive: true, force: true });
}
