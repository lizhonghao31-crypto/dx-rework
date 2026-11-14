import {BulkWashingArrangementSchema,type BulkWashingArrangement} from '@dx-rework/contracts/bulk-washing';
import type {FixedTimelineInput} from './fixed-timeline-adoptions.js';
type Work=FixedTimelineInput['work'][number];

/** Pure route expansion, invoked only with an explicitly adopted arrangement.
 * Decomposition of factory-inclusive time preserves its total and calendar;
 * neither this helper nor the planner writes a real start or receipt. */
export function bulkWashingWork(orderId:string,lineId:string,arrangement:BulkWashingArrangement|undefined,factory:Work,receivedInspectionId:string){
 if(!arrangement||arrangement.mode==='none')return {factory,work:[] as Work[],factoryEnd:factory.id,packingPredecessor:receivedInspectionId};
 const plan=BulkWashingArrangementSchema.parse(arrangement);
 if(plan.mode==='none')throw Error('洗水路线无效');
 const inFactory=plan.mode==='factory',included=inFactory&&plan.accounting==='included_in_factory';
 const total=plan.washing.minutes+plan.inspection.minutes;
 if(included&&(factory.minutes===null||factory.minutes<total||factory.calendar!==plan.washing.calendar||factory.calendar!==plan.inspection.calendar))
  throw Error('工厂内含洗水须有足够的原生产用时并采用相同日历');
 const prefix=inFactory?'bulk_factory_washing':'bulk_return_washing';
 const node=(key:string,policy:typeof plan.washing,dependsOn:string[]):Work=>({
  id:`${key}:${lineId}`,parameterKey:key,dependsOn,minutes:policy.minutes,calendar:policy.calendar,stage:inFactory?6:7,
  canonicalWorkRef:`order:${orderId}:work:${key}:${lineId}`,accountingRole:'original_work',
  planningParameterRef:`${plan.reference}:washing:${plan.revision}:${key}`,
  nativeDuration:{reference:`${plan.reference}:washing:${plan.revision}:${key}`,minutes:policy.minutes,calendar:policy.calendar},
  responsibilitySlaRef:`${plan.reference}:washing:${plan.revision}:${key}`,
  responsibilityMinutes:policy.minutes,responsibilityCalendar:policy.calendar,
 });
 const washing=node(prefix,plan.washing,[inFactory?factory.id:receivedInspectionId]);
 const inspection=node(`${prefix}_inspection`,plan.inspection,[washing.id]);
 return {factory:included?{...factory,minutes:factory.minutes!-total,nativeDuration:{reference:`${plan.reference}:washing:${plan.revision}:factory-remainder`,minutes:factory.minutes!-total,calendar:factory.calendar}}:factory,work:[washing,inspection],
  factoryEnd:inFactory?inspection.id:factory.id,packingPredecessor:inFactory?receivedInspectionId:inspection.id};
}
