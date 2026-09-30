import {z} from "zod";
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v);
export const WorkAnalysisQuerySchema=z.object({q:z.string().trim().max(100).default(''),page:z.coerce.number().int().min(1).max(100000).default(1),from:day.optional(),to:day.optional(),group:z.string().max(80).default('all')}).strict().refine(v=>!v.from||!v.to||v.from<=v.to,{message:'日期范围无效'});
export type WorkAnalysisQuery=z.infer<typeof WorkAnalysisQuerySchema>;
const price=z.string().regex(/^\d+(\.\d{1,4})?$/).nullable();
const instant=z.string().datetime().nullable();
const line=z.object({position:z.number().int(),styleNo:z.string().nullable(),color:z.string().nullable(),quantity:z.string(),unitPrice:price});
const stage=z.object({id:z.string(),version:z.number().int(),recordedAt:instant,lines:z.array(line)});
export const QuoteAnalysisResponseSchema=z.object({asOf:z.string().datetime(),filters:WorkAnalysisQuerySchema,total:z.number().int(),missingInitialCount:z.number().int(),items:z.array(z.object({id:z.string().uuid(),orderNo:z.string(),archived:z.boolean(),initialPriceExpected:z.boolean().optional(),initial:stage,ie:z.array(stage),approved:z.array(stage)}))});
export type QuoteAnalysisResponse=z.infer<typeof QuoteAnalysisResponseSchema>;
export const WorkflowAnalysisQuerySchema=WorkAnalysisQuerySchema.safeExtend({
 node:z.string().max(80).default(''),state:z.enum(['all','waiting','closed']).default('all'),
 roundtrip:z.enum(['all','yes','repeated','no']).default('all'),issue:z.enum(['all','missing']).default('all'),
 sort:z.enum(['longest','shortest']).default('longest'),snapshot:z.enum(['current','period_end']).default('current'),
});
export type WorkflowAnalysisQuery=z.infer<typeof WorkflowAnalysisQuerySchema>;
const transition=z.object({id:z.string(),from:z.string().nullable(),to:z.string().nullable(),action:z.string(),changesNode:z.boolean(),enteredAt:instant,leftAt:instant,actorName:z.string().nullable().default(null),reason:z.string().nullable().default(null),returned:z.boolean().default(false)});
const workflowNodeMetric=z.object({status:z.string(),flowCount:z.number().int().nonnegative(),averageFlowSeconds:z.number().nonnegative().nullable(),openCount:z.number().int().nonnegative(),longestOpenSeconds:z.number().nonnegative().nullable()});
export const WorkflowAnalysisResponseSchema=z.object({asOf:z.string().datetime(),filters:WorkflowAnalysisQuerySchema,total:z.number().int(),waitingCount:z.number().int().default(0),roundtripCount:z.number().int().default(0),repeatedCount:z.number().int().default(0),longestEnteredAt:instant.default(null),missingEntryCount:z.number().int(),enteredCount:z.number().int().nonnegative().default(0),completedInRangeCount:z.number().int().nonnegative().default(0),openAtEndCount:z.number().int().nonnegative().default(0),averageCycleSeconds:z.number().nonnegative().nullable().default(null),cycleSampleCount:z.number().int().nonnegative().default(0),nodeMetrics:z.array(workflowNodeMetric).default([]),groups:z.array(z.object({key:z.string(),count:z.number().int(),missingEntryCount:z.number().int()})),items:z.array(z.object({id:z.string().uuid(),kind:z.enum(['sourcing','rework']),label:z.string(),status:z.string(),independentFinance:z.boolean(),cumulativeNodeSeconds:z.number().nonnegative().optional(),totalElapsedSeconds:z.number().nonnegative().optional(),enteredAt:instant,createdAt:instant.default(null),styleNo:z.string().nullable().default(null),orderNo:z.string().nullable().default(null),
 submitterName:z.string().nullable().default(null),handlers:z.array(z.string()).default([]),roundtripCount:z.number().int().default(0),
 execution:z.array(z.object({taskId:z.string(),processName:z.string(),people:z.array(z.string()),reports:z.array(z.object({id:z.string(),quantity:z.string(),at:instant,actorName:z.string().nullable(),rejected:z.boolean()}))})).default([]),history:z.array(transition)}))});
export type WorkflowAnalysisResponse=z.infer<typeof WorkflowAnalysisResponseSchema>;
export const DiagnosticOutcomeSchema=z.enum(['success','validation','permission','technical']);
export const DiagnosticsResponseSchema=z.object({asOf:z.string().datetime(),filters:WorkAnalysisQuerySchema,recordingSince:instant,total:z.number().int(),recordCount:z.string(),groups:z.array(z.object({operation:z.string(),outcome:DiagnosticOutcomeSchema,code:z.string(),count:z.string(),replayedCount:z.string(),timingSampleCount:z.string(),averageDurationMs:z.number().nonnegative().nullable(),maxDurationMs:z.number().nonnegative().nullable(),lastAt:z.string().datetime()})),revisions:z.array(z.object({action:z.string(),field:z.string(),count:z.string()}))});
export type DiagnosticsResponse=z.infer<typeof DiagnosticsResponseSchema>;
