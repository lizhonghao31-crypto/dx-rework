import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import type pg from 'pg';
import {mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.js';
import {assertTestDatabaseTarget} from '../../scripts/test-database-safety.mjs';

/** The real server entry point, not a test registerRoutes/buildApp variant. */
export async function normalFixtureApi(url:string,db:pg.Pool){
 await assertTestDatabaseTarget(url,db);
 const schema=(await db.query<{name:string}>('SELECT current_schema() AS name')).rows[0]?.name;
 if(!schema||!/^business_anchors_[0-9a-f]{32}$/.test(schema))throw Error('Normal TEST API requires the owned business-anchor schema');
 const databaseUrl=new URL(url);databaseUrl.searchParams.set('options',`-c search_path=${schema}`);
 const secret=randomBytes(32).toString('base64url');
 const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening');
 const address=socket.address();if(!address||typeof address==='string')throw Error('Normal TEST API requires a loopback port');
 await new Promise<void>((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));
 const origin=`http://127.0.0.1:${address.port}`;
 const processHandle=spawn(process.execPath,['--import','tsx','apps/api/src/server.ts'],{env:{
  PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(address.port),DATABASE_URL:databaseUrl.toString(),
  DINGTALK_CORP_ID:'anchor-test',DINGTALK_H5_APP_KEY:'TEST',DINGTALK_H5_APP_SECRET:'TEST',DINGTALK_WEB_CLIENT_ID:'TEST',DINGTALK_WEB_CLIENT_SECRET:'TEST',
  DINGTALK_QR_REDIRECT_URI:'https://example.test/callback',ROOT_DINGTALK_USER_ID:'uat-root',SESSION_SECRET:randomBytes(32).toString('base64url'),
  ACCEPTANCE_LAB_ENABLED:'true',ACCEPTANCE_LAB_SECRET:secret,DIGITAL_PRODUCTION_ENABLED:'true',DIGITAL_PRODUCTION_CREATION_ENABLED:'true',
  DIGITAL_WORKBENCH_NUMBERED_CREATION_ENABLED:'true',TODO_RUNTIME_ENABLED:'false',TODO_DELIVERY_ENABLED:'false',TODO_TIMING_ENABLED:'false',
 },stdio:['ignore','ignore','pipe']});
 let failure:Error|undefined;
 let stderr='';processHandle.stderr?.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-6000);});
 const exited=new Promise<void>(resolve=>{processHandle.once('error',error=>{failure=error;resolve();});processHandle.once('exit',()=>resolve());});
 const close=async()=>{
  if(!failure&&processHandle.exitCode===null&&processHandle.signalCode===null)processHandle.kill('SIGTERM');
  const timer=setTimeout(()=>processHandle.kill('SIGKILL'),5000);
  try{await exited;}finally{clearTimeout(timer);}
 };
 const request=(path:string,init?:RequestInit)=>fetch(origin+path,{...init,redirect:'manual',signal:AbortSignal.timeout(15000)});
 try{
  for(let attempt=0;attempt<200&&!failure&&processHandle.exitCode===null;attempt++){
   if(await fetch(origin+'/health/live',{signal:AbortSignal.timeout(500)}).then(r=>r.ok,()=>false))return {
    request,close,
    async login(alias:string){
     const response=await request('/auth/mobile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:mintAcceptanceLoginCode(alias,secret)})});
     const cookie=response.headers.getSetCookie().find(value=>value.startsWith('dx_rework_session='))?.split(';',1)[0];
     if(!response.ok||!cookie)throw Error(`Normal TEST API login failed (${response.status})`);
     return cookie.slice('dx_rework_session='.length);
    },
   };
   await delay(100);
  }
  throw Error(`Normal TEST API startup failed: ${failure?.message??stderr}`);
 }catch(error){await close();throw error;}
}
