import { persistedSettingsFixture, persistedSessionResetFixture } from '../../../Burrow-Backend/tests/helpers/persisted-ui-settings.mjs';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
const f = await persistedSettingsFixture();
const session = await persistedSessionResetFixture({nextSend:true});
const dir = join(process.env.BURROW_RUNTIME_ROOT,'react-bridge');
await fs.mkdir(dir); await fs.mkdir(join(dir,'home')); await fs.mkdir(join(dir,'tmp'));
let running=true, held;
const handled=new Set();
async function respond(name,data) { await fs.writeFile(join(dir,name+'.response.tmp'),JSON.stringify(data)); await fs.rename(join(dir,name+'.response.tmp'),join(dir,name+'.response')); }
async function request(data) {
 if(data.kind==='connections') return f.settingsRequest(data.method,data.body);
 if(data.kind==='session' && data.path==='/api/sessions?agentId=a') return {status:200,body:{sessions:(await session.conversations.listSessions({agentId:'a'})).map(s=>({...s,id:s.sessionId}))}};
 if(data.kind==='session') return session.sessionRequest(data.method,data.path,data.body);
 if(data.kind==='chat') return session.chatRequest(data.body);
 if(data.control==='seedSessions') { for(const sessionId of ['named','default']) await session.conversations.append({agentId:'a',sessionId,entry:{type:'message',role:'user',content:'before-'+sessionId}}); return {}; }
 if(data.control==='sessionEvidence') return {prompts:session.prompts,named:await session.conversations.read({agentId:'a',sessionId:'named'}),default:await session.conversations.read({agentId:'a',sessionId:'default'})};
 if(data.control==='failure') { data.enabled?f.failures.add('b'):f.failures.delete('b'); return {}; }
 if(data.control==='writes') return {writes:f.writes};
 if(data.control==='hold') { held={}; held.gate=new Promise(r=>held.release=r); return {}; }
 if(data.control==='release') { held?.release(); return {}; }
 if(data.control==='held') return {entered:!!held?.entered};
 if(data.method==='PUT' && data.kind==='model-selection' && held && !held.entered) { held.entered=true; await held.gate; }
 return f.request(data.method,data.id,data.kind,data.body);
}
const pump=(async()=>{ while(running) { for(const name of await fs.readdir(dir)) if(name.endsWith('.request')&&!handled.has(name)) { handled.add(name); const data=JSON.parse(await fs.readFile(join(dir,name),'utf8')); void request(data).then(value=>respond(name,{value}),error=>respond(name,{error:error.message})); } await new Promise(r=>setTimeout(r,5)); } })();
try {
 const env={ PATH:process.env.PATH, HOME:join(dir,'home'),TMPDIR:join(dir,'tmp'),LANG:'C.UTF-8',NODE_ENV:'test',UI_PERSISTED_BRIDGE:dir,NODE_OPTIONS:`--require=${resolve('scripts/deny-network.cjs')}` };
 const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','scripts/persisted-ui/vitest.config.ts'],{cwd:process.cwd(),env,stdio:'inherit'});
 process.exitCode=await new Promise((r,j)=>{child.on('exit',code=>r(code??1));child.on('error',j);});
} finally { running=false;held?.release();await pump;await session.close();await f.close(); }
