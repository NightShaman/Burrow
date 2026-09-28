#!/usr/bin/env node
// Disposable Docker-only full entrypoint acceptance. Usage: node scripts/postgres-http-rehearsal.mjs IMAGE [--external]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const image=process.argv[2]; if(!image) throw Error('explicit_disposable_image_required');
const external=process.argv[3]==='--external';
if(process.argv[3] && !external) throw Error('unknown_rehearsal_mode');
const name=`burrow-pg-http-${process.pid}`, volume=`${name}-data`, network=`${name}-net`, server=`${name}-pg`;
const dbConfig=external ? "postgresConfig()" : "{host:'/data/postgres-socket',user:'burrow',database:'postgres'}";
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:8*1024*1024});
const inside=code=>docker('exec',name,'node','--input-type=module','-e',code);
const seed=`
import {promises as fs} from 'node:fs';
import {scryptSync} from 'node:crypto';
import {openSettingsDatabase,setSettingsMeta} from './src/settings-database.mjs';
import {encrypt} from './src/model-settings-store.mjs';
if((await fs.readdir('/data')).length) throw Error('nonempty_rehearsal_volume');
await fs.mkdir('/data/config'); const key=Buffer.alloc(32,7); await fs.writeFile('/data/config/settings.key',key.toString('base64'),{mode:0o600});
const db=openSettingsDatabase({databasePath:'/data/config/settings.sqlite'}), at='2026-01-01T00:00:00Z';
db.prepare('INSERT INTO agents(id,name,enabled,available_capabilities,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('sample','HTTP Sample',1,'[]',at,at);
db.prepare('INSERT INTO model_connections(id,provider,api_type,base_url,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('fixture','openai','chat-completions','https://example.invalid/v1',at,at);
const sealed=encrypt(key,'fixture-secret','fixture','apiKey','disposable-provider-fixture');
db.prepare('INSERT INTO model_connection_secrets(id,connection_id,name,ciphertext,nonce,auth_tag,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('fixture-secret','fixture','apiKey',sealed.ciphertext,sealed.nonce,sealed.authTag,at,at);
const salt=Buffer.alloc(16,8); setSettingsMeta(db,'ui_auth',{mode:'basic',basic:{username:'rehearsal',passwordHash:'scrypt:16384:'+salt.toString('base64url')+':'+scryptSync('disposable-password',salt,32,{N:16384}).toString('base64url')}}); db.close();
await fs.mkdir('/data/workspace/sample/sessions/default',{recursive:true});
await fs.writeFile('/data/workspace/sample/sessions/default/session.meta.json',JSON.stringify({createdAt:at}));
await fs.writeFile('/data/workspace/sample/sessions/default/session.jsonl',JSON.stringify({id:'seed',type:'message',visibility:'chat',entersPrompt:true,ts:at,role:'user',content:'HTTP legacy conversation fixture'})+'\\n');
`;
// Diagnostic server events are non-authoritative; all other JSONL, SQLite and session metadata are protected.
const snapshot=`import {promises as fs} from 'node:fs';import {createHash} from 'node:crypto';const out={};async function walk(p){for(const e of await fs.readdir(p,{withFileTypes:true})){const f=p+'/'+e.name;if(e.isDirectory()){if(!['postgres','integrations'].includes(e.name))await walk(f);}else if(f !== '/data/logs/server-events.jsonl' && (/\\.(sqlite(?:-wal|-shm)?|jsonl)$/.test(f)||f.endsWith('/settings.key')||f.endsWith('/session.meta.json'))){const s=await fs.stat(f);out[f]={hash:createHash('sha256').update(await fs.readFile(f)).digest('hex'),mtime:s.mtimeMs};}}}await walk('/data');console.log(JSON.stringify(out));`;
const auth='Basic '+Buffer.from('rehearsal:disposable-password').toString('base64');
let base;
async function request(path,{authenticated=true,method='GET',body}={}){const r=await fetch(base+path,{method,signal:AbortSignal.timeout(5000),headers:{...(authenticated?{authorization:auth}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const text=await r.text();return {status:r.status,text};}
async function ready(){for(let i=0;i<240;i++){try{if((await request('/api/health')).status===200)return;}catch{}await new Promise(r=>setTimeout(r,1000));}throw Error('HTTP_health_timeout');}
async function verify({ mutated=false }={}){
// Docker liveness must work with Basic authentication enabled; application health is checked authenticated.
for(let i=0;i<30 && docker('inspect','--format','{{.State.Health.Status}}',name).trim()!=='healthy';i++) await new Promise(r=>setTimeout(r,1000));
assert.equal(docker('inspect','--format','{{.State.Health.Status}}',name).trim(),'healthy');
assert.equal((await request('/api/sessions?agentId=sample',{authenticated:false})).status,401);for(const [p,marker] of [['/api/sessions','default'],['/api/sessions?agentId=sample','default'],['/api/sessions/default?agentId=sample',mutated?'default':'HTTP legacy conversation fixture'],['/api/settings/model-connections','fixture']]){const r=await request(p);assert.equal(r.status,200,r.text);assert.ok(r.text.includes(marker),r.text);}inside(`import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createPostgresPool,postgresConfig} from './src/postgres-foundation.mjs';import {PostgresModelSettingsStore} from './src/postgres-model-settings-store.mjs';const pool=createPostgresPool({config:${dbConfig}});const store=new PostgresModelSettingsStore({pool,key:Buffer.from(readFileSync('/data/config/settings.key','utf8').trim(),'base64')});assert.equal((await store.resolveAuth('fixture')).token,'disposable-provider-fixture');assert.equal((await pool.query('SELECT count(*) FROM burrow_migration_receipts')).rows[0].count,'1');await pool.end();`);}
async function inspections({mutated=false}={}) {
  for (const path of ['/api/session/context','/api/context','/api/session/context-status','/api/sessions/default/export']) {
    const url=path+(path.includes('/sessions/')?'?agentId=sample':'?agentId=sample&sessionId=default');
    assert.equal((await request(url,{authenticated:false})).status,401);
    const r=await request(url); assert.equal(r.status,200,r.text); assert.equal(JSON.parse(r.text).ok,true,r.text);
    if(path.endsWith('/export')) { const entries=JSON.parse(r.text).entries; assert.equal(entries.length,mutated?0:1,r.text); }
    if(path==='/api/session/context'||path==='/api/context') assert.equal(r.text.includes('HTTP legacy conversation fixture'),!mutated,r.text);
  }
  for(const message of ['/context','/status']) {
    const r=await request('/api/chat',{method:'POST',body:{agentId:'sample',sessionId:'default',message}});
    assert.equal(r.status,200,r.text); assert.equal(JSON.parse(r.text).ok,true,r.text);
  }
}
async function mutate() {
  assert.equal((await request('/api/chat',{authenticated:false,method:'POST',body:{agentId:'sample',message:'/new'}})).status,401);
  const fresh=await request('/api/chat',{method:'POST',body:{agentId:'sample',sessionId:'default',message:'/new'}});
  assert.equal(fresh.status,200,fresh.text);assert.equal(JSON.parse(fresh.text).ok,true,fresh.text);
  const reset=await request('/api/sessions/default/reset?agentId=sample',{method:'POST',body:{}});
  assert.equal(reset.status,200,reset.text);assert.equal(JSON.parse(reset.text).ok,true,reset.text);
}
function verifyMutation() {
  inside(`import assert from 'node:assert/strict';import {createPostgresPool,postgresConfig} from './src/postgres-foundation.mjs';const pool=createPostgresPool({config:${dbConfig}});assert.equal((await pool.query("SELECT count(*) FROM conversation_entries WHERE agent_id='sample' AND session_id='default'")).rows[0].count,'0');const archives=(await pool.query("SELECT entries FROM conversation_archives WHERE agent_id='sample' AND session_id='default' AND kind='reset'")).rows;assert.equal(archives.length,1);assert.equal(archives[0].entries[0].content,'HTTP legacy conversation fixture');assert.equal(Number((await pool.query("SELECT metadata->>'generation' AS generation FROM conversation_sessions WHERE agent_id='sample' AND session_id='default'")).rows[0].generation),2);await pool.end();`);
}

try{
assert.ok(docker('image','inspect','--format','{{json .Config.Env}}',image).includes('BURROW_POSTGRES_LIFECYCLE=managed'),'image must default to managed');
if(external){
  docker('network','create',network);
  docker('run','-d','--name',server,'--network',network,'-e','POSTGRES_HOST_AUTH_METHOD=trust','pgvector/pgvector:pg17');
  let available=false;
  for(let i=0;i<60;i++){try{docker('exec',server,'pg_isready','-U','postgres');available=true;break;}catch{}await new Promise(r=>setTimeout(r,1000));}
  assert.ok(available,'disposable external PostgreSQL readiness');
  docker('exec',server,'psql','-U','postgres','-c','CREATE EXTENSION vector');
}
docker('volume','create',volume);docker('run','--rm','--entrypoint','node','-v',`${volume}:/data`,image,'--input-type=module','-e',seed);
// Seed container is stopped; snapshot source files before the real entrypoint runs.
docker('run','-d','--name',name,'--entrypoint','sleep','-v',`${volume}:/data`,image,'infinity');const before=inside(snapshot);docker('rm','-f',name);
docker('run','-d','--name',name,'-p','127.0.0.1::42817',...(external?['--network',network,'-e','BURROW_POSTGRES_LIFECYCLE=external','-e',`BURROW_POSTGRES_HOST=${server}`,'-e','BURROW_POSTGRES_USER=postgres','-e','BURROW_POSTGRES_DATABASE=postgres']:[]),'-v',`${volume}:/data`,image);base='http://'+docker('port',name,'42817/tcp').trim();await ready();await verify();await inspections();await mutate();await inspections({mutated:true});verifyMutation();assert.equal(inside(snapshot),before,'legacy source writes during full startup/HTTP/mutation');
docker('restart','-t','30',name);base='http://'+docker('port',name,'42817/tcp').trim();await ready();await verify({mutated:true});await inspections({mutated:true});verifyMutation();assert.equal(inside(snapshot),before,'legacy source writes after restart');console.log('PASS '+(external?'external':'image-default managed')+' full Docker entrypoint: HTTP health, auth rejection + imported settings/conversations, authenticated context/status/export + /new/reset, PG archive/generation, encrypted provider auth, restart after mutation/receipt, unchanged SQLite/JSONL/key hashes and mtimes');
}catch(e){try{console.error(docker('logs','--tail','100',name));}catch{}throw e;}finally{try{docker('rm','-f','-v',name);}catch{}try{docker('volume','rm',volume);}catch{}if(external){try{docker('rm','-f','-v',server);}catch{}try{docker('network','rm',network);}catch{}}}
