import {describe,expect,it} from 'vitest';
import type {DeliveryPoFact} from '@dx-rework/contracts/delivery-calendar';
import {DeliveryCalendarFiltersSchema,DeliveryDayQuerySchema,DeliveryMonthQuerySchema,DeliveryMissingQuerySchema} from '@dx-rework/contracts/delivery-calendar';
import {deliveryPo,deliverySummary,deliveryDays,deliveryDayGroups,selectedDeliveryRows} from '@dx-rework/domain/delivery-calendar';
const fact=(overrides:Partial<DeliveryPoFact>={}):DeliveryPoFact=>({orderId:'mother-A',lineId:'line-A',businessOrderNo:'TRUE-A',designStyleNo:'STYLE-A',po:'PO-A',color:'蓝',customer:'C1',productType:null,orderedQty:100,rawPackedQty:20,packingRevision:'real-packing',effectiveDueDate:'2026-11-15',originalDueDate:'2026-11-15',factoryDueDate:'2026-11-10',dueRevision:1,dueHistoryRef:'real-date-approval',hasRecordedDueChange:false,reminderDays:7,scopeStatus:'active',sourceRefs:['real-test-fact'],unknownReasons:[],...overrides});
const today='2026-11-08',rows=(...facts:DeliveryPoFact[])=>facts.map(f=>deliveryPo(f,today));
describe('current customer due date calendar projection',()=>{
 it('separates the Shanghai observation day from selected past or future dates',()=>{
  const current=rows(fact({lineId:'overdue',effectiveDueDate:'2026-11-07'}),fact({lineId:'future',effectiveDueDate:'2026-11-15'}),fact({lineId:'today',effectiveDueDate:today}),fact({lineId:'selected',effectiveDueDate:'2026-11-20'}));
  const future=deliveryDayGroups(current,'2026-11-20',today);expect(future.overdue.map(r=>r.lineId)).toEqual(['overdue']);expect(future.beforeSelectedNotYetOverdue.map(r=>r.lineId)).toEqual(['future','today']);expect(future.day.map(r=>r.lineId)).toEqual(['selected']);expect(current.find(r=>r.lineId==='today')!.riskStatus).toBe('due_soon');
  const past=deliveryDayGroups(current,'2026-11-01',today);expect(past.beforeSelectedNotYetOverdue).toEqual([]);expect(past.day).toEqual([]);expect(past.overdue.map(r=>r.lineId)).toEqual(['overdue']);
 });
 it('uses the existing effective reminder window rather than inventing a fixed seven-day rule',()=>{expect(deliveryPo(fact({reminderDays:3}),today).riskStatus).toBe('pending');expect(deliveryPo(fact({reminderDays:7}),today).riskStatus).toBe('due_soon');const unknown=deliveryPo(fact({reminderDays:null}),today);expect(unknown.riskStatus).toBe('unknown');expect(deliveryDayGroups([unknown],'2026-11-20',today).missing).toEqual([unknown]);expect(deliveryPo(fact({reminderDays:null,effectiveDueDate:'2026-11-07'}),today).riskStatus).toBe('overdue');});
 it('clamps each PO independently and does not use one surplus to clear a sibling debt',()=>{
  const current=rows(fact({rawPackedQty:125}),fact({lineId:'line-B',po:'PO-B',rawPackedQty:10,effectiveDueDate:'2026-12-01'})),sum=deliverySummary(current);
  expect(sum).toMatchObject({poCount:2,orderedQty:200,packedQty:110,pendingQty:90,extraQty:25});expect(sum.orderedQty).toBe(sum.packedQty!+sum.pendingQty!);expect(current[0]!.riskStatus).toBe('delivered');expect(current[1]!.riskStatus).toBe('pending');
 });
 it('retains reliable demand when packing is unknown and exposes the common known subset separately',()=>{
  const current=rows(fact(),fact({lineId:'unknown',rawPackedQty:null})),sum=deliverySummary(current);
  expect(sum.orderedQty).toBe(200);expect(sum.packedQty).toBeNull();expect(sum.pendingQty).toBeNull();expect(sum.unknownQuantityPoCount).toBe(1);expect(sum.knownOrderedQty).toBe(200);expect(sum.comparableOrderedQty).toBe(sum.knownPackedQty+sum.knownPendingQty);expect(current[1]!.riskStatus).toBe('unknown');
  expect(deliveryPo(fact({rawPackedQty:0}),today).pendingQty).toBe(100);expect(deliveryPo(fact({rawPackedQty:NaN}),today).pendingQty).toBeNull();expect(deliveryPo(fact({orderedQty:null}),today).pendingQty).toBeNull();
 });
 it('keeps undated and unverified quantities in the missing set without assigning them to today',()=>{
  const current=rows(fact({lineId:'date-unknown',effectiveDueDate:null,originalDueDate:null,dueHistoryRef:null}),fact({lineId:'quantity-unknown',rawPackedQty:null}));
  expect(deliveryDayGroups(current,today,today).missing).toHaveLength(2);expect(deliveryDays(current,today,today)[0]!.summary.poCount).toBe(0);expect(current[0]!.effectiveDueDate).toBeNull();expect(current[0]!.originalDueDate).toBeNull();expect(deliveryPo(fact({effectiveDueDate:null,rawPackedQty:100}),today)).toMatchObject({riskStatus:'unknown',packedQty:100,pendingQty:0});
 });
 it('uses only the current effective date across year changes and includes leap day once',()=>{
  const current=rows(fact({originalDueDate:'2025-12-31',effectiveDueDate:'2026-01-01',dueRevision:2}));expect(deliveryDays(current,'2025-01-01','2025-12-31').reduce((n,d)=>n+d.summary.poCount,0)).toBe(0);expect(deliveryDays(current,'2026-01-01','2026-12-31').reduce((n,d)=>n+d.summary.poCount,0)).toBe(1);expect(deliveryDays([], '2028-01-01','2028-12-31')).toHaveLength(366);expect(deliveryDays([],'2028-02-01','2028-02-29').at(-1)!.date).toBe('2028-02-29');
 });
 it('keeps cancelled and special-closed separate without pretending they have shipped',()=>{
  const current=rows(fact(),fact({lineId:'cancelled',scopeStatus:'cancelled'}),fact({lineId:'closed',scopeStatus:'special_closed'})),filters=DeliveryCalendarFiltersSchema.parse({});
  expect(selectedDeliveryRows(current,filters).map(r=>r.lineId)).toEqual(['line-A']);expect(selectedDeliveryRows(current,{...filters,scope:'excluded'})).toHaveLength(2);expect(selectedDeliveryRows(current,{...filters,scope:'all'})).toHaveLength(3);expect(current[2]!.pendingQty).toBe(80);
 });
 it('intersects real customer, PO search and status filters and rejects duplicate scope',()=>{
  const current=rows(fact(),fact({lineId:'line-B',po:'PO-B',customer:'C2',effectiveDueDate:'2026-12-31'})),filters=DeliveryCalendarFiltersSchema.parse({customer:'C1',search:'po-a',status:'due_soon'});expect(selectedDeliveryRows(current,filters)).toHaveLength(1);expect(selectedDeliveryRows(current,{...filters,customer:'C2'})).toHaveLength(0);expect(()=>selectedDeliveryRows([...current,current[0]!],filters)).toThrow(/Duplicate/);
 });
 it('conserves known daily and monthly sums and bounds public dates/pages without silent normalization',()=>{
  const current=rows(fact({effectiveDueDate:'2026-11-02'}),fact({lineId:'B',effectiveDueDate:'2026-11-20',rawPackedQty:200}));const days=deliveryDays(current,'2026-11-01','2026-11-30'),sum=deliverySummary(current);for(const key of ['orderedQty','packedQty','pendingQty','extraQty','poCount'] as const)expect(days.reduce((n,d)=>n+d.summary[key]!,0)).toBe(sum[key]);
  expect(DeliveryDayQuerySchema.safeParse({date:'2026-02-30'}).success).toBe(false);expect(DeliveryMonthQuerySchema.safeParse({month:'2026-13'}).success).toBe(false);expect(DeliveryDayQuerySchema.safeParse({date:today,pageSize:101}).success).toBe(false);
  expect(DeliveryDayQuerySchema.safeParse({date:today,group:'late'}).success).toBe(false);expect(DeliveryDayQuerySchema.parse({date:today,group:'overdue'}).group).toBe('overdue');
  expect(DeliveryMissingQuerySchema.safeParse({year:2026,month:'2027-01'}).success).toBe(false);
 });
});
