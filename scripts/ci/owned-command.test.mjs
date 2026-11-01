import assert from 'node:assert/strict';import{test}from'node:test';import{spawn}from'node:child_process';import{mkdtempSync,readFileSync,rmSync,existsSync,writeFileSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{runOwnedCommand,stopOwnedCommand,ownedInterruptionGuard}from'../owned-command.mjs';
test('a failing command returns actual nonzero and closes its process group',async()=>{const r=await runOwnedCommand(process.execPath,['-e','process.exit(7)'],{stdio:'ignore'});assert.equal(r.code,7);assert.equal(r.allExited,true);});
test('stopping by owned state interrupts supervisor and grandchildren, without process-name guessing',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dx-stop-')),file=join(dir,'state.json');
 const url=new URL('../owned-command.mjs',import.meta.url).href;
 const grand=`setInterval(()=>{},1000)`;
 const worker=`import{spawn}from'node:child_process';spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
 const supervisor=`import{runOwnedCommand}from ${JSON.stringify(url)};const r=await runOwnedCommand(process.execPath,['--input-type=module','-e',${JSON.stringify(worker)}],{stateFile:${JSON.stringify(file)},stdio:'ignore'});process.exitCode=r.code;`;
 const child=spawn(process.execPath,['--input-type=module','-e',supervisor],{stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',v=>errors+=v);
 const done=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 try{
  for(let i=0;i<50&&!existsSync(file);i++)await new Promise(r=>setTimeout(r,20));assert.ok(existsSync(file));await new Promise(r=>setTimeout(r,100));
  assert.equal(stopOwnedCommand(file).signalled,true);const result=await done;assert.equal(result.code,130,errors);
  const state=JSON.parse(readFileSync(file,'utf8'));assert.equal(state.allExited,true);assert.equal(state.interrupted,true);assert.equal(stopOwnedCommand(file).signalled,false);
 }finally{if(child.exitCode===null)child.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
});
test('stale controller identity is rejected rather than killing a reused PID',()=>{const dir=mkdtempSync(join(tmpdir(),'dx-stale-stop-')),file=join(dir,'state.json');try{writeFileSync(file,JSON.stringify({version:1,status:'running',controllerPid:process.pid,controllerStarted:'wrong-start-ticks'}));assert.throws(()=>stopOwnedCommand(file),/CONTROLLER_CHANGED/);}finally{rmSync(dir,{recursive:true,force:true});}});
test('a surviving grandchild prevents a zero exit from being reported as success',async()=>{
 const worker="require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref()";
 const r=await runOwnedCommand(process.execPath,['-e',worker],{stdio:'ignore'});assert.equal(r.orphaned,true);assert.equal(r.code,1);assert.equal(r.allExited,true);
});
test('an interrupt between commands remains active and forbids the next suite',()=>{
 const guard=ownedInterruptionGuard();try{guard.assertActive();process.emit('SIGINT');assert.throws(()=>guard.assertActive(),/OWNED_TASK_INTERRUPTED/);}finally{guard.close();}
});
test('a missing controller is not proof that its descendants stopped',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dx-unverified-stop-')),file=join(dir,'state.json');try{writeFileSync(file,JSON.stringify({version:1,status:'running',controllerPid:2147483647,controllerStarted:'1',allExited:false}));assert.throws(()=>stopOwnedCommand(file),/EXIT_NOT_VERIFIED/);}finally{rmSync(dir,{recursive:true,force:true});}
});
