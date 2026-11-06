import { browserPipe } from '../fidgit-settings-fixture/browser-pipe.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const evidence = process.env.AUDIT_EVIDENCE_DIR ?? '/tmp/hatchet-audit-20261106/ui/browser';
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'audit-remediation-chromium-'));
const server = spawn('python3', ['scripts/audit-remediation-fixture/serve.py'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser, pipe;
const observations = [],
  exceptions = [],
  network = [];
let port, evaluate;
try {
  const line = await new Promise((resolve, reject) => {
    server.stdout.once('data', (chunk) => resolve(String(chunk)));
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Fixture server exited ${code}`)));
  });
  port = /PORT=(\d+)/.exec(line)?.[1];
  if (!port) throw new Error('Fixture did not advertise port');
  browser = spawn(
    process.env.CHROMIUM_BIN ?? 'chromium',
    [
      '--headless',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-first-run',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] },
  );
  pipe = browserPipe(browser, {
    binary: process.env.CHROMIUM_BIN ?? 'chromium',
    onEvent: (message) => {
      if (message.method === 'Runtime.exceptionThrown')
        exceptions.push(message.params.exceptionDetails);
      if (message.method === 'Network.requestWillBeSent') network.push(message.params.request.url);
    },
  });
  await pipe.ready();
  const { targetId } = await pipe.call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await pipe.call('Target.attachToTarget', { targetId, flatten: true });
  const c = (method, params = {}) => pipe.call(method, params, sessionId);
  await c('Page.enable');
  await c('Runtime.enable');
  await c('Network.enable');
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  evaluate = async (expression) => {
    const r = await c('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 70; i++) {
      try {
        if (await evaluate(expression)) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('Timed out waiting ' + expression);
  };
  const note = async (id, expression) => {
    const result = await evaluate(expression);
    observations.push({ id, result });
    return result;
  };
  const screenshot = async (id) => {
    const r = await c('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(evidence, `${id}.png`), Buffer.from(r.data, 'base64'));
  };
  const nav = async (route) => {
    await c('Page.navigate', { url: `http://127.0.0.1:${port}/?${route}` });
    await wait('!!window.fixtureEvidence && document.body.innerText.length > 50');
  };
  const click = async (selector, label) =>
    evaluate(
      `(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];const e=nodes.find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e)throw Error('Missing '+${JSON.stringify(label)});e.click();return true})()`,
    );
  const setInput = async (selector, value) =>
    evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input '+${JSON.stringify(selector)});const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return e.value})()`,
    );
  await nav('route=auth&mode=basic');
  await wait("document.querySelector('[role=status]')?.textContent!=='Discovering…'");
  await screenshot('after-api01-basic');
  await note('API01-basic', "document.querySelector('[role=status]').textContent");
  await nav('route=auth&mode=none');
  await wait("document.querySelector('[role=status]')?.textContent!=='Discovering…'");
  await screenshot('after-api01-none');
  await note('API01-none', "document.querySelector('[role=status]').textContent");
  await nav('route=auth&mode=invalid');
  await wait("document.querySelector('[role=status]')?.textContent==='auth_discovery_failed'");
  await screenshot('after-api01-invalid');
  await note('API01-invalid', "document.querySelector('[role=status]').textContent");
  await nav('route=app');
  await new Promise((resolve) => setTimeout(resolve, 850));
  await screenshot('after-ui03-right-only');
  await note(
    'UI03-right-only',
    "({workspaceRequests:window.fixtureEvidence.requests.filter(r=>r.path.startsWith('/api/workspace/files')),errors:window.fixtureEvidence.errors,right:document.querySelector('.right-rail')?.textContent.slice(0,150),left:document.querySelector('.left-rail')?.textContent.slice(0,100)})",
  );
  await note(
    'UI01-UI02-chat-readiness',
    "({composer:!!document.querySelector('#chat-message'),send:document.querySelector('button[aria-label]')?.disabled,session:document.body.innerText.slice(0,250)})",
  );
  await setInput('#chat-message', 'Synthetic chat user message');
  await wait('!document.querySelector(\'button[aria-label="Send message"]\')?.disabled');
  await screenshot('after-ui01-before-send');
  await evaluate('document.querySelector(\'button[aria-label="Send message"]\')?.click()');
  await wait('window.fixtureChatStreamStarted()');
  await wait("document.body.innerText.includes('Synthetic partial answer before failed stream')");
  await screenshot('after-ui01-partial');
  await note(
    'UI01-partial',
    "document.body.innerText.includes('Synthetic partial answer before failed stream')",
  );
  await evaluate('window.fixtureFailChat()');
  await wait("document.body.innerText.includes('Synthetic accepted stream interruption')");
  await screenshot('after-ui01-failed');
  await note(
    'UI01-refresh',
    "({conversation:window.fixtureEvidence.requests.filter(r=>r.path.startsWith('/api/sessions/default')),error:document.body.innerText.includes('Synthetic accepted stream interruption'),assistant:document.body.innerText.includes('Synthetic partial answer before failed stream')})",
  );
  await nav('route=app');
  await wait("!!document.querySelector('#chat-session option[value=second]')");
  await setInput('#chat-message', 'Synthetic delayed A failure');
  await evaluate('document.querySelector(\'button[aria-label="Send message"]\')?.click()');
  await wait('window.fixtureChatStreamStarted()');
  await evaluate(
    "(()=>{const e=document.querySelector('#chat-session');e.value='second';e.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  await wait("document.querySelector('#chat-session')?.value==='second'");
  await screenshot('after-ui02-B-before-A-failure');
  await evaluate('window.fixtureFailChat()');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await screenshot('after-ui02-B-after-A-failure');
  await note(
    'UI02-B',
    "({session:document.querySelector('#chat-session')?.value,leak:document.body.innerText.includes('Synthetic accepted stream interruption'),originRefresh:window.fixtureEvidence.requests.filter(r=>r.path.startsWith('/api/sessions/default'))})",
  );
  await evaluate(
    "(()=>{const e=document.querySelector('#chat-session');e.value='default';e.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  await wait("document.querySelector('#chat-session')?.value==='default'");
  await screenshot('after-ui02-A-error');
  await note(
    'UI02-A',
    "document.body.innerText.includes('Synthetic accepted stream interruption')",
  );
  await nav('route=first-run');
  await wait("!!document.querySelector('.agent-wizard')");
  await screenshot('after-clean03-mandatory-start');
  await click('button', 'Start fresh');
  await click('button', 'Next');
  await setInput('input[placeholder=Luna]', 'Fixture agent');
  await click('button', 'Next');
  await click('button', 'Next');
  await wait(
    "[...document.querySelectorAll('.oauth-trigger')].some(e=>e.textContent.includes('OpenAI'))",
  );
  await screenshot('after-clean03-before-oauth');
  await evaluate(
    "[...document.querySelectorAll('.oauth-trigger')].find(e=>e.textContent.includes('OpenAI'))?.click()",
  );
  await wait("!!document.querySelector('.oauth-modal')");
  await screenshot('after-clean03-oauth-open');
  await c('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await c('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await new Promise((resolve) => setTimeout(resolve, 240));
  await screenshot('after-clean03-escape');
  await note(
    'CLEAN03-escape',
    "({nested:!!document.querySelector('.oauth-modal'),mandatory:!!document.querySelector('.agent-wizard'),requests:window.fixtureEvidence.requests})",
  );
  await nav('route=archive');
  await wait("document.body.innerText.includes('Fixture card A')");
  await click(
    '.tiddle-archive-card',
    'hatchetFixture card ASynthetic continuity evidence.2repeatsWarm',
  ).catch(async () => {
    await evaluate("document.querySelector('.tiddle-archive-card')?.click()");
  });
  await wait("document.body.innerText.includes('Load more history')");
  await click('button', 'Load more history');
  await wait('!!window.fixtureReleaseHistory');
  await screenshot('after-uiarc01-A-pending');
  await evaluate("document.querySelectorAll('.tiddle-archive-card')[1].click()");
  await wait(
    "document.body.innerText.includes('Fixture card B') && document.querySelector('.tiddle-archive-card.selected')?.textContent.includes('Fixture card B')",
  );
  await evaluate('window.fixtureReleaseHistory()');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await screenshot('after-uiarc01-B');
  await note(
    'UIARC01-B',
    "[...document.querySelectorAll('button')].filter(e=>/history/i.test(e.textContent)).map(e=>({text:e.textContent.trim(),disabled:e.disabled}))",
  );
  await nav('route=tasks');
  await wait("document.body.innerText.includes('Initial task')");
  await screenshot('after-uitask01-list');
  await note(
    'UITASK01-controls',
    "[...document.querySelectorAll('button')].filter(e=>/project|initial task|edit/i.test(e.textContent)).map(e=>({text:e.textContent.trim(),title:e.title,aria:e.getAttribute('aria-label')})).slice(0,20)",
  );
  await evaluate("document.querySelector('.task-card')?.click()");
  await wait("!!document.querySelector('.task-detail-form input[name=title]')");
  await setInput('.task-detail-form input[name=title]', 'Submitted task');
  await evaluate('window.fixtureHoldSave()');
  await click('.task-detail-form button', 'Save changes');
  await wait("document.querySelector('.task-detail-form button.primary')?.disabled");
  await setInput('.task-detail-form input[name=title]', 'New unsaved task work');
  await screenshot('after-uitask01-pending-task');
  await evaluate('window.fixtureReleaseSave()');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await screenshot('after-uitask01-reconciled-task');
  await note(
    'UITASK01-task',
    "({title:document.querySelector('.task-detail-form input[name=title]')?.value ?? null, submitted:window.fixtureEvidence.requests.find(r=>r.method==='PATCH'&&r.path.includes('/tasks/'))?.body.title})",
  );
  await click('button', 'Manage projects');
  await wait(
    "document.body.innerText.includes('Initial project') && !!document.querySelector('.project-manager-content')",
  );
  await note(
    'UITASK01-project-controls',
    "[...document.querySelectorAll('.project-manager-content button')].map(e=>e.textContent.trim()).slice(0,12)",
  );
  await click('.project-manager-content button', 'Edit');
  await wait("!!document.querySelector('.project-form input')");
  await setInput('.project-form input', 'Submitted project');
  await evaluate('window.fixtureHoldSave()');
  await click('button', 'Save project');
  await wait("document.querySelector('.project-form button.primary')?.disabled");
  await setInput('.project-form input', 'New unsaved project work');
  await screenshot('after-uitask01-pending-project');
  await evaluate('window.fixtureReleaseSave()');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await screenshot('after-uitask01-reconciled-project');
  await note(
    'UITASK01-project',
    "({name:document.querySelector('.project-form input')?.value ?? null, submitted:window.fixtureEvidence.requests.find(r=>r.method==='PATCH'&&r.path.includes('/projects/'))?.body.name})",
  );
  await nav('route=settings');
  await wait("!!window.fixtureSetTab && document.body.innerText.includes('SETTINGS')");
  await screenshot('after-settings-landing');
  await note(
    'settings-nav',
    "[...document.querySelectorAll('button')].filter(e=>/Agent|Model|Mod|Dream|Rail/i.test(e.textContent)).map(e=>e.textContent.trim()).slice(0,50)",
  );
  await evaluate("window.fixtureSetOwnerOnly(true);window.fixtureSetTab('general')");
  await new Promise((resolve) => setTimeout(resolve, 160));
  await click('button', 'Rail panels');
  await new Promise((resolve) => setTimeout(resolve, 220));
  await screenshot('after-ui05-owner');
  await note(
    'UI05-owner',
    "({ownerPanel:!![...document.querySelectorAll('.settings-content-workspace select')].find(e=>[...e.options].some(o=>o.value==='owner-agents:fixture-extension')),agentPreferences:!!document.querySelector('.agent-sidebar-order-list'),primary:document.body.innerText.includes('Rail Panels')})",
  );
  await evaluate("window.fixtureSetOwnerOnly(false);window.fixtureSetTab('general')");
  await click('button', 'Rail panels');
  await wait("!!document.querySelector('.agent-sidebar-order-list')");
  await screenshot('after-ui04-reorder-before');
  await evaluate(
    "document.querySelectorAll('.agent-sidebar-order-list [role=listitem]')[1]?.focus()",
  );
  await c('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowUp',
    code: 'ArrowUp',
    windowsVirtualKeyCode: 38,
    modifiers: 1,
  });
  await c('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowUp',
    code: 'ArrowUp',
    windowsVirtualKeyCode: 38,
    modifiers: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 160));
  await note(
    'UI04-keyboard-reorder',
    "({top:[...document.querySelectorAll('.agent-sidebar-order-list [role=listitem]')].slice(0,2).map(e=>e.getAttribute('aria-label')),announcement:document.querySelector('.agent-sidebar-order-announcement')?.textContent,focus:document.activeElement?.getAttribute('aria-label')})",
  );
  await screenshot('after-ui04-reorder-after');
  await evaluate("window.fixtureSetTab('agents')");
  await new Promise((resolve) => setTimeout(resolve, 250));
  await screenshot('after-ui04-agents');
  await note(
    'minion-placement',
    "({primary:[...document.querySelectorAll('.settings-content-workspace .setting-section h2')].some(e=>e.textContent.trim()==='Minion settings'),support:[...document.querySelectorAll('.settings-prototype-overflow .setting-section h2')].some(e=>e.textContent.trim()==='Minion settings')})",
  );
  await note(
    'UI04-controls',
    "[...document.querySelectorAll('button')].filter(e=>/Move up|Move down/i.test(e.textContent+' '+e.getAttribute('aria-label'))).map(e=>({text:e.textContent.trim(),aria:e.getAttribute('aria-label')})).slice(0,10)",
  );
  await click('button', 'Dreams').catch(() => {});
  await screenshot('after-dream-placement');
  await note(
    'dream-placement',
    "({primary:!!document.querySelector('.settings-content-workspace .dream-settings-fields'),support:!!document.querySelector('.settings-prototype-overflow .dream-settings-fields')})",
  );
  await evaluate("window.fixtureSetTab('connections')");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await note(
    'connections-nav',
    "[...document.querySelectorAll('button')].filter(e=>/Model|provider/i.test(e.textContent)).map(e=>e.textContent.trim()).slice(0,20)",
  );
  await click('button', 'Models');
  await wait("!!document.querySelector('.models-workspace')");
  await screenshot('after-set02-set03-models');
  await note(
    'SET02-SET03-controls',
    "({select:!!document.querySelector('#models-connection-fields select'),keys:document.querySelectorAll('#models-connection-fields input[type=password]').length,save:[...document.querySelectorAll('.models-workspace button')].some(e=>e.textContent.trim()==='Save')})",
  );
  await setInput('#models-connection-fields input[placeholder=OpenAI]', 'Fixture pending provider');
  await setInput(
    '#models-connection-fields input[placeholder="https://api.example.com/v1"]',
    'https://fixture.invalid/v1',
  );
  await setInput('#models-connection-fields input[type=password]', 'old-fixture-key');
  await click('.models-connection-editor button', 'Connect');
  await wait("!!document.querySelector('#manual-model-id')");
  await setInput('#manual-model-id', 'fixture-model-id');
  await click('button', 'Add model');
  await wait(
    "![...document.querySelectorAll('.models-workspace button')].find(e=>e.textContent.trim()==='Save')?.disabled",
  );
  await evaluate('window.fixtureDelayModelSave()');
  await click('button', 'Save');
  await wait(
    "[...document.querySelectorAll('.models-workspace button')].some(e=>e.textContent.trim()==='Saving…')",
  );
  await note(
    'SET02-SET03-pending',
    "({type:document.querySelector('#models-connection-fields select')?.disabled,key:document.querySelector('#models-connection-fields input[type=password]')?.disabled,requests:window.fixtureEvidence.requests.filter(r=>r.path==='/api/settings/model-connections'&&r.method==='POST').length})",
  );
  await setInput('#models-connection-fields input[type=password]', 'new-fixture-key');
  await evaluate(
    "(()=>{const e=document.querySelector('#models-connection-fields select');e.value='anthropic-messages';e.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  await note(
    'SET02-SET03-edited-during-save',
    "({type:document.querySelector('#models-connection-fields select')?.value,key:document.querySelector('#models-connection-fields input[type=password]')?.value})",
  );
  await screenshot('after-set02-set03-pending');
  await evaluate('window.fixtureReleaseModelSave()');
  await wait(
    "[...document.querySelectorAll('.models-workspace button')].some(e=>e.textContent.trim()==='Save')",
  );
  await screenshot('after-set02-set03-saved');
  await note(
    'SET02-next-save-state',
    "({save:[...document.querySelectorAll('.models-workspace button')].find(e=>e.textContent.trim()==='Save')?.disabled,requestState:document.querySelector('.settings-request-error')?.textContent ?? ''})",
  );
  await note(
    'SET02-SET03-after',
    "({type:document.querySelector('#models-connection-fields select')?.value,key:document.querySelector('#models-connection-fields input[type=password]')?.value,posted:window.fixtureEvidence.requests.filter(r=>r.path==='/api/settings/model-connections'&&r.method==='POST').map(r=>({apiType:r.body.apiType,key:r.body.apiKey}))})",
  );
  await click('button', 'Save');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await note(
    'SET02-second-post',
    "({count:window.fixtureEvidence.requests.filter(r=>r.path==='/api/settings/model-connections'&&r.method==='POST').length,error:document.querySelector('.settings-request-error')?.textContent??''})",
  );
  await screenshot('after-set02-second-save');
  await evaluate("window.fixtureSetTab('mods')");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await screenshot('after-set01-mods-nav');
  await click('button', 'Fixture extension');
  await wait(
    "!!document.querySelector('.settings-content-workspace input') || document.body.innerText.includes('Fixture extension overview')",
  );
  await click('button', 'Form');
  await wait("!!document.querySelector('.settings-content-workspace input')");
  await screenshot('after-set01-form');
  await setInput('.settings-content-workspace input', 'Unsaved declarative edit');
  await screenshot('after-set01-dirty');
  await note(
    'SET01-beforeunload',
    "(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()",
  );
  await click('.settings-prototype-menu button', 'Mods');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await screenshot('after-set01-navigation-attempt');
  await note(
    'SET01-navigation',
    "({guard:document.body.innerText.includes('Unsaved'),value:document.querySelector('.settings-content-workspace input')?.value})",
  );
  await note(
    'SET01-form-controls',
    "({input:document.querySelector('.settings-content-workspace input')?.value,save:[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Save form')})",
  );
  await note(
    'mods-controls',
    "[...document.querySelectorAll('button')].filter(e=>/Fixture|Form|Mod/i.test(e.textContent)).map(e=>e.textContent.trim()).slice(0,35)",
  );
  await note('runtime-errors', 'window.fixtureEvidence.errors');
  const disallowed = network.filter(
    (url) =>
      !url.startsWith(`http://127.0.0.1:${port}/`) &&
      !url.startsWith('data:') &&
      !url.startsWith(`blob:http://127.0.0.1:${port}/`),
  );
  observations.push({ id: 'network-origin-violation', result: disallowed });
  await writeFile(
    join(evidence, 'results.json'),
    JSON.stringify(
      {
        port,
        viewport: { width: 1920, height: 1200 },
        observations,
        exceptions,
        network,
        outcome: 'completed',
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ port, observations, exceptions: exceptions.length, disallowed }, null, 2),
  );
} catch (error) {
  console.error(error);
  try {
    observations.push({
      id: 'failure-dom',
      result: await evaluate('document.body.innerText.slice(0,5000)'),
    });
  } catch {}
  await writeFile(
    join(evidence, 'results.json'),
    JSON.stringify(
      {
        port,
        viewport: { width: 1920, height: 1200 },
        observations,
        exceptions,
        network,
        outcome: 'failed',
        error: String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  browser?.kill();
  server.kill();
  await rm(profile, { recursive: true, force: true });
}
