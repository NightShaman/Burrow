import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [distArg,outArg]=process.argv.slice(2);if(!distArg||!outArg)throw Error('usage: node profile-archive.mjs DIST OUTPUT');
const dist=path.resolve(distArg),out=path.resolve(outArg);await fs.mkdir(out,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sessions=['live','reset'].map(kind=>({agentId:'a',agentName:'Acceptance Agent A',sessionId:'acceptance-'+kind,id:'acceptance-'+kind,title:'Acceptance acceptance-'+kind,summary:'Deterministic archive fixture',turnCount:1250,chatTurnCount:1250,createdAt:'2026-10-01T10:00:00Z',updatedAt:'2026-10-25T10:00:00Z',archived:kind==='reset',archivedAt:kind==='reset'?'2026-10-26T10:00:00Z':null,kind:'chat',lastRole:'assistant',lastRunId:null,...(kind==='reset'?{archiveSnapshot:'reset',sourceSessionId:'acceptance-reset'}:{})}));
// Exact Markdown text and timestamp arithmetic from browser-harness.mjs seed lines 84-95.
const turns=id=>Array.from({length:1250},(_,i)=>{const n=i+1;return {id:id+'-'+n,type:'message',role:n%2===0?'assistant':'user',visibility:'chat',entersPrompt:true,ts:new Date(Date.UTC(2026,9,1,10)+Math.floor((n-1)/50)*86400000+(n%50)*60000).toISOString(),content:'### Archive fixture '+n+'\n\nA meaningful paragraph with **bold**, *emphasis*, and `inline code`.\n\n- Item one\n- Item two\n\n> Blockquote for layout acceptance.\n\n'+'Chronological history with searchable project detail. '.repeat(3)}});
const data=Object.fromEntries(sessions.map(s=>[s.sessionId,turns(s.sessionId)]));await fs.writeFile(out+'/fixture.json',JSON.stringify({sessions,data},null,2));
const requests=[],errors=[];
function api(u){const p=u.pathname;
 if(p==='/api/archive/sessions')return {sessions,nextCursor:null,hasMore:false};
 if(p.startsWith('/api/archive/sessions/a/')){const id=decodeURIComponent(p.split('/').at(-1));if(!data[id])throw Error('unknown session');const end=Number(u.searchParams.get('before')||1250),start=Math.max(0,end-100);return {session:{turns:data[id].slice(start,end)},hasMore:start>0,nextCursor:start?String(start):null,historyStatus:'complete'};}
 if(p==='/api/archive/calendar')return {ok:true,kind:u.searchParams.get('kind'),month:u.searchParams.get('month'),dates:Array.from({length:25},(_,i)=>'2026-10-'+String(i+1).padStart(2,'0'))};
 if(p.includes('/dreams/groups'))return {ok:true,groups:[],hasMore:false,nextCursor:null};
 if(p.includes('/continuity/cards'))return {cards:[],hasMore:false,nextCursor:null};
 if(p==='/api/setup/status')return {wizardStep:'ready',configured:true};
 if(p==='/api/health')return {ok:true,version:'controlled-production-fixture'};
 if(p==='/api/settings/model-connections')return {connections:[]};
 if(p==='/api/settings/identities')return {agents:[],operator:{name:'Operator'}};
 if(p==='/api/task-board/tasks')return {tasks:[]};if(p==='/api/task-board/projects')return {projects:[]};
 if(p==='/api/agents'||p==='/api/agents/overview')return {agents:[]};
 if(p==='/api/group-channels')return {ok:true,channels:[]};
 if(p.includes('/mods'))return {ok:true,mods:[],panels:[],archives:[]};
 return null;
}
const server=createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost');if(u.pathname.startsWith('/api/')){const body=api(u);requests.push({method:req.method,url:req.url,status:body?200:404});res.writeHead(body?200:404,{'content-type':'application/json'});res.end(JSON.stringify(body||{error:'Unmocked endpoint'}));return;}const file=path.resolve(dist,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!file.startsWith(dist+path.sep))throw Error('invalid path');const bytes=await fs.readFile(file);res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream'});res.end(bytes)}catch(e){res.writeHead(404);res.end(String(e))}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser,ws,chromeDir;const ops=[];let call,ev;
try{
 chromeDir=await fs.mkdtemp('/tmp/archive-profile-chrome-');browser=spawn('/snap/bin/chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update','--no-first-run','--remote-debugging-port=0','--user-data-dir='+chromeDir,'about:blank'],{stdio:['ignore','ignore','pipe']});let log='';browser.stderr.on('data',b=>log+=b);
 let port;for(let i=0;i<200;i++){port=log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1];if(port)break;await sleep(100)}if(!port)throw Error(log);
 const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let seq=0;const waiting=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const w=waiting.get(m.id);waiting.delete(m.id);if(w)m.error?w[1](Error(JSON.stringify(m.error))):w[0](m.result)}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params)};
 call=(method,params={})=>new Promise((r,j)=>{const id=++seq;waiting.set(id,[r,j]);ws.send(JSON.stringify({id,method,params}))});ev=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
 const until=async expr=>{for(let i=0;i<4000;i++){if(await ev(expr))return;await sleep(25)}throw Error('timeout '+expr+' BODY '+await ev('document.body.innerText'))};
 await call('Page.enable');await call('Runtime.enable');await call('Profiler.enable');await call('Profiler.setSamplingInterval',{interval:1000});await call('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});await call('Emulation.setTimezoneOverride',{timezoneId:'UTC'});
 await call('Page.addScriptToEvaluateOnNewDocument',{source:`window.__copies=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copies.push({text,time:performance.now(),pending:document.querySelectorAll('[data-body-ready=false]').length})}}});window.__long=[];new PerformanceObserver(l=>window.__long.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});`});await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});
 const click=text=>`[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)}).click()`;
 await until(`!![...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='archive')`);await ev(click('archive'));await until(`document.querySelectorAll('.archive-session-card').length===2`);
 const probes=[];
 async function measure(name,action,count){
 await sleep(150);await call('Profiler.start');
 await ev(`window.__op={start:performance.now(),paint:null,complete:null};window.__watch=()=>{const rows=[...document.querySelectorAll('.archive-turn')];const visible=window.__op.paint===null&&rows.flatMap(n=>[...n.querySelectorAll('.archive-turn-body h3')]).find(n=>{const r=n.getBoundingClientRect();const p=document.querySelector('.archive-reader-body')?.getBoundingClientRect();return p&&r.bottom>p.top&&r.top<p.bottom&&r.bottom>0&&r.top<innerHeight});if(rows.length===${count}&&visible&&window.__op.paint===null)requestAnimationFrame(()=>{if(window.__op.paint===null){window.__op.paint=performance.now();window.__op.visible=visible.textContent}});if(rows.length===${count}&&rows.every(n=>n.dataset.bodyReady!=='false'))requestAnimationFrame(()=>window.__op.complete=performance.now());else requestAnimationFrame(window.__watch)};requestAnimationFrame(window.__watch);${action}`);
 if(name.startsWith('open-')){
 await until(`document.querySelectorAll('.archive-turn').length===${count}`);
 await ev(`window.__responsiveness={pendingAtStart:document.querySelectorAll('[data-body-ready=false]').length,start:performance.now()};document.querySelector('.archive-copy-button').click();setTimeout(()=>{const r=document.querySelector('.archive-reader-body');r.scrollTop=Math.max(0,r.scrollTop-250);window.__responsiveness.timer=performance.now();window.__responsiveness.scrollTop=r.scrollTop;window.__responsiveness.pendingAtTimer=document.querySelectorAll('[data-body-ready=false]').length},0)`);
 }
 await until('window.__op.complete!==null');await sleep(120);
 const state=await ev(`({...window.__op,end:performance.now(),rows:document.querySelectorAll('.archive-turn').length,ready:document.querySelectorAll('[data-body-ready=false]').length===0,longs:window.__long.filter(e=>e.start>=window.__op.start&&e.start<window.__op.complete),heading:document.querySelector('.archive-reader-toolbar')?.innerText,responsiveness:${name.startsWith('open-')?'window.__responsiveness':'null'},anchor:window.__anchor?{connected:window.__anchor.node.isConnected,offsetBefore:window.__anchor.offset,offsetAfter:window.__anchor.node.getBoundingClientRect().top-document.querySelector('.archive-reader-body').getBoundingClientRect().top}:null})`);
 const {profile}=await call('Profiler.stop');await fs.writeFile(out+'/'+name+'.cpuprofile',JSON.stringify(profile));state.name=name;state.actionToFirstVisibleMarkdownPaintMs=state.paint-state.start;state.actionToCompletionMs=state.complete-state.start;state.longestTaskMs=Math.max(0,...state.longs.map(x=>x.duration));ops.push(state);console.log(JSON.stringify(state));
 }
 for(const kind of ['live','reset']){
 await ev('window.__anchor=null');
 await measure('open-'+kind,`[...document.querySelectorAll('.archive-session-card')].find(n=>n.textContent.includes('Acceptance acceptance-${kind}')).click()`,100);
 for(let i=2;i<=13;i++){
 await ev(`document.querySelector('.archive-reader-body').scrollTop=0`);await sleep(80);
 await ev(`{const r=document.querySelector('.archive-reader-body'),top=r.getBoundingClientRect().top;const node=[...r.querySelectorAll('.archive-turn')].find(n=>n.getBoundingClientRect().bottom>top);window.__anchor={node,offset:node.getBoundingClientRect().top-top};void 0}`);
 await measure(kind+'-prepend-'+i,click('Load earlier messages'),Math.min(i*100,1250));
 }
 probes.push(await ev(`(()=>{const r=document.querySelector('.archive-reader-body');const range=document.createRange();range.selectNodeContents(r);getSelection().removeAllRanges();getSelection().addRange(range);const selected=getSelection().toString();const result={kind:'${kind}',selectionFirst:selected.includes('Archive fixture 1'),selectionLast:selected.includes('Archive fixture 1250'),findFirst:window.find('Archive fixture 1',false,false,true),findLast:window.find('Archive fixture 1250',false,false,true),rows:r.querySelectorAll('.archive-turn').length};getSelection().removeAllRanges();return result})()`));
 // Controlled DOM-only height changes in a retained row above a mid-history anchor.
 await ev(`{const r=document.querySelector('.archive-reader-body'),rows=[...r.querySelectorAll('.archive-turn')];r.scrollTop=rows[600].offsetTop;window.__mediaAnchor=rows[600];void 0;}`);await sleep(120);
 const before=await ev(`window.__mediaAnchor.getBoundingClientRect().top-document.querySelector('.archive-reader-body').getBoundingClientRect().top`);
 await ev(`{const row=document.querySelectorAll('.archive-turn')[500];const table=document.createElement('table');table.innerHTML='<tr><td style="height:175px">Injected table layout probe</td></tr>';row.append(table);}`);await sleep(180);
 const table=await ev(`window.__mediaAnchor.getBoundingClientRect().top-document.querySelector('.archive-reader-body').getBoundingClientRect().top`);
 await ev(`{const row=document.querySelectorAll('.archive-turn')[500];const img=document.createElement('img');img.id='delayed-probe';row.append(img);setTimeout(()=>{img.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="210"><rect width="300" height="210" fill="orange"/></svg>')},100)}`);await sleep(450);
 probes.push({kind,media:{before,afterTable:table,afterImage:await ev(`window.__mediaAnchor.getBoundingClientRect().top-document.querySelector('.archive-reader-body').getBoundingClientRect().top`),imageLoaded:await ev(`document.querySelector('#delayed-probe').naturalHeight===210`)}});
 const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(out+'/'+kind+'.png',Buffer.from(shot.data,'base64'));
 }
 // Switch the selected shelf item with the previous body's queue still pending.
 await ev(`[...document.querySelectorAll('.archive-session-card')].find(n=>n.textContent.includes('Acceptance acceptance-live')).click()`);
 await until(`document.querySelectorAll('.archive-turn').length===100`);
 const pendingBeforeSwitch=await ev(`document.querySelectorAll('[data-body-ready=false]').length`);
 await ev(`[...document.querySelectorAll('.archive-session-card')].find(n=>n.textContent.includes('Acceptance acceptance-reset')).click()`);
 await until(`document.querySelector('.archive-reader-toolbar')?.innerText.includes('acceptance-reset')&&document.querySelectorAll('.archive-turn').length===100&&document.querySelectorAll('[data-body-ready=false]').length===0`);await sleep(180);
 probes.push({cancellation:{pendingBeforeSwitch,...await ev(`({rows:document.querySelectorAll('.archive-turn').length,ready:document.querySelectorAll('[data-body-ready=false]').length===0,toolbar:document.querySelector('.archive-reader-toolbar').innerText,headings:[...document.querySelectorAll('.archive-turn h3')].map(n=>n.textContent)})`)}});
 await fs.writeFile(out+'/probes.json',JSON.stringify({probes,copies:await ev('window.__copies')},null,2));
 const hashes={};for(const f of await fs.readdir(dist+'/assets')){hashes[f]=createHash('sha256').update(await fs.readFile(dist+'/assets/'+f)).digest('hex')}
 await fs.writeFile(out+'/report.json',JSON.stringify({status:'passed',mode:'full production UI, deterministic mock HTTP API, empty runtime agent rail',dist,hashes,fixtureSha256:createHash('sha256').update(JSON.stringify(data)).digest('hex'),chromium:await call('Browser.getVersion'),viewport:{width:1600,height:1000},timezone:'UTC',cpuThrottling:1,measurement:'First visible heading and ALL rows data-body-ready not false separately, each following rAF paint opportunity proxy. Baseline missing attr treated ready. Long tasks cover entire action to completion. CPU profiles 1ms.',ops,requests,errors},null,2));
 if(errors.length)throw Error('Runtime exceptions recorded');
} catch(e){await fs.writeFile(out+'/failure.json',JSON.stringify({error:String(e.stack),ops,requests,errors},null,2));throw e}finally{ws?.close();if(browser){browser.kill('SIGTERM');await Promise.race([new Promise(r=>browser.once('exit',r)),sleep(3000)]);if(browser.exitCode===null)browser.kill('SIGKILL')}server.closeAllConnections();await new Promise(r=>server.close(r));if(chromeDir)await fs.rm(chromeDir,{recursive:true,force:true});}
