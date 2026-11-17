import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {assertTestDatabaseTarget} from '../test-database-safety.mjs';
import {OrderTimeScopeRecoveryService} from '../../apps/api/src/production-platform/order-time-scope-recovery.js';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';

// This is an isolated maintenance entry, not a production application command.
// It never loads a shared .env, changes actors, or rebuilds an absent plan.
let database:pg.Pool|undefined;
try{
 const {values}=parseArgs({options:{'request-id':{type:'string'},'root-user':{type:'string'},'corporation-id':{type:'string'},apply:{type:'boolean',default:false},fingerprint:{type:'string'},key:{type:'string'},'reason-file':{type:'string'}}});
 if(!values['request-id']||!values['root-user']||!values['corporation-id'])throw Error('Provide --request-id, --root-user and --corporation-id; preview is the default');
 const databaseUrl=process.env.TEST_DATABASE_URL;
 if(!databaseUrl)throw Error('An explicitly marked isolated TEST_DATABASE_URL is required');
 await assertTestDatabaseTarget(databaseUrl);
 database=new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:3000,max:2,application_name:'dx_order_time_scope_recovery'});
 const actor:TrustedActorContext={actorId:values['root-user'],actorRoles:['root_superuser'],authorizationCapabilities:['digital_production:view'],requestId:randomUUID()};
 const service=new OrderTimeScopeRecoveryService(database,new RootAuthority(database,values['corporation-id'],undefined));
 if(!values.apply)console.log(JSON.stringify(await service.preview(actor,values['request-id'])));
 else{
  if(!values.fingerprint||!values.key||!values['reason-file'])throw Error('Apply requires the original preview --fingerprint, explicit maintenance --key and --reason-file');
  const reason=(await readFile(values['reason-file'],'utf8')).trim();
  console.log(JSON.stringify(await service.recover(actor,{requestId:values['request-id'],fingerprint:values.fingerprint,reason},values.key)));
 }
}catch(error){
 const safe=error instanceof ApplicationError?{code:error.code,message:error.message}:{code:'RECOVERY_NOT_CONFIRMED',message:'Maintenance result not confirmed; preserve the maintenance key and inspect its receipt before any repeat'};
 console.error(JSON.stringify(safe));process.exitCode=1;
}finally{await database?.end();}
