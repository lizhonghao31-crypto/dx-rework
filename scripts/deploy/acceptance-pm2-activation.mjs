import {execFileSync} from 'node:child_process';
import {lstatSync,mkdirSync,readFileSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const name='dx-rework-acceptance-api',fixedRoot='/opt/dx-rework-acceptance',fixedHome='/home/dxacceptance/.pm2';
const require=createRequire(import.meta.url);
const fail=message=>{throw Error(message);};
const signature=row=>JSON.stringify([row.pm_id,row.pm2_env.pm_cwd,row.pm2_env.pm_exec_path]);

// Only the exported test seam changes paths/transport. The operator CLI is fixed
// to the existing Acceptance root/home and never accepts a PM2 namespace override.
export function acceptancePm2(mode,sha,previous,evidence,io={}){
 if(!['stop','activate','halt','recover','pending','complete'].includes(mode)||![sha,previous].every(s=>/^[0-9a-f]{40}$/.test(s)))fail('Invalid Acceptance PM2 action');
 const root=io.root??fixedRoot,home=io.home??fixedHome;
 const run=io.run??(args=>{
  try{return execFileSync('pm2',args,{env:{...process.env,PM2_HOME:home},encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});}
  catch(error){throw Error(`Acceptance PM2 ${args[0]} failed (status ${error.status??'unknown'})`);}
 });
 if(!evidence.startsWith(`${root}/logs/update-${sha}-`)||lstatSync(evidence).isSymbolicLink()||!lstatSync(evidence).isDirectory())fail('Invalid Acceptance PM2 evidence directory');
 const pidFile=join(home,'pm2.pid');
 if(lstatSync(pidFile).isSymbolicLink()||!lstatSync(pidFile).isFile())fail('Existing Acceptance PM2 daemon is required');
 const daemon=Number(readFileSync(pidFile,'utf8').trim());
 if(!Number.isSafeInteger(daemon)||daemon<=1)fail('Invalid Acceptance PM2 daemon identity');
 process.kill(daemon,0); // Do not let a diagnostic jlist start a new daemon.
 const recordFile=join(evidence,'stopped-pm2.json'),dump=join(home,'dump.pm2');
 const release=s=>`${root}/releases/${s}`,script=s=>`${release(s)}/scripts/deploy/start-acceptance-api.sh`;
 const legacy=row=>row.pm_cwd===`${root}/current`&&row.pm_exec_path===`${root}/current/scripts/deploy/start-acceptance-api.sh`;
 const canonical=(row,s)=>row.pm_cwd===release(s)&&row.pm_exec_path===script(s);
 const read=()=>{
  const rows=JSON.parse(run(['jlist']));
  if(!Array.isArray(rows)||rows.length>1||rows.some(r=>r.name!==name||!Number.isSafeInteger(r.pm_id)||r.pm_id<0))fail('Acceptance PM2 must contain only its single API');
  return rows[0]??null;
 };
 const trustedImmutable=row=>{
  const prefix=`${root}/releases/`,at=row.pm_cwd?.slice(prefix.length);
  if(!row.pm_cwd?.startsWith(prefix)||!/^[0-9a-f]{40}$/.test(at)||!canonical(row,at))return false;
  try{const manifest=JSON.parse(readFileSync(`${release(at)}/release-manifest.json`,'utf8'));return realpathSync(release(at))===release(at)&&manifest.gitSha===at&&manifest.appBasePath==='/acceptance/';}catch{return false;}
 };
 const allowed=row=>{
  if(trustedImmutable(row.pm2_env))return true;
  // A persisted stopped legacy alias can survive a daemon restart after a
  // failed save. It is only removed, never used to execute old code.
  return legacy(row.pm2_env)&&[release(sha),release(previous)].includes(realpathSync(`${root}/current`));
 };
 const stopped=row=>row?.pm2_env.status==='stopped'&&(!row.pid||row.pid===0);
 const savedStopped=(file=dump)=>{
  if(lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile())fail('Unsafe Acceptance saved runtime');
  const rows=JSON.parse(readFileSync(file,'utf8'));
  if(!Array.isArray(rows)||rows.length!==1||rows[0].name!==name)fail('Acceptance saved runtime identity mismatch');
  const row=rows[0].pm2_env??rows[0];
  if(row.status!=='stopped')fail('Acceptance saved runtime is not safely stopped');
  if(!trustedImmutable(row)&&!(legacy(row)&&[release(sha),release(previous)].includes(realpathSync(`${root}/current`))))fail('Unrecognized stopped restart path');
  return row;
 };
 const persistStopped=()=>{
  try{
   run(['save']);savedStopped();
   // PM2 resurrect also reads dump.pm2.bak. Both restart sources must be
   // stopped before migration and after a failed activation/persistence.
   run(['save']);savedStopped();savedStopped(dump+'.bak');
  }catch(error){savedStopped();savedStopped(dump+'.bak');return {saved:'previous-stopped',saveError:error.message};}
  return {saved:'stopped'};
 };
 const configuration=()=>{
  const file=`${release(sha)}/infra/pm2/ecosystem.acceptance.config.cjs`;
  if(realpathSync(release(sha))!==release(sha)||realpathSync(`${root}/current`)!==release(sha))fail('Acceptance candidate generation is not active');
  const config=require(file),apps=config.apps;
  if(!Array.isArray(apps)||apps.length!==1||apps[0].name!==name||apps[0].cwd!==release(sha)||apps[0].script!==script(sha))fail('Acceptance candidate PM2 configuration mismatch');
  return {file,app:apps[0]};
 };
 const checkpointDir=join(root,'shared/update-checkpoints'),checkpoint=join(checkpointDir,sha+'.pm2.json');
 const digest=file=>createHash('sha256').update(JSON.stringify(JSON.parse(readFileSync(file,'utf8')))).digest('hex');
 const schemaFile=`${release(sha)}/apps/api/src/platform/migration-manifest.json`;
 const evidenceFile=(directory,file)=>{
  if(!directory.startsWith(`${root}/logs/update-${sha}-`)||realpathSync(directory)!==directory||lstatSync(directory).isSymbolicLink())fail('Invalid activation witness origin');
  const path=join(directory,file);if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())fail('Unsafe activation witness');return path;
 };
 const store=record=>{
  mkdirSync(checkpointDir,{recursive:true,mode:0o700});
  if(lstatSync(checkpointDir).isSymbolicLink()||realpathSync(checkpointDir)!==checkpointDir)fail('Unsafe activation checkpoint directory');
  const temporary=checkpoint+'.'+process.pid+'.tmp';
  writeFileSync(temporary,JSON.stringify(record)+'\n',{mode:0o600,flag:'wx'});renameSync(temporary,checkpoint);
 };
 const witness=()=>{
  if(lstatSync(checkpointDir).isSymbolicLink()||realpathSync(checkpointDir)!==checkpointDir||lstatSync(checkpoint).isSymbolicLink()||!lstatSync(checkpoint).isFile())fail('Unsafe activation checkpoint');
  const saved=JSON.parse(readFileSync(checkpoint,'utf8'));
  if(saved.version!==1||saved.sha!==sha||saved.phase!=='registering'||saved.manifest!==digest(schemaFile))fail('Activation checkpoint does not match this candidate');
  const phase=readFileSync(evidenceFile(saved.evidence,'phase'),'utf8').trim();
  if(!['runtime','runtime-verified-awaiting-persistence','failed-runtime-state-unverified'].includes(phase))fail('Activation witness is not at the registration phase');
  const originalHistory=digest(evidenceFile(saved.evidence,'activation-history.json'));
  let currentHistory;try{currentHistory=evidenceFile(evidence,'activation-history.json');}catch(error){if(error.code!=='ENOENT')throw error;currentHistory=evidenceFile(evidence,'initial-history.json');}
  if(saved.history!==originalHistory||saved.history!==digest(currentHistory)||saved.identity!==digest(evidenceFile(saved.evidence,'live-acceptance-identity.json'))||saved.identity!==digest(evidenceFile(evidence,'live-acceptance-identity.json')))fail('Activation database history or identity changed');
  configuration();return saved;
 };
 const halt=()=>{
  let row=read();
  if(!row){
   // Register, but never execute, the verified target if spawning failed after
   // deletion. This preserves the existing same-SHA activation retry contract.
   const {app}=configuration(),file=join(evidence,'stopped-acceptance.config.json');
   try{if(lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile())fail('Unsafe stopped configuration');}catch(error){if(error.code!=='ENOENT')throw error;}
   writeFileSync(file,JSON.stringify({apps:[{...app,autostart:false}]})+'\n',{mode:0o600,flag:'w'});
   run(['startOrReload',file,'--only',name,'--update-env']);row=read();
  }
  if(!row||!allowed(row))fail('Cannot identify the failed Acceptance runtime');
  run(['stop',String(row.pm_id)]);
  const after=read();if(!stopped(after)||!allowed(after))fail('Acceptance runtime did not stop');
  return {status:'stopped',...persistStopped()};
 };
 if(mode==='pending'){
  try{const saved=JSON.parse(readFileSync(checkpoint,'utf8'));if(saved.phase==='verified')return {pending:false};}
  catch(error){if(error.code==='ENOENT')return {pending:false};throw error;}
  witness();const row=read();
  if(!row||row.pm2_env.status!=='online'||!canonical(row.pm2_env,sha))fail('Pending activation is not the expected online candidate');
  return {pending:true};
 }
 if(mode==='complete'){
  const saved=witness(),row=read();if(!row||row.pm2_env.status!=='online'||!canonical(row.pm2_env,sha))fail('Cannot complete another runtime activation');
  store({...saved,phase:'verified'});return {status:'activation-record-verified'};
 }
 if(mode==='recover'){
  if(read())fail('Recovery is limited to a missing Acceptance registration');
  const saved=witness();savedStopped();savedStopped(dump+'.bak');
  if(saved.dump!==digest(dump)||saved.backupDump!==digest(dump+'.bak'))fail('Stopped restart records changed since registration began');
  // halt only creates autostart:false and persists stopped state; it never
  // resurrects the old dump or runs a process before normal activation guards.
  return {...halt(),recoveredRegistration:true};
 }
 if(mode==='halt')return halt();
 const row=read();if(!row)fail('Acceptance API registration is missing');
 if(mode==='stop'){
  if(!['online','stopped'].includes(row.pm2_env.status))fail('Acceptance runtime cannot be stopped from this state');
  if(!canonical(row.pm2_env,previous)&&!(legacy(row.pm2_env)&&realpathSync(`${root}/current`)===release(previous)))fail('Acceptance old runtime path mismatch');
  run(['stop',String(row.pm_id)]);
  const after=read();if(!stopped(after)||signature(after)!==signature(row))fail('Acceptance stop identity changed');
  writeFileSync(recordFile,JSON.stringify({previous,signature:signature(after)})+'\n',{mode:0o600});
  // A stopped restart record is persisted before migration. Online candidate
  // persistence remains exclusively after the original local/public verifier.
  const persisted=persistStopped();
  if(persisted.saveError)fail('Acceptance stopped restart record could not be saved before migration');
  return {status:'stopped',...persisted};
 }
 if(!stopped(row)||!allowed(row))fail('Only a verified stopped Acceptance API may be re-registered');
 const {file}=configuration(),again=read();
 if(!stopped(again)||signature(again)!==signature(row))fail('Acceptance runtime changed before registration');
 const persisted=persistStopped();if(persisted.saveError)fail('Cannot checkpoint stopped Acceptance restart records');
 if(readFileSync(evidenceFile(evidence,'phase'),'utf8').trim()!=='runtime')fail('Activation registration phase is missing');
 store({version:1,sha,phase:'registering',evidence,manifest:digest(schemaFile),history:digest(evidenceFile(evidence,'activation-history.json')),identity:digest(evidenceFile(evidence,'live-acceptance-identity.json')),dump:digest(dump),backupDump:digest(dump+'.bak')});
 try{
  run(['delete',String(row.pm_id)]);
  if(read())fail('Acceptance registration was not removed');
  run(['startOrReload',file,'--only',name,'--update-env']);
  const fresh=read();
  if(!fresh||fresh.pm2_env.status!=='online'||!canonical(fresh.pm2_env,sha))fail('Acceptance immutable runtime did not start');
  return {status:'online',sha,cwd:fresh.pm2_env.pm_cwd,script:fresh.pm2_env.pm_exec_path};
 }catch(error){
  try{halt();}catch{throw Error(`${error.message}; Acceptance stopped persistence could not be verified`);}
  throw error;
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==6)fail('Usage: acceptance-pm2-activation.mjs ACTION SHA PREVIOUS EVIDENCE');
 const result=acceptancePm2(...process.argv.slice(2));process.stdout.write(JSON.stringify(result)+'\n');
 if(process.argv[2]==='pending'&&!result.pending)process.exitCode=10;
}
