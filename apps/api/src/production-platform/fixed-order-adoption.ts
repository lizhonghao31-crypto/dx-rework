import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import type {SlaAnchor} from '@dx-rework/domain/digital-sla-plan';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {InstructionDocument} from '@dx-rework/contracts/production-instruction';
import {CraftStepChoicesSchema} from '@dx-rework/contracts/digital-craft';
import {FixedTimelineAdoptionRepository} from './fixed-timeline-adoptions.js';
import {readInitialTimelineInput} from './fixed-timeline-initial-input.js';
import {captureFixedCraftSteps} from './fixed-craft-steps.js';
import {fixedOrderWork} from './fixed-order-work.js';
import {captureFixedOrderRoute} from './fixed-order-route.js';

/** Only original authorized native publication/preparation calls this adapter.
 * It freezes identities and planning inputs; the bounded worker computes B.
 */
export async function captureOrderTimeline(db:PoolClient,actorId:string,orderId:string,routeRef:string,instructionVersion:number,document:InstructionDocument,
 sourceId:string,sourceRound:number,sourceDocument:DevelopmentDocument,eventRef:string,time:BusinessTime){
 const resource={kind:'order' as const,id:orderId},initial=await readInitialTimelineInput(db,resource);if(!initial)return null;
 const repo=new FixedTimelineAdoptionRepository(db);
 const saved=await repo.capture(resource,1,actorId,eventRef,time,'fixed_v2',async()=>{
  const original=(await db.query('SELECT plan_id,revision,plan_json FROM digital_sla_plans WHERE production_order_id=$1 ORDER BY revision LIMIT 1',[orderId])).rows[0];
  const inherited=document.secondaryCraft==='沿用开发',label=inherited?sourceDocument.craft:document.secondaryCraft;
  const selected=inherited?sourceDocument.craftSteps:document.craftSteps;
  if(label==='印绣花'&&!selected)throw Error('请在原制单明确绣花、印花的实际先后顺序');
  const choices=label==='无'?[]:CraftStepChoicesSchema.parse(selected??[{craftKind:label==='绣花'?'embroidery':'printing',sequence:1}]);
  const craftSteps=choices.map(step=>({...step,stepId:randomUUID()})),dual=craftSteps.length===2;
  const source=await repo.existing({kind:'source',id:sourceId},sourceRound),lines=(await db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[orderId])).rows;
  const planningLines=[];
  for(const line of lines){const recorded=(await db.query("SELECT version FROM digital_po_date_changes WHERE line_id=$1 AND date_kind='customer' AND source='initial_po' ORDER BY version LIMIT 1",[line.line_id])).rows[0];
   planningLines.push({line_id:String(line.line_id),goal:original.plan_json.anchors[`customer_shipping_date:${line.line_id}`] as SlaAnchor|undefined,customerDateVersion:Number(recorded?.version??0)});
  }
  const {work,route,consumers}=fixedOrderWork(initial,orderId,sourceId,sourceRound,document.preshrink,craftSteps,dual,source?.input??null,planningLines);
  return {timelineSchemaVersion:2,routeSchemaVersion:2,calculationVersion:'fixed-backward-v1',resource,round:1,
   originalPlan:{ref:`digital_sla_plans:${original.plan_id}`,revision:original.revision,plan:original.plan_json},
   unified:{snapshotRef:initial.data.unified.snapshotRef,values:initial.data.unified.values},development:initial.data.development,
   sourceVersions:{initialIdentityHash:initial.identityHash,configurationId:initial.data.unified.configurationId,routeRef,instructionVersion,sourceId,sourceRound,preshrink:document.preshrink},work,route,craftSteps,consumers};
 });
 if(saved){
  const scope=await captureFixedOrderRoute(db,saved,routeRef,document,sourceDocument,eventRef,time,actorId);
  await captureFixedCraftSteps(db,saved,resource,routeRef,1,scope?.craftSteps??saved.input.craftSteps??[],actorId,eventRef);
 }
 return saved;
}
