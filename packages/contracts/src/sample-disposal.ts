import {z} from 'zod';
import {SampleMoneySchema,SampleStatusSchema} from './samples.js';
const version=z.number().int().positive(),reason=z.string().trim().min(1).max(2000),recipient=z.string().trim().min(1).max(200);
const money=SampleMoneySchema.refine(value=>!/^0(?:\.0{1,2})?$/.test(value),'金额必须大于零');
const proofs=z.array(z.string().uuid()).min(1).max(20).refine(values=>new Set(values).size===values.length);
export const SampleDisposalRequestSchema=z.discriminatedUnion('type',[
 z.object({version,type:z.literal('sale'),recipient,amount:money,proofAttachmentIds:proofs}).strict(),
 z.object({version,type:z.literal('gift'),recipient,proofAttachmentIds:proofs}).strict(),
 z.object({version,type:z.literal('scrap'),reason,proofAttachmentIds:proofs}).strict(),
 z.object({version,type:z.literal('loss'),reason,responsibleUserId:z.string().uuid()}).strict(),
]);
export const SampleDisposalDecisionSchema=z.discriminatedUnion('decision',[
 z.object({version,decision:z.literal('approve'),finalAmount:money.optional(),reason:reason.optional()}).strict(),
 z.object({version,decision:z.literal('reject'),reason}).strict(),
]);
export const SampleLossCloseSchema=z.object({version,proofAttachmentIds:proofs}).strict();
export const SampleBasicUpdateSchema=z.object({version,brand:z.string().trim().min(1).max(100),styleName:z.string().trim().min(1).max(100),color:z.string().trim().min(1).max(100),department:z.string().trim().min(1).max(100),styleNo:z.string().trim().max(200),category:z.string().trim().max(200),size:z.string().trim().max(200),remark:z.string().trim().max(2000),reason}).strict();
export const SampleLocationUpdateSchema=z.object({version,storageLocation:z.string().trim().min(1).max(200),reason}).strict();
export const SampleFinanceCorrectionSchema=z.object({version,purchasePrice:SampleMoneySchema,receiptAttachmentIds:z.array(z.string().uuid()).max(20).refine(values=>new Set(values).size===values.length).default([]),receiptMode:z.enum(['append','replace']).default('append'),reason}).strict();
export const SampleArchiveSchema=z.object({version,reason}).strict();
export const SampleMaintenanceResultSchema=z.object({sampleId:z.string().uuid(),status:SampleStatusSchema,version}).strict();
export const SampleDisposalActionsSchema=z.object({enabled:z.boolean(),sampleId:z.string().uuid(),version,status:SampleStatusSchema,
 canRequest:z.boolean(),canApprove:z.boolean(),canCloseLoss:z.boolean(),canUpdateBasic:z.boolean(),canUpdateLocation:z.boolean(),canCorrectFinance:z.boolean(),canReplaceReceipts:z.boolean(),canArchive:z.boolean(),canRestore:z.boolean(),
 pending:z.object({requestId:z.string().uuid(),type:z.enum(['sale','gift','scrap','loss']),status:z.string(),reason:z.string(),recipient:z.string().nullable(),responsibleName:z.string().nullable(),proposedAmount:SampleMoneySchema.optional(),finalAmount:SampleMoneySchema.optional()}).strict().nullable(),
}).strict();
export const SampleFinancialAuditResponseSchema=z.object({page:z.number().int().positive(),totalCount:z.number().int().nonnegative(),items:z.array(z.object({eventId:z.string().uuid(),action:z.string(),actorName:z.string(),occurredAt:z.string(),reason:z.string().nullable(),before:z.record(z.string(),z.unknown()).nullable(),after:z.record(z.string(),z.unknown())}).strict()).max(15)}).strict();
