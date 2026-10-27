import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {certifyFinal,emitReceipt,scopeFor,scopeRequired,checkCatalog,resolveEvent} from './ci-gate-runtime.mjs';
import {finalRef,REPOSITORY} from './pr-gate-protocol.mjs';
function fixture(kind,path,run) {
 const root=mkdtempSync(join(tmpdir(),'actual-gate-')),cwd=process.cwd();
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try {
  git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Isolated fixture');
  writeFileSync(join(root,'initial'),'base');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),'change');git('add','.');git('commit','-qm','candidate');const head=git('rev-parse','HEAD');
  const plan={kind,pr:901,head,base,baseRef:'release/digital-production-v1',phase:'final',repository:REPOSITORY};
  const event=join(root,'event.json'),output=join(root,'output');writeFileSync(event,JSON.stringify({repository:{full_name:REPOSITORY},ref_type:'branch',ref:finalRef(plan)}));
  const scope=scopeFor(plan,[path]),catalog=checkCatalog(kind);
  const steps=Object.fromEntries(catalog.map(([id,,tag])=>[id,{outcome:scopeRequired(tag,scope)?'success':'skipped'}]));
  const env={GITHUB_EVENT_NAME:'create',GITHUB_REPOSITORY:REPOSITORY,GITHUB_EVENT_PATH:event,GITHUB_SHA:head,GITHUB_RUN_ID:'801',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:output,GATE_SCOPE_JSON:JSON.stringify(scope),GATE_CHECKS_JSON:JSON.stringify(catalog),GATE_STEPS_JSON:JSON.stringify(steps),GATE_JOB_STATUS:'success'};
  process.chdir(root);return run({plan,scope,steps,catalog,env,event,output});
 }finally{process.chdir(cwd);rmSync(root,{recursive:true,force:true});}
}
const quiet=fn=>{const print=console.log;console.log=()=>{};try{return fn();}finally{console.log=print;}};
for(const [kind,path]of [['full','.github/workflows/example.yml'],['quick','docs/governance/example.md']])test(`actual ${kind} checkout, diff, worker output and GitHub result certify successfully`,()=>fixture(kind,path,({plan,env,output})=>{
 assert.equal(resolveEvent(env).head,plan.head);assert.match(readFileSync(output,'utf8'),/phase=final/);
 const receipt=quiet(()=>emitReceipt(env));assert.equal(receipt.head,plan.head);
 const certified=quiet(()=>certifyFinal({...env,WORKER_RESULT:'success',WORKER_RECEIPT:JSON.stringify(receipt)}));
 assert.deepEqual(certified,receipt);
 for(const result of ['skipped','failure','cancelled',''])assert.throws(()=>certifyFinal({...env,WORKER_RESULT:result,WORKER_RECEIPT:JSON.stringify(receipt)}),/worker did not succeed/);
 assert.throws(()=>certifyFinal({...env,WORKER_RESULT:'success',WORKER_RECEIPT:''}),/no actual receipt/);
}));
test('old Head/base/run/attempt and spoofed scope cannot certify a green selected worker',()=>fixture('full','.github/workflows/example.yml',({env})=>{
 const receipt=quiet(()=>emitReceipt(env)),cert=r=>quiet(()=>certifyFinal({...env,WORKER_RESULT:'success',WORKER_RECEIPT:JSON.stringify(r)}));
 for(const [key,value]of [['head','a'.repeat(40)],['base','b'.repeat(40)],['runId',800],['attempt',2],['pr',902]])assert.throws(()=>cert({...receipt,[key]:value}));
 assert.throws(()=>cert({...receipt,scope:{...receipt.scope,db:'false'}}),/scope db differs/);
 const missing=receipt.checks.filter(c=>c.id!=='db_migrate');assert.throws(()=>cert({...receipt,checks:missing}),/Required actual check absent/);
 assert.throws(()=>cert({...receipt,checks:receipt.checks.map(c=>c.id==='tests'?{...c,outcome:'skipped'}:c)}),/absent or skipped/);
}));
test('high-risk paths remain ineligible for Quick even if its worker reports success',()=>fixture('quick','apps/api/src/new-domain.ts',({env})=>{
 const receipt=quiet(()=>emitReceipt(env));assert.throws(()=>certifyFinal({...env,WORKER_RESULT:'success',WORKER_RECEIPT:JSON.stringify(receipt)}),/Sensitive diff/);
}));
test('missing, failed and cancelled actual checks fail receipt generation, not just presentation',()=>fixture('full','.github/workflows/example.yml',({env,steps})=>{
 for(const outcome of ['skipped','failure','cancelled','not_run'])assert.throws(()=>emitReceipt({...env,GATE_STEPS_JSON:JSON.stringify({...steps,tests:{outcome}})}),/Gate incomplete/);
 assert.throws(()=>emitReceipt({...env,GATE_JOB_STATUS:'failure'}),/Gate incomplete/);
 assert.throws(()=>resolveEvent({...env,EXPECTED_GATE_HEAD:'a'.repeat(40)}),/head differs/);
 assert.throws(()=>resolveEvent({...env,GITHUB_SHA:'a'.repeat(40)}),/actual commit/);
}));
test('ordinary PR light evidence cannot become a final check through supplied outputs',()=>fixture('full','docs/governance/example.md',({env,event,plan})=>{
 writeFileSync(event,JSON.stringify({action:'opened',repository:{full_name:REPOSITORY},pull_request:{number:plan.pr,title:'[FULL] example',head:{sha:plan.head},base:{sha:plan.base,ref:plan.baseRef,repo:{full_name:REPOSITORY}}}}));
 assert.throws(()=>certifyFinal({...env,GITHUB_EVENT_NAME:'pull_request',WORKER_RESULT:'success',WORKER_RECEIPT:'{}'}),/FINAL_GATE_NOT_REQUESTED/);
}));
