import {z} from 'zod';

/** Rolling observation windows, independent of the old Shanghai calendar-day metric. */
export const QC_PROGRESS_CAPABILITY='qc-production-progress';
export const QC_PROGRESS_HOURS=Object.freeze({remind:48,escalate:72});
export const QcStageObservationSchema=z.object({
 lineId:z.string().uuid(),
 state:z.enum(['not_started','working','stopped','finished']),
 cuttingPercent:z.number().int().min(0).max(100).nullable(),
 sewingPercent:z.number().int().min(0).max(100).nullable(),
 ironingPercent:z.number().int().min(0).max(100).nullable(),
 reason:z.string().trim().max(2000).default(''),
 additionalFinishedQuantity:z.number().int().positive().max(10000000).optional(),
}).strict().superRefine((v,c)=>{
 if((v.state==='not_started'||v.state==='stopped')&&!v.reason)c.addIssue({code:'custom',path:['reason'],message:'尚未开工或暂停须说明真实原因'});
 if(v.state==='not_started'&&[v.cuttingPercent,v.sewingPercent,v.ironingPercent].some(n=>n!==null&&n!==0))c.addIssue({code:'custom',message:'尚未开工不能填写已完成比例'});
 if(v.state==='not_started'&&v.additionalFinishedQuantity!==undefined)c.addIssue({code:'custom',message:'尚未开工不能新增成品量'});
});
export const SubmitQcProgressSchema=z.object({
 submissionId:z.string().uuid(),factoryDecisionId:z.string().uuid().nullable(),
 expectedScopeRevision:z.string().regex(/^[0-9a-f]{64}$/),expectedProgressRevision:z.number().int().nonnegative(),
 kind:z.enum(['progress','photos']),relatedProgressRecordId:z.string().uuid().nullable().default(null),collectedAt:z.iso.datetime({offset:true}).nullable(),
 observations:z.array(QcStageObservationSchema).max(100),
 criticalEvents:z.array(z.enum(['cut_start','first_piece'])).max(2).default([]),
 attachmentIds:z.array(z.string().uuid()).max(10).default([]),note:z.string().trim().max(2000).default(''),
}).strict().superRefine((v,c)=>{
 if(v.kind==='progress'&&v.relatedProgressRecordId!==null)c.addIssue({code:'custom',message:'新进度不能冒充另一条原记录'});
 if(v.kind==='progress'&&(!v.collectedAt||!v.observations.length))c.addIssue({code:'custom',message:'生产进度须有真实采集时间和本次观察范围'});
 if(v.kind==='photos'&&(!v.relatedProgressRecordId||v.collectedAt!==null||v.observations.length||v.criticalEvents.length||!v.attachmentIds.length))c.addIssue({code:'custom',message:'补传照片不改变进度或采集时间，请选择已有进度范围'});
 if(v.criticalEvents.length&&!v.attachmentIds.length)c.addIssue({code:'custom',message:'开裁或首件须关联本次现场照片'});
 if(new Set(v.observations.map(o=>o.lineId)).size!==v.observations.length||new Set(v.attachmentIds).size!==v.attachmentIds.length||new Set(v.criticalEvents).size!==v.criticalEvents.length)c.addIssue({code:'custom',message:'PO、照片或关键事件不能重复'});
});
export type SubmitQcProgress=z.infer<typeof SubmitQcProgressSchema>;
export type QcStageObservation=z.infer<typeof QcStageObservationSchema>;
export type QcProgressClock={state:'unknown'|'not_due'|'due'|'escalated'|'finished';basis:'start'|'progress'|'unknown';anchor:string|null;remindAt:string|null;escalateAt:string|null;windowKey:string|null;reason:string|null};
export function qcProgressClock(input:{trackingId:string|null;startedAt:string|null;latestProgressId:string|null;latestCollectedAt:string|null;finished:boolean},asOf:string):QcProgressClock{
 const now=Date.parse(asOf),hasProgress=Boolean(input.latestCollectedAt&&(!input.startedAt||Date.parse(input.latestCollectedAt)>=Date.parse(input.startedAt)));
 const anchor=hasProgress?input.latestCollectedAt:input.startedAt,basis=hasProgress?'progress':input.startedAt?'start':'unknown';
 if(input.finished)return {state:'finished',basis,anchor,remindAt:null,escalateAt:null,windowKey:null,reason:null};
 if(!input.trackingId||!anchor||!Number.isFinite(now)||!Number.isFinite(Date.parse(anchor))||Date.parse(anchor)>now)return {state:'unknown',basis:'unknown',anchor:null,remindAt:null,escalateAt:null,windowKey:null,reason:'缺少可信的生产监督起点或现场采集时间，原产量和历史仍保留'};
 const remindAt=new Date(Date.parse(anchor)+QC_PROGRESS_HOURS.remind*3600000).toISOString(),escalateAt=new Date(Date.parse(anchor)+QC_PROGRESS_HOURS.escalate*3600000).toISOString();
 return {state:now>=Date.parse(escalateAt)?'escalated':now>=Date.parse(remindAt)?'due':'not_due',basis,anchor,remindAt,escalateAt,windowKey:hasProgress&&input.latestProgressId?`progress:${input.latestProgressId}`:`start:${input.trackingId}`,reason:null};
}
export type QcProgressRecord={recordId:string;relatedProgressRecordId:string|null;revision:number;kind:'progress'|'photos';collectedAt:string|null;recordedAt:string;actorName:string;observations:Array<QcStageObservation&{allocationQuantity:number}>;criticalEvents:string[];attachmentIds:string[];reportIds:string[];note:string};
export type QcProductionExecution={productionId:string;factoryDecisionId:string|null;supplierName:string;status:string;scopeRevision:string;progressRevision:number;trackingId:string|null;trackingStartedAt:string|null;trackingBasis:string|null;clock:QcProgressClock;lineClocks:Array<{lineId:string;clock:QcProgressClock}>;windows:Array<{key:string;lineIds:string[];clock:QcProgressClock}>;canRecord:boolean;lines:Array<{lineId:string;position:number;poNumber:string|null;color:string;quantity:number;completedQuantity:number}>;records:QcProgressRecord[]};
export type QcProductionProgressSheet={viewerId:string;orderId:string;asOf:string;canManage:boolean;canRecord:boolean;paused:boolean;qcUserId:string|null;qcName:string|null;qualityLeadId:string|null;qualityLeadName:string|null;settingsVersion:number;archivedExecutions?:Array<{factoryDecisionId:string|null;supplierName:string;records:QcProgressRecord[]}>;executions:QcProductionExecution[]};
export const QcSupervisionSettingsSchema=z.object({expectedVersion:z.number().int().nonnegative(),qualityLeadId:z.string().uuid().nullable()}).strict();
export const QcAdoptSupervisionSchema=z.object({factoryDecisionId:z.string().uuid().nullable(),expectedScopeRevision:z.string().regex(/^[0-9a-f]{64}$/),reason:z.string().trim().min(1).max(2000)}).strict();
