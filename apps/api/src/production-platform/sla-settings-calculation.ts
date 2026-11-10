import {DIGITAL_SLA_PARAMETERS,resolveDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {SettingsCalculationSchema,validateSettingsSetValues,type SettingsCalculationInput,type SettingsCalculationResult} from '@dx-rework/contracts/sla-settings-sets';
import {CraftStepChoicesSchema,craftLegacyLabel} from '@dx-rework/contracts/digital-craft';
import {isCalendarDate} from '@dx-rework/contracts/series-calendar';
import {fixedDevelopmentWork} from './fixed-development-work.js';
import {fixedOrderWork} from './fixed-order-work.js';
import {developmentSlaRoute} from './development-sla-enrollment.js';
import {fixedConsumerTargets} from './fixed-timeline-adoptions.js';
import type {FixedWorkInputs} from './fixed-work-definition.js';
/** Same pure work builders, same backward engine and original calendar rules.
 * No database, actual evidence, order IDs, writes, or configuration draft access. */
export function settingsCalculation(raw:SettingsCalculationInput):SettingsCalculationResult{
 const input=SettingsCalculationSchema.parse(raw),values=validateSettingsSetValues(input.values).unified,developmentSteps=CraftStepChoicesSchema.parse(input.development.craftSteps),bulkSteps=CraftStepChoicesSchema.parse(input.bulk.craftSteps);
 if(new Set(input.lines.map(line=>line.id)).size!==input.lines.length||input.lines.some(line=>!isCalendarDate(line.customerDate)))throw Error('请填写不重复的PO编号与有效交期');
 const initial:FixedWorkInputs={data:{unified:{configurationId:'temporary-calculation',snapshotRef:'temporary-calculation',values:resolveDigitalSlaSnapshot({version:1,values})},development:{snapshotRef:'temporary-calculation',version:1,values:input.values.development},planning:{standardRef:'temporary-calculation',version:1,values:input.values.planning}}};
 const doc={craft:craftLegacyLabel(developmentSteps),craftSteps:developmentSteps,washing:input.development.washing},development=input.development.enabled?fixedDevelopmentWork(initial,'temporary-source',1,['development_materials',...developmentSlaRoute(doc,'整件样板',2)],developmentSteps.map(step=>({...step,stepId:'temporary-'+step.craftKind})),developmentSteps.length===2,input.development.washing,input.development.accessories):null;
 const bulk=fixedOrderWork(initial,'temporary-order','temporary-source',1,input.bulk.preshrink?'需要预缩':'不需预缩',bulkSteps.map(step=>({...step,stepId:'temporary-'+step.craftKind})),bulkSteps.length===2,development,input.lines.map(line=>({line_id:line.id,goal:{precision:'date',value:line.customerDate,source:'explicit-calculation-input'},customerDateVersion:0})));
 const catalog=new Map(DIGITAL_SLA_PARAMETERS.map(p=>[p.key,p]));
 return {lines:bulk.consumers.map((consumer,index)=>{
  const work=bulk.work.filter(node=>consumer.nodeIds.includes(node.id));
  // Without a development path the explicit zero-length handoff is a planning
  // boundary only, not a fabricated actual source completion.
  if(!input.development.enabled){const handoff=work.find(node=>node.id==='source_confirmation');if(handoff){handoff.minutes=0;handoff.calendar='continuous';}}
  const targets=fixedConsumerTargets(work,consumer),byId=new Map(work.map(node=>[node.id,node])),required=new Set<string>();
  const visit=(id:string)=>{if(required.has(id))return;required.add(id);for(const dep of byId.get(id)?.dependsOn??[])visit(dep);};for(const id of consumer.customerGoalIds??[])visit(id);
  const roots=work.filter(node=>required.has(node.id)&&!node.includedIn&&!node.dependsOn.length).map(node=>targets.find(target=>target.id===node.id)?.start.at??null),ends=(consumer.customerGoalIds??[]).map(id=>targets.find(target=>target.id===id)?.end.at??null);
  const startAt=roots.length&&roots.every(Boolean)?roots.reduce((a,b)=>a!<b!?a:b)!:null,endAt=ends.length&&ends.every(Boolean)?ends.reduce((a,b)=>a!>b!?a:b)!:null;
  const rows=work.map(node=>{const target=targets.find(target=>target.id===node.id)!,key=node.parameterKey??node.id,p=catalog.get(key);return {id:node.id,parameterKey:key,label:p?.label??(key==='factory_production_work'?'工厂生产规划':key==='source_confirmation'?'开发交接':key==='customer_confirmation'?'客户确认':key),stage:p?.stage??(key==='factory_production_work'?6:2),minutes:node.minutes,calendar:node.calendar,startAt:target.start.at,endAt:target.end.at,endDate:consumer.customerGoalIds?.includes(node.id)?input.lines[index]!.customerDate:null,includedIn:node.includedIn??null,missing:[...new Set([...target.start.reasons,...target.end.reasons])]};});
  const stages=Array.from({length:7},(_,i)=>{const stage=i+1,list=rows.filter(row=>row.stage===stage&&required.has(row.id)&&!row.includedIn),known=list.length&&list.every(row=>row.startAt&&row.endAt);return {stage,spanMinutes:known?(Math.max(...list.map(row=>Date.parse(row.endAt!)))-Math.min(...list.map(row=>Date.parse(row.startAt!))))/60000:null};});
  return {id:input.lines[index]!.id,customerDate:input.lines[index]!.customerDate,startAt,endAt,totalSpanMinutes:startAt&&endAt?(Date.parse(endAt)-Date.parse(startAt))/60000:null,rows,stages};
 })};
}
