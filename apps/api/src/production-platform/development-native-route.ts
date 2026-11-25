import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {CraftStepChoicesSchema,craftStepIdentity,type CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import type {DigitalTaskKind} from './task-access-repository.js';
import {FixedTimelineAdoptionRepository,type FixedTimelineInput} from './fixed-timeline-adoptions.js';
import {developmentRoutePositions} from './fixed-development-work.js';
import {fixedTimelineIdentity} from './fixed-timeline-identity.js';

type DB=Pick<PoolClient,'query'>;
type NativeInput=Pick<FixedTimelineInput,'route'|'craftSteps'|'sourceVersions'>&{executionOnly?:'workbench-preorder-route-v1'};
type DeferredInput=NativeInput&{executionOnly:'workbench-preorder-route-v1';resource:{kind:'source';id:string};round:number;timelineSchemaVersion:2;routeSchemaVersion:2};
export async function deferredDevelopmentRoute(db:DB,sourceId:string,round=1){
 if(!await new FixedTimelineAdoptionRepository(db).available())return null;
 const row=(await db.query<{adoption_id:string;identity_hash:string;input_snapshot:DeferredInput}>(`SELECT adoption_id,identity_hash,input_snapshot
  FROM digital_timeline_adoptions WHERE resource_kind='source' AND source_id=$1 AND round_number=$2
  AND input_snapshot->>'executionOnly'='workbench-preorder-route-v1'`,[sourceId,round])).rows[0];
 if(!row)return null;
 if(row.input_snapshot.resource.id!==sourceId||row.input_snapshot.round!==round||fixedTimelineIdentity(row.input_snapshot)!==row.identity_hash)
  throw Error('原预下单开发路线与实际身份不一致');
 return {adoptionId:row.adoption_id,input:row.input_snapshot};
}
export async function developmentNativeRoute(db:DB,sourceId:string,round:number):Promise<{adoptionId:string;input:NativeInput}|null>{
 return await new FixedTimelineAdoptionRepository(db).existing({kind:'source',id:sourceId},round)??await deferredDevelopmentRoute(db,sourceId,round);
}
/** Physical positions use the original task/step FKs. This subrecord has no
 * supervision, targets, deadline rule, company settings or adoption inputs. */
export async function captureDeferredDevelopmentRoute(db:PoolClient,actorId:string,sourceId:string,round:number,routeRef:string,
 routeKinds:readonly DigitalTaskKind[],document:DevelopmentDocument,documentVersion:number,eventId:string,time:BusinessTime){
 const choices:CraftStepChoice[]=document.craft==='无'?[]:CraftStepChoicesSchema.parse(document.craftSteps??[{craftKind:document.craft==='绣花'?'embroidery':'printing',sequence:1}]);
 const craftSteps=choices.filter(choice=>routeKinds.includes(choice.craftKind==='embroidery'?'development_embroidery':'development_printing'))
  .map((choice,index)=>({...choice,sequence:index+1,stepId:randomUUID()}));
 const input:DeferredInput={executionOnly:'workbench-preorder-route-v1',resource:{kind:'source',id:sourceId},round,timelineSchemaVersion:2,routeSchemaVersion:2,
  sourceVersions:{routeRef,documentVersion},route:developmentRoutePositions(routeKinds,craftSteps),craftSteps};
 const recordId=randomUUID(),identity=fixedTimelineIdentity(input),eventRef=`audit_events:${eventId}`;
 await db.query(`INSERT INTO digital_timeline_adoptions(adoption_id,resource_kind,source_id,round_number,input_snapshot,identity_hash,creation_event_ref,business_time,created_by)
  VALUES($1,'source',$2,$3,$4,$5,$6,$7,$8)`,[recordId,sourceId,round,JSON.stringify(input),identity,eventRef,JSON.stringify(time),actorId]);
 for(const choice of craftSteps){
  const scope=`source:${sourceId}:round:${round}:route:${routeRef}:craft:${craftStepIdentity(choice)}`;
  await db.query(`INSERT INTO digital_timeline_craft_steps(step_id,adoption_id,resource_kind,source_id,route_ref,round_number,craft_kind,sequence,scope_ref,canonical_work_ref,adopted_version,source_event_ref,created_by,special_craft)
   VALUES($1,$2,'source',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[choice.stepId,recordId,sourceId,routeRef,round,choice.craftKind,choice.sequence,scope,
   `source:${sourceId}:round:${round}:step:${choice.stepId}:work`,identity,eventRef,actorId,choice.specialCraft?JSON.stringify(choice.specialCraft):null]);
 }
}
