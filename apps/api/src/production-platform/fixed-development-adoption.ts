import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import type {SlaAnchor} from '@dx-rework/domain/digital-sla-plan';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import {CraftStepChoicesSchema} from '@dx-rework/contracts/digital-craft';
import type {DigitalTaskKind} from './task-access-repository.js';
import {FixedTimelineAdoptionRepository} from './fixed-timeline-adoptions.js';
import {readInitialTimelineInput} from './fixed-timeline-initial-input.js';
import {captureFixedCraftSteps} from './fixed-craft-steps.js';
import {frozenWorkDefinition as definition} from './fixed-work-definition.js';
import {fixedDevelopmentWork} from './fixed-development-work.js';


/** Captures native route inputs only, in the original publication transaction.
 * No target dates are calculated here: storage/calculation failures in B remain
 * isolated in the existing bounded object's worker after business commit.
 */
export async function captureDevelopmentTimeline(db:PoolClient,actorId:string,sourceId:string,round:number,routeRef:string,routeKinds:readonly DigitalTaskKind[],document:DevelopmentDocument,documentVersion:number,eventRef:string,time:BusinessTime){
 const resource={kind:'source' as const,id:sourceId},initial=await readInitialTimelineInput(db,resource);if(!initial)return null;
 const saved=await new FixedTimelineAdoptionRepository(db).capture(resource,round,actorId,eventRef,time,'fixed_v2',async()=>{
  const original=(await db.query('SELECT revision,plan_json FROM digital_development_sla_plans WHERE source_id=$1 ORDER BY revision LIMIT 1',[sourceId])).rows[0];
  const choices=document.craft==='无'?[]:CraftStepChoicesSchema.parse(document.craftSteps??[{craftKind:document.craft==='绣花'?'embroidery':'printing',sequence:1}]);
  const craftSteps=choices.filter(choice=>routeKinds.includes(choice.craftKind==='embroidery'?'development_embroidery':'development_printing')).map((choice,index)=>({...choice,sequence:index+1,stepId:randomUUID()})),dual=choices.length===2;
  const {work,route,previous}=fixedDevelopmentWork(initial,sourceId,round,routeKinds,craftSteps,dual,document.washing,document.materials.some(material=>material.category==='辅料'&&material.requiredThisRound!==false));
  // The existing sample-completion date is a completion goal, not a fabricated
  // customer shipment promise. The independent shipping task stays explicit.
  const ends:Record<string,SlaAnchor>={};
  if(previous)ends[previous]=document.returnDate?{precision:'date',value:document.returnDate,source:`development:${sourceId}:round:${round}:document:${documentVersion}:returnDate`}:{precision:'unknown',reason:'本轮预计样板完成日期尚未填写'};
  if(round===1){work.push({id:'development_shipping',parameterKey:'development_shipping',dependsOn:[],...definition(initial,'development_shipping'),canonicalWorkRef:`source:${sourceId}:round:${round}:work:development_shipping`,accountingRole:'original_work'});ends.development_shipping={precision:'unknown',reason:'原资料尚无独立寄样目标，不以样板预计完成日期代替'};}
  return {timelineSchemaVersion:2,routeSchemaVersion:2,calculationVersion:initial.data.orderTimePlan?'fixed-backward-v2':'fixed-backward-v1',resource,round,
   originalPlan:{ref:`digital_development_sla_plans:${sourceId}:${original.revision}`,revision:original.revision,plan:original.plan_json},
   unified:{snapshotRef:initial.data.unified.snapshotRef,values:initial.data.unified.values},development:initial.data.development,...(initial.data.orderTimePlan?{orderTimePlan:initial.data.orderTimePlan}:{}),
   sourceVersions:{initialIdentityHash:initial.identityHash,configurationId:initial.data.unified.configurationId,routeRef,documentVersion,round},work,route,craftSteps,
   consumers:[{scopeRef:`source:${sourceId}:round:${round}`,lineId:null,nodeIds:work.map(work=>work.id),ends}]};
 });
 if(saved)await captureFixedCraftSteps(db,saved,resource,routeRef,round,saved.input.craftSteps??[],actorId,eventRef);
 return saved;
}
