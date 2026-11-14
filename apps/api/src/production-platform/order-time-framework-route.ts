import {addCalendarDays} from '@dx-rework/contracts/series-calendar';
import {SERIES_MILESTONES,type SeriesRoute,type SeriesMilestoneKey} from '@dx-rework/contracts/digital-series-plan';
import {TimeFrameworkInputSchema,type TimeFrameworkInput, type FrameworkTarget} from '@dx-rework/contracts/order-time-framework';
import type {SlaAnchor} from '@dx-rework/domain/digital-sla-plan';
import type {OrderTimeInput} from './order-time-plan-repository.js';
import type {OrderTimeNativeProgress} from './order-time-request-plan.js';
import type {FrameworkCandidateContext} from './order-time-framework.js';

/** Bind the actual original graph by business identity, not display labels or
 * array order. These references never create another business task. */
export function frameworkScopeInputs(value:OrderTimeInput,route:SeriesRoute,acceptedAt:SlaAnchor,notBefore:Readonly<Record<string,SlaAnchor>>={}):TimeFrameworkInput[]{
 const standard=value.plan.company.framework;if(!standard)throw Error('本单未采用三层时间标准');
 const byId=new Map(value.work.map(row=>[row.id,row]));
 return value.scopes.map(scope=>{
  if(scope.customerGoal.precision!=='date')throw Error('请填写本单客户交货日期');
  const ids=new Set<string>();
  const visit=(id:string)=>{if(ids.has(id))return;const row=byId.get(id);if(!row)throw Error('里程碑缺少原工作身份');ids.add(id);for(const dep of row.dependsOn)visit(dep);};
  for(const id of scope.terminalIds)visit(id);
  const select=(key:string)=>value.work.filter(row=>ids.has(row.id)&&row.parameterKey===key);
  const related:Record<SeriesMilestoneKey,string[]>={
   design_handover:select('design_handover').map(row=>row.id),material_investment:select('material_investment').map(row=>row.id),
   fabric_receipt:select(route==='A'?'fabric_receipt_a':'fabric_receipt_b').map(row=>row.id),
   color_confirmation:route==='A'?select('color_confirmation').map(row=>row.id):[],
   client_sample_approval:select('client_sample_approval').map(row=>row.id),
   accessories_ready:select('warehouse_accessories').map(row=>row.id),style_label_ready:select('style_label_ready').map(row=>row.id),
   processing_dispatch:select('warehouse_dispatch').map(row=>row.id),planned_shipment:[...scope.terminalIds],
  };
  const bindings=SERIES_MILESTONES.filter(row=>route==='A'||row.key!=='color_confirmation').map(row=>({key:row.key,workIds:related[row.key]}));
  for(const binding of bindings){if(!binding.workIds.length)throw Error('里程碑缺少原关联工作：'+binding.key);for(const id of binding.workIds)visit(id);}
  for(const row of value.work)if(row.includedIn&&ids.has(row.includedIn))ids.add(row.id);
  const bounds:Record<string,SlaAnchor>=Object.fromEntries(Object.entries(notBefore).filter(([id])=>ids.has(id)));
  // These are approved target-based planning conditions, not invented reply
  // lead times, actual receipts or employee responsibility starts.
  for(const [key,parameter]of [['client_sample_approval','client_sample_approval'],['accessories_ready','warehouse_accessories'],['style_label_ready','style_label_ready']] as const){
   for(const row of select(parameter))if(ids.has(row.id)&&!bounds[row.id])bounds[row.id]={precision:'date',value:addCalendarDays(scope.customerGoal.value,-standard.milestoneOffsets[route][key]!),source:'按本单里程碑安排：'+key};
  }
  return TimeFrameworkInputSchema.parse({scopeRef:scope.scopeRef,route,acceptedAt,customerDelivery:{date:scope.customerGoal.value,source:scope.customerGoal.source,revision:scope.customerDateVersion??1},plan:value.plan,
   milestoneStandard:{reference:value.plan.company.reference,revision:value.plan.company.revision,offsets:standard.milestoneOffsets[route]},
   work:value.work.filter(row=>ids.has(row.id)),bindings,notBefore:bounds});
 });
}

/** Actual completion is a scheduling boundary; a previous planned date is not
 * an actual event. Started work keeps its last formally effective arrangement.
 * Unknown completion remains unknown and cannot silently become zero time. */
export function retainedFrameworkWork(input:TimeFrameworkInput,progress:ReadonlyMap<string,OrderTimeNativeProgress>,previous?:{reference:string;arranged:readonly FrameworkTarget[]}):NonNullable<FrameworkCandidateContext['retained']>{
 const retained:Record<string,{target:FrameworkTarget;sourceRef:string;actualCompletion?:FrameworkTarget['end']}>={};
 for(const work of input.work){
  if(work.includedIn)continue;
  const ref=work.canonicalWorkRef??work.id,fact=progress.get(input.scopeRef+'|'+ref)??progress.get(ref);
  if(fact?.completed){
   const time={at:fact.actualAt,exclusive:false,reasons:fact.actualAt?[]:['已完成但缺少可信完成时间']};
   const prior=previous?.arranged.find(row=>row.id===work.id);
   retained[work.id]={target:prior?structuredClone(prior):{id:work.id,start:time,end:time},sourceRef:prior?previous!.reference:ref+':native-completion',actualCompletion:time};
  }else if(fact?.readyAt&&previous){
   const prior=previous.arranged.find(row=>row.id===work.id);
   if(prior)retained[work.id]={target:structuredClone(prior),sourceRef:previous.reference};
  }
 }
 return retained;
}
