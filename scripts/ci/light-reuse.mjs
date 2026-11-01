import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,appendFileSync,readdirSync,lstatSync,existsSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {currentPlan} from './ci-gate-runtime.mjs';
import {assertRunBinding,LIGHT_CHECK,REPOSITORY,parseReceipt,REUSABLE_CHECKS} from './pr-gate-protocol.mjs';
export {REUSABLE_CHECKS};
const hash=value=>createHash('sha256').update(value).digest('hex');
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
const MAX_BYTES=256*1024*1024;
export function reuseContext(cwd='.',environment=process.env){
 if(git(cwd,'status','--porcelain','--untracked-files=normal'))throw Error('REUSE_WORKTREE_CHANGED');
 const inputs=Object.fromEntries(Object.keys(environment).filter(k=>/^(?:VITE_|TSUP_|NODE_OPTIONS$|NODE_ENV$|SERVICE_NAME$)/.test(k)).sort().map(k=>[k,environment[k]]));
 return {head:git(cwd,'rev-parse','HEAD'),tree:git(cwd,'rev-parse','HEAD^{tree}'),lock:hash(readFileSync(join(cwd,'package-lock.json'))),node:process.versions.node,npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),platform:process.platform,arch:process.arch,image:[environment.ImageOS??'',environment.ImageVersion??''],inputsHash:hash(JSON.stringify(inputs))};
}
function safeOutputPath(path){if(typeof path!=='string'||! /^(?:apps|packages)\/[a-z0-9-]+\/dist\/.+/.test(path)||path.includes('\\')||path.split('/').some(p=>p==='..'||p==='.'||p==='')||[...path].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))throw Error('REUSE_OUTPUT_PATH_REJECTED');return path;}
function noSymlinkParents(cwd,path){let current=resolve(cwd);for(const part of path.split('/').slice(0,-1)){current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw Error('REUSE_OUTPUT_SYMLINK_REJECTED');}}
export function createBundle({cwd='.',plan,receipt,environment=process.env}={}){
 for(const key of ['repository','pr','head','base','kind'])if(receipt[key]!==plan[key])throw Error('REUSE_SNAPSHOT_TUPLE_CHANGED');
 if(receipt.phase!=='light'||!['snapshot','success'].includes(receipt.jobStatus)||!Number.isSafeInteger(receipt.runId)||receipt.runId<1||!Number.isSafeInteger(receipt.attempt)||receipt.attempt<1)throw Error('REUSE_SNAPSHOT_INVALID');
 for(const id of REUSABLE_CHECKS){const row=receipt.checks.find(c=>c.id===id);if(row?.applicable!==true||row.outcome!=='success')throw Error('REUSE_SNAPSHOT_CHECK_MISSING: '+id);}
 const files=[];let bytes=0;
 const collect=path=>{const stat=lstatSync(join(cwd,path));if(stat.isSymbolicLink())throw Error('REUSE_OUTPUT_SYMLINK_REJECTED');if(stat.isDirectory()){for(const name of readdirSync(join(cwd,path)).sort())collect(path+'/'+name);}else if(stat.isFile()){safeOutputPath(path);const body=readFileSync(join(cwd,path));bytes+=body.length;if(bytes>MAX_BYTES)throw Error('REUSE_OUTPUT_TOO_LARGE');files.push({path,mode:stat.mode&0o111?0o755:0o644,sha256:hash(body),content:body.toString('base64')});}};
 for(const group of ['apps','packages'])if(existsSync(join(cwd,group)))for(const name of readdirSync(join(cwd,group)).sort())if(existsSync(join(cwd,group,name,'dist')))collect(group+'/'+name+'/dist');
 if(!files.length)throw Error('REUSE_BUILD_OUTPUT_MISSING');
 return {version:1,repository:REPOSITORY,plan:{pr:plan.pr,head:plan.head,base:plan.base,baseRef:plan.baseRef,kind:plan.kind},context:reuseContext(cwd,environment),builtAt:environment.BUILD_TIME??null,receipt,files};
}
export function validateBundle(bundle,{cwd='.',plan,context=reuseContext(cwd),server}={}){
 if(bundle.version!==1||bundle.repository!==REPOSITORY)throw Error('REUSE_ARTIFACT_VERSION_REJECTED');
 for(const key of ['pr','head','base','baseRef','kind'])if(bundle.plan[key]!==plan[key])throw Error('REUSE_PLAN_CHANGED: '+key);
 if(JSON.stringify(bundle.context)!==JSON.stringify(context))throw Error('REUSE_CONTEXT_CHANGED');
 if(!Number.isFinite(Date.parse(bundle.builtAt??'')))throw Error('REUSE_BUILD_TIME_MISSING');
 assertRunBinding(server.run,server.job,server.receipt,{...plan,phase:'light',requiredIds:REUSABLE_CHECKS});
 for(const key of ['version','repository','pr','head','base','kind','phase','runId','attempt'])if(bundle.receipt[key]!==server.receipt[key])throw Error('REUSE_RECEIPT_CHANGED');
 for(const id of REUSABLE_CHECKS){const a=bundle.receipt.checks.find(c=>c.id===id),b=server.receipt.checks.find(c=>c.id===id);if(a?.outcome!=='success'||a.applicable!==true||b?.outcome!=='success'||b.applicable!==true)throw Error('REUSE_RECEIPT_CHECK_CHANGED');}
 if(!Array.isArray(bundle.files)||!bundle.files.length||bundle.files.length>10000)throw Error('REUSE_FILE_LIST_REJECTED');
 const tracked=new Set(git(cwd,'ls-files').split('\n')),names=new Set();let bytes=0;
 for(const f of bundle.files){safeOutputPath(f.path);noSymlinkParents(cwd,f.path);if(existsSync(join(cwd,f.path))&&lstatSync(join(cwd,f.path)).isSymbolicLink())throw Error('REUSE_OUTPUT_SYMLINK_REJECTED');if(names.has(f.path)||tracked.has(f.path)||![0o644,0o755].includes(f.mode)||typeof f.content!=='string')throw Error('REUSE_FILE_REJECTED');names.add(f.path);const body=Buffer.from(f.content,'base64');bytes+=body.length;if(bytes>MAX_BYTES||body.toString('base64')!==f.content||hash(body)!==f.sha256)throw Error('REUSE_CONTENT_CHANGED');}
 return {fingerprint:hash(JSON.stringify(bundle.context)),artifactSha256:hash(JSON.stringify(bundle)),source:{repository:REPOSITORY,pr:plan.pr,head:plan.head,base:plan.base,baseRef:plan.baseRef,kind:plan.kind,phase:'light',runId:server.run.id,attempt:server.run.run_attempt,jobId:server.job.id,workflow:server.run.path}};
}
export function restoreBundle(bundle,options){const proof=validateBundle(bundle,options);for(const f of bundle.files){const path=join(options.cwd??'.',f.path);if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw Error('REUSE_OUTPUT_SYMLINK_REJECTED');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,Buffer.from(f.content,'base64'),{mode:f.mode});}return proof;}
const output=(key,value)=>appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${value}\n`);
async function github(path,{text=false}={}){const r=await fetch('https://api.github.com/repos/'+REPOSITORY+path,{headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(20000)});if(!r.ok){const e=Error('REUSE_GITHUB_READ_HTTP_'+r.status);e.status=r.status;throw e;}return text?await r.text():await r.json();}
async function select(plan){
 const runs=await github(`/actions/runs?head_sha=${plan.head}&event=pull_request&per_page=100`);if(runs.total_count>100)throw Error('REUSE_RUN_PAGINATION_REQUIRED');
 const run=runs.workflow_runs.filter(r=>r.path==='.github/workflows/ci.yml'&&r.head_sha===plan.head&&r.event==='pull_request').sort((a,b)=>b.id-a.id)[0];
 if(!run||run.status!=='completed'||run.conclusion!=='success')return null;
 const jobs=await github(`/actions/runs/${run.id}/jobs?per_page=100`);if(jobs.total_count>100)throw Error('REUSE_JOB_PAGINATION_REQUIRED');const matches=jobs.jobs.filter(j=>j.name===LIGHT_CHECK);if(matches.length!==1)return null;const job=matches[0];
 const receipt=parseReceipt(await github(`/actions/jobs/${job.id}/logs`,{text:true}));
 try{assertRunBinding(run,job,receipt,{...plan,phase:'light',requiredIds:REUSABLE_CHECKS});}catch{return null;}
 const artifacts=await github(`/actions/runs/${run.id}/artifacts?per_page=100`);if(artifacts.total_count>100)throw Error('REUSE_ARTIFACT_PAGINATION_REQUIRED');
 const found=artifacts.artifacts.filter(a=>a.name===`light-build-${plan.head}-${run.run_attempt}`&&!a.expired);if(found.length!==1)return null;
 return {run,job,receipt,artifact:found[0]};
}
async function cli(){
 const [command,...args]=process.argv.slice(2),plan=currentPlan();
 if(command==='publish'){
  const steps=JSON.parse(process.env.LIGHT_STEPS),receipt={version:1,repository:REPOSITORY,pr:plan.pr,head:plan.head,base:plan.base,baseRef:plan.baseRef,kind:plan.kind,phase:'light',jobStatus:'snapshot',runId:Number(process.env.GITHUB_RUN_ID),attempt:Number(process.env.GITHUB_RUN_ATTEMPT),checks:REUSABLE_CHECKS.map(id=>({id,applicable:true,outcome:steps[id]?.outcome??'not_run'}))};
  const bundle=createBundle({plan,receipt});mkdirSync(args[0],{recursive:true});writeFileSync(join(args[0],'light-build.json'),JSON.stringify(bundle));
 }else if(command==='select'){
  let server=null;try{server=await select(plan);}catch(e){console.log(e.message);}
  writeFileSync(args[0],JSON.stringify({server}));output('artifact_id',server?.artifact.id??'');output('run_id',server?.run.id??'');
 }else if(command==='restore'){
  const {server}=JSON.parse(readFileSync(args[0],'utf8'));if(!server)throw Error('REUSE_SOURCE_MISSING');const file=args[1];if(lstatSync(file).size>MAX_BYTES*2)throw Error('REUSE_ARTIFACT_TOO_LARGE');const bundle=JSON.parse(readFileSync(file,'utf8'));let proof;
  try{proof=restoreBundle(bundle,{plan,server});}catch(e){if(e.message==='REUSE_CONTEXT_CHANGED'){console.log('LIGHT_REUSE_CONTEXT_MISS: execute fresh checks and build');return;}throw e;}
  writeFileSync(args[2],JSON.stringify({...proof,context:reuseContext(),checks:REUSABLE_CHECKS}));appendFileSync(process.env.GITHUB_ENV,`BUILD_TIME=${bundle.builtAt}\n`);
 }else if(command==='run'){
  const [id,...cmd]=args;if(!REUSABLE_CHECKS.includes(id)||!cmd.length)throw Error('REUSE_CHECK_REJECTED');const file=process.env.LIGHT_REUSE_STATE;
  if(file&&existsSync(file)){const proof=JSON.parse(readFileSync(file,'utf8'));if(!proof.checks.includes(id)||proof.fingerprint!==hash(JSON.stringify(reuseContext())))throw Error('REUSE_CHECK_CONTEXT_CHANGED');for(const key of ['head','base','baseRef','kind'])if(proof.source[key]!==plan[key])throw Error('REUSE_CHECK_PLAN_CHANGED');output('reuse_source',JSON.stringify({...proof.source,check:id,fingerprint:proof.fingerprint,artifactSha256:proof.artifactSha256}));console.log(`Verified ${id} from successful light run ${proof.source.runId}, job ${proof.source.jobId}`);}
  else execFileSync(cmd[0],cmd.slice(1),{stdio:'inherit'});
 }else throw Error('Expected publish, select, restore or run');
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)await cli();
