// Actual native pointer/keyboard input, reused single page; browser/profile always cleaned.
import { browserPipe } from '../fidgit-settings-fixture/browser-pipe.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const profile = await mkdtemp(join(tmpdir(), 'smatchet-ranges-'));
const evidence = new URL('./evidence/', import.meta.url).pathname;
await mkdir(evidence, { recursive: true });
const browser = spawn(
  'chromium',
  [
    '--headless',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--no-first-run',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] },
);
const transport = browserPipe(browser, { binary: 'chromium' });
const results = [];
try {
  await transport.ready();
  const { targetId } = await transport.call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await transport.call('Target.attachToTarget', { targetId, flatten: true });
  const c = (method, params = {}) => transport.call(method, params, sessionId);
  const evaluate = async (expression) => {
    const r = await c('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const settle = () => new Promise((r) => setTimeout(r, 120));
  const screenshot = async (name) => {
    const { cssContentSize } = await c('Page.getLayoutMetrics');
    const { data } = await c('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 },
    });
    await writeFile(join(evidence, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const sliders = () =>
    evaluate(`Array.from(document.querySelectorAll('input[type=range]')).map(e => {
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    return {control:e.closest('[data-control]')?.dataset.control, value:e.value, disabled:e.disabled,
      x:r.x,y:r.y,width:r.width,height:r.height,padding:s.padding,border:s.borderWidth,background:s.backgroundColor,
      accent:s.accentColor,appearance:s.appearance,opacity:s.opacity}; })`);
  const select = (control) =>
    `document.querySelector('[data-control="${control}"] input[type=range]')`;
  const focus = async (control) => {
    await evaluate(`${select(control)}.focus()`);
  };
  const key = async (key, code) => {
    await c('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    });
    await c('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    });
    await settle();
  };
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const bundle of ['bundle-before', 'bundle']) {
    await c('Page.navigate', { url: `http://127.0.0.1:46735/${bundle}/` });
    for (let i = 0; i < 60; i++) {
      if (
        await evaluate(`document.querySelectorAll('input[type=range]:not(:disabled)').length >= 6`)
      )
        break;
      await settle();
    }
    assert.equal((await sliders()).length, 7, 'six enabled controls plus disabled mod sample');
    await screenshot(bundle === 'bundle-before' ? 'before-smatchet-1440' : 'after-smatchet-1440');
    if (bundle === 'bundle-before') {
      await c('Emulation.setDeviceMetricsOverride', {
        width: 1000,
        height: 1100,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await screenshot('before-smatchet-1000');
      await c('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1100,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    results.push({ bundle, sliders: await sliders() });
  }
  const themes = [
    'midnight',
    'violet-grove',
    'halloween',
    'blue-hour',
    'nexus',
    'hatchet',
    'smatchet',
    'chaos',
    'terminal',
  ];
  for (const width of [1440, 1000]) {
    await c('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const theme of themes) {
      await evaluate(`window.rangeSetTheme(${JSON.stringify(theme)})`);
      await settle();
      const ranges = await sliders();
      const accent = await evaluate(
        `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`,
      );
      assert.equal(
        await evaluate(`document.documentElement.scrollWidth <= innerWidth`),
        true,
        'no horizontal page overflow',
      );
      for (const r of ranges) {
        assert.equal(r.height, 28, `${r.control} hit height`);
        assert.equal(r.border, '0px', `${r.control} must not inherit text field border`);
        assert.equal(r.padding, '0px', `${r.control} must not inherit text field padding`);
        assert.equal(r.appearance, 'none');
        assert.ok(r.x >= 0 && r.x + r.width <= width, `${r.control} stays within viewport`);
      }
      results.push({ theme, width, accent, ranges });
      if (['smatchet', 'halloween', 'hatchet'].includes(theme))
        await screenshot(`after-${theme}-${width}`);
    }
  }
  await evaluate(`window.rangeSetTheme('smatchet')`);
  await settle();
  await focus('chat');
  await key('Home', 36);
  assert.equal(await evaluate(`${select('chat')}.value`), '0');
  await screenshot('after-chat-min-focus');
  await key('End', 35);
  assert.equal(await evaluate(`${select('chat')}.value`), '2');
  await screenshot('after-chat-max-focus');
  await key('ArrowLeft', 37);
  assert.equal(await evaluate(`${select('chat')}.value`), '1.9');
  for (const [control, maximum] of [
    ['depth', '2'],
    ['minion', '2'],
    ['curator', '0.5'],
    ['dreams', '100'],
    ['mod', '100'],
  ]) {
    await focus(control);
    await key('End', 35);
    assert.equal(
      await evaluate(`${select(control)}.value`),
      maximum,
      `${control} keyboard maximum`,
    );
    await focus(control);
    await key('Home', 36);
    assert.equal(await evaluate(`${select(control)}.value`), '0', `${control} keyboard minimum`);
    const r = (await sliders()).find((r) => r.control === control);
    const x = r.x + r.width / 2,
      y = r.y + r.height / 2;
    await c('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await c('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: r.x + r.width - 7,
      y,
      button: 'left',
      buttons: 1,
    });
    await c('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: r.x + r.width - 7,
      y,
      button: 'left',
      clickCount: 1,
    });
    await settle();
    assert.equal(await evaluate(`${select(control)}.value`), maximum, `${control} pointer drag`);
  }
  const puts = await evaluate(`window.rangeEvidence.requests.filter(r=>r.startsWith('PUT'))`);
  for (const suffix of [
    'minion-settings',
    'minion-model-selection',
    'settings/curator',
    'dream-settings',
  ])
    assert.ok(
      puts.some((r) => r.endsWith(suffix)),
      suffix + ' saved',
    );
  await evaluate(`window.rangeSetLocked(true)`);
  await settle();
  assert.equal(await evaluate(`${select('chat')}.disabled`), true);
  assert.equal(await evaluate(`getComputedStyle(${select('chat')}).opacity`), '0.5');
  await screenshot('after-chat-disabled');
  await evaluate(`window.rangeSetLocked(false); window.rangeSetSaving(true)`);
  await settle();
  assert.equal(await evaluate(`${select('chat')}.disabled`), true);
  assert.equal(await evaluate(`getComputedStyle(${select('chat')}).opacity`), '1');
  await screenshot('after-chat-saving');
  assert.deepEqual(await evaluate(`window.rangeEvidence.errors`), []);
  results.push({
    interactionChecks:
      'PASS: keyboard endpoints, step, pointer dragging, settings saves, disabled/save-only styles',
    puts,
  });
  await c('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  await screenshot('after-forced-colors');
  assert.equal(await evaluate(`getComputedStyle(${select('chat')}).appearance`), 'auto');
  results.push({ forcedColors: 'native appearance restored' });
  await writeFile(join(evidence, 'results.json'), JSON.stringify(results, null, 2));
  console.log(
    'PASS: 7 sliders, 9 themes at 1440/1000, keyboard/pointer/save/disabled/forced-color checks',
  );
} finally {
  try {
    await transport.call('Browser.close');
  } catch {}
  if (browser.exitCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([once(browser, 'exit'), new Promise((r) => setTimeout(r, 2000))]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  }
  await rm(profile, { recursive: true, force: true });
}
