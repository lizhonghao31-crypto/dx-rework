import {z} from 'zod';
export const DigitalAnalysisFilterSchema=z.object({
 from:z.iso.date(),to:z.iso.date(),customer:z.string().trim().max(100).default(''),category:z.string().trim().max(100).default(''),
 role:z.string().trim().max(100).default(''),designer:z.string().uuid().optional(),page:z.coerce.number().int().min(1).max(100000).default(1),
}).strict().refine(value=>value.to>=value.from,'结束日期不能早于开始日期');
export const DigitalAnalysisNoteSchema=z.object({filters:DigitalAnalysisFilterSchema,conclusion:z.string().trim().min(1).max(2000),action:z.string().trim().min(1).max(2000),observeAt:z.iso.datetime({offset:true}),taskIds:z.array(z.string().uuid()).min(1).max(50)}).strict();
export type DigitalAnalysisFilters=z.infer<typeof DigitalAnalysisFilterSchema>;
export type DigitalAnalysisNote=z.infer<typeof DigitalAnalysisNoteSchema>;
export type DigitalAnalysisEvent={id:string;kind:string;at:string|null;recordedAt:string;quality:string;actorId:string;actorName?:string;correctsId:string|null;payload:Record<string,unknown>};
export type DigitalAnalysisRow={taskId:string;sourceId:string|null;orderId:string|null;styleNo:string;customer:string;category:string;requiredRole:string;assigneeId:string|null;assigneeName:string|null;nodeKey:string;label:string;round:number;state:string;createdAt:string;enteredAt:string|null;completedAt:string|null;enteredQuality:string;completedQuality:string;dueAt:string|null;policyVersion:number|null;assignmentHistory:{at:string;actorName:string;beforeName:string|null;afterName:string|null}[];delegations:{name:string;from:string;expiresAt:string;revokedAt:string|null}[];events:DigitalAnalysisEvent[];pendingConditions:string[];handlingSeconds:number|null;slaIncluded:boolean;onTime:boolean|null;exclusion:string|null;waitingSeconds:number;unknownWaiting:number;missingTime:boolean;unverifiedTime:boolean;registrationDelaySeconds:number|null};
export type DigitalAnalysisResult={
 ruleVersion:string;asOf:string;filters:DigitalAnalysisFilters;canExport:boolean;canRecord:boolean;page:number;total:number;
 summary:{newStyles:number;materialPending:number;handoverPending:number;tasks:number;cancelled:number;completed:number;slaDenominator:number;onTime:number;measurable:number;handlingSeconds:number;waitingSeconds:number;unknownWaiting:number;missingTime:number;unverifiedTime:number;correctedTasks:number};
 rounds:{sourceId:string;round:number;origin:string;categories:string[];publishedAt:string}[];
 rows:DigitalAnalysisRow[];
 notes:{id:string;author:string;createdAt:string;conclusion:string;action:string;observeAt:string;filters:DigitalAnalysisFilters;taskIds:string[];ruleVersion:string}[];
};
