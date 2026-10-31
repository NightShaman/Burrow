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
// Real Markdown fixture variant: table plus same-origin image served with delayed response.
for(const rows of Object.values(data)) rows[1200].content += '\n\n| Real table | Value |\n| --- | --- |\n| retained | anchor |\n\n![Delayed fixture image](/delayed-fixture.svg)';
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
const server=createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost');if(u.pathname==='/delayed-fixture.svg'){await sleep(2500);res.writeHead(200,{'content-type':'image/svg+xml','cache-control':'no-store'});res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="280"><rect width="400" height="280" fill="orange"/></svg>');return;}if(u.pathname.startsWith('/api/')){const body=api(u);requests.push({method:req.method,url:req.url,status:body?200:404});res.writeHead(body?200:404,{'content-type':'application/json'});res.end(JSON.stringify(body||{error:'Unmocked endpoint'}));return;}const file=path.resolve(dist,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!file.startsWith(dist+path.sep))throw Error('invalid path');const bytes=await fs.readFile(file);res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream'});res.end(bytes)}catch(e){res.writeHead(404);res.end(String(e))}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
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
 const trustedClick=async selector=>{await sleep(50);const p=await ev(`(()=>{const n=${selector};n?.scrollIntoView({block:'nearest'});if(!n)throw Error('missing click target');const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});};
 await ev(`window.__trusted=[];document.addEventListener('click',e=>window.__trusted.push({kind:'click',trusted:e.isTrusted,pending:document.querySelectorAll('[data-body-ready=false]').length}),true);document.addEventListener('wheel',e=>window.__trusted.push({kind:'wheel',trusted:e.isTrusted,pending:document.querySelectorAll('[data-body-ready=false]').length}),true)`);
 const card=`[...document.querySelectorAll('.archive-session-card')].find(n=>n.textContent.includes('Acceptance acceptance-live'))`;
 await trustedClick(card);await until(`document.querySelectorAll('.archive-turn').length===100`);
 const pendingAtInput=await ev(`document.querySelectorAll('[data-body-ready=false]').length`);
 const wheelPoint=await ev(`(()=>{const r=document.querySelector('.archive-reader-body').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 await call('Input.dispatchMouseEvent',{type:'mouseWheel',...wheelPoint,deltaX:0,deltaY:-550});
 await trustedClick(`document.querySelector('.archive-copy-button')`);
 await until(`document.querySelectorAll('[data-body-ready=false]').length===0`);
 probes.push({input:{pendingAtInput,events:await ev('window.__trusted'),copies:await ev('window.__copies.map(x=>({pending:x.pending,time:x.time,length:x.text.length}))')}});
 // Actual table is Markdown output. Hold an anchor below the delayed image while its HTTP response completes.
 await ev(`{const r=document.querySelector('.archive-reader-body');const rows=[...r.querySelectorAll('.archive-turn')];rows[50].scrollIntoView();void 0}`);await sleep(100);
 await ev(`{const r=document.querySelector('.archive-reader-body');const rows=[...r.querySelectorAll('.archive-turn')];window.__realAnchor=rows[51];r.scrollTop+=rows[51].getBoundingClientRect().top-r.getBoundingClientRect().top;void 0}`);await sleep(150);
 const mediaBefore=await ev(`({offset:window.__realAnchor.getBoundingClientRect().top-document.querySelector('.archive-reader-body').getBoundingClientRect().top,table:!!document.querySelector('.markdown-table-scroll table'),loaded:document.querySelector('img[alt="Delayed fixture image"]')?.complete})`);
 await until(`document.querySelector('img[alt="Delayed fixture image"]')?.naturalHeight===280`);await sleep(200);
 probes.push({realMarkdownMedia:{before:mediaBefore,after:await ev(`({offset:window.__realAnchor.getBoundingClientRect().top-document.querySelector('.archive-reader-body').getBoundingClientRect().top,naturalHeight:document.querySelector('img[alt="Delayed fixture image"]').naturalHeight})`)}});
 await fs.writeFile(out+'/media-probes.json',JSON.stringify(probes,null,2));for(let i=2;i<=13;i++){console.log('prepend',i);await ev(`document.querySelector('.archive-reader-body').scrollTop=0`);await sleep(250);await ev(`document.querySelector('.archive-reader-body').scrollTop=0`);await sleep(100);await trustedClick(`[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='Load earlier messages')`);await until(`document.querySelectorAll('.archive-turn').length===${Math.min(i*100,1250)}&&document.querySelectorAll('[data-body-ready=false]').length===0`);}
 // Full viewport sweep, read-only browser positioning; record visible headings after two paints per row.
 await ev(`window.__sweep={start:performance.now(),visited:[],missing:[]};void 0`);
 for(let start=0;start<1250;start+=25){await ev(`(async()=>{const root=document.querySelector('.archive-reader-body'),rows=[...root.querySelectorAll('.archive-turn')];for(let i=${start};i<${Math.min(start+25,1250)};i++){rows[i].scrollIntoView({block:'start'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));rows[i].scrollIntoView({block:'start'});await new Promise(r=>requestAnimationFrame(r));const h=rows[i].querySelector('h3'),rect=h?.getBoundingClientRect(),box=root.getBoundingClientRect();if(h&&rect.bottom>box.top&&rect.top<box.bottom)window.__sweep.visited.push(h.textContent);else window.__sweep.missing.push({i,text:h?.textContent,top:rect?.top});}return true})()`);}
 probes.push({scrollSweep:await ev(`({...window.__sweep,end:performance.now(),total:document.querySelectorAll('.archive-turn').length,pending:document.querySelectorAll('[data-body-ready=false]').length,longs:window.__long.filter(x=>x.start>=window.__sweep.start)})`)});
 // Reopen fresh reset, cancel body queue by switching shelf while pending, then return Chat.
 await trustedClick(`[...document.querySelectorAll('.archive-session-card')].find(n=>n.textContent.includes('Acceptance acceptance-reset'))`);await until(`document.querySelectorAll('.archive-turn').length===100`);
 const pendingBeforeDreams=await ev(`document.querySelectorAll('[data-body-ready=false]').length`);
 await trustedClick(`[...document.querySelectorAll('.archive-sidebar button, .archive-kind-list button')].find(n=>n.textContent.startsWith('Dreams'))`);await sleep(900);
 const dreams=await ev(`({rows:document.querySelectorAll('.archive-turn').length,pending:document.querySelectorAll('[data-body-ready=false]').length,text:document.querySelector('.archive-page')?.innerText||document.body.innerText})`);
 await trustedClick(`[...document.querySelectorAll('.archive-sidebar button, .archive-kind-list button')].find(n=>n.textContent.startsWith('Chat'))`);await until(`document.querySelectorAll('.archive-session-card').length===2`);await sleep(900);
 const returned=await ev(`({rows:document.querySelectorAll('.archive-turn').length,pending:document.querySelectorAll('[data-body-ready=false]').length,toolbar:document.querySelector('.archive-reader-toolbar')?.innerText||null})`);
 probes.push({shelfCancellation:{pendingBeforeDreams,dreams,returned}});
 await fs.writeFile(out+'/probes.json',JSON.stringify({probes,longTasks:await ev('window.__long')},null,2));
 const assertions={allHeadings:probes[2].scrollSweep.visited.length===1250&&probes[2].scrollSweep.missing.length===0,trustedPendingWheel:probes[0].input.events.some(x=>x.kind==='wheel'&&x.trusted&&x.pending>0),trustedPendingClick:probes[0].input.events.some(x=>x.kind==='click'&&x.trusted&&x.pending>0),realMediaAnchor:!mediaBefore.loaded&&Math.abs(probes[1].realMarkdownMedia.after.offset-mediaBefore.offset)<=2,shelfCancellation:pendingBeforeDreams>0&&dreams.rows===0&&returned.rows===0};
 await fs.writeFile(out+'/assertions.json',JSON.stringify(assertions,null,2));
 const hashes={};for(const f of await fs.readdir(dist+'/assets')){hashes[f]=createHash('sha256').update(await fs.readFile(dist+'/assets/'+f)).digest('hex')}
 await fs.writeFile(out+'/report.json',JSON.stringify({status:Object.values(assertions).every(Boolean)?'passed':'failed',assertions,mode:'full production UI, deterministic mock HTTP API, empty runtime agent rail',dist,hashes,fixtureSha256:createHash('sha256').update(JSON.stringify(data)).digest('hex'),chromium:await call('Browser.getVersion'),viewport:{width:1600,height:1000},timezone:'UTC',cpuThrottling:1,measurement:'First visible heading and ALL rows data-body-ready not false separately, each following rAF paint opportunity proxy. Baseline missing attr treated ready. Long tasks cover entire action to completion. CPU profiles 1ms.',ops,requests,errors},null,2));
 if(errors.length)throw Error('Runtime exceptions recorded');
} catch(e){await fs.writeFile(out+'/failure.json',JSON.stringify({error:String(e.stack),ops,requests,errors},null,2));throw e}finally{ws?.close();if(browser){browser.kill('SIGTERM');await Promise.race([new Promise(r=>browser.once('exit',r)),sleep(3000)]);if(browser.exitCode===null)browser.kill('SIGKILL')}server.closeAllConnections();await new Promise(r=>server.close(r));if(chromeDir)await fs.rm(chromeDir,{recursive:true,force:true});}
