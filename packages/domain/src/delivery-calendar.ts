import type {DeliveryPoFact,DeliveryPo,DeliverySummary,DeliveryDay,DeliveryCalendarFilters} from '@dx-rework/contracts/delivery-calendar';
import {isCalendarDate,addCalendarDays} from '@dx-rework/contracts/series-calendar';

const quantity=(value:number|null)=>value!==null&&Number.isSafeInteger(value)&&value>=0?value:null;
const validDate=(value:string|null)=>value&&isCalendarDate(value)?value:null;
export function deliveryPo(fact:DeliveryPoFact,today:string):DeliveryPo{
 if(!isCalendarDate(today))throw Error('A real Shanghai observation date is required');
 const orderedQty=quantity(fact.orderedQty),rawPackedQty=quantity(fact.rawPackedQty),date=validDate(fact.effectiveDueDate);
 const known=orderedQty!==null&&rawPackedQty!==null,packedQty=known?Math.min(orderedQty,rawPackedQty):null,pendingQty=known?Math.max(orderedQty-rawPackedQty,0):null,extraQty=known?Math.max(rawPackedQty-orderedQty,0):null;
 const reminderDays=fact.reminderDays!==null&&Number.isInteger(fact.reminderDays)&&fact.reminderDays>=0&&fact.reminderDays<=365?fact.reminderDays:null;
 const riskStatus=pendingQty===null||date===null?'unknown':pendingQty===0?'delivered':date<today?'overdue':reminderDays===null?'unknown':date<=addCalendarDays(today,reminderDays)?'due_soon':'pending';
 return {...fact,orderedQty,rawPackedQty,reminderDays,effectiveDueDate:date,originalDueDate:validDate(fact.originalDueDate),factoryDueDate:validDate(fact.factoryDueDate),packedQty,pendingQty,extraQty,riskStatus};
}
export function deliverySummary(rows:readonly DeliveryPo[]):DeliverySummary{
 const known=rows.filter(row=>row.orderedQty!==null&&row.packedQty!==null&&row.pendingQty!==null&&row.extraQty!==null),unknownQuantityPoCount=rows.length-known.length;
 // Conservation is evaluated on the same fully known PO set, never by adding
 // one PO's surplus against a sibling's debt or treating absent packing as0.
 const sum=(key:'orderedQty'|'packedQty'|'pendingQty'|'extraQty')=>known.reduce((total,row)=>total+row[key]!,0);
 const [ordered,packed,pending,extra]=(['orderedQty','packedQty','pendingQty','extraQty'] as const).map(sum),overdue=known.filter(row=>row.riskStatus==='overdue'),knownOrderedQty=rows.reduce((total,row)=>total+(row.orderedQty??0),0);
 return {poCount:rows.length,orderedQty:rows.some(row=>row.orderedQty===null)?null:knownOrderedQty,packedQty:unknownQuantityPoCount?null:packed!,pendingQty:unknownQuantityPoCount?null:pending!,extraQty:unknownQuantityPoCount?null:extra!,knownOrderedQty,comparableOrderedQty:ordered!,knownPackedQty:packed!,knownPendingQty:pending!,knownExtraQty:extra!,unknownQuantityPoCount,missingDuePoCount:rows.filter(row=>!row.effectiveDueDate).length,overduePoCount:overdue.length,overduePendingQty:overdue.reduce((total,row)=>total+row.pendingQty!,0)};
}
export function selectedDeliveryRows(rows:readonly DeliveryPo[],filters:DeliveryCalendarFilters):DeliveryPo[]{
 const needle=filters.search.toLocaleLowerCase();
 const ids=new Set<string>();for(const row of rows){const id=row.orderId+':'+row.lineId;if(ids.has(id))throw Error('Duplicate current PO scope in delivery projection');ids.add(id);}
 const inScope=(row:DeliveryPo)=>{const excluded=['cancelled','special_closed'].includes(row.scopeStatus);return filters.scope==='all'||(filters.scope==='excluded'?excluded:!excluded);};
 return rows.filter(row=>(!filters.customer||row.customer===filters.customer)&&(!needle||[row.businessOrderNo,row.designStyleNo,row.po,row.customer,row.color].some(text=>text?.toLocaleLowerCase().includes(needle)))&&(!filters.status||row.riskStatus===filters.status)&&inScope(row)).sort((a,b)=>(a.effectiveDueDate??'9999').localeCompare(b.effectiveDueDate??'9999')||['overdue','due_soon','pending','unknown','delivered'].indexOf(a.riskStatus)-['overdue','due_soon','pending','unknown','delivered'].indexOf(b.riskStatus)||(a.po??'').localeCompare(b.po??'')||a.lineId.localeCompare(b.lineId));
}
export function deliveryDays(rows:readonly DeliveryPo[],from:string,to:string):DeliveryDay[]{
 if(!isCalendarDate(from)||!isCalendarDate(to)||from>to)throw Error('Invalid delivery date range');
 const buckets=new Map<string,DeliveryPo[]>();for(const row of rows)if(row.effectiveDueDate&&row.effectiveDueDate>=from&&row.effectiveDueDate<=to){const group=buckets.get(row.effectiveDueDate)??[];group.push(row);buckets.set(row.effectiveDueDate,group);}
 const days:DeliveryDay[]=[];for(let date=from;date<=to;date=addCalendarDays(date,1)){const group=buckets.get(date)??[],states:DeliveryDay['states']={};for(const row of group)states[row.riskStatus]=(states[row.riskStatus]??0)+1;days.push({date,summary:deliverySummary(group),states});}return days;
}
export const hasDeliveryMissingEvidence=(row:DeliveryPo)=>row.effectiveDueDate===null||row.pendingQty===null||row.riskStatus==='unknown';
export function deliveryDayGroups(rows:readonly DeliveryPo[],selectedDate:string,today:string){
 if(!isCalendarDate(selectedDate)||!isCalendarDate(today))throw Error('Invalid selected/observed delivery date');
 return {day:rows.filter(row=>row.effectiveDueDate===selectedDate),overdue:rows.filter(row=>row.effectiveDueDate!==null&&row.effectiveDueDate<today&&row.pendingQty!==null&&row.pendingQty>0),beforeSelectedNotYetOverdue:selectedDate>today?rows.filter(row=>row.effectiveDueDate!==null&&row.effectiveDueDate>=today&&row.effectiveDueDate<selectedDate&&row.pendingQty!==null&&row.pendingQty>0):[],missing:rows.filter(hasDeliveryMissingEvidence)};
}
