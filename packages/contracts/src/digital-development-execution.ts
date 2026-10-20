import {DevelopmentReturnIssueSchema,type DevelopmentReturnIssue} from "./digital-development-amendments.js";
import {DEVELOPMENT_REVISION_NODES,DEVELOPMENT_PROBLEM_CATEGORIES} from "./digital-development-rounds.js";
import { z } from "zod";
export const MaterialVerificationEntrySchema=z.object({
 materialId:z.string().uuid(),usage:z.enum(["pending","use","unused"]),
 physical:z.boolean(),quantity:z.boolean(),color:z.boolean(),specification:z.boolean(),
 note:z.string().trim().max(1000),confirmedWith:z.string().trim().max(100),
}).strict();
export const SaveMaterialVerificationSchema=z.object({
 returnIssues:z.array(DevelopmentReturnIssueSchema).max(100).optional(),
 note:z.string().trim().max(1000).default(""),result:z.enum(["通过","缺项退回"]).default("通过"),
 taskId:z.string().uuid(),expectedDocumentVersion:z.number().int().positive(),
 expectedVersion:z.number().int().nonnegative(),entries:z.array(MaterialVerificationEntrySchema).max(100),
}).strict().superRefine((v,c)=>{if(new Set(v.entries.map(r=>r.materialId)).size!==v.entries.length)c.addIssue({code:"custom",message:"材料确认行不能重复"});});
export type MaterialVerificationEntry=z.infer<typeof MaterialVerificationEntrySchema>;
export type MaterialVerification={returnIssues?:DevelopmentReturnIssue[];note:string;result:"通过"|"缺项退回";version:number;documentVersion:number;taskId:string|null;entries:Array<MaterialVerificationEntry&{changedBy:string|null;changedAt:string|null;invalidated:string[]}>};
export const DevelopmentDispatchSchema=z.object({expectedVersion:z.number().int().nonnegative(),patternWorkerId:z.string().uuid(),cuttingWorkerId:z.string().uuid(),sewingWorkerId:z.string().uuid(),reassignExisting:z.boolean().optional(),confirmExecution:z.object({roundId:z.string().uuid(),version:z.number().int().positive(),amount:z.string().regex(/^(?:0|[1-9]\d{0,16})(?:\.\d{1,3})?$/).optional()}).strict().optional()}).strict();
export const DevelopmentCheckSchema=z.object({returnIssues:z.array(DevelopmentReturnIssueSchema).max(100).optional(),expectedVerificationVersion:z.number().int().positive().optional(),taskId:z.string().uuid(),result:z.enum(["通过","缺项退回"]),note:z.string().trim().max(1000),items:z.array(z.object({materialId:z.string().uuid(),physical:z.boolean(),quantity:z.boolean(),color:z.boolean(),specification:z.boolean()}).strict()).max(100)}).strict().superRefine((value,ctx)=>{if(value.result==="缺项退回"&&!value.note&&!value.returnIssues?.length)ctx.addIssue({code:"custom",path:["note"],message:"请说明缺项"});if(new Set(value.items.map(item=>item.materialId)).size!==value.items.length)ctx.addIssue({code:"custom",path:["items"],message:"核配物料不能重复"});});
export const DevelopmentWorkSchema=z.object({taskId:z.string().uuid(),note:z.string().trim().max(1000),attachmentIds:z.array(z.string().uuid()).max(20)}).strict();
export const DevelopmentFabricReportSchema=z.object({materialIds:z.array(z.string().uuid()).min(1).max(100).optional(),recommendation:z.enum(["正常","建议停用"]),note:z.string().trim().min(1).max(1000),attachmentIds:z.array(z.string().uuid()).min(1).max(10)}).strict();
export const DevelopmentFabricDecisionSchema=z.object({expectedDecisionId:z.string().uuid().nullable().optional(),reportId:z.string().uuid(),decision:z.enum(["允许使用","停止使用"]),note:z.string().trim().min(1).max(1000)}).strict();
export type DevelopmentDispatch=z.infer<typeof DevelopmentDispatchSchema>;
export type DevelopmentCheck=z.infer<typeof DevelopmentCheckSchema>;
export type DevelopmentWork=z.infer<typeof DevelopmentWorkSchema>;
export const DevelopmentRouteActionSchema=z.object({attachmentIds:z.array(z.string().uuid()).max(20).optional(),returnNodes:z.array(z.enum(DEVELOPMENT_REVISION_NODES)).max(6).optional(),problemCategories:z.array(z.enum(DEVELOPMENT_PROBLEM_CATEGORIES)).max(8).optional(),craftExecution:z.enum(["内部","外发"]).nullable(),taskId:z.string().uuid(),note:z.string().trim().max(2000),result:z.enum(["通过","退回"]),nextAssigneeId:z.string().uuid().nullable(),sentDate:z.iso.date().nullable(),trackingNo:z.string().trim().max(100).nullable()}).strict();
export const DevelopmentPatternOrderSchema=z.object({categoryId:z.string().uuid(),priceVersion:z.number().int().positive()}).strict();
export const DevelopmentCustomerSampleSchema=z.object({routeVersion:z.number().int().positive(),note:z.string().trim().min(1).max(2000)}).strict();
