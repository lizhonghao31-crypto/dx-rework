import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import type {SlaAnchor} from '@dx-rework/domain/digital-sla-plan';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import {CraftStepChoicesSchema} from '@dx-rework/contracts/digital-craft';
import type {DigitalTaskKind} from './task-access-repository.js';
import {FixedTimelineAdoptionRepository,type FixedTimelineInput} from './fixed-timeline-adoptions.js';
import {readInitialTimelineInput} from './fixed-timeline-initial-input.js';
import {captureFixedCraftSteps} from './fixed-craft-steps.js';
import {frozenWorkDefinition as definition} from './fixed-work-definition.js';

type Work=FixedTimelineInput['work'][number];

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
  const work:Work[]=[],route:NonNullable<FixedTimelineInput['route']>=[];let previous:string|null=null,craftIndex=-1;
  const ref=(id:string)=>`source:${sourceId}:round:${round}:work:${id}`;
  for(const [position,kind]of routeKinds.entries()){
   const shared=kind==='development_craft_dispatch'||kind==='development_craft_confirmation';
   const step=kind==='development_craft_dispatch'?craftSteps[++craftIndex]:kind==='development_craft_confirmation'?craftSteps[craftIndex]:kind==='development_printing'?craftSteps.find(step=>step.craftKind==='printing'):kind==='development_embroidery'?craftSteps.find(step=>step.craftKind==='embroidery'):null;
   const id=shared&&step?`${kind}:${step.stepId}`:kind,key=kind==='development_material_recheck'?'development_materials':kind;
   route.push({kind,position,nodeId:id,...(step?{stepId:step.stepId,phase:kind==='development_craft_dispatch'?'dispatch':kind==='development_craft_confirmation'?'confirmation':'work'}:{})});
   if(shared&&step){
    const parent=`development_${step.craftKind}`,policy=definition(initial,kind==='development_craft_confirmation'?'development_craft_return':'development_craft_dispatch');
    work.push({id,parameterKey:kind==='development_craft_confirmation'?'development_craft_return':kind,dependsOn:[],...policy,includedIn:parent,includedPosition:kind==='development_craft_confirmation'?'end':'start',canonicalWorkRef:`source:${sourceId}:round:${round}:step:${step.stepId}:${kind}`,accountingRole:'included'});
    continue;
   }
   if(kind==='development_washing_dispatch'||kind==='development_sewing_transfer'){
    work.push({id,parameterKey:key,dependsOn:[],...definition(initial,key),includedIn:kind==='development_washing_dispatch'?'development_washing':'development_sewing',includedPosition:'start',canonicalWorkRef:ref(id),accountingRole:'included'});continue;
   }
   const milestone=kind==='development_confirmation',policy=milestone?{minutes:0,calendar:null,planningParameterRef:null,responsibilitySlaRef:null,responsibilityMinutes:null,responsibilityCalendar:null}:definition(initial,key,Boolean(step&&dual));
   if(kind==='development_washing'&&document.washing==='外洗'){
    const days=initial.data.development?.values.externalWashDays;
    if(typeof days==='number'){policy.minutes=days*1440;policy.calendar='natural_days';policy.planningParameterRef=`${initial.data.development!.snapshotRef}:externalWashDays`;policy.responsibilitySlaRef=policy.planningParameterRef;policy.responsibilityMinutes=days*1440;policy.responsibilityCalendar='natural_days';}
   }
   work.push({id,parameterKey:key,dependsOn:previous?[previous]:[],...policy,canonicalWorkRef:step?`source:${sourceId}:round:${round}:step:${step.stepId}:work`:ref(id),accountingRole:milestone?'event':round===1?'original_work':'added_work'});
   previous=id;
  }
  const sewing=work.find(work=>work.id==='development_sewing');
  if(sewing){
   const policy=definition(initial,'development_sewing_transfer');
   if(!work.some(work=>work.id==='development_sewing_transfer'))work.push({id:'development_sewing_transfer',parameterKey:'development_sewing_transfer',dependsOn:[],...policy,includedIn:sewing.id,includedPosition:'start',canonicalWorkRef:ref('development_sewing_transfer'),accountingRole:'included'});
   if(document.materials.some(material=>material.category==='辅料'&&material.requiredThisRound!==false)){
    work.push({id:'development_accessories',parameterKey:'development_accessories',dependsOn:[],...definition(initial,'development_accessories'),canonicalWorkRef:ref('development_accessories'),accountingRole:'original_work'});
    sewing.dependsOn=[...sewing.dependsOn,'development_accessories'];
   }
  }
  for(const included of work.filter(work=>work.includedIn)){
   const parent=work.find(work=>work.id===included.includedIn);included.calendar=parent?.calendar??null;
  }
  // The existing sample-completion date is a completion goal, not a fabricated
  // customer shipment promise. The independent shipping task stays explicit.
  const ends:Record<string,SlaAnchor>={};
  if(previous)ends[previous]=document.returnDate?{precision:'date',value:document.returnDate,source:`development:${sourceId}:round:${round}:document:${documentVersion}:returnDate`}:{precision:'unknown',reason:'本轮预计样板完成日期尚未填写'};
  if(round===1){work.push({id:'development_shipping',parameterKey:'development_shipping',dependsOn:[],...definition(initial,'development_shipping'),canonicalWorkRef:ref('development_shipping'),accountingRole:'original_work'});ends.development_shipping={precision:'unknown',reason:'原资料尚无独立寄样目标，不以样板预计完成日期代替'};}
  return {timelineSchemaVersion:2,routeSchemaVersion:2,calculationVersion:'fixed-backward-v1',resource,round,
   originalPlan:{ref:`digital_development_sla_plans:${sourceId}:${original.revision}`,revision:original.revision,plan:original.plan_json},
   unified:{snapshotRef:initial.data.unified.snapshotRef,values:initial.data.unified.values},development:initial.data.development,
   sourceVersions:{initialIdentityHash:initial.identityHash,configurationId:initial.data.unified.configurationId,routeRef,documentVersion,round},work,route,craftSteps,
   consumers:[{scopeRef:`source:${sourceId}:round:${round}`,lineId:null,nodeIds:work.map(work=>work.id),ends}]};
 });
 if(saved)await captureFixedCraftSteps(db,saved,resource,routeRef,round,saved.input.craftSteps??[],actorId,eventRef);
 return saved;
}
