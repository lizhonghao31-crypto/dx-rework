import type {CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import type {DigitalTaskKind} from './task-access-repository.js';
import type {FixedTimelineInput} from './fixed-timeline-adoptions.js';
import {frozenWorkDefinition as definition,frozenCraftDefinition,frozenCraftChoice,craftParameterKey,withOrderTimeStageReserves,type FixedWorkInputs} from './fixed-work-definition.js';
type Work=FixedTimelineInput['work'][number];
/** Physical positions are independent of the policy which may later time them. */
export function developmentRoutePositions(routeKinds:readonly DigitalTaskKind[],craftSteps:Array<CraftStepChoice&{stepId:string}>){
 let craftIndex=-1;
 return routeKinds.map((kind,position)=>{
  const shared=kind==='development_craft_dispatch'||kind==='development_craft_confirmation';
  const step=kind==='development_craft_dispatch'?craftSteps[++craftIndex]:kind==='development_craft_confirmation'?craftSteps[craftIndex]:['development_printing','development_embroidery'].includes(kind)?craftSteps[craftIndex]:null;
  const nodeId=step&&(shared||step.craftKind==='special')?`${kind}:${step.stepId}`:kind;
  const phase=kind==='development_craft_dispatch'?'dispatch' as const:kind==='development_craft_confirmation'?'confirmation' as const:'work' as const;
  return {kind,position,nodeId,...(step?{stepId:step.stepId,phase}:{})};
 });
}
/** Shared pure adopted route construction. The caller supplies original inputs;
 * the settings calculator supplies clearly temporary inputs, never actual A. */
export function fixedDevelopmentWork(initial:FixedWorkInputs,sourceId:string,round:number,routeKinds:readonly DigitalTaskKind[],craftSteps:Array<CraftStepChoice&{stepId:string}>,dual:boolean,washing:'免洗'|'内洗'|'外洗',hasAccessories:boolean){
 const work:Work[]=[],route=developmentRoutePositions(routeKinds,craftSteps);let previous:string|null=null;
  const ref=(id:string)=>`source:${sourceId}:round:${round}:work:${id}`;
  for(const {kind,nodeId:id,stepId}of route){
   const shared=kind==='development_craft_dispatch'||kind==='development_craft_confirmation';
   const step=stepId?craftSteps.find(choice=>choice.stepId===stepId):null;
   const key=step&&!shared?craftParameterKey(step,'development'):kind==='development_material_recheck'?'development_materials':kind;
   if(shared&&step){
    const parent=step.craftKind==='special'?`development_printing:${step.stepId}`:`development_${step.craftKind}`,policy=definition(initial,kind==='development_craft_confirmation'?'development_craft_return':'development_craft_dispatch');
    work.push({id,parameterKey:kind==='development_craft_confirmation'?'development_craft_return':kind,dependsOn:[],...policy,includedIn:parent,includedPosition:kind==='development_craft_confirmation'?'end':'start',canonicalWorkRef:`source:${sourceId}:round:${round}:step:${step.stepId}:${kind}`,accountingRole:'included'});
    continue;
   }
   if(kind==='development_washing_dispatch'||kind==='development_sewing_transfer'){
    work.push({id,parameterKey:key,dependsOn:[],...definition(initial,key),includedIn:kind==='development_washing_dispatch'?'development_washing':'development_sewing',includedPosition:'start',canonicalWorkRef:ref(id),accountingRole:'included'});continue;
   }
   const milestone=kind==='development_confirmation'&&!initial.data.orderTimePlan?.company.framework,policy=milestone?{minutes:0,calendar:null,planningParameterRef:null,responsibilitySlaRef:null,responsibilityMinutes:null,responsibilityCalendar:null}:step?frozenCraftDefinition(initial,step,'development',dual):definition(initial,key);
   if(kind==='development_washing'&&washing==='外洗'&&!initial.data.orderTimePlan){
    const days=initial.data.development?.values.externalWashDays;
    if(typeof days==='number'){policy.minutes=days*1440;policy.calendar='natural_days';policy.planningParameterRef=`${initial.data.development!.snapshotRef}:externalWashDays`;policy.responsibilitySlaRef=policy.planningParameterRef;policy.responsibilityMinutes=days*1440;policy.responsibilityCalendar='natural_days';}
   }
   work.push({id,parameterKey:key,...(step?.craftKind==='special'?{stage:2,craftStep:frozenCraftChoice(step)}:{}),dependsOn:previous?[previous]:[],...policy,canonicalWorkRef:step?`source:${sourceId}:round:${round}:step:${step.stepId}:work`:ref(id),accountingRole:milestone?'event':round===1?'original_work':'added_work'});
   previous=id;
  }
  // Positioning follows this round's pattern in parallel with cutting. Only
  // the explicitly adopted framework owns the new 4h/2h rules; legacy windows
  // and historical route shapes are not silently upgraded.
  if(initial.data.orderTimePlan?.company.framework&&craftSteps.length){
   const pattern=work.find(node=>['development_pattern','development_external_pattern','external_pattern'].includes(node.parameterKey??''));
   if(pattern){
    const id='development_positioning';
    if(!work.some(node=>node.id===id))work.push({id,parameterKey:id,dependsOn:[pattern.id],...definition(initial,id),canonicalWorkRef:ref(id),accountingRole:round===1?'original_work':'added_work'});
    const first=work.find(node=>node.canonicalWorkRef===`source:${sourceId}:round:${round}:step:${craftSteps[0]!.stepId}:work`);
    if(first&&!first.dependsOn.includes(id))first.dependsOn=[...first.dependsOn,id];
   }
  }
  const sewing=work.find(work=>work.id==='development_sewing');
  if(sewing){
   const policy=definition(initial,'development_sewing_transfer');
   if(!work.some(work=>work.id==='development_sewing_transfer'))work.push({id:'development_sewing_transfer',parameterKey:'development_sewing_transfer',dependsOn:[],...policy,includedIn:sewing.id,includedPosition:'start',canonicalWorkRef:ref('development_sewing_transfer'),accountingRole:'included'});
   if(hasAccessories){
    work.push({id:'development_accessories',parameterKey:'development_accessories',dependsOn:[],...definition(initial,'development_accessories'),canonicalWorkRef:ref('development_accessories'),accountingRole:'original_work'});
    sewing.dependsOn=[...sewing.dependsOn,'development_accessories'];
   }
  }
  for(const included of work.filter(work=>work.includedIn)){
   const parent=work.find(work=>work.id===included.includedIn);included.calendar=parent?.calendar??null;
  }
 return {work:withOrderTimeStageReserves(initial,work),route,previous};
}
