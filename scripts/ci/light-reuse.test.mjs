import assert from'node:assert/strict';import{test}from'node:test';import{execFileSync}from'node:child_process';import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{createBundle,validateBundle,restoreBundle,reuseContext}from'./light-reuse.mjs';
import{REPOSITORY,LIGHT_CHECK,assertReceipt,assertReuseLineage}from'./pr-gate-protocol.mjs';
function fixture(work){const cwd=mkdtempSync(join(tmpdir(),'dx-reuse-')),git=(...a)=>execFileSync('git',['-C',cwd,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();try{
 git('init','-q');git('config','user.name','TEST');git('config','user.email','test@example.invalid');writeFileSync(join(cwd,'.gitignore'),'dist/\n');writeFileSync(join(cwd,'package-lock.json'),'{}');writeFileSync(join(cwd,'source.mjs'),'export const source=1;');git('add','.');git('commit','-qm','source');
 const head=git('rev-parse','HEAD'),plan={repository:REPOSITORY,pr:42,head,base:head,baseRef:'main',kind:'full',phase:'final'},environment={NODE_ENV:'test',SERVICE_NAME:'dx-rework-api',BUILD_TIME:'2026-11-01T00:00:00Z'};
 const receipt={version:1,repository:REPOSITORY,pr:42,head,base:head,kind:'full',phase:'light',runId:101,attempt:1,jobStatus:'success',missing:[],checks:['title','checkout','head','policy','lint','types','build','migration_lint'].map(id=>({id,applicable:true,outcome:'success'}))};
 const server={run:{id:101,run_attempt:1,head_sha:head,path:'.github/workflows/ci.yml',event:'pull_request',status:'completed',conclusion:'success'},job:{id:201,run_id:101,name:LIGHT_CHECK,status:'completed',conclusion:'success'},receipt};
 mkdirSync(join(cwd,'apps/api/dist'),{recursive:true});writeFileSync(join(cwd,'apps/api/dist/index.js'),'export const compiled=1;');const bundle=createBundle({cwd,plan,receipt,environment}),context=reuseContext(cwd,environment);
 work({cwd,git,plan,server,bundle,context});
 }finally{rmSync(cwd,{recursive:true,force:true});}}
test('same-Head successful light proof restores exact build bytes with source lineage',()=>fixture(({cwd,plan,server,bundle,context})=>{
 rmSync(join(cwd,'apps/api/dist'),{recursive:true,force:true});const proof=restoreBundle(bundle,{cwd,plan,server,context});assert.equal(proof.source.runId,101);assert.equal(readFileSync(join(cwd,'apps/api/dist/index.js'),'utf8'),'export const compiled=1;');assert.equal(proof.fingerprint.length,64);
}));
test('head/base/toolchain/lock/environment changes, failed/skipped sources and altered receipts never reuse',()=>fixture(({cwd,plan,server,bundle,context})=>{
 const cases=[b=>b.plan.head='a'.repeat(40),b=>b.plan.base='b'.repeat(40),b=>b.context.node='0.0.0',b=>b.context.lock='wrong',b=>b.context.inputsHash='wrong',b=>b.context.image=['another-image'],(b,s)=>s.run.conclusion='failure',(b,s)=>s.job.conclusion='skipped',(b,s)=>s.run.run_attempt=2,(b,s)=>s.job.run_id=9,b=>b.receipt.checks.find(c=>c.id==='build').outcome='failure'];
 for(const mutate of cases){const b=structuredClone(bundle),s=structuredClone(server);mutate(b,s);assert.throws(()=>validateBundle(b,{cwd,plan,server:s,context}));}
}));
test('corrupt bytes, duplicate or escaping paths, executable modes and symlink targets reject before restore',()=>fixture(({cwd,plan,server,bundle,context})=>{
 for(const mutate of [b=>b.files[0].content=Buffer.from('corrupted').toString('base64'),b=>b.files[0].path='apps/api/dist/../../source.mjs',b=>b.files[0].path='/tmp/escape',b=>b.files.push({...b.files[0]}),b=>b.files[0].mode=0o4777]){const b=structuredClone(bundle);mutate(b);assert.throws(()=>restoreBundle(b,{cwd,plan,server,context}));}
 rmSync(join(cwd,'apps/api/dist/index.js'));symlinkSync(join(cwd,'source.mjs'),join(cwd,'apps/api/dist/index.js'));assert.throws(()=>restoreBundle(bundle,{cwd,plan,server,context}),/SYMLINK/);assert.equal(readFileSync(join(cwd,'source.mjs'),'utf8'),'export const source=1;');
}));
test('final receipt cites the verified current light job, never another run or a skipped source',()=>fixture(({plan,server})=>{
 const source={repository:REPOSITORY,pr:42,head:plan.head,base:plan.base,baseRef:plan.baseRef,phase:'light',kind:'full',runId:101,attempt:1,jobId:201,workflow:'.github/workflows/ci.yml',check:'build',fingerprint:'a'.repeat(64),artifactSha256:'b'.repeat(64)};
 const receipt={...server.receipt,phase:'final',runId:102,checks:['title','checkout','head','policy','risk','install','audit','lint','types','build','tests','migration_lint','secrets'].map(id=>({id,applicable:true,outcome:'success',...(id==='build'?{execution:'verified_reuse',source}:{})}))};
 assertReceipt(receipt,plan);assertReuseLineage(receipt,{runId:101,jobId:201,receipt:server.receipt});const wrong=structuredClone(receipt);wrong.checks.find(c=>c.id==='build').source.runId=99;assert.throws(()=>assertReuseLineage(wrong,{runId:101,jobId:201,receipt:server.receipt}));
}));
