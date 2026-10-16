// Owned fixture only: temporary profile/server, CDP over pipe, no live app.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const profile = await mkdtemp(join(homedir(), 'ui-owned-chromium-'));
const server = spawn('python3', ['scripts/export-settings-fixture/serve.py']);
let browser;
try {
 const line = await new Promise((resolve,reject)=>{server.stdout.once('data',d=>resolve(String(d)));server.once('error',reject);});
 const port = /PORT=(\d+)/.exec(line)[1];
 browser = spawn('chromium',['--headless','--no-sandbox','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--remote-debugging-pipe',`--user-data-dir=${profile}`],{stdio:['ignore','ignore','ignore','pipe','pipe']});
 const exceptions=[], network=[];
 let id=0, buffer=''; const pending=new Map();
 browser.stdio[4].on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\0'))>=0){const text=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!text)continue;const m=JSON.parse(text);if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params);if(m.method==='Network.requestWillBeSent')network.push(m.params.request.url);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}});
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(new Error(`CDP timeout ${method}`));},10000);pending.set(key,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});browser.stdio[3].write(JSON.stringify({id:key,method,params,...(sessionId?{sessionId}:{})})+'\0');});
 const {targetId}=await call('Target.createTarget',{url:'about:blank'});
 const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
 const c=(method,params)=>call(method,params,sessionId);
 await c('Page.enable'); await c('Runtime.enable'); await c('Network.enable'); await c('Page.navigate',{url:`http://127.0.0.1:${port}`});
 const evaluate=async expression=>{const r=await c('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 for(let i=0;i<50;i++){if(await evaluate("document.querySelectorAll('.export-option').length===8"))break;await new Promise(r=>setTimeout(r,100));}
 const sleep = ms => new Promise(r => setTimeout(r,ms));
 const assert = (ok, message) => { if (!ok) throw new Error(message); };
 const click = async text => { await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('missing button '+${JSON.stringify(text)});b.click()})()`); await sleep(80); };
 const fill = async (selector, value) => { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing field');const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set;setter.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(40); };
 const text = () => evaluate('document.body.innerText');
 const check = async label => { await evaluate(`(()=>{const e=[...document.querySelectorAll('.export-option')].find(e=>e.querySelector('b').textContent===${JSON.stringify(label)});e.querySelector('input').click()})()`); await sleep(50); };
 await check('Settings'); await check('Scheduled jobs'); await check('Operator text skills');
 await click('Download export');
 assert(await evaluate("JSON.stringify(window.fixtureRequests.find(r=>r.path==='/api/export').body)===''+JSON.stringify({categories:['scheduled-jobs','skills']})"),'implicit dependencies or password included');
 await check('Model connections');
 assert(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Download export').disabled"),'secret export not gated');
 await fill('input[type=password]', 'fixture-only-password'); await click('Download export');
 assert(await evaluate("document.querySelector('input[type=password]').value===''") ,'transient password retained');
 assert(await evaluate("window.fixtureRequests.filter(r=>r.path==='/api/export')[1].body.password==='fixture-only-password'"),'secret password missing');
 await evaluate(`(()=>{const f=new File(['fixture'], 'portable-fixture.bin');const t=new DataTransfer();t.items.add(f);const e=document.querySelector('input[type=file]');e.files=t.files;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await sleep(150);
 assert((await text()).includes('This export is encrypted.'),'encrypted challenge missing');
 await fill('section.setting-section:last-child input[type=password]','fixture-only-password');
 await click('Preview export');
 assert((await text()).includes('Supported: 4 items'),'expanded import preview missing');
 assert((await text()).includes('Enabled scheduled jobs remain enabled'),'enabled job warning missing');
 // Inspect shared section hierarchy, scrolling/reachability and narrow/desktop layout.
 const layouts=[];
 for(const width of [375,1280]){
   await c('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false}); await sleep(100);
   layouts.push(await evaluate(`(()=>{const e=document.querySelector('.settings-prototype-configuration'); const h=e.querySelector('h2');const s=getComputedStyle(h);const b=[...e.querySelectorAll('button')].find(b=>b.textContent==='Import export');b.scrollIntoView();return {width:${width},scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,headingSize:s.fontSize,headingDivider:s.borderBottomWidth,primarySections:e.querySelectorAll(':scope > .setting-section').length,overflowControls:document.querySelector('.settings-prototype-overflow').querySelectorAll('input,button').length,importReachable:b.getBoundingClientRect().bottom<=innerHeight}})()`));
 }
 assert(layouts.every(r=>r.scroll<=r.client && r.importReachable && r.headingSize==='14px' && r.primarySections===2 && r.overflowControls===0),'layout regression '+JSON.stringify(layouts));
 await click('Import export');
 assert(await evaluate("!!document.activeElement.closest('[role=alertdialog]')"),'confirmation focus escaped');
 await click('Cancel');
 assert(await evaluate("!window.fixtureRequests.some(r=>r.path==='/api/export/import')"),'cancel applied import');
 await click('Import export');
 await evaluate("document.querySelector('[role=alertdialog] button.danger').click()"); await sleep(120);
 assert(await evaluate("window.fixtureRequests.filter(r=>r.path==='/api/export/import').length===1"),'apply count wrong');
 assert(!(await text()).includes('Selected: portable-fixture.bin'),'import not cleared');
 assert(!exceptions.length,'uncaught browser exceptions '+JSON.stringify(exceptions));
 assert(!network.some(url=>url.includes('/api/')),'real API request');
 console.log(JSON.stringify({catalogCategories:8,explicitSelectionsOnly:true,secretPasswordGating:true,encryptedImportChallenge:true,expandedPreview:true,cancelWithoutApply:true,confirmedApplyCount:1,transientPasswordsCleared:true,uncaughtExceptions:exceptions.length,realApiRequests:network.filter(url=>url.includes('/api/')).length,layouts},null,2));
} finally {browser?.kill();server.kill();await new Promise(r=>setTimeout(r,200));await rm(profile,{recursive:true,force:true});}
