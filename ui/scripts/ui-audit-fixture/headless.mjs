// Owned fixture only: temporary profile/server, CDP over pipe, no live app.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const profile = await mkdtemp(join(homedir(), 'ui-owned-chromium-'));
const server = spawn('python3', ['scripts/ui-audit-fixture/serve.py']);
let browser;
try {
 const line = await new Promise((resolve,reject)=>{server.stdout.once('data',d=>resolve(String(d)));server.once('error',reject);});
 const port = /PORT=(\d+)/.exec(line)[1];
 browser = spawn('chromium',['--headless','--no-sandbox','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--remote-debugging-pipe',`--user-data-dir=${profile}`],{stdio:['ignore','ignore','ignore','pipe','pipe']});
 let id=0, buffer=''; const pending=new Map();
 browser.stdio[4].on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\0'))>=0){const text=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!text)continue;const m=JSON.parse(text);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}});
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(new Error(`CDP timeout ${method}`));},10000);pending.set(key,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});browser.stdio[3].write(JSON.stringify({id:key,method,params,...(sessionId?{sessionId}:{})})+'\0');});
 const {targetId}=await call('Target.createTarget',{url:'about:blank'});
 const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
 const c=(method,params)=>call(method,params,sessionId);
 await c('Page.enable'); await c('Page.navigate',{url:`http://127.0.0.1:${port}`});
 const evaluate=async expression=>{const r=await c('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 for(let i=0;i<50;i++){if(await evaluate("!!document.querySelector('.cockpit')"))break;await new Promise(r=>setTimeout(r,100));}
 const results=[];
 for(const width of [320,375,600,640,1280]){
  await c('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  await new Promise(r=>setTimeout(r,100));
  results.push(await evaluate(`(()=>{const elements=[...document.querySelectorAll('.left-rail,.right-rail,.workspace-toolbar select')];return {width:${width},scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,controls:elements.map(e=>({tag:e.tagName,label:e.getAttribute('aria-label'),visible:e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0}))};})()`));
 }
 await evaluate("[...document.querySelectorAll('button')].find(e=>e.textContent==='Destructive confirmation').focus();document.activeElement.click()");
 await new Promise(r=>setTimeout(r,100));
 const focus=await evaluate("({active:document.activeElement.textContent,inert:[...document.body.children].filter(e=>e.inert).length,dialogs:document.querySelectorAll('[role=alertdialog],[role=dialog]').length})");
 await c('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await c('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await new Promise(r=>setTimeout(r,100));
 const restored=await evaluate('document.activeElement.textContent');
 const keyboard=[];
 const key=async (name,code,modifiers=0)=>{for(const type of ['keyDown','keyUp'])await c('Input.dispatchKeyEvent',{type,key:name,code:name,windowsVirtualKeyCode:code,modifiers});};
 await evaluate("[...document.querySelectorAll('button')].find(e=>e.textContent==='Destructive confirmation').focus()");
 await evaluate('document.activeElement.click()'); await new Promise(r=>setTimeout(r,100));
 for(let i=0;i<8;i++){await key('Tab',9);keyboard.push(await evaluate("!!document.activeElement.closest('[role=alertdialog],[role=dialog]')"));}
 for(let i=0;i<8;i++){await key('Tab',9,8);keyboard.push(await evaluate("!!document.activeElement.closest('[role=alertdialog],[role=dialog]')"));}
 await key('Escape',27);
 if(keyboard.some(v=>!v))throw new Error('Keyboard focus escaped owned dialog');
 await evaluate("document.querySelector('[aria-label=\"Move Bea up\"]').focus()");
 const focusedOrder=await evaluate('document.activeElement.getAttribute("aria-label")');
 if(focusedOrder!=='Move Bea up')throw new Error('Order button not focused');
 await c('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '});
 await c('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
 await new Promise(r=>setTimeout(r,100));
 const order=await evaluate("[...document.querySelectorAll('.agent-sidebar-order-list b')].map(e=>e.textContent)");
 if(order[0]!=='Bea')throw new Error('Native Space did not reorder: '+JSON.stringify(order));
 await evaluate("document.querySelector('[aria-label=\"Resize left rail panels\"]').focus()");
 await key('ArrowDown',40); await new Promise(r=>setTimeout(r,100));
 const split=await evaluate("document.querySelector('[aria-label=\"Resize left rail panels\"]').getAttribute('aria-valuenow')");
 if(split!=='55')throw new Error('Keyboard split failed '+split);
 await key('Home',36); await new Promise(r=>setTimeout(r,50));
 if(await evaluate("document.querySelector('[aria-label=\"Resize left rail panels\"]').getAttribute('aria-valuenow')")!=='25')throw new Error('Home split');
 await key('End',35); await new Promise(r=>setTimeout(r,50));
 if(await evaluate("document.querySelector('[aria-label=\"Resize left rail panels\"]').getAttribute('aria-valuenow')")!=='75')throw new Error('End split');
 await evaluate("document.querySelector('[aria-label=\"Stop fixture run\"]').focus()");
 await c('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '}); await c('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
 await new Promise(r=>setTimeout(r,50));
 if(await evaluate("document.querySelector('[role=status]').textContent")!=='Stopped local run')throw new Error('Stop activation');
 await evaluate("document.querySelector('[role=tab]').focus()"); await key('ArrowRight',39); await new Promise(r=>setTimeout(r,50));
 if(await evaluate("document.activeElement.getAttribute('aria-selected')")!=='true')throw new Error('Tab selection');
 await evaluate("document.querySelector('.workspace-toolbar select').focus()"); await key('ArrowDown',40); await key('Tab',9); await new Promise(r=>setTimeout(r,50));
 const selector=await evaluate("document.querySelector('.workspace-toolbar select').value");
 console.log(JSON.stringify({stopActivated:true,tabSelected:true,selector}));
 const zoomBefore=await evaluate('({dpr:devicePixelRatio,width:innerWidth})');
 await key('+',187,2); await new Promise(r=>setTimeout(r,100));
 const zoomAfter=await evaluate('({dpr:devicePixelRatio,width:innerWidth})');
 console.log(JSON.stringify({focusedOrder,order,split,nativeZoomProbe:{zoomBefore,zoomAfter,changed:JSON.stringify(zoomBefore)!==JSON.stringify(zoomAfter)}}));
 // Increased text sizing is reflow evidence, NOT native browser zoom certification.
 await evaluate("document.documentElement.style.fontSize='200%'");
 await c('Emulation.setDeviceMetricsOverride',{width:640,height:900,deviceScaleFactor:1,mobile:false});
 await new Promise(r=>setTimeout(r,100));
 const textReflow=await evaluate("({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})");
 if(textReflow.scroll>textReflow.client)throw new Error('200% text caused page overflow');
 console.log(JSON.stringify({keyboardTrap:keyboard,textReflow}));

 console.log(JSON.stringify({results,focus,restored},null,2));
 if(results.some(r=>r.scrollWidth>r.clientWidth||r.controls.some(e=>!e.visible))||focus.active!=='Cancel'||!focus.inert||restored!=='Destructive confirmation')throw new Error('Rendered acceptance failed');
} finally {browser?.kill();server.kill();await new Promise(r=>setTimeout(r,200));await rm(profile,{recursive:true,force:true});}
