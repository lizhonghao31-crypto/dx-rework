import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import {validateBusinessTime} from '@dx-rework/domain/business-clock';
import type {InstructionDocument} from '@dx-rework/contracts/production-instruction';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import {CraftStepChoicesSchema} from '@dx-rework/contracts/digital-craft';
import type {FixedTimelineAdoption,FixedTimelineInput} from './fixed-timeline-adoptions.js';
import {readInitialTimelineInput} from './fixed-timeline-initial-input.js';
import {fixedTimelineIdentity} from './fixed-timeline-identity.js';
import {frozenWorkDefinition} from './fixed-work-definition.js';

type DB=Pick<PoolClient,'query'>;
export type FixedOrderRoute={version:2;kind:'same_scope'|'added_scope';adoptionId:string;adoptionIdentity:string;orderId:string;routeRef:string;canonicalRouteRef:string;
 work:FixedTimelineInput['work'];route:NonNullable<FixedTimelineInput['route']>;craftSteps:NonNullable<FixedTimelineInput['craftSteps']>;
 groups:Array<{nodeIds:string[];lastNodeId:string;handoffNodeId:string}>;eventRef:string;time:BusinessTime;actorId:string};

export async function readFixedOrderRoute(db:DB,saved:FixedTimelineAdoption,routeRef:string):Promise<FixedOrderRoute|null>{
 if(saved.input.resource.kind!=='order')return null;
 const row=(await db.query('SELECT * FROM digital_timeline_order_routes WHERE adoption_id=$1 AND route_ref=$2 AND production_order_id=$3',[saved.adoptionId,routeRef,saved.input.resource.id])).rows[0];
 if(!row)return null;
 const input=row.input_snapshot as FixedOrderRoute;
 if(input.version!==2||input.adoptionId!==saved.adoptionId||input.adoptionIdentity!==saved.identityHash||input.orderId!==saved.input.resource.id||input.routeRef!==routeRef||fixedTimelineIdentity(input)!==row.identity_hash)throw Error('本次产前工艺范围与原冻结输入不一致');
 validateBusinessTime(input.time);return input;
}

/** Original preparation creation already owns the task/resource lock and role
 * checks. No current standard, target calculation or business gate is added.
 */
export async function captureFixedOrderRoute(db:DB,saved:FixedTimelineAdoption,routeRef:string,document:InstructionDocument,source:DevelopmentDocument,eventRef:string,time:BusinessTime,actorId:string){
 if(saved.input.sourceVersions.routeRef===routeRef)return null;
 const existing=await readFixedOrderRoute(db,saved,routeRef);if(existing)return existing;
 const label=document.secondaryCraft==='沿用开发'?source.craft:document.secondaryCraft,selected=document.secondaryCraft==='沿用开发'?source.craftSteps:document.craftSteps;
 if(label==='印绣花'&&!selected)throw Error('请在原制单明确绣花、印花的实际先后顺序');
 const choices=label==='无'?[]:CraftStepChoicesSchema.parse(selected??[{craftKind:label==='绣花'?'embroidery':'printing',sequence:1}]);
 const original=saved.input.craftSteps??[],same=choices.length===original.length&&choices.every((step,index)=>step.craftKind===original[index]?.craftKind&&step.sequence===original[index]?.sequence);
 const work:FixedTimelineInput['work']=[],groups:FixedOrderRoute['groups']=[],route:FixedOrderRoute['route']=[];
 const steps=same?original:choices.map(step=>({...step,stepId:randomUUID()}));
 const initial=await readInitialTimelineInput(db,saved.input.resource);if(!initial)throw Error('原订单冻结标准缺失');
 if(same)route.push(...structuredClone(saved.input.route??[]));
 else{
  let previous:string|null=null;
  for(const step of steps){
   const nodeId=`bulk_${step.craftKind}:${routeRef}`,qcId=`bulk_qc:${step.stepId}`;
   work.push({id:nodeId,parameterKey:`bulk_${step.craftKind}`,dependsOn:previous?[previous]:[],...frozenWorkDefinition(initial,`bulk_${step.craftKind}`,steps.length===2),canonicalWorkRef:`order:${saved.input.resource.id}:route:${routeRef}:step:${step.stepId}`,accountingRole:'added_work'});
   work.push({id:qcId,parameterKey:'bulk_qc',dependsOn:[nodeId],...frozenWorkDefinition(initial,'bulk_qc'),canonicalWorkRef:`order:${saved.input.resource.id}:route:${routeRef}:qc:${step.stepId}`,accountingRole:'added_work'});previous=qcId;
   route.push({kind:'process_logistics',position:route.length,nodeId,stepId:step.stepId,phase:'logistics'},{kind:'bulk_qc',position:route.length+1,nodeId:qcId,stepId:step.stepId,phase:'qc'});
  }
  if(previous)groups.push({nodeIds:work.map(node=>node.id),lastNodeId:previous,handoffNodeId:'warehouse_dispatch'});
  route.push({kind:'warehouse_dispatch',position:route.length,nodeId:'warehouse_dispatch'});
 }
 if(document.preshrink==='需要预缩'&&saved.input.sourceVersions.preshrink!=='需要预缩'){
  const id=`warehouse_preshrink:${routeRef}`;
  work.push({id,parameterKey:'warehouse_preshrink',dependsOn:[],...frozenWorkDefinition(initial,'warehouse_preshrink'),canonicalWorkRef:`order:${saved.input.resource.id}:route:${routeRef}:preshrink`,accountingRole:'added_work'});
  groups.push({nodeIds:[id],lastNodeId:id,handoffNodeId:'bulk_cutting'});
 }
 const input:FixedOrderRoute={version:2,kind:groups.length?'added_scope':'same_scope',adoptionId:saved.adoptionId,adoptionIdentity:saved.identityHash,orderId:saved.input.resource.id,routeRef,
  canonicalRouteRef:same?String(saved.input.sourceVersions.routeRef):routeRef,work,route,craftSteps:steps,groups,eventRef,time:validateBusinessTime(time),actorId};
 await db.query(`INSERT INTO digital_timeline_order_routes(route_ref,adoption_id,adoption_identity,production_order_id,canonical_route_ref,input_snapshot,identity_hash,source_event_ref,business_time,created_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[routeRef,saved.adoptionId,saved.identityHash,saved.input.resource.id,input.canonicalRouteRef,JSON.stringify(input),fixedTimelineIdentity(input),eventRef,JSON.stringify(time),actorId]);
 return input;
}
