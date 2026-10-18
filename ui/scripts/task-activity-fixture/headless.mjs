// Owned fixture only: temporary profile/server, CDP over pipe, no live app.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const profile = await mkdtemp(join(homedir(), 'ui-owned-chromium-'));
const server = {kill(){}};
let browser;
try {
 const port=8766;
 browser = spawn('chromium',['--headless','--no-sandbox','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--remote-debugging-pipe',`--user-data-dir=${profile}`],{stdio:['ignore','ignore','ignore','pipe','pipe']});
 let id=0, buffer=''; const pending=new Map();
 browser.stdio[4].on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\0'))>=0){const text=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!text)continue;const m=JSON.parse(text);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}});
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(new Error(`CDP timeout ${method}`));},10000);pending.set(key,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});browser.stdio[3].write(JSON.stringify({id:key,method,params,...(sessionId?{sessionId}:{})})+'\0');});
 const {targetId}=await call('Target.createTarget',{url:'about:blank'});
 const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
 const c=(method,params)=>call(method,params,sessionId);
 await c('Page.enable'); await c('Page.navigate',{url:`http://127.0.0.1:${port}`});
 const evaluate=async expression=>{const r=await c('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 for(let i=0;i<50;i++){if(await evaluate("!!document.querySelector('.task-card')"))break;await new Promise(r=>setTimeout(r,100));}

 await evaluate("document.querySelector('.task-card').click()");
 for(let i=0;i<50;i++){if(await evaluate("!!document.querySelector('.task-history-row')"))break;await new Promise(r=>setTimeout(r,100));}
 const results=[];
 for(const width of [1440,375,320]){
 await c('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
 await new Promise(r=>setTimeout(r,150));
 results.push(await evaluate(`(()=>{const dialog=document.querySelector('[role=dialog]'); const activity=document.querySelector('.task-activity'); const box=dialog.getBoundingClientRect(); const rows=[...document.querySelectorAll('.task-history-row')];return {width:${width},viewport:innerWidth,dialog:{left:box.left,right:box.right,scrollWidth:dialog.scrollWidth,clientWidth:dialog.clientWidth},documents:document.querySelectorAll('.task-document-list li').length,history:rows.length,order:rows.map(e=>e.querySelector('strong').textContent),detailsClosed:[...activity.querySelectorAll('details')].every(e=>!e.open),overflow:[...activity.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();return r.width&& (r.right>box.right+1||r.left<box.left-1)}).map(e=>e.className||e.tagName)};})()`));
 await c('Page.captureScreenshot',{format:'png'}).then(async r=>{const {writeFile}=await import('node:fs/promises');await writeFile('/tmp/task-activity-'+width+'.png',Buffer.from(r.data,'base64'));});
 }
 await evaluate("document.querySelector('.task-history-list details summary').click()");
 const disclosure=await evaluate("({open:document.querySelector('.task-history-list details').open,text:document.querySelector('.task-history-list details').textContent})");
 const scrolling=await evaluate("(()=>{const e=document.querySelector('[role=dialog]');let p=document.querySelector('.task-activity');const a=[];while(p){if(p.scrollHeight>p.clientHeight){p.scrollTop=p.scrollHeight;a.push({class:p.className,top:p.scrollTop,height:p.clientHeight,scroll:p.scrollHeight});}p=p.parentElement;}return a})()");
 console.log(JSON.stringify({results,disclosure,scrolling},null,2));
 if(results.some(r=>r.documents!==1||r.history!==3||r.overflow.length||r.dialog.scrollWidth>r.dialog.clientWidth||r.dialog.left<0||r.dialog.right>r.viewport))throw Error('Layout failed');
} finally {browser?.kill();server.kill();await new Promise(r=>setTimeout(r,200));await rm(profile,{recursive:true,force:true});}
