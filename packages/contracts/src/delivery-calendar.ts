import {z} from 'zod';

export const DELIVERY_CALENDAR_VERSION='customer-delivery-calendar-v1' as const;
export const DeliveryRiskSchema=z.enum(['delivered','overdue','due_soon','pending','unknown']);
export type DeliveryRisk=z.infer<typeof DeliveryRiskSchema>;
export const DeliveryScopeSchema=z.enum(['active','paused','cancelled','special_closed']);
export type DeliveryScope=z.infer<typeof DeliveryScopeSchema>;
export const DeliveryCalendarFiltersSchema=z.object({
 search:z.string().trim().max(100).default(''),customer:z.string().trim().max(100).optional(),
 status:DeliveryRiskSchema.optional(),scope:z.enum(['current','excluded','all']).default('current'),
}).strict();
export type DeliveryCalendarFilters=z.infer<typeof DeliveryCalendarFiltersSchema>;
const calendarDate=z.iso.date().refine(value=>value>='2000-01-01'&&value<='2199-12-31','请选择2000至2199年的日期');
const snapshot={snapshotId:z.string().uuid().optional()};
const page={page:z.coerce.number().int().min(1).max(10000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(15)};
export const DeliveryYearQuerySchema=DeliveryCalendarFiltersSchema.extend({...snapshot,year:z.coerce.number().int().min(2000).max(2199)});
export const DeliveryMonthQuerySchema=DeliveryCalendarFiltersSchema.extend({...snapshot,...page,month:z.string().regex(/^20\d\d-(?:0[1-9]|1[0-2])$|^21\d\d-(?:0[1-9]|1[0-2])$/),selectedDate:calendarDate.optional()}).refine(value=>!value.selectedDate||value.selectedDate.startsWith(value.month+'-'),'所选日期须在当前月份');
export const DeliveryListGroupSchema=z.enum(['day','overdue','before-selected']);
export type DeliveryListGroup=z.infer<typeof DeliveryListGroupSchema>;
export const DeliveryDayQuerySchema=DeliveryCalendarFiltersSchema.extend({...snapshot,...page,date:calendarDate,group:DeliveryListGroupSchema.default('day')});
export const DeliveryMissingKindSchema=z.enum(['all','undated','quantity']);
export type DeliveryMissingKind=z.infer<typeof DeliveryMissingKindSchema>;
export const DeliveryMissingQuerySchema=DeliveryCalendarFiltersSchema.extend({...snapshot,...page,kind:DeliveryMissingKindSchema.default('all'),year:z.coerce.number().int().min(2000).max(2199).optional(),month:z.string().regex(/^(?:20|21)\d\d-(?:0[1-9]|1[0-2])$/).optional()}).refine(value=>!value.year||!value.month||value.month.startsWith(String(value.year)+'-'),'缺项查询的年份和月份须一致');
/** Original current facts only. No implied actual shipping occurrence date. */
export type DeliveryPoFact={
 orderId:string;lineId:string;businessOrderNo:string|null;designStyleNo:string;po:string|null;color:string;customer:string;productType:string|null;
 orderedQty:number|null;rawPackedQty:number|null;packingRevision:string|null;
 effectiveDueDate:string|null;originalDueDate:string|null;factoryDueDate:string|null;dueRevision:number;
 dueHistoryRef:string|null;hasRecordedDueChange:boolean;reminderDays:number|null;scopeStatus:DeliveryScope;sourceRefs:string[];unknownReasons:string[];
 styleImageUrl?:string|null;styleImageState?:'available'|'empty'|'unavailable'|'failed';
};
export type DeliveryPo=DeliveryPoFact&{packedQty:number|null;pendingQty:number|null;extraQty:number|null;riskStatus:DeliveryRisk};
/** Nullable whole values and separate known subtotals never impersonate complete totals. */
export type DeliverySummary={
 poCount:number;orderedQty:number|null;packedQty:number|null;pendingQty:number|null;extraQty:number|null;
 knownOrderedQty:number;comparableOrderedQty:number;knownPackedQty:number;knownPendingQty:number;knownExtraQty:number;
 unknownQuantityPoCount:number;missingDuePoCount:number;overduePoCount:number;overduePendingQty:number;
};
export type DeliveryDay={date:string;summary:DeliverySummary;states:Partial<Record<DeliveryRisk,number>>};
export type DeliveryCoverage={kind:'period';from:string;to:string}|{kind:'day';date:string};
export type DeliveryRelatedDay={date:string;overdue:DeliverySummary;beforeSelected:DeliverySummary;quantityUnknownPoCount:number};
export type DeliverySnapshot={
 result:{ruleVersion:typeof DELIVERY_CALENDAR_VERSION};watermark:string;asOf:string;asOfBusinessDate:string;
 clockRevision:number;scenarioId:string|null;coverage:DeliveryCoverage;relatedDay?:DeliveryRelatedDay;filters:DeliveryCalendarFilters;rows:DeliveryPo[];permissionOrderIds:string[];
};
export type DeliveryReadBasis={
 asOf:string;asOfBusinessDate:string;snapshotId:string;createdAt:string;expiresAt:string;
 freshness:'current'|'query-snapshot';filterEcho:DeliveryCalendarFilters;datePrecision:'date';dateRole:'effective_customer_shipping_date';
 quantityRole:'current_cumulative_packing_grouped_by_customer_due_date';
};
export type DeliveryYearResponse=DeliveryReadBasis&{year:number;yearSummary:DeliverySummary;months:Array<{month:string;summary:DeliverySummary;days:DeliveryDay[]}>;missingSummary:DeliverySummary;undatedSummary?:DeliverySummary;excludedSummary:DeliverySummary;focusMonth:string;focusDays:DeliveryDay[];customers?:string[]};
export type DeliveryMonthResponse=DeliveryReadBasis&{yearMonth:string;monthSummary:DeliverySummary;days:DeliveryDay[];missingSummary:DeliverySummary;undatedSummary?:DeliverySummary;excludedSummary:DeliverySummary;selectedDay?:DeliveryDayResponse;relatedQuantityUnknownPoCount?:number;customers?:string[]};
export type DeliveryDayResponse=DeliveryReadBasis&{selectedDate:string;daySummary:DeliverySummary;listGroup:DeliveryListGroup;listSummary:DeliverySummary;items:DeliveryPo[];total:number;page:number;pageSize:number;overdueAsOfTodaySummary:DeliverySummary;pendingBeforeSelectedNotYetOverdueSummary:DeliverySummary;missingSummary:DeliverySummary;dateChangeSummary:{poCount:number}};
export type DeliveryMissingResponse=DeliveryReadBasis&{items:DeliveryPo[];total:number;page:number;pageSize:number;missingSummary:DeliverySummary;kind:DeliveryMissingKind};
