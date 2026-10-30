import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync,mkdtempSync,mkdirSync,readFileSync,readlinkSync,renameSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {acceptancePm2} from '../../scripts/deploy/acceptance-pm2-activation.mjs';
import {currentCandidateAction} from '../../scripts/deploy/acceptance-update-policy.mjs';

const cli=process.env.PM2_TEST_CLI,evidence=process.env.PM2_TEST_EVIDENCE;
assert.ok(cli&&evidence,'Supply an already installed pinned PM2_TEST_CLI and private PM2_TEST_EVIDENCE directory');
assert.equal(process.versions.node.split('.')[0],'22');
assert.equal(JSON.parse(readFileSync(join(dirname(cli),'../package.json'),'utf8')).version,'6.0.14');
mkdirSync(evidence,{recursive:true,mode:0o700});
const root=mkdtempSync(join(resolve(evidence),'runtime-')),home=join(root,'pm2'),productionHome=join(root,'sentinel-pm2');
const name='dx-rework-acceptance-api',calls=[],results=[];
const env=pm2Home=>({HOME:root,USER:process.env.USER??'agent',PATH:dirname(process.execPath)+':/usr/bin:/bin',PM2_HOME:pm2Home,PM2_SILENT:'true',NO_COLOR:'1'});
const command=(pm2Home,args)=>{
 assert.ok(pm2Home.startsWith(root+'/'));
 calls.push({home:pm2Home===home?'acceptance':'sentinel',args});
 try{return execFileSync(process.execPath,[cli,...args],{env:env(pm2Home),encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});}
 catch(error){throw Error(`Real PM2 ${args[0]} failed with status ${error.status}`);}
};
const run=args=>command(home,args),list=()=>JSON.parse(run(['jlist'])),row=()=>list().find(r=>r.name===name);
const manifest=sha=>({gitSha:sha,appBasePath:'/acceptance/'});
function candidate(sha){
 const release=join(root,'releases',sha),script=join(release,'scripts/deploy/start-acceptance-api.sh');mkdirSync(dirname(script),{recursive:true});
 writeFileSync(script,`#!/usr/bin/env bash\nexec '${process.execPath}' -e 'setInterval(()=>{},1000)'\n`,{mode:0o700});
 writeFileSync(join(release,'release-manifest.json'),JSON.stringify(manifest(sha)));
 mkdirSync(join(release,'apps/api/src/platform'),{recursive:true});writeFileSync(join(release,'apps/api/src/platform/migration-manifest.json'),JSON.stringify({migrations:[{version:'fixture',checksum:'0'.repeat(64)}]}));
 const file=join(release,'infra/pm2/ecosystem.acceptance.config.cjs');mkdirSync(dirname(file),{recursive:true});
 const app={name,cwd:release,script,interpreter:'/usr/bin/bash',exec_mode:'fork',instances:1,kill_timeout:1000,env:{}};
 writeFileSync(file,'module.exports='+JSON.stringify({apps:[app]})+';');return {sha,release,script,file,app};
}
const old=candidate('a'.repeat(40)),next=candidate('b'.repeat(40)),third=candidate('c'.repeat(40)),fourth=candidate('d'.repeat(40));
const active=target=>{try{unlinkSync(join(root,'current'));}catch(error){if(error.code!=='ENOENT')throw error;}symlinkSync(target.release,join(root,'current'));};
const directory=(target,label)=>{const path=join(root,'logs',`update-${target.sha}-${label}`);mkdirSync(path,{recursive:true,mode:0o700});for(const file of ['initial-history.json','activation-history.json'])writeFileSync(join(path,file),JSON.stringify({migrations:[{version:'fixture',checksum:'0'.repeat(64)}]}));writeFileSync(join(path,'live-acceptance-identity.json'),JSON.stringify({database:'local-PM2-fixture',role:'fixture'}));writeFileSync(join(path,'phase'),'runtime\n');return path;};
const exact=target=>{const r=row();assert.equal(r.pm2_env.status,'online');assert.equal(r.pm2_env.pm_cwd,target.release);assert.equal(r.pm2_env.pm_exec_path,target.script);assert.equal(readlinkSync(`/proc/${r.pid}/cwd`),target.release);return r;};
const dump=()=>JSON.parse(readFileSync(join(home,'dump.pm2'),'utf8'));
const maintain=(mode,target,previous,path,transport=run)=>acceptancePm2(mode,target.sha,previous.sha,path,{root,home,run:transport});
let sentinelPid,complete=false;
try{
 command(productionHome,['start',old.script,'--name','production-sentinel','--interpreter','/usr/bin/bash']);
 sentinelPid=JSON.parse(command(productionHome,['jlist']))[0].pid;
 active(old);run(['startOrReload',old.file,'--only',name,'--update-env']);run(['save']);exact(old);
 const first=directory(next,'spawn-failure');maintain('stop',next,old,first);assert.equal(dump()[0].status,'stopped');assert.equal(JSON.parse(readFileSync(join(home,'dump.pm2.bak'),'utf8'))[0].status,'stopped');
 active(next);let failed=false;
 const failSpawn=args=>{
  if(!failed&&args[0]==='startOrReload'&&args[1]===next.file){failed=true;renameSync(next.script,next.script+'.fault');try{return run(args);}finally{renameSync(next.script+'.fault',next.script);}}
  return run(args);
 };
 assert.throws(()=>maintain('activate',next,old,first,failSpawn),/Real PM2 startOrReload failed/);
 assert.ok(failed);assert.equal(row().pm2_env.status,'stopped');assert.equal(dump()[0].status,'stopped');assert.equal(dump()[0].pm_cwd,next.release);
 results.push('spawn failure registers target without executing it and persists stopped state');
 const retry=directory(next,'same-sha-retry');maintain('activate',next,next,retry);exact(next);run(['save']);
 const before=calls.length;assert.equal(currentCandidateAction(next.sha,next.sha,true,'online'),'verify');assert.equal(calls.length,before);
 assert.throws(()=>maintain('activate',next,next,retry),/verified stopped/);exact(next);
 results.push('same-SHA activation retry succeeds; healthy planner no-op and online deletion refusal');

 const saving=directory(third,'save-failure');maintain('stop',third,next,saving);active(third);maintain('activate',third,next,saving);exact(third);
 chmodSync(join(home,'dump.pm2'),0o400);assert.throws(()=>run(['save']),/Real PM2 save failed/);
 const halted=maintain('halt',third,next,saving);assert.equal(halted.status,'stopped');assert.equal(halted.saved,'stopped');assert.equal(dump()[0].status,'stopped');assert.equal(dump()[0].pm_cwd,third.release);
 run(['kill']);run(['resurrect']);assert.equal(row().pm2_env.status,'stopped');assert.equal(row().pid??0,0);
 chmodSync(join(home,'dump.pm2'),0o600);maintain('activate',third,third,directory(third,'post-restart'));exact(third);run(['save']);
 run(['kill']);run(['resurrect']);exact(third);assert.equal(dump()[0].pm_cwd,third.release);
 results.push('actual save failure retains safe stopped dump; stopped and online daemon restarts plus same-SHA retry');

 run(['stop',String(row().pm_id)]);run(['delete',String(row().pm_id)]);
 const legacyFile=join(root,'legacy.config.cjs');writeFileSync(legacyFile,'module.exports='+JSON.stringify({apps:[{...third.app,cwd:join(root,'current'),script:join(root,'current/scripts/deploy/start-acceptance-api.sh')}]})+';');
 run(['startOrReload',legacyFile,'--only',name,'--update-env']);assert.equal(row().pm2_env.pm_cwd,join(root,'current'));
 const legacy=directory(fourth,'legacy');maintain('stop',fourth,third,legacy);active(fourth);maintain('activate',fourth,third,legacy);exact(fourth);run(['save']);
 results.push('stopped legacy current registration upgrades to canonical immutable target');

 run(['start',old.script,'--name','unrelated-local-app','--interpreter','/usr/bin/bash']);const extra=list().find(r=>r.name==='unrelated-local-app'),apiPid=row().pid;
 assert.throws(()=>maintain('stop',fourth,fourth,directory(fourth,'ambiguous')),/only its single API/);assert.equal(row().pid,apiPid);assert.equal(list().find(r=>r.name==='unrelated-local-app').pid,extra.pid);
 run(['delete',String(extra.pm_id)]);results.push('ambiguous PM2 home rejected without stopping either process');
 assert.equal(JSON.parse(command(productionHome,['jlist']))[0].pid,sentinelPid);
 complete=true;
}finally{
 for(const pm2Home of [home,productionHome]){
  try{for(const r of JSON.parse(command(pm2Home,['jlist'])))command(pm2Home,['delete',String(r.pm_id)]);assert.equal(JSON.parse(command(pm2Home,['jlist'])).length,0);command(pm2Home,['kill']);}catch(error){results.push('cleanup failed: '+error.message);complete=false;}
 }
 writeFileSync(join(evidence,'real-pm2-results.json'),JSON.stringify({complete,node:process.version,pm2:'6.0.14',results,calls,sentinelPid,limits:['Fresh local PM2 homes and fixture processes only; no ECS or public HTTP.','Online save follows fixture path verification; official full public verifier is separately exercised by controller tests.']},null,2));
 console.log(JSON.stringify({complete,passed:results.length,results}));
}
assert.equal(complete,true);
