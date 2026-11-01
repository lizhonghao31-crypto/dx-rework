import {z} from 'zod';
import {isCalendarDate} from './series-calendar.js';

export const SERIES_PLAN_RULE='series-plan-20261101-v1';
export const SeriesDateSchema=z.string().refine(isCalendarDate,'请输入有效日期');
export const SERIES_MILESTONES=[
 {key:'design_handover',label:'设计资料交接',role:'设计'},
 {key:'material_investment',label:'跟单投面料',role:'订单跟单'},
 {key:'fabric_receipt',label:'面料实际到仓',role:'仓管'},
 {key:'color_confirmation',label:'对色完成',role:'订单跟单（登记对色反馈）'},
 {key:'client_sample_approval',label:'客户最终批复',role:'设计（登记客户反馈）'},
 {key:'accessories_ready',label:'辅料实物备齐',role:'仓管'},
 {key:'style_label_ready',label:'款号唛实物备齐',role:'仓管'},
 {key:'processing_dispatch',label:'发加工',role:'仓管'},
 {key:'planned_shipment',label:'系统计划出货',role:'订单跟单'},
] as const;
export const SeriesMilestoneKeySchema=z.enum(SERIES_MILESTONES.map(x=>x.key));
export type SeriesMilestoneKey=z.infer<typeof SeriesMilestoneKeySchema>;
export type SeriesRoute='A'|'B';
export const SeriesProfileInputSchema=z.object({
 customerCode:z.string().trim().min(1).max(100).nullable().default(null),expectedVersion:z.number().int().nonnegative(),
 monthOffset:z.number().int().min(-12).max(0),shippingDay:z.number().int().min(1).max(31).nullable(),reason:z.string().trim().min(1).max(1000),
}).strict();
export const SeriesContextInputSchema=z.object({expectedOrderVersion:z.number().int().positive(),
 salesYear:z.number().int().min(1000).max(9999).nullable(),salesSeries:z.enum(['P01','P02','P03','P04','P05','P06','P07','P08','P09','P10','P11','P12']).nullable(),
 requiresColorMatching:z.boolean().nullable(),reason:z.string().trim().min(1).max(1000),
}).strict();
export const SeriesPreviewInputSchema=z.object({expectedOrderVersion:z.number().int().positive(),expectedPlanRevision:z.number().int().nonnegative(),
 plannedShippingDate:SeriesDateSchema.nullable().default(null),
 selectedNodeIds:z.array(z.string().min(1).max(220)).max(500).nullable().default(null),
 plannedDurations:z.partialRecord(z.enum(['fabric_inspection','fabric_preshrink','size_review','instruction','pattern_marker','cutting','post_cut_craft','post_cut_check','dispatch','factory_production','return_logistics','garment_qc','packing']),z.number().int().min(1).max(525600)).default({}),
}).strict();
export const ApplySeriesPlanSchema=SeriesPreviewInputSchema.extend({previewToken:z.string().max(512),reason:z.string().trim().min(1).max(1000),acceptSuggestedDate:z.boolean().default(false),requestId:z.uuid().nullable().default(null)}).strict();
export const SeriesRequestDecisionSchema=z.object({reason:z.string().trim().min(1).max(1000)}).strict();
export const RequestSeriesPlanSchema=SeriesPreviewInputSchema.extend({reason:z.string().trim().min(1).max(1000)}).strict();
export type SeriesPreviewInput=z.infer<typeof SeriesPreviewInputSchema>;
export type SeriesProfile={customerCode:string|null;version:number;monthOffset:number;shippingDay:number|null;suggestionDay:15;configured:boolean};
export type SeriesMilestone={id:string;key:SeriesMilestoneKey;label:string;role:string;scopeRef:string;offsetDays:number;templateDate:string;
 targetDate:string|null;retainedFromRevision:number|null;frozenReason:string|null};
export type SeriesObservedFact={key:SeriesMilestoneKey;scopeRef:string;sourceDomain:string;sourceRecordId:string;sourceVersion:number;
 completed:boolean;started:boolean;occurredAt:string|null;occurredDate:string|null;precision:'instant'|'date'|'unknown';reason:string|null};
/** Internal producer contract. PR05 supplies native evidence; there is no generic HTTP fact writer. */
export const SeriesSourceEventSchema=z.object({eventId:z.uuid(),orderId:z.uuid(),key:SeriesMilestoneKeySchema,scopeRef:z.string().trim().min(1).max(150),
 sourceDomain:z.enum(['development','bulk-preparation','production-instruction','cutting','factory-flow','receiving']),sourceRecordId:z.uuid(),sourceVersion:z.number().int().positive(),
 occurredAt:z.iso.datetime({offset:true}).nullable(),occurredDate:SeriesDateSchema.nullable(),precision:z.enum(['instant','date','unknown']),
 supersedesEventId:z.uuid().nullable(),voided:z.boolean().default(false),reason:z.string().trim().min(1).max(1000),
}).strict().superRefine((x,c)=>{
 if(x.precision==='instant'?!x.occurredAt||x.occurredDate!==null:x.precision==='date'?!x.occurredDate||x.occurredAt!==null:x.occurredAt!==null||x.occurredDate!==null)c.addIssue({code:'custom',path:['precision'],message:'时间精度与实际依据不符'});
});
export type SeriesSourceEvent=z.infer<typeof SeriesSourceEventSchema>;
export type PlanningDependency={id:string;label:string;scopeRef:string;dependsOn:string[];anchorDate:string|null;durationMinutes:number|null;basis:'confirmed'|'estimate'|'unknown';targetDate?:string|null};
export type PlanningDependencyResult={id:string;label:string;scopeRef:string;startAt:string|null;endAt:string|null;lateMinutes:number|null;basis:'confirmed'|'estimate'|'unknown';reasons:string[]};
export type SeriesRisk={code:string;message:string;nodeId:string|null;tone:'danger'|'warning'|'unknown'};
export type SeriesPlanSnapshot={revision:number;plannedShippingDate:string;route:SeriesRoute;salesYear:number|null;salesSeries:string|null;
 profile:SeriesProfile;milestones:SeriesMilestone[];plannedDurations:SeriesPreviewInput['plannedDurations'];reason:string;createdBy:string;recordedAt:string;
 /** Frozen adoption evidence; absent in a legacy snapshot is unknown, never a recomputed pass. */
 planningGraph?:PlanningDependency[];dependencies?:PlanningDependencyResult[];risks?:SeriesRisk[];slaSnapshotRef?:{id:string;revision:number}|null};
export type SeriesPlanPreview={orderId:string;input:SeriesPreviewInput;orderVersion:number;planRevision:number;profile:SeriesProfile;
 candidateDate:string|null;basis:'manual'|'configured-series'|'series-suggestion'|'unavailable';route:SeriesRoute|null;
 previewToken:string;milestones:SeriesMilestone[];facts:SeriesObservedFact[];selectedNodeIds:string[];risks:SeriesRisk[];
 planningGraph:PlanningDependency[];dependencies:PlanningDependencyResult[];sourceRevisionSet:Record<string,unknown>};
export type SeriesPlanState={orderId:string;serverToday:string;orderVersion:number;sourceId:string|null;canEditSeries:boolean;canApply:boolean;canRequest:boolean;active:boolean;
 salesYear:number|null;salesSeries:string|null;requiresColorMatching:boolean|null;profile:SeriesProfile;customerDates:Array<{lineId:string;poNumber:string|null;color:string;date:string|null;version:number}>;
 current:SeriesPlanSnapshot|null;history:SeriesPlanSnapshot[];facts:SeriesObservedFact[];risks:SeriesRisk[];pendingRequests:Array<{requestId:string;requestedBy:string;reason:string;candidateDate:string|null;requestedAt:string;input:SeriesPreviewInput;stale:boolean}>};
