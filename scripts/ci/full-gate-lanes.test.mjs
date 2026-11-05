import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,copyFileSync,symlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {finalRef} from './pr-gate-protocol.mjs';
import {aggregate,owner,digest,validateBuildFiles,validateBundle,validateNonDatabase,identity} from './full-gate-lanes.mjs';
import {checkCatalog,scopeRequired} from './ci-gate-runtime.mjs';
const id={repository:'lizhonghao31-crypto/dx-rework',pr:1,head:'a'.repeat(40),base:'b'.repeat(40),baseRef:'release/digital-production-v1',kind:'full',runId:'1',attempt:'1'};
const inputs={scope:{event:'create',final:'true',base:id.baseRef,db:'true',mapped:'test',journey:'true',migration:'true',business_chain:'true',deployment:'true',maintenance:'true',activation:'true',transfer:'true'},postgres:{status:'required',plan:[]}};
const hash='c'.repeat(64),catalog=checkCatalog('full');
function fixture(){return Object.fromEntries(['prepare','non-db','postgres'].map(lane=>[lane,{result:'success',outputs:{bundle_hash:hash,record:JSON.stringify({version:1,lane,identity:id,inputs,status:'success',buildHash:hash,evidenceHash:hash,cleanup:'passed',steps:Object.fromEntries(catalog.filter(([key])=>owner(key)===lane).map(([key])=>[key,{outcome:'success'}]))})}}]));}
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
 assert.equal((w.match(/needs: prepare/g)||[]).length,2);assert.match(w,/needs: \[prepare, non-db, postgres\]/);assert.match(w,/FULL_GATE_NEEDS: \$\{\{ toJSON\(needs\) \}\}/);
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
  const hash=readFileSync(output,'utf8').trim().split('=')[1];
  git(root,'clone','-q',producer,consumer); // dist is ignored: only the producer has build output.
  execFileSync(process.execPath,[script,'restore'],{cwd:consumer,env:{...env,FULL_GATE_BUNDLE_HASH:hash},stdio:'pipe'});
  assert.equal(readFileSync(join(consumer,'apps/api/dist/out.js'),'utf8'),'export const value=42;');
  assert.match(readFileSync(envfile,'utf8'),/DB_REQUIRED=false/);
  assert.throws(()=>execFileSync(process.execPath,[script,'restore'],{cwd:consumer,env:{...env,GITHUB_RUN_ATTEMPT:'2',FULL_GATE_BUNDLE_HASH:hash},stdio:'pipe'}));
  rmSync(join(consumer,'apps/api/dist'),{recursive:true});symlinkSync(join(producer,'apps/api/dist'),join(consumer,'apps/api/dist'));
  assert.throws(()=>execFileSync(process.execPath,[script,'restore'],{cwd:consumer,env:{...env,FULL_GATE_BUNDLE_HASH:hash},stdio:'pipe'}));
  copyFileSync(join(temp,'full-inputs.json'),join(root,'retained-input.json'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
