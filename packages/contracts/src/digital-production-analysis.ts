import {z} from 'zod';
import {PRODUCTION_STATISTICS_DRILLS} from './production-statistics.js';
export const DigitalAnalysisFilterSchema=z.object({
 from:z.iso.date(),to:z.iso.date(),customer:z.string().trim().max(100).default(''),category:z.string().trim().max(100).default(''),
 role:z.string().trim().max(100).default(''),designer:z.string().uuid().optional(),page:z.coerce.number().int().min(1).max(100000).default(1),
 assigneeId:z.string().uuid().optional(),
 scope:z.enum(['created','published','completed','snapshot','revisions']).optional(),
 metric:z.enum(['all','shipping','active','pending','unassigned','blocked','overdue','sla','late','measurable','materials','handover','other_wait','missing','unverified','waiting','unknown_wait']).optional(),
 cycle:z.enum(['under_day','one_three','three_seven','over_week']).optional(),
 node:z.string().trim().max(100).optional(),origin:z.enum(['客户新增要求','未达原要求','内部发现']).optional(),
 view:z.literal('production').optional(),snapshotId:z.string().uuid().optional(),factoryId:z.string().uuid().optional(),
 lineId:z.string().uuid().optional(),salesYear:z.coerce.number().int().min(1000).max(9999).optional(),salesSeries:z.string().regex(/^P(0[1-9]|1[0-2])$/).optional(),
 primaryMerchandiserId:z.string().uuid().optional(),secondaryMerchandiserId:z.string().uuid().optional(),
 drillLineId:z.string().uuid().optional(),drillOrderId:z.string().uuid().optional(),drillFactoryId:z.string().uuid().optional(),drillMetric:z.enum(PRODUCTION_STATISTICS_DRILLS).optional(),
}).strict().refine(value=>value.to>=value.from,'结束日期不能早于开始日期')
 .superRefine((value,context)=>{
  const productionOnly=['snapshotId','factoryId','lineId','salesYear','salesSeries','primaryMerchandiserId','secondaryMerchandiserId','drillLineId','drillOrderId','drillFactoryId','drillMetric'] as const;
  if(value.view!=='production'&&productionOnly.some(key=>value[key]!==undefined))context.addIssue({code:'custom',message:'这些筛选仅用于当前生产查询'});
  if(value.view==='production'&&(value.role||value.node||value.origin||value.cycle||value.assigneeId||value.metric&&value.metric!=='all'||value.scope&&value.scope!=='snapshot'))context.addIssue({code:'custom',message:'当前生产查询不混用任务岗位或期间筛选'});
 });
export const DigitalAnalysisNoteSchema=z.object({filters:DigitalAnalysisFilterSchema,conclusion:z.string().trim().min(1).max(2000),action:z.string().trim().min(1).max(2000),observeAt:z.iso.datetime({offset:true}),taskIds:z.array(z.string().uuid()).min(1).max(50)}).strict();
export type DigitalAnalysisFilters=z.infer<typeof DigitalAnalysisFilterSchema>;
export type DigitalAnalysisNote=z.infer<typeof DigitalAnalysisNoteSchema>;
export type DigitalAnalysisEvent={id:string;kind:string;at:string|null;recordedAt:string;quality:string;actorId:string;actorName?:string;correctsId:string|null;payload:Record<string,unknown>};
// round retains the original task route version for compatibility; use sourceRound for development.
export type DigitalAnalysisRow={deadlineMode?:"duration"|"date_target";businessTime?:{now:string;scenarioId:string|null;revision:number};taskId:string;sourceId:string|null;orderId:string|null;styleNo:string;customer:string;category:string;requiredRole:string;assigneeId:string|null;assigneeName:string|null;nodeKey:string;label:string;round:number;sourceRound:number|null;instructionVersion:number|null;canReadSourceRound:boolean;state:string;createdAt:string;enteredAt:string|null;completedAt:string|null;enteredQuality:string;completedQuality:string;dueAt:string|null;policyVersion:number|null;sourcePublishedAt?:string|null;assignmentHistory:{at:string;actorName:string;beforeName:string|null;afterName:string|null}[];delegations:{name:string;from:string;expiresAt:string;revokedAt:string|null}[];events:DigitalAnalysisEvent[];pendingConditions:string[];materialSupplyPending?:boolean;handlingSeconds:number|null;slaIncluded:boolean;onTime:boolean|null;exclusion:string|null;waitingSeconds:number;unknownWaiting:number;missingTime:boolean;unverifiedTime:boolean;registrationDelaySeconds:number|null};
export type DigitalAnalysisOverview={
 period:{newStyles:number;shippedRounds:number;completed:number;slaDenominator:number;onTime:number;measurable:number;missingTime:number;unverifiedTime:number;handlingSeconds:number;waitingSeconds:number;unknownWaiting:number;cycleBuckets:Array<{key:'under_day'|'one_three'|'three_seven'|'over_week';label:string;count:number}>};
 snapshot:{active:number;pending:number;unassigned:number;blocked:number;overdue:number;materialPending:number;handoverPending:number;otherBlocked:number};
 nodes:Array<{key:string;label:string;overdue:number;completed:number;slaDenominator:number;onTime:number}>;
};
export type DigitalAnalysisResult={
 ruleVersion:string;asOf:string;filters:DigitalAnalysisFilters;canExport:boolean;canRecord:boolean;page:number;total:number;
 summary:{newStyles:number;materialPending:number;handoverPending:number;tasks:number;cancelled:number;completed:number;slaDenominator:number;onTime:number;measurable:number;handlingSeconds:number;waitingSeconds:number;unknownWaiting:number;missingTime:number;unverifiedTime:number;correctedTasks:number};
 rounds:{sourceId:string;round:number;origin:string;categories:string[];publishedAt:string;affectedNodes?:string[];customerComment?:string;internalProblem?:string;explanation?:string}[];
 rows:DigitalAnalysisRow[];
 overview?:DigitalAnalysisOverview;
 people?:Array<{id:string;name:string|null}>;
 notes:{id:string;author:string;createdAt:string;conclusion:string;action:string;observeAt:string;filters:DigitalAnalysisFilters;taskIds:string[];ruleVersion:string;asOf?:string}[];
};
