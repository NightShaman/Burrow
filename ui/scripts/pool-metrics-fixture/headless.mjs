// Owned fixture only: temporary profile/server, CDP over pipe, no live app.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const profile = await mkdtemp(join(homedir(), 'ui-owned-chromium-'));
const server = spawn('python3', ['scripts/pool-metrics-fixture/serve.py']);
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
 for(let i=0;i<50;i++){if(await evaluate("!!document.querySelector('.pool-footer-metrics strong')"))break;await new Promise(r=>setTimeout(r,100));}
 const sleep = ms => new Promise(r => setTimeout(r,ms));
 const assert = (ok, message) => { if (!ok) throw new Error(message); };
 const click = async text => { await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('missing button '+${JSON.stringify(text)});b.click()})()`); await sleep(80); };
 const fill = async (selector, value) => { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing field');const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set;setter.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(40); };
 const text = () => evaluate('document.body.innerText');


 const results=[];
 for (const [width,height,label] of [[1920,1200,'100'],[2133,1333,'90-equivalent'],[1100,900,'narrow'],[720,900,'scroll']]) {
  await c('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false}); await sleep(100);
  const geometry=await evaluate(`(()=>{const f=document.querySelector('.status-bar');return {width:innerWidth,body:document.documentElement.scrollWidth,footer:f.getBoundingClientRect().toJSON(),client:f.clientWidth,scroll:f.scrollWidth,text:f.innerText,clipped:[...f.querySelectorAll('strong')].some(e=>e.scrollWidth>e.clientWidth)}})()`);
  assert(geometry.body<=width && !geometry.clipped, 'footer/page clips numbers');
  if(width>=1100)assert(geometry.scroll<=geometry.client+1,'desktop footer overflow');
  if(width===720){await evaluate("document.querySelector('.status-bar').scrollLeft=9999");assert(await evaluate("document.querySelector('.status-bar').scrollLeft>0"),'narrow scrolling unavailable');}
  results.push({label,...geometry});
  await c('Page.captureScreenshot',{format:'png'}).then(async r=>(await import('node:fs/promises')).writeFile(`/tmp/smatchet-metrics-${label}.png`,Buffer.from(r.data,'base64')));
 }
 await fill('select','7d');
 assert((await text()).includes('1M') && (await text()).includes('—') && (await text()).includes('0%'),'7d/null switch failed');
 assert(await evaluate("document.querySelector('[title*=Partial]').title.includes('12000 of 13000')"),'cache coverage tooltip missing');
 assert(await evaluate('window.fixtureEvidence.requests.length===1'),'selector refetched');
 assert(exceptions.length===0,'browser exceptions');
 console.log(JSON.stringify({ok:true,results,exceptions},null,2));
} finally { browser?.kill('SIGTERM'); server.kill('SIGTERM'); await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:150}); }
