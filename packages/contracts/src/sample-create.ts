import { z } from "zod";
import { SampleMoneySchema } from "./samples.js";
const required = z.string().trim().min(1).max(100);
const optional = z.string().trim().max(200).default("");
export const SampleCreateSchema = z.object({
  brand: required, styleName: required, color: required, department: required,
  styleNo: optional, category: optional, size: optional, remark: z.string().trim().max(2000).default(""),
  purchaseDate: z.string().date(), purchasePrice: SampleMoneySchema,
  purchaserUserId: z.string().uuid(), holderUserId: z.string().uuid().optional(),
  receiptAttachmentIds: z.array(z.string().uuid()).min(1).max(20),
  imageAttachmentIds: z.array(z.string().uuid()).max(20).default([]),
}).strict().refine(value => new Set(value.receiptAttachmentIds).size === value.receiptAttachmentIds.length
  && new Set(value.imageAttachmentIds).size === value.imageAttachmentIds.length
  && !value.imageAttachmentIds.some(id => value.receiptAttachmentIds.includes(id)), "照片与小票不能重复或混用");
export const SampleBatchCreateSchema = z.object({ items: z.array(SampleCreateSchema).min(1).max(50) }).strict();
export type SampleCreate = z.infer<typeof SampleCreateSchema>;
export const SampleCreateResultSchema = z.object({
  items: z.array(z.object({ sampleId: z.string().uuid(), sampleCode: z.string(), version: z.literal(1) }).strict()),
}).strict();
export const SamplePeopleQuerySchema = z.object({ search: z.string().trim().min(1).max(100) }).strict();
export const SamplePeopleResponseSchema = z.object({ people: z.array(z.object({ userId: z.string().uuid(), name: z.string(), department: z.string() }).strict()) }).strict();
export const SampleAttachmentListSchema = z.object({ attachments: z.array(z.object({
  attachmentId: z.string().uuid(), purpose: z.string(), filename: z.string(), mimeType: z.string(), sizeBytes: z.number().int().positive(),
}).strict()) }).strict();
