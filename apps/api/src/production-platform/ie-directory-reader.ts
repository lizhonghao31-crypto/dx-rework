import type {Pool,PoolClient} from 'pg';
import {ApplicationError} from '../platform/errors.js';
import {isReworkWorkflowAuthorityDenial,reworkIeCandidates} from '../reporting/management-reporting-service.js';
import {sourcingIeCandidates} from '../sourcing/sourcing-ie-directory.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {readAuthorizedIeDirectoryPage,type IeAuthorizedCandidates,type IeDirectoryPageInput} from './ie-authorized-directory.js';
import {ieProcessingViewer,processingIeCandidates} from './ie-processing-directory.js';
import {developmentRushKey,readDevelopmentOrderRush} from './development-order-rush.js';

export type IntegratedIeActors=Readonly<{processing:TrustedActorContext;sourcing:TrustedActorContext|null;rework:TrustedActorContext|null}>;

async function reworkInScope(db:PoolClient,actor:TrustedActorContext){
 await db.query('SAVEPOINT ie_directory_rework');
 try{return await reworkIeCandidates(db,actor);}
 catch(error){
  if(!isReworkWorkflowAuthorityDenial(error))throw error;
  await db.query('ROLLBACK TO SAVEPOINT ie_directory_rework');
  return undefined;
 }
}

/** The eventual server route must resolve each domain actor through its existing authorization path. */
export async function readIntegratedIeDirectory(database:Pool,actors:IntegratedIeActors,input:IeDirectoryPageInput){
 if((actors.sourcing&&actors.sourcing.actorId!==actors.processing.actorId)||(actors.rework&&actors.rework.actorId!==actors.processing.actorId))
  throw new Error('IE directory actors must refer to one authenticated identity');
 const db=await database.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const allowed:IeAuthorizedCandidates={};
  if(input.kind==='all'||input.kind==='processing_quote'){
   const viewer=await ieProcessingViewer(db,actors.processing);
   if(viewer)allowed.processing_quote=await processingIeCandidates(db,database,viewer);
  }
  if(actors.sourcing&&(input.kind==='all'||input.kind==='sourcing_review')){
   const sourcing=sourcingIeCandidates(actors.sourcing);
   if(sourcing)allowed.sourcing_review=sourcing;
  }
  if(actors.rework&&(input.kind==='all'||input.kind==='rework_review')){
   const rework=await reworkInScope(db,actors.rework);
   await db.query('RELEASE SAVEPOINT ie_directory_rework');
   if(rework)allowed.rework_review=rework;
  }
  if(!Object.keys(allowed).length)throw new ApplicationError('FORBIDDEN','当前账号没有可查看的 IE 核价范围',403);
  const result=await readAuthorizedIeDirectoryPage(db,input,allowed);
  const identity=(item:(typeof result.items)[number])=>item.orderId===null?{sourceId:item.resourceId,orderId:null}:{sourceId:null,orderId:item.resourceId};
  const rush=await readDevelopmentOrderRush(db,result.items.filter(item=>item.kind==='processing_quote').map(identity));
  const items=result.items.map(item=>item.kind==='processing_quote'&&rush.has(developmentRushKey(identity(item))??'')?{...item,orderRush:true as const}:item);
  await db.query('COMMIT');
  return {...result,items};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
