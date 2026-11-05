// Cross-runner transport, not cross-run test reuse or case-completeness proof.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {appendFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {checkCatalog,currentPlan,scopeFor,scopeRequired} from './ci-gate-runtime.mjs';
import {reuseContext} from './light-reuse.mjs';
import {fullGatePostgresPlan,postgresTestFiles,assertExecutionReceipt} from '../test-suite-plan.mjs';

export const digest=value=>createHash('sha256').update(value).digest('hex');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const output=(key,value)=>appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${typeof value==='string'?value:JSON.stringify(value)}\n`);
const same=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error('FULL_LANE_MISMATCH: '+label);};
const pgIds=new Set(['db_start','db_seed','db_migrate','resource_smoke','db_tests','journey','root_audit','business_chain','backup','acceptance_recovery','release_history','release_acceptance','package','db_stop']);
export const owner=id=>id==='tests'?'non-db':pgIds.has(id)?'postgres':'prepare';
const flags={db:'DB_REQUIRED',mapped:'MAPPED_POSTGRES_TESTS',journey:'JOURNEY_PG13_COMPAT',migration:'MIGRATION_SENSITIVE',business_chain:'BUSINESS_CHAIN_SENSITIVE',deployment:'DEPLOYMENT_SENSITIVE',maintenance:'MAINTENANCE_SENSITIVE',activation:'ACTIVATION_SENSITIVE',transfer:'TRANSFER_SENSITIVE'};
export function expectedInputs(plan){
 const paths=git('diff','--name-only',plan.base,plan.head).split('\n').filter(Boolean);
 const scope=scopeFor(plan,paths);
 const environment={BASE_SHA:plan.base,...Object.fromEntries(Object.entries(flags).map(([k,v])=>[v,scope[k]]))};
 const excluded=new Set(postgresTestFiles());
 const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):e.name.endsWith('.test.ts')?[dir+'/'+e.name]:[]);
 return {scope,environment,postgres:fullGatePostgresPlan(environment),nonDatabase:walk('tests').filter(p=>!excluded.has(p)).sort()};
}
export function identity(plan,env=process.env){
 if(plan.kind!=='full'||plan.phase!=='final')throw Error('FULL_LANE_FINAL_REQUEST_REQUIRED');
 for(const k of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'])if(!/^[1-9][0-9]*$/.test(env[k]??''))throw Error('FULL_LANE_RUN_REQUIRED');
 return {repository:plan.repository,pr:plan.pr,head:plan.head,base:plan.base,baseRef:plan.baseRef,kind:plan.kind,runId:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT};
}
function safePath(path){
 if(typeof path!=='string'||! /^(apps|packages)\/[a-z0-9-]+\/dist\/.+/.test(path)||path.includes('\\')||path.split('/').some(p=>['','.','..'].includes(p))||[...path].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))throw Error('FULL_BUILD_PATH_REJECTED');
 let current=resolve('.');for(const part of path.split('/')){current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw Error('FULL_BUILD_SYMLINK_REJECTED');}
}
function collectBuild(){
 const files=[];
 const walk=path=>{safePath(path+'/entry');const s=lstatSync(path);if(s.isDirectory())for(const p of readdirSync(path).sort())walk(path+'/'+p);else if(s.isFile()){const body=readFileSync(path);files.push({path,mode:s.mode&0o111?0o755:0o644,sha256:digest(body),content:body.toString('base64')});}else throw Error('FULL_BUILD_FILE_REQUIRED');};
 for(const group of ['apps','packages'])for(const name of readdirSync(group).sort()){const path=group+'/'+name+'/dist';if(existsSync(path))walk(path);}
 if(!files.length)throw Error('FULL_BUILD_EMPTY');return files;
}
export function validateBuildFiles(files,tracked=new Set(git('ls-files').split('\n'))){
 if(!Array.isArray(files)||!files.length||files.length>10000)throw Error('FULL_BUILD_EMPTY_OR_OVERSIZED');
 let bytes=0;const seen=new Set();
 for(const f of files){safePath(f.path);if(seen.has(f.path)||tracked.has(f.path)||![0o644,0o755].includes(f.mode)||typeof f.content!=='string')throw Error('FULL_BUILD_FILE_REJECTED');seen.add(f.path);const body=Buffer.from(f.content,'base64');bytes+=body.length;if(bytes>256*1024*1024||body.toString('base64')!==f.content||digest(body)!==f.sha256)throw Error('FULL_BUILD_CONTENT_REJECTED');}
}
export function validateBundle(bundle,{id,inputs,context,hash,raw}){
 if(!/^[a-f0-9]{64}$/.test(hash??'')||digest(raw)!==hash)throw Error('FULL_BUILD_DIGEST_MISMATCH');
 if(bundle.version!==1)throw Error('FULL_BUILD_VERSION_REJECTED');
 same(bundle.identity,id,'request/run/attempt');same(bundle.inputs,inputs,'risk and plans');same(bundle.context,context,'build environment');
 if(!Number.isFinite(Date.parse(bundle.builtAt??'')))throw Error('FULL_BUILD_TIME_REQUIRED');
 if(inputs.scope.base==='release/digital-production-v1'&&!bundle.compatibility)throw Error('FULL_COMPATIBILITY_MISSING');
 validateBuildFiles(bundle.files);return bundle;
}
export function validateNonDatabase(report,files){
 if(report.success!==true||report.numFailedTests!==0||report.numFailedTestSuites!==0||!Array.isArray(report.testResults)||report.testResults.length!==files.length)throw Error('FULL_NON_DB_INCOMPLETE');
 for(const path of files){const rows=report.testResults.filter(r=>r.name.endsWith('/'+path));if(rows.length!==1)throw Error('FULL_NON_DB_FILE_MISMATCH: '+path);const r=rows[0];
  // The pre-existing acceptance PG suite is intentionally discovered by the non-DB
  // config, but skips without TEST_DATABASE_URL. Retain and disclose it; no new waiver.
  const knownSkip=path==='tests/acceptance/v2-pr06-postgres.test.ts';
  if(!Array.isArray(r.assertionResults)||!r.assertionResults.length||r.assertionResults.some(c=>!['passed','skipped','pending'].includes(c.status))||(!knownSkip&&!r.assertionResults.some(c=>c.status==='passed')))throw Error('FULL_NON_DB_NO_PASS: '+path);
 }
}
export function aggregate(needs,id,inputs,catalog=checkCatalog('full')){
 const combined={};let buildHash;
 for(const lane of ['prepare','non-db','postgres']){
  const n=needs[lane];if(n?.result!=='success')throw Error('FULL_LANE_NOT_SUCCESS: '+lane);
  const r=JSON.parse(n.outputs?.record||'null');if(!r||r.version!==1||r.lane!==lane||r.status!=='success')throw Error('FULL_LANE_RECORD_MISSING: '+lane);
  same(r.identity,id,'lane identity');same(r.inputs,inputs,'lane plans');
  if(lane==='prepare'){buildHash=n.outputs.bundle_hash;if(!/^[a-f0-9]{64}$/.test(buildHash??''))throw Error('FULL_BUILD_DIGEST_MISSING');}
  if(r.buildHash!==buildHash)throw Error('FULL_LANE_BUILD_MISMATCH');
  const expected=catalog.filter(([key])=>owner(key)===lane);
  same(Object.keys(r.steps).sort(),expected.map(([key])=>key).sort(),'step partition');
  for(const [key,,kind]of expected){const step=r.steps[key];if(scopeRequired(kind,inputs.scope)&&step?.outcome!=='success')throw Error('FULL_LANE_CHECK_INCOMPLETE: '+key);if(['failure','cancelled'].includes(step?.outcome))throw Error('FULL_LANE_CHECK_FAILED: '+key);combined[key]=step;}
  if(lane==='non-db'&&!/^[a-f0-9]{64}$/.test(r.evidenceHash??''))throw Error('FULL_NON_DB_EVIDENCE_MISSING');
  if(lane==='postgres'&&inputs.postgres.status==='required'&&(!/^[a-f0-9]{64}$/.test(r.evidenceHash??'')||r.cleanup!=='passed'))throw Error('FULL_PG_EVIDENCE_MISSING');
 }
 return combined;
}
async function cli(){
 const command=process.argv[2],plan=currentPlan(),id=identity(plan),inputs=expectedInputs(plan),temp=process.env.RUNNER_TEMP;
 if(git('rev-parse','HEAD')!==plan.head)throw Error('FULL_LANE_CHECKOUT_MISMATCH');
 const file=join(temp,'full-inputs.json');
 if(command==='bundle'){
  const compatibility=join(temp,'main-release-compat.json');
  const bundle={version:1,identity:id,inputs,context:reuseContext(),builtAt:process.env.BUILD_TIME,files:collectBuild(),compatibility:existsSync(compatibility)?json(compatibility):null};
  validateBuildFiles(bundle.files);const raw=JSON.stringify(bundle);writeFileSync(file,raw);output('bundle_hash',digest(raw));
 }else if(command==='restore'){
  const raw=readFileSync(file);const b=validateBundle(JSON.parse(raw),{id,inputs,context:reuseContext(),hash:process.env.FULL_GATE_BUNDLE_HASH,raw});
  for(const f of b.files){mkdirSync(dirname(f.path),{recursive:true});writeFileSync(f.path,Buffer.from(f.content,'base64'),{mode:f.mode});}
  if(b.compatibility)writeFileSync(join(temp,'main-release-compat.json'),JSON.stringify(b.compatibility));
  for(const [key,value]of Object.entries({...inputs.environment,BUILD_TIME:b.builtAt})){if(typeof value!=='string'||value.includes('\n')||value.includes('\r'))throw Error('FULL_ENV_VALUE_REJECTED');appendFileSync(process.env.GITHUB_ENV,`${key}=${value}\n`);}
 }else if(command==='record'){
  const lane=process.env.FULL_GATE_LANE,steps=JSON.parse(process.env.LANE_STEPS),status=process.env.LANE_STATUS;
  if(!['prepare','non-db','postgres'].includes(lane))throw Error('FULL_LANE_UNKNOWN');
  if(status==='success'&&git('status','--porcelain','--untracked-files=normal'))throw Error('FULL_LANE_WORKTREE_CHANGED');
  const record={version:1,lane,identity:id,inputs,status,buildHash:lane==='prepare'&&existsSync(file)?digest(readFileSync(file)):process.env.FULL_GATE_BUNDLE_HASH,steps:Object.fromEntries(checkCatalog('full').filter(([k])=>owner(k)===lane).map(([k])=>[k,steps[k]??{outcome:'not_run'}]))};
  if(status==='success'&&lane==='non-db'){const report=join(temp,'non-db-results.json');validateNonDatabase(json(report),inputs.nonDatabase);record.evidenceHash=digest(readFileSync(report));}
  if(status==='success'&&lane==='postgres'&&inputs.postgres.status==='required'){
   const path=join(temp,'postgres-execution.json'),r=json(path);for(const [k,v]of Object.entries({head:id.head,base:id.base,runId:id.runId,attempt:id.attempt}))same(r.context?.[k],v,'PG '+k);
   assertExecutionReceipt(r,r.context,inputs.postgres.plan);record.cleanup=r.cleanup;record.evidenceHash=digest(readFileSync(path));
  }
  writeFileSync(join(temp,'full-lane-record.json'),JSON.stringify(record));output('record',record);
  if(status!=='success')throw Error('FULL_LANE_FAILED: '+lane);
 }else if(command==='aggregate'){
  const needs=JSON.parse(process.env.FULL_GATE_NEEDS);
  try{const steps=aggregate(needs,id,inputs);output('steps',steps);output('scope',inputs.scope);}
  catch(error){
   if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    ['## Full Gate 未通过','',error.message,'',...['prepare','non-db','postgres'].map(lane=>`- ${lane}: ${needs[lane]?.result??'missing'}`),'','失败、取消、缺少产物或清理未证均不签最终回执。',''].join('\n'));
   throw error;
  }
 }else throw Error('Expected bundle, restore, record or aggregate');
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)await cli();
