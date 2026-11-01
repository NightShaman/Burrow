// Owned fixture only: temporary profile/server, CDP over pipe, no live app.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const profile = await mkdtemp(join(homedir(), 'ui-owned-chromium-'));
const server = spawn('python3', ['scripts/agent-reference-fixture/serve.py']);
let browser;
try {
  const line = await new Promise((resolve, reject) => {
    server.stdout.once('data', (d) => resolve(String(d)));
    server.once('error', reject);
  });
  const port = /PORT=(\d+)/.exec(line)[1];
  browser = spawn(
    'chromium',
    [
      '--headless',
      '--no-sandbox',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-first-run',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  let id = 0,
    buffer = '';
  const pending = new Map();
  browser.stdio[4].on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\0')) >= 0) {
      const text = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!text) continue;
      const m = JSON.parse(text);
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    }
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`CDP timeout ${method}`));
      }, 10000);
      pending.set(key, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      browser.stdio[3].write(
        JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0',
      );
    });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const c = (method, params) => call(method, params, sessionId);
  await c('Page.enable');
  await c('Page.navigate', { url: `http://127.0.0.1:${port}/after/` });
  const evaluate = async (expression) => {
    const r = await c('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  for (let i = 0; i < 50; i++) {
    if (await evaluate("!!document.querySelector('.settings-blank-slate')")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const output = process.argv[2] || '/tmp/agent-reference-acceptance';
  await mkdir(output, { recursive: true });
  const wait = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Wait failed ' + expression);
  };
  const shot = async (name) => {
    const image = await c('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(output, name + '.png'), Buffer.from(image.data, 'base64'));
  };
  const results = [];
  const pasteMode = process.argv.includes('--paste');
  const desktopWidth = Number(process.argv[3] || 1440);
  const desktopHeight = Number(process.argv[4] || 1000);
  results.push({ desktopWidth, desktopHeight, entrance: pasteMode ? 'clipboard' : 'picker' });
  await c('Emulation.setDeviceMetricsOverride', {
    width: desktopWidth,
    height: desktopHeight,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await c('Page.navigate', { url: `http://127.0.0.1:${port}/before/` });
  await wait("!!document.querySelector('.agent-profile')");
  await wait('!document.querySelector(\'[aria-label="Upload reference photo"]\')?.disabled');
  await shot('before-desktop');
  await c('Page.navigate', { url: `http://127.0.0.1:${port}/after/` });
  await wait('document.querySelector(\'[aria-label="Upload reference photo"]\')?.disabled===false');
  await shot('after-empty-desktop');
  // Local synthetic portrait bytes: no paid generation or backend request.
  const portrait = await evaluate(
    `(()=>{const canvas=document.createElement('canvas');canvas.width=180;canvas.height=260;const x=canvas.getContext('2d');x.fillStyle='#252341';x.fillRect(0,0,180,260);x.fillStyle='#d946ef';x.beginPath();x.arc(90,88,48,0,Math.PI*2);x.fill();x.fillRect(35,145,110,100);return canvas.toDataURL('image/png');})()`,
  );
  const choose = async (filename) =>
    evaluate(
      `(()=>{const content=${JSON.stringify(portrait)};const bytes=Uint8Array.from(atob(content.split(',')[1]),c=>c.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([bytes],${JSON.stringify(filename)},{type:'image/png'}));const input=document.querySelector('[aria-label="Upload reference photo"]');${pasteMode ? `const target=document.querySelector('[aria-label="Reference photo file"]');target.focus();target.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));` : `input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));`}})()`,
    );
  await choose('Canonical reference portrait — original composition.png');
  await wait("!!document.querySelector('.agent-reference-preview img')");
  await shot('after-photo-desktop');
  results.push(
    await evaluate(
      "(()=>{const e=document.querySelector('.agent-reference-preview img');return {previewWidth:e.naturalWidth,previewHeight:e.naturalHeight,objectFit:getComputedStyle(e).objectFit,sectionCount:document.querySelectorAll('.setting-section').length,overflow:document.documentElement.scrollWidth>innerWidth};})()",
    ),
  );
  await evaluate("document.querySelector('#fail-writes').click()");
  await choose('replacement.png');
  await wait("document.body.textContent.includes('Fixture upload unavailable')");
  await shot('after-error-desktop');
  await evaluate(
    "document.querySelector('#fail-writes').click();[...document.querySelectorAll('button')].find(e=>e.textContent==='Retry saving reference photo').click()",
  );
  await wait(
    "!document.body.textContent.includes('Fixture upload unavailable') && document.body.textContent.includes('Reference photo saved.')",
  );
  await evaluate(
    "[...document.querySelectorAll('.agent-toolbar-selector button')].find(e=>e.textContent==='Ember').click()",
  );
  await wait("document.querySelector('[aria-label=\"Reference photo file\"]')?.value===''");
  await evaluate(
    "[...document.querySelectorAll('.agent-toolbar-selector button')].find(e=>e.textContent==='Echo').click()",
  );
  await wait(
    "document.querySelector('[aria-label=\"Reference photo file\"]')?.value==='replacement.png'",
  );
  for (const width of [1024, 600, 375]) {
    await c('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await new Promise((r) => setTimeout(r, 80));
    await shot('after-photo-' + width);
    results.push(
      await evaluate(
        `({width:${width},scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,photoControlWidth:document.querySelector('.agent-reference-preview').getBoundingClientRect().width})`,
      ),
    );
  }
  await c('Emulation.setDeviceMetricsOverride', {
    width: desktopWidth,
    height: desktopHeight,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(
    "[...document.querySelectorAll('button')].find(e=>e.textContent==='Remove reference photo').click()",
  );
  await wait("document.body.textContent.includes('Reference photo removed.')");
  await shot('after-remove-desktop');
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, results }));
} finally {
  browser?.kill('SIGTERM');
  server.kill('SIGTERM');
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
