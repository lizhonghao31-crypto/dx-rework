import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,copyFileSync,symlinkSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {finalRef} from './pr-gate-protocol.mjs';
import {aggregate,laneNeedsFromFiles,owner,digest,validateBuildFiles,validateBundle,validateNonDatabase,identity,laneBuildMode,validateLaneBuild} from './full-gate-lanes.mjs';
import {checkCatalog,scopeRequired} from './ci-gate-runtime.mjs';
const id={repository:'lizhonghao31-crypto/dx-rework',pr:1,head:'a'.repeat(40),base:'b'.repeat(40),baseRef:'release/digital-production-v1',kind:'full',runId:'1',attempt:'1'};
const inputs={scope:{event:'create',final:'true',base:id.baseRef,db:'true',mapped:'test',journey:'true',migration:'true',business_chain:'true',deployment:'true',maintenance:'true',activation:'true',transfer:'true'},postgres:{status:'required',plan:[]}};
const hash='c'.repeat(64),catalog=checkCatalog('full');
const context={head:id.head,node:'22.22.2',npm:'10.9.9',image:['ubuntu24','20261025.353.1']};
const build={version:1,identity:id,buildHash:hash,sourceContext:context,context,mode:'restored',filesHash:hash};
function fixture(){return Object.fromEntries(['prepare','non-db','postgres'].map(lane=>[lane,{result:'success',outputs:{bundle_hash:hash,record:JSON.stringify({version:1,lane,identity:id,inputs,status:'success',buildHash:hash,build,evidenceHash:hash,cleanup:'passed',steps:Object.fromEntries(catalog.filter(([key])=>owner(key)===lane).map(([key])=>[key,{outcome:'success'}]))})}}]));}
function edit(needs,lane,fn){const r=JSON.parse(needs[lane].outputs.record);fn(r);needs[lane].outputs.record=JSON.stringify(r);}
test('three complete matching lanes preserve every existing check including distinct PG versions and restore profiles',()=>{
 const steps=aggregate(fixture(),id,inputs);assert.deepEqual(Object.keys(steps).sort(),catalog.map(([k])=>k).sort());
 for(const key of ['journey','acceptance_recovery','release_history','backup','root_audit','business_chain'])assert.equal(steps[key].outcome,'success');
});
for(const lane of ['prepare','non-db','postgres'])for(const status of ['failure','cancelled','skipped',undefined])test(`aggregation rejects ${lane} ${status}`,()=>{const n=fixture();n[lane].result=status;assert.throws(()=>aggregate(n,id,inputs),/NOT_SUCCESS/);});
for(const field of ['head','base','baseRef','runId','attempt'])test('aggregation rejects mixed '+field,()=>{const n=fixture();edit(n,'postgres',r=>r.identity[field]='foreign');assert.throws(()=>aggregate(n,id,inputs),/MISMATCH/);});
for(const lane of ['non-db','postgres'])test('missing or wrong build/plan evidence rejects '+lane,()=>{
 for(const change of [r=>delete r.evidenceHash,r=>r.buildHash='d'.repeat(64),r=>r.inputs.postgres.plan.push({path:'foreign'})]){const n=fixture();edit(n,lane,change);assert.throws(()=>aggregate(n,id,inputs));}
 const n=fixture();delete n[lane].outputs.record;assert.throws(()=>aggregate(n,id,inputs));
});
test('missing, foreign, skipped required check and cleanup failure reject',()=>{
 for(const mutate of [r=>delete r.steps.db_tests,r=>r.steps.foreign={outcome:'success'},r=>r.steps.journey.outcome='skipped',r=>r.cleanup='failed']){const n=fixture();edit(n,'postgres',mutate);assert.throws(()=>aggregate(n,id,inputs));}
});
test('explicit no-DB classification retains non-DB requirement without inventing a PG pass',()=>{
 const no=structuredClone(inputs);for(const k of ['db','journey','migration','business_chain','deployment','maintenance','activation','transfer'])no.scope[k]='false';no.scope.mapped='';no.postgres={status:'not-applicable',plan:[]};
 const n=fixture();for(const lane of Object.keys(n))edit(n,lane,r=>{r.inputs=no;for(const [k,,kind]of catalog)if(owner(k)===lane&&!scopeRequired(kind,no.scope))r.steps[k].outcome='skipped';if(lane==='postgres'){delete r.cleanup;delete r.evidenceHash;}});
 assert.equal(aggregate(n,id,no).db_tests.outcome,'skipped');edit(n,'non-db',r=>r.steps.tests.outcome='skipped');assert.throws(()=>aggregate(n,id,no));
});
const f={path:'apps/api/dist/example.js',content:Buffer.from('export {};').toString('base64'),mode:0o644,sha256:digest('export {};')};
test('build content, duplicate, traversal, tracked overwrite and permissions reject before any write',()=>{
 validateBuildFiles([f],new Set());
 for(const files of [[f,f],[{...f,path:'apps/api/dist/../../package.json'}],[{...f,mode:0o777}],[{...f,content:'AAAA'}],[{...f,path:'apps/api/dist/x\nname'}]])assert.throws(()=>validateBuildFiles(files,new Set()));
 assert.throws(()=>validateBuildFiles([f],new Set([f.path])));
});
test('shared bundle binds full bytes, source context, request, plans and compatibility',()=>{
 const b={version:1,identity:id,inputs,context:{node:'22'},builtAt:'2026-11-05T00:00:00Z',files:[f],compatibility:{passed:true}};
 const raw=JSON.stringify(b),args={id,inputs,context:b.context,hash:digest(raw),raw};validateBundle(b,args);
 for(const bad of [{...args,hash:'0'.repeat(64)},{...args,context:{node:'24'}},{...args,id:{...id,attempt:'2'}},{...args,inputs:{}}])assert.throws(()=>validateBundle(b,bad));
});
test('non-DB file evidence rejects omission, duplicates, empty and failed results, preserves observed legacy skip',()=>{
 const files=['tests/unit/a.test.ts','tests/acceptance/v2-pr06-postgres.test.ts'];
 const report={success:true,numFailedTests:0,numFailedTestSuites:0,testResults:files.map((f,i)=>({name:'/repo/'+f,status:'passed',assertionResults:[{status:i?'skipped':'passed'}]}))};validateNonDatabase(report,files);
 for(const r of [{...report,testResults:report.testResults.slice(0,1)},{...report,testResults:[report.testResults[0],report.testResults[0]]},{...report,numFailedTests:1},{...report,testResults:report.testResults.map(r=>({...r,assertionResults:[]}))}])assert.throws(()=>validateNonDatabase(r,files));
});
test('request identity cannot be a light run, missing attempt or another kind',()=>{const p={...id,phase:'final'};identity(p,{GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1'});assert.throws(()=>identity({...p,phase:'light'},{GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1'}));assert.throws(()=>identity(p,{}));});
test('workflow dispatches both lanes only after one common bundle and aggregates actual GitHub results',()=>{
 const w=readFileSync('.github/workflows/full-gate.yml','utf8'),caller=readFileSync('.github/workflows/ci.yml','utf8');
 assert.equal((w.match(/needs: prepare/g)||[]).length,2);assert.match(w,/needs: \[prepare, non-db, postgres\]/);assert.doesNotMatch(w,/FULL_GATE_NEEDS:/);assert.match(w,/FULL_GATE_RECORD_DIRECTORY:/);assert.match(w,/pattern: full-record-\*-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/);
 assert.equal((w.match(/full-gate-lanes.mjs restore/g)||[]).length,2);assert.equal((w.match(/--full-gate\n/g)||[]).length,1);assert.doesNotMatch(w,/continue-on-error:|^ {4}concurrency:/m);
 assert.match(caller,/group: pr-gate-\$\{\{ needs.request.outputs.pr \}\}/);assert.match(w,/--reporter=json --outputFile=/);
});

test('real producer and fresh consumer round-trip identical build bytes; stale attempt and symlink reject',()=>{
 const root=mkdtempSync(join(tmpdir(),'dx-full-transfer-')),producer=join(root,'producer'),consumer=join(root,'consumer'),temp=join(root,'temp');
 const script=resolve('scripts/ci/full-gate-lanes.mjs');
 const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try{
  mkdirSync(producer);mkdirSync(temp);for(const dir of ['tests/integration','apps/api','packages'])mkdirSync(join(producer,dir),{recursive:true});
  writeFileSync(join(producer,'package-lock.json'),'{}');writeFileSync(join(producer,'.gitignore'),'dist/\n');
  for(const dir of ['tests/integration','packages'])writeFileSync(join(producer,dir,'.keep'),'');
  git(producer,'init','-q');git(producer,'config','user.name','fixture');git(producer,'config','user.email','fixture@example.invalid');git(producer,'add','.');git(producer,'commit','-qm','fixture');
  const head=git(producer,'rev-parse','HEAD'),ref=finalRef({kind:'full',pr:1,head,base:head,baseRef:'main'});
  const event=join(root,'event.json'),output=join(root,'output'),envfile=join(root,'env');writeFileSync(event,JSON.stringify({ref,ref_type:'branch',repository:{full_name:id.repository}}));
  const env={...process.env,GITHUB_REPOSITORY:id.repository,GITHUB_SHA:head,GITHUB_EVENT_NAME:'create',GITHUB_EVENT_PATH:event,GITHUB_RUN_ID:'91',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:output,GITHUB_ENV:envfile,RUNNER_TEMP:temp,NODE_ENV:'test',SERVICE_NAME:'dx-rework-api',BUILD_TIME:'2026-11-05T00:00:00Z'};
  mkdirSync(join(producer,'apps/api/dist'),{recursive:true});writeFileSync(join(producer,'apps/api/dist/out.js'),'export const value=42;');
  execFileSync(process.execPath,[script,'bundle'],{cwd:producer,env,stdio:'pipe'});
  const shadow=JSON.parse(readFileSync(join(temp,'full-inputs.json'),'utf8')).shadow;
  assert.equal(shadow.mode,'shadow-only');assert.equal(shadow.selectionApproved,false);assert.equal(shadow.executionChanged,false);
  const hash=readFileSync(output,'utf8').trim().split('=')[1];
  git(root,'clone','-q',producer,consumer); // dist is ignored: only the producer has build output.
  execFileSync(process.execPath,[script,'restore'],{cwd:consumer,env:{...env,FULL_GATE_BUNDLE_HASH:hash},stdio:'pipe'});
  assert.deepEqual(JSON.parse(readFileSync(join(temp,'impact-shadow-plan.json'),'utf8')),shadow);
  assert.equal(readFileSync(join(consumer,'apps/api/dist/out.js'),'utf8'),'export const value=42;');
  assert.match(readFileSync(envfile,'utf8'),/DB_REQUIRED=false/);
  assert.throws(()=>execFileSync(process.execPath,[script,'restore'],{cwd:consumer,env:{...env,GITHUB_RUN_ATTEMPT:'2',FULL_GATE_BUNDLE_HASH:hash},stdio:'pipe'}));
  rmSync(join(consumer,'apps/api/dist'),{recursive:true});symlinkSync(join(producer,'apps/api/dist'),join(consumer,'apps/api/dist'));
  assert.throws(()=>execFileSync(process.execPath,[script,'restore'],{cwd:consumer,env:{...env,FULL_GATE_BUNDLE_HASH:hash},stdio:'pipe'}));
  copyFileSync(join(temp,'full-inputs.json'),join(root,'retained-input.json'));
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('only a same-OS image revision can request a fresh lane build; other input drift rejects',()=>{
 assert.equal(laneBuildMode(context,context),'restored');
 assert.equal(laneBuildMode(context,{...context,image:['ubuntu24','20261101.360.1']}),'rebuilt');
 for(const current of [{...context,image:['ubuntu26','new']},{...context,image:['ubuntu24','']},{...context,node:'24'},{...context,npm:'11'},{...context,inputsHash:'foreign'},{...context,head:'foreign'},{...context,arch:'arm64'}])assert.throws(()=>laneBuildMode(context,current));
});
test('aggregation requires authentic per-lane build provenance and rejects fake reuse across image revisions',()=>{
 const n=fixture(),current={...context,image:['ubuntu24','20261101.360.1']};
 edit(n,'non-db',r=>r.build={...build,mode:'rebuilt',context:current,filesHash:'e'.repeat(64)});
 aggregate(n,id,inputs);
 for(const change of [r=>delete r.build,r=>r.build.mode='restored',r=>r.build.sourceContext.node='24',r=>r.build.filesHash='',r=>r.build.identity.attempt='2']){const bad=structuredClone(n);edit(bad,'non-db',change);assert.throws(()=>aggregate(bad,id,inputs));}
 const proof={...build,mode:'rebuilt',context:current,filesHash:'e'.repeat(64)},args={id,buildHash:hash,sourceContext:context,sourceFilesHash:hash,currentContext:current,filesHash:proof.filesHash};
 validateLaneBuild(proof,args);
 assert.throws(()=>validateLaneBuild(proof,{...args,currentContext:context}));
 assert.throws(()=>validateLaneBuild(proof,{...args,filesHash:hash}));
});
test('different image revisions execute a real local workspace build; corrupt input and failed builds produce no proof',()=>{
 const root=mkdtempSync(join(tmpdir(),'dx-full-rebuild-')),producer=join(root,'producer'),consumer=join(root,'consumer'),temp=join(root,'temp');
 const script=resolve('scripts/ci/full-gate-lanes.mjs');
 const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
 try{
  mkdirSync(producer);mkdirSync(temp);for(const dir of ['tests/integration','apps/api','packages'])mkdirSync(join(producer,dir),{recursive:true});
  writeFileSync(join(producer,'package-lock.json'),'{}');writeFileSync(join(producer,'.gitignore'),'dist/\n');
  for(const dir of ['tests/integration','packages'])writeFileSync(join(producer,dir,'.keep'),'');
  writeFileSync(join(producer,'package.json'),JSON.stringify({private:true,workspaces:['apps/api']}));
  writeFileSync(join(producer,'apps/api/package.json'),JSON.stringify({name:'fixture',version:'1.0.0',scripts:{build:'node build.cjs'}}));
  writeFileSync(join(producer,'apps/api/build.cjs'),"const fs=require('node:fs');if(process.env.BUILD_FIXTURE_FAIL)process.exit(7);fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/out.js','local-'+process.env.ImageVersion);");
  git(producer,'init','-q');git(producer,'config','user.name','fixture');git(producer,'config','user.email','fixture@example.invalid');git(producer,'add','.');git(producer,'commit','-qm','fixture');
  const head=git(producer,'rev-parse','HEAD'),ref=finalRef({kind:'full',pr:1,head,base:head,baseRef:'main'}),event=join(root,'event.json'),output=join(root,'output'),envfile=join(root,'env');
  writeFileSync(event,JSON.stringify({ref,ref_type:'branch',repository:{full_name:id.repository}}));
  const env={...process.env,GITHUB_REPOSITORY:id.repository,GITHUB_SHA:head,GITHUB_EVENT_NAME:'create',GITHUB_EVENT_PATH:event,GITHUB_RUN_ID:'91',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:output,GITHUB_ENV:envfile,RUNNER_TEMP:temp,NODE_ENV:'test',SERVICE_NAME:'dx-rework-api',BUILD_TIME:'2026-11-05T00:00:00Z',ImageOS:'ubuntu24',ImageVersion:'20261025.353.1'};
  mkdirSync(join(producer,'apps/api/dist'));writeFileSync(join(producer,'apps/api/dist/out.js'),'foreign-shared-output');
  execFileSync(process.execPath,[script,'bundle'],{cwd:producer,env,stdio:'pipe'});
  const hash=readFileSync(output,'utf8').trim().split('=')[1],bundle=join(temp,'full-inputs.json'),original=readFileSync(bundle),proofFile=join(temp,'full-lane-build.json');
  git(root,'clone','-q',producer,consumer);
  const consumerEnv={...env,FULL_GATE_BUNDLE_HASH:hash,ImageVersion:'20261101.360.1'};
  execFileSync(process.execPath,[script,'restore'],{cwd:consumer,env:consumerEnv,stdio:'pipe'});
  assert.equal(readFileSync(join(consumer,'apps/api/dist/out.js'),'utf8'),'local-20261101.360.1');
  const proof=JSON.parse(readFileSync(proofFile,'utf8'));assert.equal(proof.mode,'rebuilt');assert.equal(proof.context.image[1],consumerEnv.ImageVersion);
  rmSync(proofFile);writeFileSync(bundle,Buffer.concat([original,Buffer.from(' ')]));
  assert.throws(()=>execFileSync(process.execPath,[script,'restore'],{cwd:consumer,env:consumerEnv,stdio:'pipe'}));assert.equal(existsSync(proofFile),false);
  writeFileSync(bundle,original);
  assert.throws(()=>execFileSync(process.execPath,[script,'restore'],{cwd:consumer,env:{...consumerEnv,BUILD_FIXTURE_FAIL:'1'},stdio:'pipe'}));assert.equal(existsSync(proofFile),false);assert.equal(existsSync(join(consumer,'apps/api/dist/out.js')),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('artifact transport starts a process with a large real-shape test plan and retains identity, status and hash validation',()=>{
 const directory=mkdtempSync(join(tmpdir(),'full-lane-record-'));try{
  const n=fixture(),large=structuredClone(inputs);large.nonDatabase={files:Array.from({length:6000},(_,i)=>'tests/unit/representative-business-case-'+i+'.test.ts')};
  for(const [lane,value]of Object.entries(n)){
   const record=JSON.parse(value.outputs.record);record.inputs=large;value.outputs.record=JSON.stringify(record);assert.ok(Buffer.byteLength(value.outputs.record)>131072);
   const path=join(directory,`full-record-${lane}-${id.runId}-${id.attempt}`);mkdirSync(path);writeFileSync(join(path,'full-lane-record.json'),value.outputs.record);
  }
  const environment={FULL_GATE_PREPARE_RESULT:'success',FULL_GATE_NON_DB_RESULT:'success',FULL_GATE_POSTGRES_RESULT:'success',FULL_GATE_BUNDLE_HASH:hash};
  const script=`import {laneNeedsFromFiles,aggregate} from ${JSON.stringify(new URL('./full-gate-lanes.mjs',import.meta.url).href)};import{readFileSync}from'node:fs';const spec=JSON.parse(readFileSync(process.argv[2]));console.log(Object.keys(aggregate(laneNeedsFromFiles(process.argv[1],spec.id,process.env),spec.id,spec.inputs)).length);`;
  const spec=join(directory,'context.json');writeFileSync(spec,JSON.stringify({id,inputs:large}));
  assert.equal(Number(execFileSync(process.execPath,['--input-type=module','-e',script,directory,spec],{encoding:'utf8',env:{...process.env,...environment}}).trim()),catalog.length);
  const read=env=>laneNeedsFromFiles(directory,id,{...environment,...env});
  assert.throws(()=>aggregate(read({FULL_GATE_POSTGRES_RESULT:'failure'}),id,large),/NOT_SUCCESS/);
  assert.throws(()=>aggregate(read({FULL_GATE_BUNDLE_HASH:'d'.repeat(64)}),id,large),/MISMATCH/);
  assert.throws(()=>aggregate(read({}),{...id,head:'d'.repeat(40)},large),/MISMATCH/);
  rmSync(join(directory,'full-record-postgres-1-1','full-lane-record.json'));assert.throws(()=>read({}));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
