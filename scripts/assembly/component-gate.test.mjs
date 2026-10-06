import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyRuns,waitForComponent} from './component-gate.mjs';
const sha='a'.repeat(40), workflowId=42;
const run={workflow_id:42,head_sha:sha,head_branch:'main',event:'push',status:'completed',conclusion:'success',run_number:1,run_attempt:1};
for(const [name,patch,expected] of [['accepted',{},'accepted'],['failed',{conclusion:'failure'},'rejected'],['pending',{status:'in_progress'},'pending'],['wrong SHA',{head_sha:'b'.repeat(40)},'missing'],['unrelated workflow',{workflow_id:9},'missing'],['PR',{event:'pull_request'},'missing'],['wrong branch',{head_branch:'feature'},'missing']]) test(name,()=>assert.equal(classifyRuns([{...run,...patch}],{sha,workflowId}),expected));
test('waits for running workflow completion',async()=>{
 let calls=0, sleeps=0;
 await waitForComponent({repo:'owner/repo',sha,api:async(_path,pages)=>pages?[{...run,status:++calls===1?'in_progress':'completed'}]:{id:42,name:'Verify and assemble Burrow',path:'.github/workflows/notify-burrow.yml',state:'active'},sleep:async()=>{sleeps++;}});
 assert.equal(sleeps,1);
});
test('fails closed on missing evidence',async()=>assert.rejects(waitForComponent({repo:'owner/repo',sha,api:async(_p,pages)=>pages?[]:{id:42,name:'Verify and assemble Burrow',path:'.github/workflows/notify-burrow.yml',state:'active'}}),/missing/));
test('latest attempt supersedes old green evidence',()=>assert.equal(classifyRuns([run,{...run,run_attempt:2,status:'in_progress'}],{sha,workflowId}),'pending'));
test('configured timeout bounds pending CI without an attempt cap',async()=>{
 let clock=0;
 await assert.rejects(waitForComponent({repo:'owner/repo',sha,timeoutMs:20,now:()=>clock,sleep:async ms=>{clock+=ms;},api:async(_p,pages)=>pages?[{...run,status:'in_progress'}]:{id:42,name:'Verify and assemble Burrow',path:'.github/workflows/notify-burrow.yml',state:'active'}}),/timeout/);
});
test('assembly gates immutable pins before component checkout for both triggers',async()=>{
 const {readFile}=await import('node:fs/promises');
 const yaml=await readFile(new URL('../../.github/workflows/assemble.yml',import.meta.url),'utf8');
 assert(yaml.indexOf('Require trusted component CI')<yaml.indexOf('repository: NightShaman/Burrow-Backend'));
 assert.match(yaml,/backend_ref=\$\(gh api "repos\/NightShaman\/Burrow-Backend\/commits\/\$backend_ref" --jq .sha\)/);
 assert.match(yaml,/ui_ref=\$\(gh api "repos\/NightShaman\/Burrow-UI\/commits\/\$ui_ref" --jq .sha\)/);
 assert.match(yaml,/Refusing non-forward/);
 assert.match(yaml,/workflow_dispatch:/);
});
