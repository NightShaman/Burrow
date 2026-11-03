// Isolated real-component browser acceptance. No live backend or user data.
import { clientClipBox } from './client-clip.mjs';
import { browserPipe } from './browser-pipe.mjs';
import { auditAgentToolbar } from './agent-toolbar-audit.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const profile = await mkdtemp(join(tmpdir(), 'fidgit-chromium-'));
const evidence = process.env.FIDGIT_EVIDENCE_DIR || 'scripts/fidgit-settings-fixture/evidence';
await mkdir(evidence, { recursive: true });
const server = spawn('python3', ['scripts/fidgit-settings-fixture/serve.py']);
let browser, transport, captureFailure, captureRuntimeErrors;
const runtimeExceptions = [];
const results = [];
const geometryFailures = [];
const auditFailures = [];
const recordGeometry = (error) => {
  geometryFailures.push(String(error));
  results.push({ geometryFailure: String(error) });
};
try {
  const line = await new Promise((resolve, reject) => {
    server.stdout.once('data', (d) => resolve(String(d)));
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Fixture server exited ${code}`)));
  });
  const port = /PORT=(\d+)/.exec(line)?.[1];
  if (!port) throw new Error('No fixture port');
  browser = spawn(
    process.env.CHROMIUM_BIN || 'chromium',
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
  transport = browserPipe(browser, {
    binary: process.env.CHROMIUM_BIN || 'chromium',
    onEvent: (message) => {
      if (message.method === 'Runtime.exceptionThrown')
        runtimeExceptions.push(message.params.exceptionDetails);
    },
  });
  await transport.ready();
  const call = transport.call;
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' }),
    { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const c = (method, params = {}) => call(method, params, sessionId);
  const evaluate = async (expression) => {
    const r = await c('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  captureRuntimeErrors = async () => ({
    windowErrors: await evaluate('window.fixtureEvidence?.errors ?? []'),
    runtimeExceptions,
  });
  const pause = () => new Promise((r) => setTimeout(r, 120));
  const wait = async (expression) => {
    for (let i = 0; i < 80; i++) {
      if (await evaluate(expression)) return;
      await pause();
    }
    throw new Error('Timed out: ' + expression);
  };
  const click = async (label, selector = 'button') => {
    await evaluate(
      `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e)throw new Error('Missing control '+${JSON.stringify(label)});e.click()})()`,
    );
    await pause();
  };
  const chooseAgent = async (name) => {
    await evaluate(
      `(()=>{if(document.querySelector('.agent-toolbar select'))throw new Error('Agent dropdown is forbidden');const button=[...document.querySelectorAll('.agent-toolbar [data-agent-id]')].find(e=>e.textContent.trim()===${JSON.stringify(name)});if(!button)throw new Error('Missing agent button '+${JSON.stringify(name)});button.click();})()`,
    );
    await pause();
  };
  const clickSelector = async (selector) => {
    await evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing '+${JSON.stringify(selector)});e.click()})()`,
    );
    await pause();
  };
  const screenshot = async (name) => {
    const result = await c('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(join(evidence, `${name}.png`), Buffer.from(result.data, 'base64'));
  };
  captureFailure = async () => {
    await screenshot('failure');
    await writeFile(join(evidence, 'failure-dom.txt'), await evaluate('document.body.innerText'));
  };
  // Reveal through native scrolling, then test the visible intersection, not only an inner list.
  const revealAndCheck = async (selector, name, width) => {
    await evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing reachability target');e.scrollIntoView({block:'nearest',inline:'nearest'});})()`,
    );
    await pause();
    const visibility = await evaluate(
      `(()=>{const clientBox=${clientClipBox.toString()};const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();let clip={left:0,top:0,right:document.documentElement.clientWidth,bottom:document.documentElement.clientHeight};const ancestors=[];let painted=true;for(let a=e;a;a=a.parentElement){const s=getComputedStyle(a);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)painted=false;}for(let a=e.parentElement;a;a=a.parentElement){const s=getComputedStyle(a),b=a.getBoundingClientRect(),root=a===document.documentElement||a===document.scrollingElement,cb=clientBox({root,rect:b,clientLeft:a.clientLeft,clientTop:a.clientTop,clientWidth:a.clientWidth,clientHeight:a.clientHeight,viewportWidth:document.documentElement.clientWidth,viewportHeight:document.documentElement.clientHeight});const x=['hidden','clip','auto','scroll'].includes(s.overflowX),y=['hidden','clip','auto','scroll'].includes(s.overflowY);if(x){clip.left=Math.max(clip.left,cb.left);clip.right=Math.min(clip.right,cb.right);}if(y){clip.top=Math.max(clip.top,cb.top);clip.bottom=Math.min(clip.bottom,cb.bottom);}if(x||y)ancestors.push({tag:a.tagName,id:a.id,className:a.className,root,x,y,rect:{left:b.left,top:b.top,right:b.right,bottom:b.bottom},client:{left:a.clientLeft,top:a.clientTop,width:a.clientWidth,height:a.clientHeight},scroll:{left:a.scrollLeft,top:a.scrollTop},clip:cb});}return {target:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},clip,ancestors,visible:painted&&r.width>0&&r.height>0&&r.left>=clip.left-2&&r.right<=clip.right+2&&r.top>=clip.top-2&&r.bottom<=clip.bottom+2}})()`,
    );
    results.push({ reachability: { name, width, ...visibility } });
    if (!visibility.visible)
      recordGeometry(
        new Error(
          'Target clipped after native reveal ' + JSON.stringify({ name, width, ...visibility }),
        ),
      );
  };
  const dimensions = async (name, width) => {
    await shellGeometry(name, width);
    await controlGeometry(name, width);
    await normalizedGeometry(name, width);
    await sizingGeometry(name, width);
    await familyGeometry(name, width);
    await schedulingGeometry(name, width);
    const continuity = await evaluate(
      "(()=>{const row=document.querySelector('.continuity-embedding-actions');if(!row)return null;return {width:row.clientWidth,gap:parseFloat(getComputedStyle(row).columnGap)||0,buttons:[...row.querySelectorAll('button')].map(e=>{const r=e.getBoundingClientRect();return {top:r.top,width:r.width}})}})()",
    );
    if (continuity) {
      results.push({ continuityActions: { name, width, ...continuity } });
      if (
        continuity.buttons.length !== 3 ||
        continuity.buttons.some((b) => b.width > 400) ||
        (continuity.width >=
          continuity.buttons.reduce((sum, b) => sum + b.width, 0) + continuity.gap * 2 &&
          continuity.buttons.some((b) => Math.abs(b.top - continuity.buttons[0].top) > 2))
      )
        recordGeometry(
          new Error(
            'Continuity actions not compact ' + JSON.stringify({ name, width, ...continuity }),
          ),
        );
    }
    const capabilitySeparators = await evaluate(
      `(()=>{const box=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}};return [...document.querySelectorAll('.model-capability-editor .model-capability-group,.model-capability-editor .model-output-limit')].map(e=>{const title=e.querySelector(':scope > .model-capability-title'),style=getComputedStyle(e),labelledBy=e.getAttribute('aria-labelledby');return {tag:e.tagName,title:title?.textContent.trim(),surface:box(e),titleBox:title?box(title):null,borderTop:parseFloat(style.borderTopWidth),paddingTop:parseFloat(style.paddingTop),legendCount:e.querySelectorAll('legend').length,accessibleName:labelledBy?labelledBy.split(/\\s+/).map(id=>document.getElementById(id)?.textContent.trim()).join(' '):null};});})()`,
    );
    if (capabilitySeparators.length) {
      results.push({ capabilitySeparators: { name, width, groups: capabilitySeparators } });
      if (
        capabilitySeparators.length !== 4 ||
        capabilitySeparators.some(
          (g) =>
            !g.titleBox ||
            g.borderTop < 1 ||
            g.paddingTop < 8 ||
            g.titleBox.top < g.surface.top + g.borderTop + 7 ||
            g.legendCount > 0 ||
            (g.tag === 'FIELDSET' && g.accessibleName !== g.title),
        )
      )
        recordGeometry(
          new Error(
            'Model capability title interrupts separator or loses accessible name ' +
              JSON.stringify({ name, width, capabilitySeparators }),
          ),
        );
    }
    const modelOverflow = await evaluate(
      "[...document.querySelectorAll('.models-workspace,.model-capability-editor,.model-options')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({className:e.className,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth})).filter(e=>e.scrollWidth>e.clientWidth+2)",
    );
    if (modelOverflow.length)
      recordGeometry(
        new Error('Nested Models overflow ' + JSON.stringify({ name, width, modelOverflow })),
      );

    const contentChecks = await evaluate(
      `(()=>{const clientBox=${clientClipBox.toString()};const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}};const visibleRect=e=>{const r=rect(e);r.top=Math.max(r.top,0);r.left=Math.max(r.left,0);r.right=Math.min(r.right,document.documentElement.clientWidth);r.bottom=Math.min(r.bottom,document.documentElement.clientHeight);for(let a=e.parentElement;a;a=a.parentElement){const style=getComputedStyle(a),b=a.getBoundingClientRect(),cb=clientBox({root:a===document.documentElement||a===document.scrollingElement,rect:b,clientLeft:a.clientLeft,clientTop:a.clientTop,clientWidth:a.clientWidth,clientHeight:a.clientHeight,viewportWidth:document.documentElement.clientWidth,viewportHeight:document.documentElement.clientHeight});if(['hidden','clip','auto','scroll'].includes(style.overflowX)){r.left=Math.max(r.left,cb.left);r.right=Math.min(r.right,cb.right);}if(['hidden','clip','auto','scroll'].includes(style.overflowY)){r.top=Math.max(r.top,cb.top);r.bottom=Math.min(r.bottom,cb.bottom);}}return r;};const inventory=document.querySelector('.settings-prototype-overflow .memory-saved'),card=inventory?.querySelector('.memory-connection');const prompt=document.querySelector('.dream-settings-fields textarea'),support=prompt&&document.querySelector('.settings-prototype-overflow .setting-section');return {skill:inventory?.querySelector('input[type="search"]')&&card?{card:rect(card),band:rect(inventory.closest('.settings-prototype-overflow'))}:null,dream:prompt&&support?{prompt:visibleRect(prompt),support:visibleRect(support),unclippedPrompt:rect(prompt),unclippedSupport:rect(support)}:null}})()`,
    );
    results.push({ contentChecks: { name, width, ...contentChecks } });
    if (contentChecks.skill) {
      const { card, band } = contentChecks.skill;
      if (
        card.top < band.top - 2 ||
        card.bottom > band.bottom + 2 ||
        card.left < band.left - 2 ||
        card.right > band.right + 2
      )
        recordGeometry(
          new Error('First skill card clipped ' + JSON.stringify({ name, width, card, band })),
        );
    }
    if (
      contentChecks.dream &&
      Math.min(contentChecks.dream.prompt.right, contentChecks.dream.support.right) -
        Math.max(contentChecks.dream.prompt.left, contentChecks.dream.support.left) >
        2 &&
      Math.min(contentChecks.dream.prompt.bottom, contentChecks.dream.support.bottom) -
        Math.max(contentChecks.dream.prompt.top, contentChecks.dream.support.top) >
        2
    )
      recordGeometry(
        new Error(
          'Dream prompt overlaps secondary controls ' +
            JSON.stringify({ name, width, ...contentChecks.dream }),
        ),
      );

    const r = await evaluate(
      `(()=>{const rows=[...document.querySelectorAll('.settings-content-workspace .card-actions,.settings-content-workspace .model-actions,.settings-content-workspace .setting-actions,.settings-content-workspace .mod-actions,.settings-content-workspace .retention-actions')].filter(e=>e.getBoundingClientRect().width>0);const clipped=rows.flatMap(row=>[...row.querySelectorAll('button')].flatMap(button=>{const b=button.getBoundingClientRect(),issues=[];if(!b.width)return issues;for(let a=button.parentElement;a&&a!==document.body;a=a.parentElement){const style=getComputedStyle(a),r=a.getBoundingClientRect();if(['hidden','clip','auto','scroll'].includes(style.overflowX)&&(b.left<r.left-2||b.right>r.right+2))issues.push({button:button.textContent.trim(),ancestor:a.className,buttonLeft:b.left,buttonRight:b.right,left:r.left,right:r.right});}return issues;}));return {name:${JSON.stringify(name)},width:${width},pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,configuration:[...document.querySelectorAll('.settings-content-workspace,.models-workspace')].map(e=>({className:e.className,width:e.getBoundingClientRect().width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})),actionRows:rows.map(e=>({className:e.className,width:e.clientWidth,scrollWidth:e.scrollWidth})),clippedActions:clipped};})()`,
    );
    results.push(r);
    if (r.pageWidth > r.viewport + 1)
      recordGeometry(new Error('Horizontal page overflow ' + JSON.stringify(r)));
    if (r.actionRows.some((row) => row.scrollWidth > row.width + 2) || r.clippedActions.length)
      recordGeometry(new Error('Clipped actions ' + JSON.stringify(r)));
  };
  const sizingGeometry = async (name, width) => {
    const g = await evaluate(`(()=>{
   const root=document.querySelector('.settings-content-workspace');if(!root)return null;
   const visible=e=>{if(!e.getClientRects().length)return false;for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;}return e.getBoundingClientRect().width>0;};
   const content=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect(),left=r.left+e.clientLeft+parseFloat(s.paddingLeft);return {left,right:left+e.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight),width:e.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)};};
   const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
   const scoped=root.matches('.settings-content-standard,.settings-content-models')||(root.matches('.settings-content-extension')&&root.querySelector('.mod-settings-mount')?.dataset.settingsLayout!=='imperative');
   const panes=[...root.children].filter(e=>e.classList.contains('settings-blank-column')&&visible(e));
   const forms=panes.flatMap(p=>[...p.children].filter(e=>visible(e)&&e.matches('section,form,.settings-personalization-profile,.settings-personalization-appearance,.settings-profile-workspace,.mod-settings-mount')).map(e=>({className:e.className,box:box(e),allocated:content(p)})));
   if(scoped)for(const e of root.querySelectorAll('.setting-section,.settings-form,.settings-personalization-profile,.settings-personalization-appearance')){if(!visible(e)||forms.some(f=>f.className===e.className&&Math.abs(f.box.left-e.getBoundingClientRect().left)<1&&Math.abs(f.box.width-e.getBoundingClientRect().width)<1))continue;const p=e.parentElement,style=getComputedStyle(p);if(style.display==='grid'&&style.gridTemplateColumns.trim().split(' ').filter(Boolean).length>1)continue;if(style.display==='flex'&&style.flexDirection==='row'&&p.children.length>1)continue;forms.push({className:e.className,box:box(e),allocated:content(p)});}
   const controls=scoped?[...root.querySelectorAll('.field > input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]),.field > select,.field > textarea')].filter(visible).map(e=>({tag:e.tagName,type:e.type,label:e.parentElement.textContent.trim().slice(0,90),quantity:e.parentElement.classList.contains('settings-quantity-field'),box:box(e),allocated:content(e.parentElement),boxSizing:getComputedStyle(e).boxSizing})):[];
   const pairs=root.matches('.settings-content-standard,.settings-content-models')?[...root.querySelectorAll('.field-pair,.settings-field-pair')].filter(visible).map(e=>({className:e.className,gap:parseFloat(getComputedStyle(e).gap)})):[];
   const actions=root.matches('.settings-content-standard')?[...root.querySelectorAll('.card-actions,.model-actions,.setting-actions')].filter(visible).map(e=>({className:e.className,gap:parseFloat(getComputedStyle(e).gap)})):[];
   const sections=root.matches('.settings-content-standard')?[...root.querySelectorAll('.setting-section + .setting-section')].filter(visible).map(e=>({className:e.className,margin:parseFloat(getComputedStyle(e).marginTop)})):[];
   const fields=scoped?[...root.querySelectorAll('.field')].filter(visible).map(e=>({className:e.className,box:box(e),allocated:content(e.parentElement)})):[];
   const explicitActions=[...root.querySelectorAll('button.settings-action')].filter(visible).map(e=>{const style=getComputedStyle(e),range=document.createRange();range.selectNodeContents(e);const text=range.getBoundingClientRect();return {text:e.textContent.trim(),box:box(e),allocated:content(e.parentElement),justifySelf:style.justifySelf,textWidth:text.width,chromeWidth:parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+parseFloat(style.borderLeftWidth)+parseFloat(style.borderRightWidth),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth};});
   const profileField=root.querySelector('.operator-profile-actions > .field:only-child');const profileAllocation=profileField&&visible(profileField)?{field:box(profileField),allocated:content(profileField.parentElement)}:null;
   const range=root.querySelector('.curator-card input[type=range]');const curator=range&&visible(range)?{range:box(range),field:box(range.parentElement),allocated:content(range.closest('.curator-card'))}:null;
   const caps=scoped?[...root.querySelectorAll('.setting-section,.settings-form,.settings-personalization-profile,.settings-personalization-appearance,.field')].filter(visible).map(e=>({className:e.className,maxWidth:getComputedStyle(e).maxWidth})).filter(e=>e.maxWidth!=='none'):[];
   const separators=[];for(const e of [...panes,...root.querySelectorAll('.models-provider-column,.models-capabilities-workspace')]){if(!visible(e))continue;const c=getComputedStyle(e);if(parseFloat(c.borderRightWidth)>0&&e.matches('.settings-blank-column,.models-provider-column'))separators.push({className:e.className,side:'right',inset:parseFloat(c.paddingRight)});if(e.matches('.models-provider-column')&&parseFloat(c.borderBottomWidth)>0)separators.push({className:e.className,side:'bottom',inset:parseFloat(c.paddingBottom)});if(e.matches('.models-capabilities-workspace'))for(const [border,padding,side] of [['borderLeftWidth','paddingLeft','left'],['borderTopWidth','paddingTop','top']])if(parseFloat(c[border])>0)separators.push({className:e.className,side,inset:parseFloat(c[padding])});}
   const modelGaps=[...root.querySelectorAll('.models-workspace,.models-catalog-workspace')].filter(visible).map(e=>({className:e.className,gap:parseFloat(getComputedStyle(e).gap)}));
   const utility=document.querySelector('.settings-utility-panel'),utilityStyle=getComputedStyle(utility),rs=getComputedStyle(root);
   return {explicitActions,profileAllocation,separators,modelGaps,workspace:box(root),viewportWidth:innerWidth,insets:[rs.paddingTop,rs.paddingRight,rs.paddingBottom,rs.paddingLeft].map(parseFloat),statistics:{open:!!document.querySelector('.settings-fidgit.has-utility-panel'),visible:visible(utility),ariaHidden:utility.getAttribute('aria-hidden'),...box(utility)},caps,curator,composition:root.dataset.composition,extension:root.querySelector('.mod-settings-mount')?.dataset.settingsLayout,normalized:root.classList.contains('settings-content-normalized'),paneGap:parseFloat(getComputedStyle(root).gap),forms,controls,pairs,actions,sections,fields};
  })()`);
    if (!g) return;
    results.push({ sizingGeometry: { name, width, ...g } });
    const expectedInset = g.viewportWidth <= 850 ? 8 : g.viewportWidth <= 1200 ? 12 : 16;
    const failures = g.caps.map((c) => ({ rule: 'unexpected active form/field cap', ...c }));
    if (g.insets.some((i) => Math.abs(i - expectedInset) > 1))
      failures.push({ rule: 'equal responsive workspace insets', expectedInset, actual: g.insets });
    if (
      g.statistics.open &&
      (!g.statistics.visible ||
        g.statistics.ariaHidden !== 'false' ||
        (g.viewportWidth > 850
          ? g.workspace.right > g.statistics.left + 2
          : g.workspace.bottom > g.statistics.top + 2))
    )
      failures.push({
        rule: 'visible statistics reserve separate area',
        statistics: g.statistics,
        workspace: g.workspace,
      });
    if (!g.statistics.open && (g.statistics.visible || g.statistics.ariaHidden !== 'true'))
      failures.push({ rule: 'closed statistics actually hidden', statistics: g.statistics });
    for (const a of g.explicitActions)
      if (
        a.justifySelf !== 'end' ||
        a.box.width > a.textWidth + a.chromeWidth + 4 ||
        a.box.right > a.allocated.right + 2 ||
        a.scrollWidth > a.clientWidth + 2
      )
        failures.push({ rule: 'explicit action sizes to label', ...a });
    if (
      g.profileAllocation &&
      Math.abs(g.profileAllocation.field.width - g.profileAllocation.allocated.width) > 2
    )
      failures.push({ rule: 'sole profile field fills actions track', ...g.profileAllocation });
    if (
      g.curator &&
      (Math.abs(g.curator.field.width - g.curator.allocated.width) > 3 ||
        Math.abs(g.curator.range.width - g.curator.allocated.width) > 3)
    )
      failures.push({ rule: 'curator range fills allocated form', ...g.curator });
    for (const f of g.forms)
      if (
        Math.abs(f.box.width - f.allocated.width) > 3 ||
        Math.abs(f.box.left - f.allocated.left) > 3
      )
        failures.push({ rule: 'form fills allocated pane', ...f });
    for (const f of g.controls) {
      const expected = f.quantity ? Math.min(220, f.allocated.width) : f.allocated.width;
      if (
        Math.abs(f.box.width - expected) > 3 ||
        f.box.left < f.allocated.left - 2 ||
        f.box.right > f.allocated.right + 2 ||
        f.boxSizing !== 'border-box'
      )
        failures.push({
          rule: f.quantity ? 'shared quantity width' : 'ordinary control fills field',
          ...f,
        });
    }
    for (const item of g.separators)
      if (Math.abs(item.inset - 16) > 1) failures.push({ rule: 'separator inset16', ...item });
    for (const item of g.modelGaps)
      if (!Number.isFinite(item.gap) || Math.abs(item.gap - 20) > 1)
        failures.push({ rule: 'Models mainpane gap20', ...item });
    if (g.normalized && Math.abs(g.paneGap - 20) > 1)
      failures.push({ rule: 'pane gap20', actual: g.paneGap });
    for (const f of g.pairs)
      if (!Number.isFinite(f.gap) || Math.abs(f.gap - 12) > 1)
        failures.push({ rule: 'field pair gap12', ...f });
    for (const f of g.actions)
      if (!Number.isFinite(f.gap) || Math.abs(f.gap - 8) > 1)
        failures.push({ rule: 'action gap8', ...f });
    for (const f of g.sections)
      if (Math.abs(f.margin - 24) > 1) failures.push({ rule: 'section spacing24', ...f });
    if (failures.length)
      recordGeometry(
        new Error('Inconsistent shared sizing ' + JSON.stringify({ name, width, failures })),
      );
  };
  const controlGeometry = async (name, width) => {
    const g = await evaluate(
      `(()=>{const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};const inventories=[...document.querySelectorAll('.mcp-server-inventory,.mod-source-inventory')].map(i=>({className:i.className,clientWidth:i.clientWidth,scrollWidth:i.scrollWidth,cards:[...i.querySelectorAll('.memory-connection')].map(c=>({card:box(c),metadata:box(c.querySelector('.memory-connection-select')),actions:c.querySelector('.memory-connection-actions')?box(c.querySelector('.memory-connection-actions')):null}))}));const storage=document.querySelector('.retention-storage');const oidc=document.querySelector('.oidc-fields');return {inventories,storage:storage?{row:box(storage),number:box(storage.querySelector('input')),unit:box(storage.querySelector('select'))}:null,oidc:oidc?{inputBackground:getComputedStyle(oidc.querySelector('input')).backgroundColor,textareas:[...oidc.querySelectorAll('textarea')].map(e=>({background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color}))}:null}})()`,
    );
    if (!g.inventories.length && !g.storage && !g.oidc) return;
    results.push({ controlGeometry: { name, width, ...g } });
    for (const inventory of g.inventories) {
      if (
        inventory.scrollWidth > inventory.clientWidth + 2 ||
        inventory.cards.some(
          ({ card, metadata, actions }) =>
            metadata.width < 120 ||
            metadata.width < card.width - 36 ||
            metadata.left < card.left - 2 ||
            metadata.right > card.right + 2 ||
            (actions && (actions.top < metadata.bottom - 2 || actions.right > card.right + 2)),
        )
      )
        recordGeometry(
          new Error(
            'Inventory metadata/action layout ' + JSON.stringify({ name, width, inventory }),
          ),
        );
    }
    if (g.storage) {
      const { row, number, unit } = g.storage;
      if (
        number.width < 120 ||
        unit.width < 60 ||
        unit.width > 140 ||
        number.right > unit.left + 2 ||
        unit.right > row.right + 2
      )
        recordGeometry(
          new Error(
            'Retention storage controls cramped ' + JSON.stringify({ name, width, ...g.storage }),
          ),
        );
    }
    if (
      g.oidc &&
      (!g.oidc.textareas.length ||
        g.oidc.textareas.some(
          (t) =>
            t.background !== g.oidc.inputBackground ||
            ['rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)'].includes(t.background),
        ))
    )
      recordGeometry(
        new Error('OIDC textarea theme mismatch ' + JSON.stringify({ name, width, ...g.oidc })),
      );
  };
  const normalizedGeometry = async (name, width) => {
    const g = await evaluate(
      `(()=>{const w=document.querySelector('.settings-content-normalized');if(!w)return null;const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,overflowY:getComputedStyle(e).overflowY}};const css=getComputedStyle(w),panes=[...w.children].filter(e=>e.classList.contains('settings-blank-column')&&e.getBoundingClientRect().width>0);return {gap:parseFloat(css.columnGap),composition:w.dataset.composition,extension:w.querySelector('.mod-settings-mount')?.dataset.settingsLayout,contentWidth:w.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight),contentLeft:w.getBoundingClientRect().left+w.clientLeft+parseFloat(css.paddingLeft),workspace:box(w),panes:panes.map(box)}})()`,
    );
    if (!g) return;
    results.push({ normalizedGeometry: { name, width, ...g } });
    const single = g.composition === 'single' || ['form', 'activity'].includes(g.extension),
      [a, b] = g.panes;
    if (single) {
      const split = g.contentWidth >= 640,
        expectedWidth = split ? (g.contentWidth - g.gap) / 2 : g.contentWidth;
      if (
        g.panes.length !== 1 ||
        !a ||
        Math.abs(a.left - g.contentLeft) > 3 ||
        Math.abs(a.width - expectedWidth) > 4 ||
        !['auto', 'scroll'].includes(a.overflowY)
      )
        recordGeometry(
          new Error(
            'Normalized single must occupy left track with empty right track ' +
              JSON.stringify({ name, width, split, expectedWidth, ...g }),
          ),
        );
      results.push({
        singleTrack: {
          name,
          width,
          split,
          expectedWidth,
          actualWidth: a?.width,
          emptyRightWidth: split ? g.contentWidth - g.gap - (a?.width ?? 0) : 0,
        },
      });
      return;
    }
    if (g.panes.length !== 2) {
      recordGeometry(
        new Error('Normalized split missing pane ' + JSON.stringify({ name, width, ...g })),
      );
      return;
    }
    if (g.panes.some((p) => !['auto', 'scroll'].includes(p.overflowY)))
      recordGeometry(
        new Error(
          'Normalized panes not independently scrollable ' + JSON.stringify({ name, width, ...g }),
        ),
      );
    const ordered = [...g.panes].sort((x, y) =>
        g.contentWidth >= 640 ? x.left - y.left : x.top - y.top,
      ),
      [first, last] = ordered;
    const inventory =
      ['inventory', 'document'].includes(g.composition) ||
      ['form-inventory', 'list-detail'].includes(g.extension);
    if (g.contentWidth >= 640) {
      if (
        last.left < first.right - 2 ||
        Math.abs(first.top - last.top) > 2 ||
        Math.min(first.height, last.height) < 300
      )
        recordGeometry(
          new Error('Normalized desktop geometry ' + JSON.stringify({ name, width, ...g })),
        );
      if (inventory) {
        if (first.width < 238 || first.width > 322 || last.width < first.width)
          recordGeometry(
            new Error('Normalized picker proportions ' + JSON.stringify({ name, width, ...g })),
          );
      } else if (Math.abs(first.width - last.width) > 3)
        recordGeometry(
          new Error('Normalized paired widths ' + JSON.stringify({ name, width, ...g })),
        );
    } else {
      if (last.top < first.bottom - 2 || Math.abs(first.left - last.left) > 2)
        recordGeometry(
          new Error('Normalized stacked overlap ' + JSON.stringify({ name, width, ...g })),
        );
      if (inventory) {
        if (
          first.height > 222 ||
          first.height > g.workspace.height * 0.35 + 2 ||
          last.height < 250 ||
          last.height <= first.height
        )
          recordGeometry(
            new Error(
              'Normalized compact picker/editor geometry ' + JSON.stringify({ name, width, ...g }),
            ),
          );
      } else if (
        Math.min(first.height, last.height) < 220 ||
        Math.abs(first.height - last.height) > 3
      )
        recordGeometry(
          new Error('Normalized paired stacked geometry ' + JSON.stringify({ name, width, ...g })),
        );
    }
  };
  const familyGeometry = async (name, width) => {
    const g = await evaluate(
      `(()=>{const w=document.querySelector('.settings-content-bounded');if(!w||w.classList.contains('settings-content-normalized'))return null;const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,overflowY:getComputedStyle(e).overflowY}};return {family:w.dataset.family,statsOpen:!!document.querySelector('.settings-fidgit.has-utility-panel'),picker:box(w.querySelector('.settings-prototype-configuration')),editor:box(w.querySelector('.settings-prototype-overflow')),workspace:box(w)}})()`,
    );
    if (!g) return;
    results.push({ familyGeometry: { name, width, ...g } });
    const { picker: p, editor: e } = g;
    if (!['auto', 'scroll'].includes(p.overflowY) || !['auto', 'scroll'].includes(e.overflowY))
      recordGeometry(new Error('Family panes not independently scrollable ' + JSON.stringify(g)));
    if (width > 700 && !(g.statsOpen && width > 850 && width <= 1400)) {
      if (e.left < p.right - 2 || Math.abs(e.top - p.top) > 2 || e.height < 300 || p.height < 300)
        recordGeometry(new Error('Broken split family ' + JSON.stringify(g)));
      if (g.family !== 'rails' && (p.width > (width > 1100 ? 282 : 242) || e.width <= p.width))
        recordGeometry(new Error('Picker/editor proportions incorrect ' + JSON.stringify(g)));
    } else if (
      e.top < p.bottom - 2 ||
      Math.abs(e.left - p.left) > 2 ||
      p.height > (g.family === 'rails' ? 242 : 182) ||
      e.height < 250
    )
      recordGeometry(new Error('Broken bounded phone family ' + JSON.stringify(g)));
  };
  const schedulingGeometry = async (name, width) => {
    const g = await evaluate(
      `(()=>{const w=document.querySelector('.settings-content-scheduling');if(!w||w.classList.contains('settings-content-normalized'))return null;const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,overflowY:getComputedStyle(e).overflowY}};const panel=document.querySelector('.settings-utility-panel[aria-hidden=\"false\"]');return {family:w.dataset.family,containerContentWidth:w.clientWidth-parseFloat(getComputedStyle(w).paddingLeft)-parseFloat(getComputedStyle(w).paddingRight),workspace:box(w),first:box(w.firstElementChild),last:box(w.lastElementChild),statistics:panel?box(panel):null}})()`,
    );
    if (!g) return;
    results.push({ schedulingGeometry: { name, width, ...g } });
    const { first: a, last: b, workspace: w } = g;
    if (
      g.statistics &&
      Math.min(w.right, g.statistics.right) - Math.max(w.left, g.statistics.left) > 2 &&
      Math.min(w.bottom, g.statistics.bottom) - Math.max(w.top, g.statistics.top) > 2
    )
      recordGeometry(
        new Error('Scheduling statistics overlap ' + JSON.stringify({ name, width, ...g })),
      );
    if (!['auto', 'scroll'].includes(a.overflowY) || !['auto', 'scroll'].includes(b.overflowY))
      recordGeometry(
        new Error(
          'Scheduling panes must scroll independently ' + JSON.stringify({ name, width, ...g }),
        ),
      );
    if (g.containerContentWidth >= 640) {
      if (b.left < a.right - 2 || Math.abs(a.top - b.top) > 2 || Math.min(a.height, b.height) < 300)
        recordGeometry(
          new Error('Scheduling split geometry ' + JSON.stringify({ name, width, ...g })),
        );
      if (g.family !== 'dreams' && b.width < a.width * 1.5)
        recordGeometry(
          new Error(
            'Scheduling inventory must be narrower than editor ' +
              JSON.stringify({ name, width, ...g }),
          ),
        );
    } else if (
      b.top < a.bottom - 2 ||
      Math.abs(a.left - b.left) > 2 ||
      Math.min(a.height, b.height) < 220
    )
      recordGeometry(
        new Error('Scheduling stacked panes unusable ' + JSON.stringify({ name, width, ...g })),
      );
  };
  const categoryBand = async () => {
    const band = await evaluate(
      `(()=>{const nav=document.querySelector('.settings-navigation-card'),items=[...nav.querySelectorAll('button')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top}});return {height:nav.getBoundingClientRect().height,items,shell:!!document.querySelector('.cockpit.settings-mode.settings-top-navigation > .app-navigation-stack > .settings-navigation-card'),workspace:!!document.querySelector('.cockpit > .workspace.settings-workspace > .settings-blank-slate')}})()`,
    );
    results.push({ categoryBand: band });
    if (
      !band.shell ||
      !band.workspace ||
      band.height > 90 ||
      band.items.some(
        (item, i) =>
          i && (Math.abs(item.top - band.items[0].top) > 2 || item.left <= band.items[i - 1].left),
      )
    )
      recordGeometry(
        new Error('Production shell/category navigation parity failed ' + JSON.stringify(band)),
      );
  };
  const shellGeometry = async (name, width) => {
    const geometry = await evaluate(
      `(()=>{const rect=selector=>{const e=document.querySelector(selector);if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};return {navigationStack:rect('.app-navigation-stack'),header:rect('.app-header'),categories:rect('.settings-navigation-card'),workspace:rect('.workspace.settings-workspace'),status:rect('.status-bar'),subsections:rect('.settings-prototype-sections'),content:rect('.settings-content-workspace'),agentSelector:rect('.settings-prototype-agent-selector')}})()`,
    );
    results.push({ shellGeometry: { name, width, ...geometry } });
    const {
      navigationStack,
      header,
      categories,
      workspace,
      status,
      subsections,
      content,
      agentSelector,
    } = geometry;
    const overlap = (a, b) =>
      a &&
      b &&
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
    const failures = [];
    if (header.bottom > categories.top + 2) failures.push('header/categories overlap');
    if (navigationStack.bottom > workspace.top + 2)
      failures.push('navigation stack/workspace overlap');
    if (categories.bottom > workspace.top + 2) failures.push('categories/workspace overlap');
    if (workspace.bottom > status.top + 2) failures.push('workspace/status overlap');
    if (overlap(categories, subsections)) failures.push('categories/subsections overlap');
    if (overlap(subsections, content)) failures.push('subsections/content overlap');
    if (overlap(agentSelector, subsections) || overlap(agentSelector, content))
      failures.push('agent selector overlap');
    if (failures.length)
      recordGeometry(
        new Error(
          'Shell vertical geometry failed ' + JSON.stringify({ name, width, failures, geometry }),
        ),
      );
  };
  const actionScreenshot = async (name) => {
    await evaluate(
      `(()=>{const rows=[...document.querySelectorAll('.settings-content-workspace .card-actions,.settings-content-workspace .model-actions,.settings-content-workspace .setting-actions')].filter(e=>e.getBoundingClientRect().width>0);rows.at(-1)?.scrollIntoView({block:'center',inline:'nearest'});})()`,
    );
    await pause();
    await screenshot(name);
  };

  await c('Runtime.enable');
  await c('Page.enable');
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await c('Page.navigate', { url: `http://127.0.0.1:${port}` });
  await wait("!!document.querySelector('.settings-blank-slate')");
  await auditAgentToolbar({ c, evaluate, wait, pause, click, screenshot, results });
  await categoryBand();
  if (
    await evaluate(
      "[...document.querySelectorAll('.settings-prototype-section-items button')].some(e=>e.textContent.trim()==='Browser origin')",
    )
  )
    throw new Error('Removed Browser origin menu remains');
  await click('Models', '.settings-prototype-section-items button');
  await wait(
    "document.querySelectorAll('.models-provider-inventory .provider-card-select').length===3",
  );
  await clickSelector('.models-provider-inventory .provider-card-select');
  await wait("!!document.querySelector('.model-capability-editor')");
  await screenshot('models-desktop');
  await dimensions('models', 1600);
  if (
    (await evaluate(
      "[...document.querySelectorAll('.models-provider-inventory .provider-card-select')].every(e=>e.getBoundingClientRect().width>0)",
    )) !== true
  )
    throw new Error('Providers not visible');
  await clickSelector('.model-option:nth-child(2) .model-option-select');
  if (
    (await evaluate("document.querySelector('.model-capability-editor h3').textContent")) !==
    'Synthetic Vision'
  )
    throw new Error('Model selection failed');
  await click('Edit connection', '.models-connection-heading button');
  await evaluate(
    "(()=>{const input=[...document.querySelectorAll('label.field')].find(e=>e.textContent.trim().startsWith('Provider')).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Dirty draft');input.dispatchEvent(new Event('input',{bubbles:true}))})()",
  );
  await pause();
  await clickSelector(
    '.models-provider-inventory .provider-card:nth-child(2) .provider-card-select',
  );
  await wait("!!document.querySelector('[data-unsaved-changes-modal]')");
  await click('Stay');
  if (await evaluate("!!document.querySelector('[data-unsaved-changes-modal]')"))
    throw new Error('Stay failed');
  await clickSelector(
    '.models-provider-inventory .provider-card:nth-child(2) .provider-card-select',
  );
  await wait("!!document.querySelector('[data-unsaved-changes-modal]')");
  await click('Discard');
  await wait(
    "document.querySelector('.models-provider-inventory .provider-card:nth-child(2) .provider-card-select').getAttribute('aria-pressed')==='true'",
  );
  results.push({
    providerSelection: true,
    modelSelection: true,
    unsavedStay: true,
    unsavedDiscard: true,
  });
  for (const width of [1280, 1000, 768, 390]) {
    await c('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await pause();
    await screenshot(`models-${width}`);
    await dimensions('models', width);
    await categoryBand();
  }
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click('General', '.settings-prototype-menu button');
  await click('Personalization', '.settings-prototype-section-items button');
  await wait('!!document.querySelector(\'input[value="Goblin King"]\')');
  if (
    await evaluate(
      "[...document.querySelectorAll('.settings-prototype-section-items button')].some(e=>['Operator profile','Appearance'].includes(e.textContent.trim()))",
    )
  )
    throw new Error('Old personalization menus remain');
  await wait(
    "document.querySelector('.settings-personalization-profile .agent-reference-preview img')?.naturalWidth===64",
  );
  await evaluate(
    `(async()=>{const image=await (await fetch('/api/operator/reference-image/content?revision=1')).blob();const file=new File([image],'operator-reference-updated.png',{type:'image/png'});const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('.settings-personalization-profile input[aria-label="Upload reference photo"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await wait("document.body.textContent.includes('Reference photo saved.')");
  await click('Trace retention', '.settings-prototype-section-items button');
  await click('Personalization', '.settings-prototype-section-items button');
  await wait(
    "document.querySelector('.settings-personalization-profile input[aria-label=\"Reference photo file\"]')?.value==='operator-reference-updated.png'",
  );
  await wait(
    "document.querySelector('.settings-personalization-profile .agent-reference-preview img')?.naturalWidth===64",
  );
  await screenshot('operator-reference-personalization-1600');
  results.push({
    operatorReferencePreview: true,
    operatorReferenceUpload: true,
    operatorReferencePersistsAcrossNavigation: true,
  });

  await wait("document.querySelector('input[placeholder=\"Dev, Test, or Prod\"]')?.value==='Dev'");
  await evaluate(
    "(()=>{const e=document.querySelector('input[placeholder=\"Dev, Test, or Prod\"]');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Fixture appearance');e.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  await pause();
  if (
    !(await evaluate(
      "document.querySelector('input[placeholder=\"Dev, Test, or Prod\"]').closest('.setting-section').querySelector('.settings-help strong').textContent==='Burrow — Fixture appearance'",
    ))
  )
    throw new Error('Browser tab preview did not follow suffix');
  await evaluate('document.querySelector(\'input[placeholder="Dev, Test, or Prod"]\').blur()');
  await wait(
    "document.querySelector('.settings-content-workspace').textContent.includes('Browser tab suffix saved.')",
  );
  await click('Trace retention', '.settings-prototype-section-items button');
  if (await evaluate('!!document.querySelector(\'input[placeholder="Dev, Test, or Prod"]\')'))
    throw new Error('Browser tab leaked into Trace retention');
  await click('Personalization', '.settings-prototype-section-items button');
  await wait(
    "document.querySelector('input[placeholder=\"Dev, Test, or Prod\"]')?.value==='Fixture appearance'",
  );
  await evaluate(
    "(()=>{const e=document.querySelector('input[placeholder=\"Dev, Test, or Prod\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Unsaved personalization');e.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  await pause();
  await click('Trace retention', '.settings-prototype-section-items button');
  await wait("!!document.querySelector('[data-unsaved-changes-modal]')");
  await click('Stay', '[data-unsaved-changes-modal] button');
  if (
    !(await evaluate(
      "document.querySelector('input[placeholder=\"Dev, Test, or Prod\"]')?.value==='Unsaved personalization'",
    ))
  )
    throw new Error('Personalization Stay lost draft');
  await click('Trace retention', '.settings-prototype-section-items button');
  await wait("!!document.querySelector('[data-unsaved-changes-modal]')");
  await click('Discard', '[data-unsaved-changes-modal] button');
  await click('Personalization', '.settings-prototype-section-items button');
  await wait(
    "document.querySelector('input[placeholder=\"Dev, Test, or Prod\"]')?.value==='Fixture appearance'",
  );
  results.push({ personalizationNavigationStay: true, personalizationNavigationDiscard: true });
  const personalizationGeometry = async (width, statistics) => {
    const g = await evaluate(
      `(()=>{const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};const w=document.querySelector('.settings-content-workspace'),p=document.querySelector('.settings-personalization-profile'),a=document.querySelector('.settings-personalization-appearance'),style=getComputedStyle(w),panel=document.querySelector('.settings-utility-panel');return {contentWidth:w.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),profile:box(p),appearance:box(a),workspace:box(w),stats:box(panel),statsVisible:getComputedStyle(panel).visibility==='visible'&&Number(getComputedStyle(panel).opacity)>0,fields:[...p.querySelectorAll('input:not([type=file]),select'),...a.querySelectorAll('input:not([type=file])')].map(box),profileHasSuffix:!!p.querySelector('input[placeholder="Dev, Test, or Prod"]'),appearanceHasSuffix:!!a.querySelector('input[placeholder="Dev, Test, or Prod"]'),appearanceHasThemes:!!a.querySelector('.theme-picker')}})()`,
    );
    results.push({ personalizationGeometry: { width, statistics, ...g } });
    if (
      g.profileHasSuffix ||
      !g.appearanceHasSuffix ||
      !g.appearanceHasThemes ||
      g.fields.some((f) => f.width > Math.max(g.profile.width, g.appearance.width) + 2)
    )
      recordGeometry(
        new Error('Personalization grouping/field widths broken ' + JSON.stringify(g)),
      );
    if (
      g.contentWidth >= 640 &&
      (g.profile.right > g.appearance.left + 2 || Math.abs(g.profile.top - g.appearance.top) > 2)
    )
      recordGeometry(
        new Error('Personalization desktop baseline/direction broken ' + JSON.stringify(g)),
      );
    if (
      statistics &&
      (!g.statsVisible ||
        (width > 850 ? g.workspace.right > g.stats.left + 2 : g.workspace.bottom > g.stats.top + 2))
    )
      recordGeometry(new Error('Personalization statistics overlay ' + JSON.stringify(g)));
  };
  for (const [width, statistics] of [
    [1600, false],
    [1600, true],
    [1910, false],
    [1910, true],
    [390, true],
  ]) {
    await c('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const open = await evaluate("!!document.querySelector('.settings-fidgit.has-utility-panel')");
    if (open !== statistics)
      await clickSelector(
        statistics
          ? '[aria-label="Open system statistics"]'
          : '[aria-label="Collapse system statistics"]',
      );
    await wait(`!!document.querySelector('.settings-fidgit.has-utility-panel')===${statistics}`);
    await pause();
    await personalizationGeometry(width, statistics);
    await revealAndCheck(
      '.settings-personalization-profile .agent-reference-preview',
      'operator-reference-preview',
      width,
    );
    await revealAndCheck(
      '.settings-personalization-profile input[aria-label="Reference photo file"]',
      'operator-reference-filename',
      width,
    );
    await revealAndCheck(
      '.settings-personalization-profile .reference-photo-file-control button:last-of-type',
      'operator-reference-paste',
      width,
    );

    await revealAndCheck(
      '.settings-personalization-profile input[value="Goblin King"]',
      'personalization-name',
      width,
    );
    await revealAndCheck(
      '.settings-personalization-profile input[placeholder="America/Chicago"]',
      'personalization-timezone',
      width,
    );
    await revealAndCheck(
      '.settings-personalization-appearance .theme-picker button',
      'personalization-theme',
      width,
    );
    await revealAndCheck(
      'input[placeholder="Dev, Test, or Prod"]',
      'personalization-browser-tab',
      width,
    );
    await revealAndCheck(
      '.setting-section:has(input[placeholder="Dev, Test, or Prod"]) .settings-help strong',
      'personalization-browser-tab-preview',
      width,
    );
    const preview = await evaluate(
      "(()=>{const e=document.querySelector('input[placeholder=\"Dev, Test, or Prod\"]'),s=e.closest('.setting-section');return {heading:s.querySelector('h2').textContent,preview:s.querySelector('.settings-help strong').textContent,value:e.value}})()",
    );
    if (
      preview.heading !== 'Browser tab' ||
      preview.preview !== 'Burrow — Fixture appearance' ||
      preview.value !== 'Fixture appearance'
    )
      throw new Error('Incomplete Browser tab relocation ' + JSON.stringify(preview));
    await screenshot('personalization-browser-tab-' + width + (statistics ? '-statistics' : ''));
    await dimensions('personalization-browser-tab', width);
  }
  results.push({
    browserTabOnlyPersonalization: true,
    browserTabLivePreview: true,
    browserTabBlurAutosave: true,
    browserTabPersistsAcrossNavigation: true,
  });
  await clickSelector('[aria-label="Collapse system statistics"]');
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });

  if (
    (await evaluate(
      "document.querySelector('.settings-content-workspace').dataset.composition",
    )) !== 'paired'
  )
    throw new Error('Personalization is not paired');
  await click('Agents', '.settings-prototype-menu button');
  await click('Profile documents', '.settings-prototype-section-items button');
  await wait("!!document.querySelector('.profile-document-overflow textarea:not(:disabled)')");
  await screenshot('profile-documents');
  await dimensions('profile-documents', 1600);
  await familyGeometry('profile-documents', 1600);
  await click('RULES.md', '.profile-document-selector button');
  await wait("document.querySelector('.profile-document-overflow h2').textContent==='RULES.md'");
  for (const width of [1000, 768, 390]) {
    await c('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await pause();
    await screenshot(`profile-documents-${width}`);
    await dimensions('profile-documents', width);
    await clickSelector('[aria-label="Open system statistics"]');
    await screenshot(`profile-documents-statistics-${width}`);
    await dimensions('profile-documents-statistics', width);
    await clickSelector('[aria-label="Collapse system statistics"]');
  }
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click('Skills', '.settings-prototype-menu button');
  await wait("document.body.textContent.includes('Fixture skill')");
  await screenshot('skills');
  await dimensions('skills', 1600);
  await click('Mods', '.settings-prototype-menu button');
  await wait("document.body.textContent.includes('Fixture Mod')");
  await screenshot('mods');
  await dimensions('mods', 1600);
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause();
  await screenshot('mods-1000');
  await dimensions('mods', 1000);
  await clickSelector('[aria-label="Open system statistics"]');
  await wait(
    "document.querySelector('.settings-utility-panel').getAttribute('aria-hidden')==='false'",
  );
  await screenshot('system-statistics');
  await dimensions('mods-statistics', 1000);
  const modEditor = await evaluate(
    "(()=>{const e=document.querySelector('.settings-prototype-configuration');return {width:e.clientWidth,scrollWidth:e.scrollWidth}})()",
  );
  results.push({ modEditorStatsOpen: modEditor });
  if (modEditor.width < 350 || modEditor.scrollWidth > modEditor.width + 2)
    recordGeometry(new Error('Cramped Mods editor ' + JSON.stringify(modEditor)));
  await actionScreenshot('mods-statistics-actions');
  await clickSelector('[aria-label="Collapse system statistics"]');
  // All built-in subsection layouts share a stable editing edge. Mod hosts keep their published surface contract.
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  let editingLeft;
  const anchor = async (name) => {
    await pause();
    const a = await evaluate(
      `(()=>{const w=document.querySelector('.settings-content-workspace'),doc=w.classList.contains('settings-content-document'),pane=w.querySelector(doc?'.settings-prototype-overflow':'.settings-prototype-configuration'),r=pane.getBoundingClientRect();const selector=w.querySelector(doc?'.settings-prototype-configuration':'.settings-prototype-overflow'),sr=selector?.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,selectorHeight:sr?.height,standard:w.classList.contains('settings-content-standard'),family:w.dataset.family,bounded:w.classList.contains('settings-content-bounded'),normalized:w.classList.contains('settings-content-normalized'),workspaceLeft:w.getBoundingClientRect().left,errors:[...w.querySelectorAll('.settings-request-error')].map(e=>e.textContent).filter(Boolean)}})()`,
    );
    results.push({ anchor: { name, ...a } });
    if (a.errors.length)
      throw new Error('Fixture API/section error ' + JSON.stringify({ name, ...a }));
    if (
      a.standard &&
      !a.normalized &&
      !a.bounded &&
      !['cron', 'workflow', 'dreams'].includes(a.family)
    ) {
      if (editingLeft === undefined) editingLeft = a.left;
      if (Math.abs(a.left - editingLeft) > 2 || a.width < 800 || a.top > 750)
        recordGeometry(
          new Error('Unstable editing surface ' + JSON.stringify({ name, editingLeft, ...a })),
        );
    }
    await dimensions(name, 1600);
  };
  const matrix = {
    General: ['Personalization', 'Trace retention', 'Continuity', 'Export', 'Rail panels'],
    Agents: [
      'Agent details',
      'Profile documents',
      'MCP tools',
      'Cron jobs',
      'Workflow events',
      'Dreams',
      'Skills',
    ],
    Skills: ['Installed skills', 'Import from repository', 'New text skill'],
    Connections: [
      'Authentication',
      'OpenTelemetry',
      'Models',
      'Load Balancing',
      'MCP servers',
      'API tokens',
    ],
    Mods: ['Installed mods', 'Mod sources', 'Automatic source checks'],
  };
  for (const [category, sections] of Object.entries(matrix)) {
    await click(category, '.settings-prototype-menu button');
    for (const section of sections) {
      await click(section, '.settings-prototype-section-items button');
      await anchor(category + ' / ' + section);
      if (
        ['Continuity', 'Export', 'MCP tools', 'Load Balancing', 'OpenTelemetry', 'Dreams'].includes(
          section,
        )
      )
        await screenshot('matrix-' + section.toLowerCase().replaceAll(' ', '-'));
    }
  }
  await click('Agents', '.settings-prototype-menu button');
  await click('Global', '.agent-toolbar button');
  for (const section of ['Global documents', 'Execution boundaries']) {
    await click(section, '.settings-prototype-section-items button');
    await anchor('Global / ' + section);
  }
  await chooseAgent('Hatchet');
  const statsLayout = async (name, width) => {
    const box = () =>
      evaluate(
        "(()=>{const e=document.querySelector('.settings-content-workspace').getBoundingClientRect();return {left:e.left,top:e.top,right:e.right,bottom:e.bottom,width:e.width,height:e.height}})()",
      );
    const before = await box();
    await clickSelector('[aria-label="Open system statistics"]');
    const after = await box(),
      panel = await evaluate(
        "(()=>{const r=document.querySelector('.settings-utility-panel').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width}})()",
      );
    results.push({ statisticsGeometry: { name, width, before, after, panel } });
    if (width > 850) {
      if (before.width - after.width < 250 || after.right > panel.left + 2)
        recordGeometry(
          new Error(
            'Statistics did not reserve a column ' +
              JSON.stringify({ name, width, before, after, panel }),
          ),
        );
    } else if (after.bottom > panel.top + 2)
      recordGeometry(
        new Error(
          'Statistics overlaps stacked content ' + JSON.stringify({ name, width, after, panel }),
        ),
      );
    await screenshot(name + '-statistics-' + width);
    await dimensions(name + '-statistics', width);
    await clickSelector('[aria-label="Collapse system statistics"]');
  };
  const representative = [
    ['General', 'Personalization', 'profile'],
    ['General', 'Export', 'export-import'],
    ['General', 'Continuity', 'continuity'],
    ['General', 'Rail panels', 'rail-panels'],
    ['Agents', 'Profile documents', 'documents'],
    ['Agents', 'MCP tools', 'mcp-tools'],
    ['Agents', 'Dreams', 'dreams'],
    ['Skills', 'Installed skills', 'selected-skill'],
    ['Mods', 'Installed mods', 'selected-mod'],
    ['General', 'Trace retention', 'simple-retention'],
    ['Connections', 'Models', 'models-stats'],
  ];
  for (const [category, section, name] of representative) {
    await click(category, '.settings-prototype-menu button');
    await click(section, '.settings-prototype-section-items button');
    if (name === 'models-stats')
      await clickSelector('.models-provider-inventory .provider-card-select');
    if (name === 'selected-skill') {
      await click('Fixture skill', '.memory-connection-select strong');
    }
    if (name === 'selected-mod') {
      await clickSelector('[aria-label="Manage Fixture Mod"]');
    }
    for (const width of [1600, 1000, 768, 390]) {
      await c('Emulation.setDeviceMetricsOverride', {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await pause();
      if (name === 'documents') {
        await evaluate(
          "document.querySelector('.profile-document-selector button:last-child').scrollIntoView({block:'nearest',inline:'end'})",
        );
        await click('DreamMemory.md', '.profile-document-selector button');
        await evaluate(
          "document.querySelector('.profile-document-overflow textarea').scrollTop=100000",
        );
        const d = await evaluate(
          "(()=>{const e=document.querySelector('.profile-document-overflow textarea');return {scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}})()",
        );
        if (d.scrollTop <= 0)
          throw new Error('Long profile document did not scroll internally ' + JSON.stringify(d));
        results.push({ documentScroll: { width, ...d } });
      }
      await screenshot(name + '-' + width);
      await dimensions(name, width);
      await categoryBand();
      await statsLayout(name, width);
    }
  }
  await click('Connections', '.settings-prototype-menu button');
  await click('Models', '.settings-prototype-section-items button');
  await clickSelector('.models-provider-inventory .provider-card-select');
  await c('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause();
  await statsLayout('models-stats', 900);
  // Realistic density: 17 agents, 45 GitHub tools, two servers.
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click('Agents', '.settings-prototype-menu button');
  await click('MCP tools', '.settings-prototype-section-items button');
  await wait("document.querySelectorAll('.mcp-tool-options > label').length===46");
  await click('Documentation MCP', '.mcp-server-selector strong');
  await wait("document.querySelectorAll('.mcp-tool-options > label').length===2");
  await click('GitHub MCP', '.mcp-server-selector strong');
  await wait("document.querySelectorAll('.mcp-tool-options > label').length===46");
  await clickSelector('.mcp-tool-options > label:nth-child(2) input');
  await wait("!document.querySelector('.mcp-tool-options input').disabled");
  if (
    !(await evaluate(
      "document.querySelector('.mcp-tool-options > label:nth-child(2) input').checked",
    ))
  )
    throw new Error('First tool toggle failed');
  await evaluate("document.querySelector('.settings-prototype-overflow').scrollTop=100000");
  await pause();
  await screenshot('mcp-last-tool-desktop');
  await clickSelector('.mcp-tool-options > label:last-child input');
  await wait("!document.querySelector('.mcp-tool-options input').disabled");
  if (
    !(await evaluate(
      "document.querySelector('.mcp-tool-options > label:last-child input').checked",
    ))
  )
    throw new Error('Last tool toggle failed');
  await evaluate("document.querySelector('.settings-prototype-overflow').scrollTop=0");
  await clickSelector('.mcp-tool-select-all input');
  await wait("!document.querySelector('.mcp-tool-options input').disabled");
  if (
    (await evaluate(
      "document.querySelectorAll('.mcp-tool-options > label:not(.mcp-tool-select-all) input:checked').length",
    )) !== 45
  )
    throw new Error('Select all45 failed');
  await clickSelector('.mcp-tool-select-all input');
  await wait("!document.querySelector('.mcp-tool-options input').disabled");
  if ((await evaluate("document.querySelectorAll('.mcp-tool-options input:checked').length")) !== 0)
    throw new Error('Clear all45 failed');
  for (const width of [1600, 1000, 768, 390]) {
    await c('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await pause();
    await evaluate("document.querySelector('.settings-prototype-overflow').scrollTop=0");
    const before = await evaluate(
      "(()=>{const e=document.querySelector('.settings-prototype-configuration'),r=e.getBoundingClientRect();return {top:r.top,left:r.left,scrollTop:e.scrollTop}})()",
    );
    await evaluate("document.querySelector('.settings-prototype-overflow').scrollTop=100000");
    await pause();
    const after = await evaluate(
      "(()=>{const p=document.querySelector('.settings-prototype-configuration'),r=p.getBoundingClientRect(),e=document.querySelector('.settings-prototype-overflow'),b=document.querySelector('.mcp-tool-options > label:last-child').getBoundingClientRect(),v=e.getBoundingClientRect();return {picker:{top:r.top,left:r.left,scrollTop:p.scrollTop},scrollTop:e.scrollTop,lastVisible:b.bottom<=v.bottom+2&&b.top>=v.top-2}})()",
    );
    results.push({ mcpScroll: { width, before, after } });
    if (
      JSON.stringify(before) !== JSON.stringify(after.picker) ||
      after.scrollTop <= 0 ||
      !after.lastVisible
    )
      throw new Error('MCP45 scroll isolation failed ' + JSON.stringify({ width, before, after }));
    await revealAndCheck('.mcp-tool-options > label:last-child', 'mcp-last-tool', width);
    await screenshot('mcp-last-tool-' + width);
    await dimensions('mcp45-density', width);
    await chooseAgent('Thistle');
    await wait("!document.querySelector('.mcp-tool-options input').disabled");
    const toolbar = await evaluate(
      "(()=>{const e=document.querySelector('.agent-toolbar-agent-list'),r=e.getBoundingClientRect(),selected=e.querySelector('[data-agent-id][aria-pressed=true]'),b=selected?.getBoundingClientRect();return {height:r.height,count:e.querySelectorAll('[data-agent-id]').length,selected:selected?.dataset.agentId,width:e.clientWidth,hasSelect:!!document.querySelector('.agent-toolbar select'),selectedVisible:!!b&&b.left>=r.left+e.clientLeft-2&&b.right<=r.left+e.clientLeft+e.clientWidth+2}})()",
    );
    results.push({ agentToolbar: { width, ...toolbar } });
    if (
      toolbar.height > 70 ||
      toolbar.count < 17 ||
      toolbar.selected !== 'thistle' ||
      toolbar.width < 40 ||
      toolbar.hasSelect ||
      !toolbar.selectedVisible
    )
      throw new Error('17agent selector unreachable ' + JSON.stringify(toolbar));
    await revealAndCheck('[data-agent-id="thistle"]', 'last-agent-button', width);
    await screenshot('last-agent-' + width);
    await chooseAgent('Hatchet');
  }
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click('General', '.settings-prototype-menu button');
  await click('Rail panels', '.settings-prototype-section-items button');
  await wait("document.querySelectorAll('.agent-sidebar-order-list > div').length===17");
  await evaluate(
    "(()=>{const rows=[...document.querySelectorAll('.agent-sidebar-order-list > div')],dt=new DataTransfer();rows[16].dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));rows[0].dispatchEvent(new DragEvent('dragover',{bubbles:true,dataTransfer:dt}));rows[0].dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));rows[16].dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));})()",
  );
  await wait("document.querySelector('.agent-sidebar-order-list > div b').textContent==='Thistle'");
  for (const width of [1600, 1000, 768, 390]) {
    await c('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await pause();
    await evaluate("document.querySelector('.agent-sidebar-order-list').scrollTop=100000");
    const order = await evaluate(
      "(()=>{const e=document.querySelector('.agent-sidebar-order-list'),r=e.getBoundingClientRect(),b=e.lastElementChild.getBoundingClientRect();return {height:r.height,scrollTop:e.scrollTop,count:e.children.length,lastVisible:b.bottom<=r.bottom+2}})()",
    );
    results.push({ railDensity: { width, ...order } });
    if (order.count !== 17 || order.height > 522 || order.scrollTop <= 0 || !order.lastVisible)
      throw new Error('Rail17 density failed ' + JSON.stringify(order));
    await revealAndCheck('.agent-sidebar-order-list > div:last-child', 'rail-last-agent', width);
    await screenshot('rail-last-agent-' + width);
    await dimensions('rail17-density', width);
  }
  results.push({ mcpFirstLastToggle: true, mcpSelectClearAll45: true, railReorder17: true });
  await c('Emulation.setDeviceMetricsOverride', {
    width: 2560,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await clickSelector('[aria-label="Open system statistics"]');
  for (const [category, section, name] of [
    ['General', 'Continuity', 'continuity'],
    ['Agents', 'Profile documents', 'documents'],
    ['Agents', 'MCP tools', 'mcp-tools'],
    ['General', 'Rail panels', 'rails'],
  ]) {
    await click(category, '.settings-prototype-menu button');
    await click(section, '.settings-prototype-section-items button');
    if (category === 'Agents') await chooseAgent('Thistle');
    if (name === 'mcp-tools') {
      await wait("document.querySelectorAll('.mcp-tool-options > label').length===46");
      await evaluate("document.querySelector('.settings-prototype-overflow').scrollTop=100000");
      await clickSelector('.mcp-tool-options > label:last-child input');
      await wait("!document.querySelector('.mcp-tool-options input').disabled");
    }
    await pause();
    const wide = await evaluate(
      "(()=>{const s=document.querySelector('.settings-utility-panel'),p=s.getBoundingClientRect(),w=document.querySelector('.settings-content-workspace').getBoundingClientRect();return {open:s.getAttribute('aria-hidden')==='false',workspaceRight:w.right,panelLeft:p.left,workspaceWidth:w.width}})()",
    );
    results.push({ persistentWideStats: { name, ...wide } });
    if (!wide.open || wide.workspaceRight > wide.panelLeft + 2 || wide.workspaceWidth < 1600)
      recordGeometry(new Error('Widescreen persistent statistics broken ' + JSON.stringify(wide)));
    await screenshot('wide-statistics-' + name);
    await dimensions('wide-statistics-' + name, 2560);
  }
  await clickSelector('[aria-label="Collapse system statistics"]');
  // Full subsection audit with realistic inventories and statistics left open.
  const ensureAuditStatistics = async (statistics = true) => {
    if (!(await evaluate("!!document.querySelector('.settings-blank-slate')"))) {
      await c('Page.reload', { ignoreCache: true });
      await wait("!!window.fixtureSetTab&&!!document.querySelector('.settings-blank-slate')");
    }
    if (
      (await evaluate("!!document.querySelector('.settings-fidgit.has-utility-panel')")) !==
      statistics
    )
      await clickSelector(
        statistics
          ? '[aria-label="Open system statistics"]'
          : '[aria-label="Collapse system statistics"]',
      );
    await wait(
      `(()=>{const p=document.querySelector('.settings-utility-panel'),s=getComputedStyle(p);return !!document.querySelector('.settings-fidgit.has-utility-panel')===${statistics}&&p.getAttribute('aria-hidden')===${JSON.stringify(statistics ? 'false' : 'true')}&&(${statistics}?s.visibility==='visible'&&Number(s.opacity)===1&&p.getBoundingClientRect().width>0:s.visibility==='hidden'&&Number(s.opacity)===0)})()`,
    );
  };
  const auditCheckpoint = async (name, action, statistics = true) => {
    try {
      await ensureAuditStatistics(statistics);
      await action();
    } catch (error) {
      const diagnostic = {
        name,
        error: String(error),
        runtimeErrors: await captureRuntimeErrors().catch((cause) => ({
          captureError: String(cause),
        })),
      };
      auditFailures.push(diagnostic);
      results.push({ auditFailure: diagnostic });
      await screenshot(
        'audit-failure-' + name.toLowerCase().replaceAll(' ', '-').replaceAll('/', '-'),
      ).catch(() => {});
      await c('Page.reload', { ignoreCache: true });
      await wait("!!window.fixtureSetTab&&!!document.querySelector('.settings-blank-slate')");
      await ensureAuditStatistics(statistics);
    }
  };
  const selectAuditEditor = async (category, section) => {
    const selectors = {
      'Installed skills': '.memory-connection-select',
      'Installed mods': '[aria-label="Manage Fixture Mod"]',
      'Mod sources': '[aria-label="Edit https://example.invalid/synthetic-team/mod-source-1.git"]',
      OpenTelemetry: '.telemetry-inventory-item',
      'Load Balancing': '.provider-card-select',
      'MCP servers': '[aria-label="Edit GitHub MCP"]',
      'Execution boundaries': '.boundary-inventory-select',
      'Cron jobs': '.settings-prototype-overflow .schedule-card-select',
      'Workflow events': '.settings-prototype-overflow .schedule-card-select',
      Models: '.models-provider-inventory .provider-card-select',
    };
    const inventories = {
      'Installed skills': ['.memory-connection-list .memory-connection', 8],
      'Installed mods': ['.memory-connection-list .memory-connection', 6],
      'Mod sources': ['.memory-connection-list .memory-connection', 4],
      OpenTelemetry: ['.telemetry-inventory-item', 3],
      'Load Balancing': ['.provider-card-select', 6],
      'MCP servers': ['.memory-connection-list .memory-connection', 2],
      'Execution boundaries': ['.boundary-inventory-select', 6],
      'API tokens': ['.api-token-row', 8],
    };
    if (inventories[section]) {
      const [inventorySelector, count] = inventories[section];
      await wait(
        `document.querySelectorAll(${JSON.stringify(inventorySelector)}).length===${count}`,
      );
      results.push({ auditInventory: { category, section, count } });
    }
    const selector = selectors[section];
    if (selector) {
      await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
      await clickSelector(selector);
    }
    await pause();
    const errors = await evaluate(
      "[...document.querySelectorAll('.settings-request-error')].map(e=>e.textContent).filter(Boolean)",
    );
    if (errors.length)
      throw new Error(
        'Audit fixture section error ' + JSON.stringify({ category, section, errors }),
      );
    await evaluate(
      "document.querySelectorAll('.settings-blank-column,.settings-content-workspace').forEach(e=>{e.scrollTop=0});window.scrollTo(0,0)",
    );
    await pause();
  };
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1910,
    height: 1025,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click('Agents', '.settings-prototype-menu button');
  await chooseAgent('Hatchet');
  for (const statistics of [false, true]) {
    const state = statistics ? 'statistics' : 'no-statistics';
    for (const [category, sections] of Object.entries(matrix))
      for (const section of sections) {
        const name = 'audit-' + category + '-' + section + '-1910-' + state;
        await auditCheckpoint(
          name,
          async () => {
            await click(category, '.settings-prototype-menu button');
            await click(section, '.settings-prototype-section-items button');
            await selectAuditEditor(category, section);
            await screenshot(name.toLowerCase().replaceAll(' ', '-'));
            await dimensions(name, 1910);
            if (section === 'Continuity') {
              await clickSelector('input[name="curator-mode"]:not(:checked)');
              await wait(
                '!!document.querySelector(\'input[placeholder="models/LFM2.5-2.6B-Q4_K_M.gguf"]\')',
              );
              await screenshot('audit-continuity-local-gguf-1910-' + state);
              await dimensions('audit-continuity-local-gguf', 1910);
              await clickSelector('input[name="curator-mode"]:not(:checked)');
              await wait("!!document.querySelector('.curator-model-row')");
            }
            if (statistics && section === 'Export') {
              await wait("document.querySelectorAll('.export-option').length===8");
              await evaluate(
                "(()=>{const e=[...document.querySelectorAll('.export-option')].find(e=>e.textContent.includes('Model connections'));e.querySelector('input').click();})()",
              );
              await wait(
                "!!document.querySelector('.settings-prototype-configuration input[type=password]')",
              );
              if (
                !(await evaluate(
                  "[...document.querySelectorAll('.setting-actions button')].find(e=>e.textContent==='Download export').disabled",
                ))
              )
                throw new Error('Sensitive export missing password guard');
              await revealAndCheck(
                '.settings-prototype-configuration input[type=password]',
                'sensitive-export-password',
                1910,
              );
              await screenshot('audit-export-sensitive-categories-1910-statistics');
              await dimensions('audit-export-sensitive', 1910);
              results.push({
                exportCategories: 8,
                sensitiveExportPasswordGuard: true,
                exportNotExecuted: true,
              });
            }
            if (statistics && section === 'Authentication') {
              for (const mode of ['trusted-proxy', 'oidc']) {
                await evaluate(
                  `(()=>{const s=document.querySelector('.settings-prototype-configuration select');s.value=${JSON.stringify(mode)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
                );
                await wait("!!document.querySelector('.auth-mode-fields')");
                await screenshot('audit-authentication-' + mode + '-1910-statistics');
                await dimensions('audit-authentication-' + mode, 1910);
                await revealAndCheck('.auth-actions button', 'auth-save-action', 1910);
              }
              await evaluate(
                "(()=>{const s=document.querySelector('.settings-prototype-configuration select');s.value='none';s.dispatchEvent(new Event('change',{bubbles:true}));})()",
              );
              await pause();
            }
            if (statistics && section === 'Import from repository') {
              await evaluate(
                `(()=>{for(const [label,value] of [['Repository','https://repository.invalid/synthetic.git'],['Skill path','skills/review']]){const e=[...document.querySelectorAll('label.field')].find(e=>e.textContent.trim()===label).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));}})()`,
              );
              await pause();
              await click('Preview skill', 'button.settings-action');
              await wait("!!document.querySelector('.skill-repository-preview')");
              await revealAndCheck(
                '.skill-repository-preview button.settings-action',
                'repository-install-preview-action',
                1910,
              );
              await screenshot('audit-skill-repository-preview-1910-statistics');
              await dimensions('audit-skill-repository-preview', 1910);
              await click('Installed skills', '.settings-prototype-section-items button');
              await wait("!!document.querySelector('[data-unsaved-changes-modal]')");
              await click('Discard', '[data-unsaved-changes-modal] button');
              await click('Import from repository', '.settings-prototype-section-items button');
              results.push({ syntheticRepositoryPreview: true, skillNotInstalled: true });
            }
            if (statistics && section === 'Mod sources') {
              await revealAndCheck('#mod-source-secret', 'mod-source-secret', 1910);
              await clickSelector('[aria-label="Browse stored credentials"]');
              await wait(
                "document.querySelectorAll('#mod-source-credentials [role=option]').length===3",
              );
              await revealAndCheck(
                '#mod-source-credentials [role=option]:last-child',
                'mod-source-last-credential',
                1910,
              );
              await screenshot('audit-mod-source-credential-1910-statistics');
              await dimensions('audit-mod-source-credential', 1910);
              await clickSelector('[aria-label="Browse stored credentials"]');
            }
          },
          statistics,
        );
      }
    for (const section of ['Global documents', 'Execution boundaries']) {
      const name = 'audit-global-' + section + '-1910-' + state;
      await auditCheckpoint(
        name,
        async () => {
          await click('Agents', '.settings-prototype-menu button');
          await click('Global', '.agent-toolbar button');
          await click(section, '.settings-prototype-section-items button');
          await selectAuditEditor('Global', section);
          await screenshot(name.toLowerCase().replaceAll(' ', '-'));
          await dimensions(name, 1910);
        },
        statistics,
      );
    }
    await click('Agents', '.settings-prototype-menu button');
    await chooseAgent('Hatchet');
  }
  await chooseAgent('Hatchet');
  await c('Emulation.setDeviceMetricsOverride', {
    width: 2560,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const [category, section] of [
    ['General', 'Personalization'],
    ['General', 'Continuity'],
    ['General', 'Export'],
    ['General', 'Rail panels'],
    ['Agents', 'Agent details'],
    ['Agents', 'Profile documents'],
    ['Agents', 'MCP tools'],
    ['Agents', 'Dreams'],
    ['Skills', 'Installed skills'],
    ['Skills', 'Import from repository'],
    ['Connections', 'OpenTelemetry'],
    ['Connections', 'Load Balancing'],
    ['Connections', 'API tokens'],
    ['Connections', 'MCP servers'],
    ['Mods', 'Installed mods'],
    ['Mods', 'Mod sources'],
  ]) {
    await auditCheckpoint('wide-' + category + '-' + section, async () => {
      await click(category, '.settings-prototype-menu button');
      await click(section, '.settings-prototype-section-items button');
      await selectAuditEditor(category, section);
      const name = 'audit-wide-' + category + '-' + section;
      await screenshot(name.toLowerCase().replaceAll(' ', '-'));
      await dimensions(name, 2560);
    });
  }
  // Whole single forms use the same allocated left half as paired pages; no fake second panel.
  const singleSections = [
    ['General', 'Trace retention'],
    ['Connections', 'Authentication'],
    ['Skills', 'Import from repository'],
    ['Skills', 'New text skill'],
    ['Agents', 'Skills'],
    ['Mods', 'Automatic source checks'],
  ];
  for (const statistics of [false, true]) {
    await ensureAuditStatistics(statistics);
    for (const [category, section] of singleSections) {
      const name =
        'single-wide-' +
        category +
        '-' +
        section +
        '-' +
        (statistics ? 'statistics' : 'no-statistics');
      await auditCheckpoint(
        name,
        async () => {
          await click(category, '.settings-prototype-menu button');
          await click(section, '.settings-prototype-section-items button');
          await selectAuditEditor(category, section);
          await screenshot(name.toLowerCase().replaceAll(' ', '-'));
          await dimensions(name, 2560);
        },
        statistics,
      );
    }
  }
  // Probe the new narrow half just above the shared container breakpoint.
  for (const [width, statistics] of [
    [700, false],
    [768, false],
    [1280, true],
  ]) {
    const name =
      'single-retention-actions-' + width + '-' + (statistics ? 'statistics' : 'no-statistics');
    await auditCheckpoint(
      name,
      async () => {
        await c('Emulation.setDeviceMetricsOverride', {
          width,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await click('General', '.settings-prototype-menu button');
        await click('Trace retention', '.settings-prototype-section-items button');
        await selectAuditEditor('General', 'Trace retention');
        await revealAndCheck(
          '.retention-actions button:last-child',
          'single-retention-last-action',
          width,
        );
        await screenshot(name);
        await dimensions(name, width);
      },
      statistics,
    );
  }
  await click('Skills', '.settings-prototype-menu button');
  await click('Installed skills', '.settings-prototype-section-items button');
  await selectAuditEditor('Skills', 'Installed skills');
  for (const width of [1600, 1400]) {
    await c('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await pause();
    await wait("document.querySelectorAll('.skills-assignment-grid .skill-check').length===17");
    await revealAndCheck(
      '.skills-assignment-grid .skill-check:last-child',
      'skill-assignment17',
      width,
    );
    await screenshot('audit-skills-assignment17-' + width);
    const details = await evaluate("document.querySelector('.skills-source-group').open");
    if (!details) await clickSelector('.skills-source-group summary');
    await revealAndCheck('.skills-source-group summary', 'skill-source-summary', width);
    await screenshot('audit-skills-source-expanded-' + width);
    await dimensions('audit-skills-source-expanded', width);
  }
  for (const [category, section] of [
    ['Connections', 'MCP servers'],
    ['Mods', 'Mod sources'],
    ['General', 'Trace retention'],
    ['Connections', 'Authentication'],
  ]) {
    await click(category, '.settings-prototype-menu button');
    await click(section, '.settings-prototype-section-items button');
    await selectAuditEditor(category, section);
    if (section === 'Authentication') {
      await evaluate(
        "(()=>{const s=document.querySelector('.settings-prototype-configuration select');s.value='oidc';s.dispatchEvent(new Event('change',{bubbles:true}));})()",
      );
      await wait("!!document.querySelector('.oidc-fields')");
    }
    for (const width of [1000, 390]) {
      await c('Emulation.setDeviceMetricsOverride', {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await pause();
      await screenshot(
        'controls-' + section.toLowerCase().replaceAll(' ', '-') + '-' + width + '-statistics',
      );
      await dimensions('controls-' + section, width);
    }
    if (section === 'Authentication') {
      await evaluate(
        "(()=>{const s=document.querySelector('.settings-prototype-configuration select');s.value='none';s.dispatchEvent(new Event('change',{bubbles:true}));})()",
      );
      await pause();
    }
  }
  await clickSelector('[aria-label="Collapse system statistics"]');
  results.push({
    fullSubsectionStatisticsAudit: true,
    realisticInventories: {
      skills: 8,
      mods: 6,
      modSources: 4,
      pools: 6,
      telemetry: 3,
      apiTokens: 8,
      boundaries: 6,
    },
  });
  // Scheduling density: real first/last selection, stable inventory, reachable editors and actions.
  const scheduleSelect = async (family, index, width) => {
    const selector =
      '.settings-prototype-overflow .schedule-card:nth-child(' + index + ') .schedule-card-select';
    await revealAndCheck(selector, family + '-inventory-' + index, width);
    const inventory = () =>
      evaluate(
        "(()=>{const p=document.querySelector('.settings-prototype-overflow'),r=p.getBoundingClientRect(),w=document.querySelector('.settings-content-workspace').getBoundingClientRect();return {left:r.left-w.left,top:r.top-w.top,scrollTop:p.scrollTop}})()",
      );
    const before = await inventory();
    await clickSelector(selector);
    const after = await inventory();
    results.push({ scheduleSelection: { family, index, width, before, after } });
    if (
      Math.abs(before.left - after.left) > 2 ||
      Math.abs(before.top - after.top) > 2 ||
      Math.abs(before.scrollTop - after.scrollTop) > 2
    )
      recordGeometry(
        new Error(
          'Selecting schedule moved inventory ' +
            JSON.stringify({ family, index, width, before, after }),
        ),
      );
    const field =
      family === 'cron'
        ? '.schedule-fields input:not([type])'
        : '.schedule-form input[placeholder="owner/repo"]';
    const expected = family === 'cron' ? String(index).padStart(2, '0') : 'repository-' + index;
    if (
      !(await evaluate(
        `document.querySelector(${JSON.stringify(field)}).value.endsWith(${JSON.stringify(expected)})`,
      ))
    )
      throw new Error('Wrong selected schedule form ' + family + ' ' + index);
    await revealAndCheck(field, family + '-selected-field-' + index, width);
  };
  for (const [section, family] of [
    ['Cron jobs', 'cron'],
    ['Workflow events', 'workflow'],
    ['Dreams', 'dreams'],
  ]) {
    await c('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await click('Agents', '.settings-prototype-menu button');
    await chooseAgent('Hatchet');
    await click(section, '.settings-prototype-section-items button');
    if (family !== 'dreams')
      await wait(
        "document.querySelectorAll('.settings-prototype-overflow .schedule-card').length===12",
      );
    else await wait("!!document.querySelector('.dream-settings-fields textarea:not(:disabled)')");
    for (const width of [1600, 1400, 1000, 768, 390]) {
      await c('Emulation.setDeviceMetricsOverride', {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await pause();
      for (const stats of [false, true]) {
        if (stats) await clickSelector('[aria-label="Open system statistics"]');
        if (family !== 'dreams') {
          await scheduleSelect(family, 1, width);
          if ([1600, 390].includes(width))
            await screenshot(family + '-first-' + width + (stats ? '-statistics' : ''));
          await scheduleSelect(family, 12, width);
          await screenshot(family + '-last-' + width + (stats ? '-statistics' : ''));
          await revealAndCheck(
            '.settings-prototype-configuration .setting-actions button.primary',
            family + '-save',
            width,
          );
          if ([1600, 390].includes(width))
            await screenshot(family + '-actions-' + width + (stats ? '-statistics' : ''));
        } else {
          await revealAndCheck('.dream-settings-fields textarea', 'dream-prompt', width);
          await screenshot('dreams-config-' + width + (stats ? '-statistics' : ''));
          await revealAndCheck('.dream-memory-preview-actions button', 'dream-preview', width);
          await screenshot('dreams-memory-' + width + (stats ? '-statistics' : ''));
        }
        await dimensions(family + '-density' + (stats ? '-statistics' : ''), width);
        if (stats) await clickSelector('[aria-label="Collapse system statistics"]');
      }
    }
    await chooseAgent('Thistle');
    if (family !== 'dreams') {
      await wait(
        "document.querySelectorAll('.settings-prototype-overflow .schedule-card').length===12",
      );
      await scheduleSelect(family, 12, 390);
      const title = await evaluate(
        "document.querySelector('.settings-prototype-overflow .schedule-card:last-child strong').textContent",
      );
      if (!title.startsWith('thistle')) throw new Error('Schedule agent isolation failed');
    }
  }
  await c('Emulation.setDeviceMetricsOverride', {
    width: 2560,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await clickSelector('[aria-label="Open system statistics"]');
  for (const [section, family] of [
    ['Cron jobs', 'cron'],
    ['Workflow events', 'workflow'],
    ['Dreams', 'dreams'],
  ]) {
    await click(section, '.settings-prototype-section-items button');
    if (family !== 'dreams') {
      await wait(
        "document.querySelectorAll('.settings-prototype-overflow .schedule-card').length===12",
      );
      await scheduleSelect(family, 12, 2560);
    }
    await screenshot('wide-statistics-' + family);
    await dimensions('wide-statistics-' + family, 2560);
    if (
      !(await evaluate(
        "document.querySelector('.settings-utility-panel').getAttribute('aria-hidden')==='false'",
      ))
    )
      throw new Error('Persistent schedule statistics closed');
  }
  await clickSelector('[aria-label="Collapse system statistics"]');
  results.push({
    schedulingFirstLast12: true,
    schedulingAgentIsolation: true,
    dreamControlReachability: true,
  });
  // Extensions run last so a host lifecycle regression cannot hide built-in audit evidence.
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click('Fixture extension', '.settings-prototype-menu button');
  await wait("!!document.querySelector('.fixture-extension-editor')");
  await screenshot('extension-overview');
  await dimensions('extension-overview', 1600);
  await click('Advanced', '.settings-prototype-section-items button');
  await wait(
    "document.querySelector('.fixture-extension-editor h2')?.textContent==='Fixture extension advanced'",
  );
  await screenshot('extension-advanced');
  for (const width of [1000, 768, 390]) {
    await c('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await pause();
    await screenshot('extension-' + width);
    await dimensions('extension', width);
  }
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await clickSelector('[aria-label="Open system statistics"]');
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1910,
    height: 1025,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const statistics of [false, true])
    for (const [section, layout] of [
      ['Overview', 'imperative'],
      ['Form', 'form'],
      ['Inventory', 'form-inventory'],
      ['Details', 'list-detail'],
      ['Activity', 'activity'],
    ]) {
      const name =
        'audit-extension-' + layout + '-1910-' + (statistics ? 'statistics' : 'no-statistics');
      await auditCheckpoint(
        name,
        async () => {
          await click('Fixture extension', '.settings-prototype-menu button');
          await click(section, '.settings-prototype-section-items button');
          await wait(
            `document.querySelector('.mod-settings-mount')?.dataset.settingsLayout===${JSON.stringify(layout)}`,
          );
          if (section === 'Overview') {
            await wait("!!document.querySelector('.fixture-extension-editor')");
            await click('Advanced', '.settings-prototype-section-items button');
            await wait(
              "document.querySelector('.fixture-extension-editor h2')?.textContent==='Fixture extension advanced'",
            );
            await click('Overview', '.settings-prototype-section-items button');
          }
          if (section === 'Inventory') {
            await wait("document.querySelectorAll('.settings-inventory-select').length===3");
            await clickSelector('.settings-inventory-card:last-child .settings-inventory-select');
            if (!(await evaluate('!!document.querySelector(\'input[value="Synthetic value 3"]\')')))
              throw new Error('Declarative inventory editor selection failed');
          }
          if (section === 'Details') {
            await clickSelector('.mod-settings-mount .mcp-server-selector button:last-child');
            if (
              !(await evaluate(
                "document.querySelector('.settings-prototype-overflow h2').textContent==='Synthetic item 3'",
              ))
            )
              throw new Error('Declarative detail selection failed');
          }
          if (
            section === 'Activity' &&
            (await evaluate(
              "document.querySelectorAll('.mod-settings-mount .provider-card').length",
            )) !== 3
          )
            throw new Error('Declarative activity items missing');
          await evaluate('window.scrollTo(0,0)');
          await pause();
          await screenshot(name);
          await dimensions(name, 1910);
        },
        statistics,
      );
    }
  await click('Inventory', '.settings-prototype-section-items button');
  await clickSelector('.settings-inventory-card:last-child .settings-inventory-select');
  await c('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause();
  await revealAndCheck(
    '.settings-prototype-configuration input',
    'extension-inventory-selected-field',
    390,
  );
  await screenshot('audit-extension-form-inventory-390-statistics');
  await dimensions('audit-extension-form-inventory', 390);
  results.push({
    declarativeExtensionContracts: ['form', 'form-inventory', 'list-detail', 'activity'],
    declarativeInventorySelection: true,
    declarativeDetailSelection: true,
  });
  await clickSelector('[aria-label="Collapse system statistics"]');
  // Feedback-sized realistic Models usability, after the unchanged whole-Settings audit.
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1900,
    height: 981,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click('Connections', '.settings-prototype-menu button');
  await click('Models', '.settings-prototype-section-items button');
  await clickSelector('[aria-label="Open system statistics"]');
  await clickSelector('.models-provider-inventory .provider-card-select');
  await wait("document.querySelectorAll('.model-option').length===10");
  const modelDensity = async (name, width = 1900) => {
    const g = await evaluate(
      `(()=>{const box=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};const list=document.querySelector('.model-options'),lr=box(list),rows=[...list.querySelectorAll('.model-option')].map(box),editor=box(document.querySelector('.model-capability-editor'));let bottom=innerHeight,top=0;for(let p=list;p;p=p.parentElement){if(['hidden','clip','scroll','auto'].includes(getComputedStyle(p).overflowY)){const r=box(p);top=Math.max(top,r.top);bottom=Math.min(bottom,r.bottom);}}return {list:{...lr,clientHeight:list.clientHeight,scrollHeight:list.scrollHeight},rows,labels:[...list.querySelectorAll('.model-option')].map(row=>{const name=row.querySelector('.model-option-select strong'),id=row.querySelector('.model-option-select small');return {name:name?.textContent,id:id?.textContent,nameBox:name?box(name):null,idBox:id?box(id):null,thirdRow:!!row.querySelector('.model-option-summary'),idVisible:id?getComputedStyle(id).display!=='none'&&getComputedStyle(id).visibility!=='hidden':false}}),visibleRows:rows.filter(r=>r.top>=top-2&&r.bottom<=bottom+2).length,editor,capabilityColumn:box(document.querySelector('.models-capabilities-workspace')),providers:box(document.querySelector('.models-provider-inventory')),connectionFieldsHidden:document.querySelector('#models-connection-fields').hidden}})()`,
    );
    results.push({ modelDensity: { name, ...g } });
    if (
      g.rows.length !== 10 ||
      g.labels.some(
        (l) =>
          !l.name ||
          !l.id ||
          !l.idVisible ||
          l.thirdRow ||
          !l.nameBox ||
          !l.idBox ||
          l.idBox.top < l.nameBox.bottom - 2 ||
          l.idBox.height < 10,
      ) ||
      g.rows.some((r) => r.height < 48 || r.height > 58) ||
      g.list.scrollHeight > g.list.clientHeight + 2 ||
      g.visibleRows < 8 ||
      g.editor.height > 500 ||
      g.editor.right > g.capabilityColumn.right + 2 ||
      g.capabilityColumn.right - g.editor.right > 24 ||
      g.editor.width < 320 ||
      g.editor.left < g.list.right
    )
      recordGeometry(new Error('Ten-model density impractical ' + JSON.stringify({ name, ...g })));
    await screenshot(name);
    await dimensions(name, width);
  };
  const providerCardDensity = async (name) => {
    const cards = await evaluate(
      `(()=>{const box=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};return [...document.querySelectorAll('.models-provider-inventory .provider-card')].map(card=>({card:box(card),name:box(card.querySelector('strong')),metadata:box(card.querySelector('small')),remove:box(card.querySelector('.danger')),scrollWidth:card.scrollWidth,clientWidth:card.clientWidth}))})()`,
    );
    results.push({ providerCardDensity: { name, cards } });
    for (const g of cards) {
      if (
        g.remove.top >= g.name.bottom ||
        g.remove.bottom <= g.name.top ||
        g.remove.left < g.name.right - 2 ||
        g.metadata.top < g.name.bottom - 2 ||
        g.metadata.width < 160 ||
        g.metadata.right > g.card.right + 2 ||
        g.scrollWidth > g.clientWidth + 2
      )
        recordGeometry(
          new Error(
            'Provider card is not readable two-line layout ' + JSON.stringify({ name, ...g }),
          ),
        );
    }
  };
  const feedbackProportions = async (prefix) => {
    await c('Emulation.setDeviceMetricsOverride', {
      width: 1910,
      height: 1025,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await pause();
    let closedWidth;
    for (const statistics of [false, true]) {
      const open = await evaluate("!!document.querySelector('.settings-fidgit.has-utility-panel')");
      if (open !== statistics)
        await clickSelector(
          statistics
            ? '[aria-label="Open system statistics"]'
            : '[aria-label="Collapse system statistics"]',
        );
      await wait(`!!document.querySelector('.settings-fidgit.has-utility-panel')===${statistics}`);
      await wait(
        `(()=>{const p=document.querySelector('.settings-utility-panel'),s=getComputedStyle(p);return ${statistics}?s.visibility==='visible'&&Number(s.opacity)===1&&p.getBoundingClientRect().width>=250:s.visibility==='hidden'&&Number(s.opacity)===0&&p.getBoundingClientRect().width===0})()`,
      );
      const name = prefix + '-1910-' + (statistics ? 'statistics' : 'no-statistics');
      const g = await evaluate(
        `(()=>{const p=document.querySelector('.settings-utility-panel'),w=document.querySelector('.settings-content-workspace'),r=p.getBoundingClientRect(),wr=w.getBoundingClientRect(),style=getComputedStyle(p);return {open:!!document.querySelector('.settings-fidgit.has-utility-panel'),ariaHidden:p.getAttribute('aria-hidden'),visible:style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&r.width>0&&r.height>0,panelWidth:r.width,panelLeft:r.left,panelRight:r.right,workspaceWidth:wr.width,workspaceRight:wr.right,viewportWidth:innerWidth}})()`,
      );
      results.push({ feedbackStatistics: { name, expectedOpen: statistics, ...g } });
      if (!statistics) closedWidth = g.workspaceWidth;
      if (
        g.open !== statistics ||
        g.ariaHidden !== (statistics ? 'false' : 'true') ||
        (statistics
          ? !g.visible ||
            g.panelWidth < 250 ||
            g.panelWidth > 320 ||
            g.workspaceRight > g.panelLeft + 2 ||
            g.panelRight > g.viewportWidth + 2 ||
            closedWidth - g.workspaceWidth < 250
          : g.visible)
      )
        recordGeometry(
          new Error(
            'Feedback statistics state or reserved rail incorrect ' +
              JSON.stringify({ name, closedWidth, ...g }),
          ),
        );
      await modelDensity(name, 1910);
      await providerCardDensity(name);
    }
    await c('Emulation.setDeviceMetricsOverride', {
      width: 1900,
      height: 981,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await pause();
    if (
      !(await evaluate(
        "!!document.querySelector('.settings-fidgit.has-utility-panel')&&document.querySelector('.settings-utility-panel').getAttribute('aria-hidden')==='false'",
      ))
    )
      throw new Error('Feedback helper did not restore statistics open');
  };
  if (!(await evaluate("document.querySelector('#models-connection-fields').hidden")))
    throw new Error('Saved connection not collapsed');
  await modelDensity('models-ten-saved-1900-statistics');
  await feedbackProportions('models-ten-saved');
  await click('Edit connection', '.models-connection-heading button');
  if (await evaluate("document.querySelector('#models-connection-fields').hidden"))
    throw new Error('Saved connection cannot expand');
  await click('Hide connection', '.models-connection-heading button');
  await click('Add provider', '.models-workspace-header button');
  if (await evaluate("document.querySelector('#models-connection-fields').hidden"))
    throw new Error('New connection hidden');
  const setModelField = async (label, value) => {
    await evaluate(
      `(()=>{const e=[...document.querySelectorAll('#models-connection-fields label.field')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await pause();
  };
  await setModelField('Provider', 'Synthetic discovery ten');
  await setModelField('URL', 'https://synthetic-discovery.invalid/v1');
  await click('Connect', '.models-connection-editor .model-actions button');
  await wait("document.querySelectorAll('.model-option').length===10");
  if ((await evaluate("document.querySelectorAll('.model-option-check:checked').length")) !== 0)
    throw new Error('Discovery unexpectedly enabled models');
  await modelDensity('models-ten-new-discovered-1900-statistics');
  await clickSelector('.model-option:nth-child(2) .model-option-select');
  if ((await evaluate("document.querySelectorAll('.model-option-check:checked').length")) !== 0)
    throw new Error('Model selection enabled a model');
  await clickSelector('.model-option:nth-child(3) .model-option-check');
  if (
    !(await evaluate(
      "document.querySelector('.model-option:nth-child(2) .model-option-select').getAttribute('aria-pressed')==='true'",
    ))
  )
    throw new Error('Model enabled toggle moved detail selection');
  await clickSelector('.model-option:nth-child(2) .model-option-check');
  await clickSelector('input[name="Input-capability-mode"]:not(:checked)');
  await wait(`!document.querySelector('[aria-label="Input image"]').disabled`);
  await clickSelector('[aria-label="Input image"]');
  await clickSelector('input[name="Output-capability-mode"]:not(:checked)');
  await wait(`!document.querySelector('[aria-label="Output audio"]').disabled`);
  await clickSelector('[aria-label="Output audio"]');
  await clickSelector('input[name="context-window-mode"]:not(:checked)');
  await evaluate(
    "(()=>{const e=document.querySelector('#context-window-override');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'120000');e.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  await pause();
  await revealAndCheck('#manual-model-id', 'manual-model-add-field', 1900);
  await evaluate(
    "(()=>{const e=document.querySelector('#manual-model-id');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'synthetic-manual-added');e.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  await pause();
  await click('Add model', '.manual-model button');
  await wait("document.querySelectorAll('.model-option').length===11");
  await clickSelector('[aria-label="Delete manually added model synthetic-manual-added"]');
  await wait("document.querySelectorAll('.model-option').length===10");
  await revealAndCheck(
    '.models-connection-editor .model-actions button:last-child',
    'model-connection-save',
    1900,
  );
  await click('Save', '.models-connection-editor .model-actions button');
  await wait(
    "[...document.querySelectorAll('.models-provider-inventory .provider-card-select strong')].some(e=>e.textContent==='Synthetic discovery ten')",
  );
  await click('Synthetic discovery ten', '.models-provider-inventory .provider-card-select strong');
  await wait("document.querySelectorAll('.model-option').length===10");
  await clickSelector('.model-option:nth-child(2) .model-option-select');
  if (
    (await evaluate("document.querySelectorAll('.model-option-check:checked').length")) !== 2 ||
    !(await evaluate(
      `document.querySelector('#context-window-override').value==='120000'&&!document.querySelector('[aria-label="Input image"]').checked&&document.querySelector('[aria-label="Output audio"]').checked`,
    ))
  )
    throw new Error('Saved model selection/overrides did not reopen');
  await modelDensity('models-ten-reopened-1900-statistics');
  await evaluate('window.fixtureExpandProviders()');
  await wait(
    "document.querySelectorAll('.models-provider-inventory .provider-card-select').length===8",
  );
  await revealAndCheck(
    '.models-provider-inventory .provider-card:last-child .provider-card-select',
    'eighth-provider',
    1900,
  );
  await clickSelector('.models-provider-inventory .provider-card:last-child .provider-card-select');
  await wait(
    "document.querySelector('.models-connection-heading h3').textContent.includes('provider 8')",
  );
  await modelDensity('models-eight-providers-1900-statistics');
  const providerLayout = await evaluate(
    "(()=>{const p=document.querySelector('.models-provider-column').getBoundingClientRect(),c=document.querySelector('.models-connection-editor').getBoundingClientRect(),e=document.querySelector('.model-capability-editor').getBoundingClientRect();return {providerRight:p.right,providerWidth:p.width,providerHeight:p.height,connectionLeft:c.left,capabilityWidth:e.width}})()",
  );
  results.push({ providerLayout });
  if (
    providerLayout.providerRight > providerLayout.connectionLeft + 2 ||
    providerLayout.providerWidth < 190 ||
    providerLayout.providerWidth > 340 ||
    providerLayout.providerHeight < 500 ||
    providerLayout.capabilityWidth < 320
  )
    recordGeometry(
      new Error(
        'Eight-provider left rail or capability space unusable ' + JSON.stringify(providerLayout),
      ),
    );
  await feedbackProportions('models-eight-providers');
  results.push({
    tenModelDiscovery: true,
    selectionDoesNotEnable: true,
    enabledDoesNotMoveSelection: true,
    manualModelAddDelete: true,
    modelOverridesSaveReopen: true,
    eightProvidersReachable: true,
  });
  await clickSelector('[aria-label="Collapse system statistics"]');
  // Connection recovery uses deterministic synthetic outcomes; no real credentials/network.
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1910,
    height: 1025,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await ensureAuditStatistics(true);
  await clickSelector('.models-provider-inventory .provider-card-select');
  await wait("document.querySelector('#models-connection-fields').hidden");
  const recoverySnapshot = () =>
    evaluate(
      `(()=>{const fields=document.querySelector('#models-connection-fields');return {fields:[...fields.querySelectorAll('input,select')].map(e=>[e.type||e.tagName,e.value]),models:[...document.querySelectorAll('.model-option')].map(e=>({id:e.querySelector('.model-option-select small')?.textContent,enabled:e.querySelector('.model-option-check').checked})),selected:document.querySelector('.model-capability-editor h3')?.textContent};})()`,
    );
  const assertRecovery = async (name, expanded) => {
    const g = await evaluate(
      `(()=>{const f=document.querySelector('#models-connection-fields'),b=document.querySelector('[aria-controls="models-connection-fields"]'),r=f.getBoundingClientRect();return {hidden:f.hidden,display:getComputedStyle(f).display,width:r.width,height:r.height,expanded:b?.getAttribute('aria-expanded'),locked:b?.disabled,error:document.querySelector('.settings-request-error')?.textContent};})()`,
    );
    results.push({ connectionRecovery: { name, ...g } });
    if (
      expanded
        ? g.hidden ||
          g.display === 'none' ||
          g.width <= 0 ||
          g.height <= 0 ||
          g.expanded !== 'true' ||
          !g.locked
        : !g.hidden || g.expanded !== 'false' || g.locked
    )
      throw new Error(
        'Connection recovery visibility mismatch ' + JSON.stringify({ name, expanded, ...g }),
      );
  };
  await evaluate('window.fixtureFailNextModelSave()');
  await click('Save', '.models-connection-editor .model-actions button');
  await wait("document.body.textContent.includes('Synthetic save unavailable')");
  await assertRecovery('unrelated-save-error', false);
  const beforeFailure = await recoverySnapshot();
  await evaluate("window.fixtureQueueDiscovery(['fail'])");
  await click('Connect', '.models-connection-editor .model-actions button');
  await wait("document.body.textContent.includes('Synthetic upstream unavailable')");
  await assertRecovery('failed-connect', true);
  if (JSON.stringify(beforeFailure) !== JSON.stringify(await recoverySnapshot()))
    throw new Error('Failed Connect discarded draft or model selection');
  await setModelField('URL', 'https://synthetic-recovery.invalid/v1');
  await setModelField('API key', 'synthetic-recovery-token');
  const retryDraft = await recoverySnapshot();
  await evaluate("window.fixtureQueueDiscovery(['pending'])");
  await click('Connect', '.models-connection-editor .model-actions button');
  await wait(
    "[...document.querySelectorAll('.model-actions button')].some(e=>e.textContent==='Connecting…'&&e.disabled)",
  );
  await assertRecovery('pending-retry', true);
  const discoveryCount = await evaluate(
    "window.fixtureEvidence.requests.filter(r=>r.path.endsWith('/discover')).length",
  );
  await click('Connecting…', '.models-connection-editor .model-actions button');
  if (
    (await evaluate(
      "window.fixtureEvidence.requests.filter(r=>r.path.endsWith('/discover')).length",
    )) !== discoveryCount
  )
    throw new Error('Repeated pending Connect started duplicate request');
  await evaluate("window.fixtureReleaseDiscovery('fail')");
  await wait("document.body.textContent.includes('Synthetic upstream unavailable')");
  await assertRecovery('repeated-failure', true);
  if (JSON.stringify(retryDraft) !== JSON.stringify(await recoverySnapshot()))
    throw new Error('Retry discarded recovery draft or model selection');
  await revealAndCheck(
    '#models-connection-fields input[type=password]',
    'connection-recovery-key',
    1910,
  );
  await screenshot('models-connection-recovery-1910-statistics');
  await dimensions('models-connection-recovery', 1910);
  await c('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause();
  await assertRecovery('narrow-recovery', true);
  await revealAndCheck(
    '#models-connection-fields input[type=password]',
    'connection-recovery-key',
    390,
  );
  await screenshot('models-connection-recovery-390-statistics');
  await dimensions('models-connection-recovery', 390);
  await c('Emulation.setDeviceMetricsOverride', {
    width: 1910,
    height: 1025,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate("window.fixtureQueueDiscovery(['success-current'])");
  await click('Connect', '.models-connection-editor .model-actions button');
  await wait("document.querySelector('#models-connection-fields').hidden");
  await assertRecovery('successful-retry', false);
  await evaluate("window.fixtureQueueDiscovery(['fail'])");
  await click('Connect', '.models-connection-editor .model-actions button');
  await wait("document.body.textContent.includes('Synthetic upstream unavailable')");
  await clickSelector(
    '.models-provider-inventory .provider-card:nth-child(2) .provider-card-select',
  );
  if (await evaluate("!!document.querySelector('[data-unsaved-changes-modal]')"))
    await click('Discard', '[data-unsaved-changes-modal] button');
  await wait("document.querySelector('#models-connection-fields').hidden");
  await assertRecovery('provider-switch', false);
  await evaluate("window.fixtureQueueDiscovery(['fail'])");
  await click('Connect', '.models-connection-editor .model-actions button');
  await wait("document.body.textContent.includes('Synthetic upstream unavailable')");
  await click('Cancel', '.models-connection-editor .model-actions button');
  await clickSelector('.models-provider-inventory .provider-card-select');
  await wait("document.querySelector('#models-connection-fields').hidden");
  await assertRecovery('reset-and-reopen', false);
  results.push({
    connectionFailureRecovery: true,
    repeatedRetryRetainsDraftAndSelection: true,
    unrelatedSaveDoesNotExpand: true,
    pendingRetryDeduplicated: true,
    recoveryClearsOnSuccessSwitchReset: true,
  });
  const errors = await evaluate('window.fixtureEvidence.errors');
  if (errors.length) throw new Error('Browser errors: ' + JSON.stringify(errors));
  const removedOriginReads = await evaluate(
    "window.fixtureEvidence.requests.filter(r=>r.path==='/api/settings/browser-origin')",
  );
  if (removedOriginReads.length) throw new Error('Removed Browser origin settings still read API');
  results.push({ browserOriginMenuAbsent: true, browserOriginRequests: removedOriginReads });
  results.push({
    runtimeErrors: errors,
    requests: await evaluate('window.fixtureEvidence.requests'),
    utilityToggle: true,
  });
  if (auditFailures.length)
    throw new AggregateError(
      auditFailures.map((f) => new Error(f.name + ': ' + f.error)),
      `${auditFailures.length} subsection audit failures; see auditFailures`,
    );
  if (geometryFailures.length)
    throw new AggregateError(
      geometryFailures.map((message) => new Error(message)),
      `${geometryFailures.length} geometry assertions failed; see results.geometryFailures and checkpoint records`,
    );
  await writeFile(
    join(evidence, 'results.json'),
    JSON.stringify({ passed: true, auditFailures, geometryFailures, results }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, evidence, results }, null, 2));
} catch (error) {
  const runtimeErrors = captureRuntimeErrors
    ? await captureRuntimeErrors().catch((cause) => ({
        captureError: String(cause),
        runtimeExceptions,
      }))
    : { runtimeExceptions };
  if (captureFailure) await captureFailure().catch(() => {});
  await writeFile(
    join(evidence, 'results.json'),
    JSON.stringify(
      {
        passed: false,
        error: String(error),
        runtimeErrors,
        auditFailures,
        geometryFailures,
        results,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  browser?.kill();
  server.kill();
  await new Promise((r) => setTimeout(r, 150));
  await writeFile(
    join(evidence, 'browser-startup.json'),
    JSON.stringify(
      transport?.snapshot() ?? { error: 'Browser transport was not initialized' },
      null,
      2,
    ),
  );
  await rm(profile, { recursive: true, force: true });
}
