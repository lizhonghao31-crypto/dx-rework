import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync,existsSync,lstatSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const startTicks=pid=>{try{return readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[19];}catch{return null;}};
const activeGroup=group=>execFileSync('ps',['-eo','pgid=,stat='],{encoding:'utf8'}).trim().split('\n').some(line=>{const[g,state]=line.trim().split(/\s+/);return Number(g)===group&&!state.startsWith('Z');});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export function ownedInterruptionGuard(){
 let interrupted=false;const mark=()=>{interrupted=true;};process.on('SIGINT',mark);process.on('SIGTERM',mark);
 return {assertActive(){if(interrupted)throw Error('OWNED_TASK_INTERRUPTED');},close(){process.removeListener('SIGINT',mark);process.removeListener('SIGTERM',mark);}};
}
function signalGroup(pid,signal){try{process.kill(-pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}}
export async function runOwnedCommand(command,args,{env=process.env,stateFile,stdio='inherit'}={}){
 if(process.platform!=='linux')throw Error('OWNED_PROCESS_GROUP_REQUIRES_LINUX');
 if(stateFile&&existsSync(stateFile)&&(lstatSync(stateFile).isSymbolicLink()||!lstatSync(stateFile).isFile()||lstatSync(stateFile).uid!==process.getuid()))throw Error('OWNED_COMMAND_STATE_REJECTED');
 const child=spawn(command,args,{env,stdio,detached:true});let interrupted=false,spawnError;
 const state={version:1,controllerPid:process.pid,controllerStarted:startTicks(process.pid),childPid:child.pid,group:child.pid,status:'running'};
 const save=()=>{if(stateFile){if(existsSync(stateFile)&&lstatSync(stateFile).isSymbolicLink())throw Error('OWNED_COMMAND_STATE_REJECTED');const tmp=stateFile+'.tmp-'+process.pid;writeFileSync(tmp,JSON.stringify(state)+'\n',{mode:0o600,flag:'wx'});renameSync(tmp,stateFile);}};
 const forward=signal=>{interrupted=true;if(child.pid)signalGroup(child.pid,signal);};
 const onInt=()=>forward('SIGINT'),onTerm=()=>forward('SIGTERM');process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
 let code,signal;
 const completion=new Promise(resolve=>{child.once('error',error=>{spawnError=error;resolve({code:1,signal:null});});child.once('close',(code,signal)=>resolve({code,signal}));});
 try{
  save();({code,signal}=await completion);
  let orphaned=false;
  if(child.pid&&activeGroup(child.pid)){
   orphaned=!interrupted;
   signalGroup(child.pid,'SIGTERM');for(let i=0;i<10&&activeGroup(child.pid);i++)await pause(100);
   if(activeGroup(child.pid)){signalGroup(child.pid,'SIGKILL');for(let i=0;i<10&&activeGroup(child.pid);i++)await pause(100);}
   if(activeGroup(child.pid)){const e=Error('OWNED_COMMAND_CHILDREN_STILL_RUNNING');e.unsafeToCleanup=true;throw e;}
  }
  Object.assign(state,{status:'children_exited',code:interrupted||signal?130:orphaned?1:code??1,signal,interrupted,orphaned,allExited:true});save();
  if(spawnError)throw spawnError;
  return {...state};
 }catch(error){
  if(child.pid&&activeGroup(child.pid)){signalGroup(child.pid,'SIGKILL');for(let i=0;i<10&&activeGroup(child.pid);i++)await pause(100);if(activeGroup(child.pid))error.unsafeToCleanup=true;}
  Object.assign(state,{status:'failed',allExited:!error.unsafeToCleanup,error:error.code??error.message});try{save();}catch{console.error('OWNED_COMMAND_STATE_WRITE_FAILED');}throw error;
 }
 finally{process.removeListener('SIGINT',onInt);process.removeListener('SIGTERM',onTerm);}
}
export function stopOwnedCommand(stateFile){
 if(!existsSync(stateFile)||lstatSync(stateFile).isSymbolicLink()||lstatSync(stateFile).uid!==process.getuid())throw Error('OWNED_COMMAND_STATE_REJECTED');
 const s=JSON.parse(readFileSync(stateFile,'utf8'));
 if(s.version!==1||!Number.isSafeInteger(s.controllerPid)||!s.controllerStarted)throw Error('OWNED_COMMAND_STATE_REJECTED');
 const actual=startTicks(s.controllerPid);if(actual===null){if(s.allExited!==true)throw Error('OWNED_COMMAND_EXIT_NOT_VERIFIED');return{state:'controller_exited',signalled:false,childrenVerified:true};}
 if(actual!==s.controllerStarted)throw Error('OWNED_COMMAND_CONTROLLER_CHANGED');
 if(!['running','children_exited'].includes(s.status))return{state:s.status,signalled:false};
 process.kill(s.controllerPid,'SIGINT');return {controller:s.controllerPid,signalled:true};
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){if(process.argv[2]!=='stop')throw Error('Expected stop <owned-state-file>');console.log(JSON.stringify(stopOwnedCommand(process.argv[3])));}
