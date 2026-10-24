import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validatePublicReadiness } from './validate-public-readiness.mjs';

const names=['Burrow','Node-Goblin','Goblin-Secret-Store','Burrow-Skills','Burrow-Backdoor','Burrow-Tutor','Burrow-Theater','Burrow-Switchboard'];
const png=(width,height)=>{ const b=Buffer.alloc(24); Buffer.from('89504e470d0a1a0a','hex').copy(b); b.writeUInt32BE(width,16); b.writeUInt32BE(height,20); return b; };
test('enforces the shared public hero contract',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'burrow-public-'));
 try {
  for(const name of names){ await fs.mkdir(path.join(root,name,'docs/assets'),{recursive:true}); await fs.writeFile(path.join(root,name,'docs/assets/hero.png'),png(1536,1024)); await fs.writeFile(path.join(root,name,'README.md'),'<img src="docs/assets/hero.png" width="720" alt="Useful art" />'); await fs.writeFile(path.join(root,name,'LICENSE'),'license text\n'); }
  assert.deepEqual(await validatePublicReadiness(root),[]);
  await fs.writeFile(path.join(root,'Burrow-Skills/docs/assets/hero.png'),png(100,100));
  assert.match((await validatePublicReadiness(root)).join('\n'),/1536x1024/);
  await fs.rm(path.join(root,'Node-Goblin/LICENSE'));
  assert.match((await validatePublicReadiness(root)).join('\n'),/Node Goblin: LICENSE unavailable/);
 } finally { await fs.rm(root,{recursive:true,force:true}); }
});
