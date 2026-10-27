// Owned fixture only: temporary profile/server, CDP over pipe, no live app.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const profile = await mkdtemp(join(homedir(), 'ui-owned-chromium-'));
const server = spawn('python3', ['scripts/compact-ui-fixture/serve.py']);
let browser;
try {
 const line = await new Promise((resolve,reject)=>{server.stdout.once('data',d=>resolve(String(d)));server.once('error',reject);});
 const port = /PORT=(\d+)/.exec(line)[1];
 browser = spawn('chromium',['--headless','--no-sandbox','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--no-proxy-server','--no-first-run','--remote-debugging-pipe',`--user-data-dir=${profile}`],{stdio:['ignore','ignore','ignore','pipe','pipe']});
 const exceptions=[], network=[], responses=[];
 let id=0, buffer=''; const pending=new Map();
 browser.stdio[4].on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\0'))>=0){const text=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!text)continue;const m=JSON.parse(text);if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params);if(m.method==='Network.requestWillBeSent')network.push(m.params.request.url);if(m.method==='Network.responseReceived')responses.push({url:m.params.response.url,headers:m.params.response.headers});const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}});
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(new Error(`CDP timeout ${method}`));},10000);pending.set(key,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});browser.stdio[3].write(JSON.stringify({id:key,method,params,...(sessionId?{sessionId}:{})})+'\0');});
 const {targetId}=await call('Target.createTarget',{url:'about:blank'});
 const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
 const c=(method,params)=>call(method,params,sessionId);
 await c('Page.enable'); await c('Runtime.enable'); await c('Network.enable'); await c('Page.navigate',{url:`http://127.0.0.1:${port}`});
 const evaluate=async expression=>{const r=await c('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const sleep = ms => new Promise(r => setTimeout(r,ms));
 const assert = (ok, message) => { if (!ok) throw new Error(message); };
 const wait = async (expression, label, timeout = 3000) => {
   const start = Date.now();
   while(Date.now()-start < timeout) { if(await evaluate(`Boolean(${expression})`)) return; await sleep(25); }
   throw new Error(`Timeout: ${label}; body=${await evaluate('document.body.innerText')}`);
 };
 const out = new URL('./evidence/', import.meta.url).pathname;
 await mkdir(out, {recursive:true});
 const screenshot = async name => {const {data}=await c('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(out,name+'.png'),Buffer.from(data,'base64'));};
 const send = async () => {
   await evaluate(`(()=>{const e=document.querySelector('#chat-message');if(!e)throw Error('missing composer');const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set;setter.call(e,'/compact');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   await wait("!document.querySelector('[aria-label=\"Send message\"]').disabled",'send enabled');
   await evaluate(`document.querySelector('[aria-label="Send message"]').click()`);
   await wait("document.body.innerText.includes('Compacting context…')",'compacting visible');
   assert(await evaluate("[...document.querySelectorAll('.message.operator .final-answer')].some(e=>e.textContent.trim()==='/compact')"),'accepted /compact user turn missing');
   assert(!(await evaluate('document.body.innerText')).includes('Preparing response…'),'generic preparing label during compaction');
 };
 const results=[];
 await wait("!!document.querySelector('.context-usage')",'fixture ready');
 for(const width of [1280,375]) {
   await c('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
   await evaluate('localStorage.clear()');
   await c('Page.reload',{ignoreCache:true});
   await wait("document.querySelector('.context-usage em')?.textContent==='82%' && document.querySelector('#chat-message')",'initial meter');
   await screenshot(`${width}-before`);
   await send();
   await screenshot(`${width}-compacting`);
   const before=await evaluate("window.compactFixture.evidence.requests.filter(r=>r.path==='/api/agents/overview').length");
   await evaluate(`(()=>{window.meterObservedAt=0;const observer=new MutationObserver(()=>{if(document.querySelector('.context-usage em')?.textContent==='14%'){window.meterObservedAt=performance.now();observer.disconnect();}});observer.observe(document.querySelector('.context-usage'),{childList:true,subtree:true,attributes:true});window.compactFixture.complete();})()`);
   await wait("document.querySelector('.context-usage em')?.textContent==='14%' && document.body.innerText.includes('Context compacted. Summary saved; recent turns remain available.')",'immediate drop and receipt',1000);
   const success=await evaluate(`({latencyMs:window.meterObservedAt-window.compactFixture.evidence.completedAt,callbacks:window.compactFixture.evidence.compactionCallbacks,overviewRequests:window.compactFixture.evidence.requests.filter(r=>r.path==='/api/agents/overview').length,meterWidth:document.querySelector('.context-usage b').style.width,events:window.compactFixture.evidence.events.map(e=>e.type),requests:window.compactFixture.evidence.requests,turns:window.compactFixture.getDatabase().turns})`);
   assert(success.latencyMs>=0 && success.latencyMs<1000,'meter waited too long');
   assert(success.callbacks===1 && success.overviewRequests===before+1,'completion did not trigger exactly one immediate overview refresh');
   assert(success.meterWidth==='14%','visual meter fill not updated');
   assert(success.events.join(',')==='run.started,context.compaction.started,context.compaction.completed,run.completed','event sequence mismatch');
   assert(await evaluate("document.querySelectorAll('.message.operator .final-answer').length===2 && document.querySelectorAll('.message.agent .final-answer').length===2"),'duplicate or missing user/assistant turns');
   assert(!(await evaluate('document.body.innerText')).includes('Compacting context…'),'stale compacting spinner');
   await screenshot(`${width}-complete`);
   // Remove actual UI caches, leaving only the independent synthetic backend.
   await evaluate("Object.keys(localStorage).filter(k=>k!=='compact-fixture.backend.v1').forEach(k=>localStorage.removeItem(k))");
   await c('Page.reload',{ignoreCache:true});
   await wait("document.querySelector('.context-usage em')?.textContent==='14%' && document.body.innerText.includes('Context compacted. Summary saved; recent turns remain available.')",'receipt survives cache-free reload');
   assert(await evaluate("window.compactFixture.evidence.requests.some(r=>r.path==='/api/sessions/default?agentId=fixture')"),'refresh did not load persisted mock session');
   assert(await evaluate("[...document.querySelectorAll('.message.operator .final-answer')].filter(e=>e.textContent.trim()==='/compact').length===1"),'persisted /compact missing or duplicated');
   await screenshot(`${width}-refreshed`);
   const layout=await evaluate(`({width:${width},scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,chatWidth:document.querySelector('.chat-view').getBoundingClientRect().width,composerVisible:document.querySelector('#chat-message').getBoundingClientRect().bottom<=innerHeight})`);
   assert(layout.scroll<=layout.client && layout.composerVisible,'overflow or composer offscreen');
   await send(); await evaluate("window.compactFixture.complete('noop')");
   await wait("document.body.innerText.includes('No context eligible for compaction.') && !document.querySelector('.live-assistant-turn')",'no-op receipt');
   assert(await evaluate("document.querySelector('.context-usage em').textContent==='14%' && window.compactFixture.evidence.compactionCallbacks===1"),'no-op changed meter or failed refresh callback');
   await screenshot(`${width}-noop`);
   await send(); await evaluate("window.compactFixture.complete('failure')");
   await wait("document.body.innerText.includes('Fixture compaction failed.') && !document.querySelector('.live-assistant-turn')",'failed receipt');
   assert(await evaluate("document.querySelector('.context-usage em').textContent==='14%' && window.compactFixture.evidence.compactionCallbacks===1"),'failure reduced meter or invoked success refresh');
   await screenshot(`${width}-failure`);
   assert(await evaluate('window.compactFixture.evidence.unexpected.length===0'),'unmocked route '+JSON.stringify(await evaluate('window.compactFixture.evidence.unexpected')));
   results.push({width,success,persistedAfterCacheFreeReload:true,noOpPreservedMeter:true,failurePreservedMeter:true,layout});
 }
 assert(!exceptions.length,'uncaught browser exceptions '+JSON.stringify(exceptions));
 assert(network.every(url=>url.startsWith(`http://127.0.0.1:${port}/`) || url.startsWith('data:')),'external network request');
 assert(!network.some(url=>url.includes('/api/')),'real API network request');
 assert(responses.some(r=>Object.entries(r.headers).some(([k,v])=>k.toLowerCase()==='content-security-policy' && v.includes("connect-src 'none'"))),'CSP isolation missing');
 const report={targetRoot:process.cwd(),browser:'Chromium headless, CDP pipe, temporary profile',results,uncaughtExceptions:exceptions.length,realApiRequests:network.filter(url=>url.includes('/api/')).length,externalPageRequests:network.filter(url=>!url.startsWith(`http://127.0.0.1:${port}/`) && !url.startsWith('data:')),screenshots:12};
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
} finally {browser?.kill();server.kill();await new Promise(r=>setTimeout(r,200));await rm(profile,{recursive:true,force:true});}
