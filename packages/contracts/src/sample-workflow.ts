import { z } from "zod";
const version = z.number().int().positive();
const ids = z.array(z.string().uuid()).min(1).max(20).refine(value=>new Set(value).size===value.length);
export const SampleBorrowRequestSchema = z.object({ version, purpose:z.string().trim().min(1).max(500), borrowerUserId:z.string().uuid().optional() }).strict();
export const SampleReturnRequestSchema = z.object({ version, photoAttachmentIds:ids }).strict();
export const SampleReturnBatchSchema = z.object({ items:z.array(SampleReturnRequestSchema.extend({ sampleId:z.string().uuid() })).min(1).max(50) }).strict();
export const SampleConfirmSchema = z.object({ version, token:z.string().regex(/^[A-Za-z0-9_-]{43}$/), storageLocation:z.string().trim().max(200).optional() }).strict();
export const SampleCancelSchema = z.object({ version, reason:z.string().trim().min(1).max(500) }).strict();
export const SampleVersionSchema = z.object({ version }).strict();
export const SampleWorkflowResultSchema = z.object({ sampleId:z.string().uuid(),requestId:z.string().uuid(),status:z.string(),version }).strict();
export const SampleWorkflowViewSchema = z.object({
  enabled:z.boolean(), sampleId:z.string().uuid(),version,status:z.string(),
  canBorrow:z.boolean(),canReturn:z.boolean(),canConfirm:z.boolean(),canCancel:z.boolean(),canIssueQr:z.boolean(),
  request:z.object({requestId:z.string().uuid(),type:z.string(),requesterName:z.string(),borrowerName:z.string().nullable(),purpose:z.string().nullable(),reason:z.string()}).strict().nullable(),
}).strict();
export const SampleHandoffQrSchema = z.object({ svg:z.string(),expiresAt:z.string().datetime(),requestId:z.string().uuid(),sampleId:z.string().uuid() }).strict();
export const SampleHandoffLookupSchema = z.object({sampleId:z.string().uuid(),requestId:z.string().uuid(),requesterName:z.string(),type:z.enum(["borrow","return"]),version}).strict();
export const SampleBatchReturnResultSchema = z.object({items:z.array(z.union([
  z.object({sampleId:z.string().uuid(),success:z.literal(true),result:SampleWorkflowResultSchema}).strict(),
  z.object({sampleId:z.string().uuid(),success:z.literal(false),message:z.string()}).strict(),
]))}).strict();
