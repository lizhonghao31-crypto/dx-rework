import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readlinkSync,renameSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {acceptancePm2} from '../../scripts/deploy/acceptance-pm2-activation.mjs';
import {currentCandidateAction,mayRecoverOldRuntime} from '../../scripts/deploy/acceptance-update-policy.mjs';
import {applyMigrations,discoverValidatedMigrations} from '../../scripts/migration-lib.mjs';
import {migrationExecutionSql} from '../../scripts/deploy/migration-execution-compatibility.mjs';
import {assertTestDatabaseTarget} from '../../scripts/test-database-safety.mjs';

const self=fileURLToPath(import.meta.url),name='dx-rework-acceptance-api',hotfix='0231_temporary_special_process_proxy_reporting';
const catalog=await discoverValidatedMigrations();
const json=file=>JSON.parse(readFileSync(file,'utf8'));
const history=db=>db.query('SELECT version,checksum,applied_at::text FROM schema_migrations ORDER BY version').then(r=>r.rows);
const env=(s,home=s.home)=>({HOME:s.root,USER:process.env.USER??'agent',PATH:dirname(process.execPath)+':/usr/bin:/bin',PM2_HOME:home,PM2_SILENT:'true',NO_COLOR:'1'});
function command(s,args,home=s.home){
 assert.ok(home.startsWith(s.root+'/'));
 writeFileSync(s.trace,JSON.stringify({kind:'pm2',home:home===s.home?'acceptance':'sentinel',args})+'\n',{flag:'a'});
 try{return execFileSync(process.execPath,[s.cli,...args],{env:env(s,home),encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});}
 catch(error){throw Error(`Real PM2 ${args[0]} failed (${error.status})`);}
}
const processes=s=>JSON.parse(command(s,['jlist']));
const api=s=>{const rows=processes(s);assert.equal(rows.length,1);assert.equal(rows[0].name,name);return rows[0];};
const record=(s,action)=>writeFileSync(s.trace,JSON.stringify({kind:'phase',action})+'\n',{flag:'a'});
function candidate(s,sha){
 const release=join(s.root,'releases',sha),script=join(release,'scripts/deploy/start-acceptance-api.sh');mkdirSync(dirname(script),{recursive:true});
 writeFileSync(script,`#!/usr/bin/env bash\nexec '${process.execPath}' -e 'setInterval(()=>{},1000)'\n`,{mode:0o700});
 writeFileSync(join(release,'release-manifest.json'),JSON.stringify({gitSha:sha,appBasePath:'/acceptance/'}));
 mkdirSync(join(release,'apps/api/src/platform'),{recursive:true});writeFileSync(join(release,'apps/api/src/platform/migration-manifest.json'),JSON.stringify({migrations:catalog.map(({version,checksum})=>({version,checksum}))}));
 const file=join(release,'infra/pm2/ecosystem.acceptance.config.cjs');mkdirSync(dirname(file),{recursive:true});
 writeFileSync(file,'module.exports='+JSON.stringify({apps:[{name,cwd:release,script,interpreter:'/usr/bin/bash',exec_mode:'fork',instances:1,kill_timeout:1000,env:{}}]})+';');return {sha,release,script,file};
}
function active(s,c){try{unlinkSync(join(s.root,'current'));}catch(error){if(error.code!=='ENOENT')throw error;}symlinkSync(c.release,join(s.root,'current'));}
function verify(s,c){const row=api(s);assert.equal(row.pm2_env.status,'online');assert.equal(row.pm2_env.pm_cwd,c.release);assert.equal(row.pm2_env.pm_exec_path,c.script);assert.equal(readlinkSync(`/proc/${row.pid}/cwd`),c.release);}
const maintain=(s,mode,run=args=>command(s,args))=>acceptancePm2(mode,s.target.sha,s.previous.sha,s.evidence,{root:s.root,home:s.home,run});

async function phase(stateFile,action){
 const s=json(stateFile);await assertTestDatabaseTarget(s.url);const db=new pg.Client({connectionString:s.url});await db.connect();
 let code=0;record(s,action);
 try{
  if(action==='worker:prepare'){
   s.current=readlinkSync(join(s.root,'current'))===s.target.release?s.target:s.current;s.previous=s.current;
   s.evidence=join(s.root,'logs',`update-${s.target.sha}-${randomUUID()}`);mkdirSync(s.evidence,{recursive:true,mode:0o700});
   const rows=await history(db);s.before=rows;
   writeFileSync(join(s.evidence,'initial-history.json'),JSON.stringify({migrations:rows.map(({version,checksum})=>({version,checksum}))}));
   const identity=(await db.query("SELECT json_build_object('database',current_database(),'port',current_setting('port')::integer,'oid',(SELECT oid::bigint FROM pg_database WHERE datname=current_database()),'address',inet_server_addr(),'role',current_user,'sessionRole',session_user) AS identity")).rows[0].identity;
   writeFileSync(join(s.evidence,'live-acceptance-identity.json'),JSON.stringify(identity));
   const current=rows.length===catalog.length&&catalog.every(m=>rows.some(r=>r.version===m.version&&r.checksum===m.checksum));
   if(processes(s).length===0){assert.equal(s.current.sha,s.target.sha);assert.ok(current);maintain(s,'recover');}
   s.initialStatus=api(s).pm2_env.status;
   const next=currentCandidateAction(s.current.sha,s.target.sha,current,s.initialStatus);
   if(next==='verify'){verify(s,s.target);const saved=json(join(s.home,'dump.pm2'))[0];assert.equal(saved.status,'online');assert.equal(saved.pm_cwd,s.target.release);code=10;}
   if(next==='activate')code=11;
  }else if(action==='worker:backup'){
   const uri=new URL(s.url),backup=execFileSync('docker',['exec',s.container,'pg_dump','--username',decodeURIComponent(uri.username),'--dbname',uri.pathname.slice(1),'--schema',s.schema,'--format=custom'],{timeout:30000,maxBuffer:8*1024*1024});
   assert.ok(backup.subarray(0,5).equals(Buffer.from('PGDMP')));writeFileSync(join(s.evidence,'database.dump'),backup,{mode:0o600});
  }else if(action==='worker:stop')maintain(s,'stop');
  else if(action==='maintenance:preflight')assert.ok((await history(db)).every(r=>catalog.some(m=>m.version===r.version&&m.checksum===r.checksum)));
  else if(action==='maintenance:apply')await applyMigrations(s.url);
  else if(action==='worker:recover'){
   const after=await history(db);assert.ok(mayRecoverOldRuntime(s.initialStatus,{migrations:s.before},{migrations:after}));
   command(s,['startOrReload',s.previous.file,'--only',name,'--update-env']);verify(s,s.previous);command(s,['save']);
  }else if(action==='worker:halt')maintain(s,'halt');
  else if(action==='worker:activate'){
   assert.equal((await history(db)).length,catalog.length);assert.equal(api(s).pm2_env.status,'stopped');active(s,s.target);s.current=s.target;
   writeFileSync(join(s.evidence,'activation-history.json'),JSON.stringify({migrations:(await history(db)).map(({version,checksum})=>({version,checksum}))}));writeFileSync(join(s.evidence,'phase'),'runtime\n');
   const transport=args=>{
    if(s.failStart&&args[0]==='startOrReload'&&args[1]===s.target.file){s.failStart=false;renameSync(s.target.script,s.target.script+'.fault');try{return command(s,args);}finally{renameSync(s.target.script+'.fault',s.target.script);}}
    const result=command(s,args);
    if(s.killAfterDelete&&args[0]==='delete'){
     s.killAfterDelete=false;writeFileSync(stateFile,JSON.stringify(s),{mode:0o600});
     const group=Number(process.env.PM2_TEST_FLOW_GROUP);assert.equal(group,process.ppid);assert.ok(group>1);process.kill(-group,'SIGKILL');
    }
    return result;
   };
   maintain(s,'activate',transport);verify(s,s.target);command(s,['save']);
   const saved=json(join(s.home,'dump.pm2'))[0];assert.equal(saved.status,'online');assert.equal(saved.pm_cwd,s.target.release);
   maintain(s,'complete');writeFileSync(join(s.evidence,'phase'),'verified\n');
  }else throw Error('Unknown test flow phase');
 }finally{await db.end();writeFileSync(stateFile,JSON.stringify(s),{mode:0o600});}
 return code;
}

if(process.argv[2]==='phase'){
 try{process.exitCode=await phase(process.argv[3],process.argv[4]);}
 catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}else{
 const cli=process.env.PM2_TEST_CLI,targets=process.env.PM2_TEST_DATABASE_TARGETS,out=process.env.PM2_TEST_EVIDENCE;
 assert.ok(cli&&targets&&out,'Supply pinned PM2_TEST_CLI, private local database targets, and PM2_TEST_EVIDENCE');assert.equal(process.versions.node.split('.')[0],'22');
 assert.equal(json(join(dirname(cli),'../package.json')).version,'6.0.14');mkdirSync(out,{recursive:true,mode:0o700});
 const results=[];
 for(const target of json(targets)){
  await assertTestDatabaseTarget(target.url);assert.match(target.container,/^[a-zA-Z0-9_-]+$/);
  const schema='pm2_flow_'+randomUUID().replaceAll('-',''),uri=new URL(target.url);uri.searchParams.set('options',`-c search_path=${schema}`);
  const root=mkdtempSync(join(resolve(out),`pg${target.major}-`)),s={root,home:join(root,'pm2'),sentinelHome:join(root,'sentinel-pm2'),cli,url:uri.toString(),schema,container:target.container,trace:join(root,'trace.jsonl')};
  const state=join(root,'state.private.json'),admin=new pg.Client({connectionString:target.url});await admin.connect();let db,failure,passed;
  const flow=()=>spawnSync('bash',['-c',`set -euo pipefail\nsource "$1/scripts/deploy/acceptance-update-flow.sh"\nnode_bin="$2";driver="$3";state="$4"\nexport PM2_TEST_FLOW_GROUP=$$\nworker(){ "$node_bin" "$driver" phase "$state" "worker:$1"; }\nmaintenance(){ "$node_bin" "$driver" phase "$state" "maintenance:$1"; }\nacceptance_update_flow`,'test',process.cwd(),process.execPath,self,state],{env:{...process.env,NODE_ENV:'test'},detached:true,encoding:'utf8',timeout:120000});
  const readPhases=()=>readFileSync(s.trace,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.kind==='phase').map(r=>r.action);
  try{
   await admin.query(`CREATE SCHEMA ${schema}`);db=new pg.Client({connectionString:s.url});await db.connect();
   const version=(await db.query('SHOW server_version')).rows[0].server_version,number=Number((await db.query('SHOW server_version_num')).rows[0].server_version_num);
   await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
   for(const m of catalog.filter(m=>m.version!==hotfix)){await db.query('BEGIN');await db.query(migrationExecutionSql(m,number));await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[m.version,m.checksum]);await db.query('COMMIT');}
   assert.equal((await history(db)).length,278);const user=randomUUID();await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST PM2 retained fixture',true)",[user]);
   const original=await history(db);s.current=candidate(s,'a'.repeat(40));s.target=candidate(s,'b'.repeat(40));s.evidence=join(root,'logs',`update-${s.target.sha}-phase-test`);mkdirSync(s.evidence,{recursive:true,mode:0o700});active(s,s.current);
   command(s,['start',s.current.script,'--name','production-sentinel','--interpreter','/usr/bin/bash'],s.sentinelHome);const sentinel=JSON.parse(command(s,['jlist'],s.sentinelHome))[0].pid;
   command(s,['startOrReload',s.current.file,'--only',name,'--update-env']);command(s,['save']);writeFileSync(state,JSON.stringify(s),{mode:0o600});
   const interruption=process.env.PM2_TEST_INTERRUPTION_ONLY==='1';let r;
   if(!interruption){
    await db.query(`CREATE FUNCTION test_reject_hotfix() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version='${hotfix}' THEN RAISE EXCEPTION 'TEST transaction rollback'; END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER test_reject_hotfix BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION test_reject_hotfix()');
    r=flow();writeFileSync(join(root,'migration-failure.log'),r.stdout+'\n'+r.stderr);assert.notEqual(r.status,0);assert.deepEqual(await history(db),original);verify(s,s.current);assert.ok(readPhases().includes('worker:recover'));
    await db.query('DROP TRIGGER test_reject_hotfix ON schema_migrations');await db.query('DROP FUNCTION test_reject_hotfix()');
   }
   s.failStart=!interruption;s.killAfterDelete=interruption;writeFileSync(state,JSON.stringify(s),{mode:0o600});const offset=readPhases().length;
   r=flow();writeFileSync(join(root,interruption?'hard-kill.log':'spawn-failure.log'),String(r.stdout)+'\n'+String(r.stderr));assert.notEqual(r.status,0);assert.equal((await history(db)).length,279);
   const upgrade=readPhases().slice(offset),expectedUpgrade=['worker:prepare','maintenance:preflight','worker:backup','worker:stop','maintenance:apply','worker:activate'];
   if(!interruption)expectedUpgrade.push('worker:halt');assert.deepEqual(upgrade,expectedUpgrade);
   if(interruption){
    assert.equal(r.signal,'SIGKILL');assert.deepEqual(processes(s),[]);
    const marker=join(s.root,'shared/update-checkpoints',s.target.sha+'.pm2.json'),originalMarker=readFileSync(marker);
    const rejection=label=>{const before=readPhases().length,result=flow();writeFileSync(join(root,label+'.log'),String(result.stdout)+'\n'+String(result.stderr));assert.notEqual(result.status,0);assert.deepEqual(processes(s),[]);assert.deepEqual(readPhases().slice(before),['worker:prepare']);};
    unlinkSync(marker);rejection('no-witness');writeFileSync(marker,originalMarker,{mode:0o600});
    const wrong=json(marker);wrong.sha=s.current.sha;writeFileSync(marker,JSON.stringify(wrong));rejection('wrong-witness-sha');writeFileSync(marker,originalMarker);
    for(const file of ['dump.pm2','dump.pm2.bak']){const path=join(s.home,file),saved=readFileSync(path),wrongDump=json(path);wrongDump[0].status='online';writeFileSync(path,JSON.stringify(wrongDump));rejection('wrong-'+file);writeFileSync(path,saved);}
    const hotfixReceipt=(await history(db)).find(x=>x.version===hotfix);await db.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2',['c'.repeat(64),hotfix]);rejection('changed-schema');await db.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2',[hotfixReceipt.checksum,hotfix]);
    assert.deepEqual(readFileSync(marker),originalMarker);
   }else assert.equal(api(s).pm2_env.status,'stopped');
   assert.equal(json(join(s.home,'dump.pm2'))[0].status,'stopped');assert.equal(json(join(s.home,'dump.pm2.bak'))[0].status,'stopped');
   const beforeRetry=await history(db),retryOffset=readPhases().length;r=flow();assert.equal(r.status,0,r.stderr);verify(s,s.target);assert.deepEqual(await history(db),beforeRetry);assert.deepEqual(readPhases().slice(retryOffset),['worker:prepare','worker:activate']);
   const healthyOffset=readPhases().length;r=flow();assert.equal(r.status,0,r.stderr);assert.deepEqual(readPhases().slice(healthyOffset),['worker:prepare']);
   for(const old of original)assert.deepEqual((await history(db)).find(x=>x.version===old.version),old);
   assert.equal((await db.query('SELECT display_name FROM app_users WHERE id=$1',[user])).rows[0].display_name,'TEST PM2 retained fixture');assert.equal(JSON.parse(command(s,['jlist'],s.sentinelHome))[0].pid,sentinel);
   passed={version,node:process.version,pm2:'6.0.14',mainFixtureCount:278,finalCount:279,mode:interruption?'hard-kill-delta':'migration-and-spawn-failure',migrationFailureRollback:!interruption,backupBeforeStopAndMigration:true,spawnFailureStopped:!interruption,hardKillAfterActualDelete:interruption,missingWitnessOrWrongShaOrBothDumpMismatchesOrChangedSchemaRejected:interruption,sameShaRetryNoMigrationOrBackup:true,healthyNoop:true,oldHistoryAndTestRowUnchanged:true,sentinelPidUnchanged:true};
  }catch(error){failure=error;}
  const cleanupErrors=[];
  try{if(db)await db.end();}catch(error){cleanupErrors.push(error);}
  try{await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}catch(error){cleanupErrors.push(error);}
  try{await admin.end();}catch(error){cleanupErrors.push(error);}
  for(const home of [s.home,s.sentinelHome]){
   try{for(const p of JSON.parse(command(s,['jlist'],home)))command(s,['delete',String(p.pm_id)],home);assert.equal(JSON.parse(command(s,['jlist'],home)).length,0);command(s,['kill'],home);}
   catch(error){cleanupErrors.push(error);}
  }
  if(!failure&&!cleanupErrors.length)results.push(passed);
  writeFileSync(join(out,'postgres-pm2-results.json'),JSON.stringify({results,cleanupErrors:cleanupErrors.map(e=>e.message),limits:['Original acceptance_update_flow; actual isolated PostgreSQL SQL/rollback/pg_dump and real PM2; phase adapters replace root/HTTP/build boundaries.','The complete real controller/worker is additionally exercised by its separate offline chain fixture. No ECS, real business data or public TLS.']},null,2));
  if(failure||cleanupErrors.length)throw new AggregateError([...(failure?[failure]:[]),...cleanupErrors],'PostgreSQL/PM2 fixture or cleanup failed');
 }
 console.log(JSON.stringify({passed:results.length,results}));
}
