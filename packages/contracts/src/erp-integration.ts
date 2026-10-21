import { z } from "zod";

const IdSchema = z.string().uuid();
const ContractVersionSchema = z.literal("1");
const MoneySchema = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/);
const QuantitySchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/);
const ReasonSchema = z.string().trim().min(1).max(500);
const ExternalIdSchema = z.string().trim().min(1).max(200);
const IdempotencyKeySchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);

export const ErpContractVersionSchema = ContractVersionSchema;

export const ErpProcessingFactorySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("own_factory") }).strict(),
  z.object({ type: z.literal("supplier"), supplierId: IdSchema }).strict(),
]);

export const ErpReworkPayloadSchema = z.object({
  styleNo: z.string().trim().min(1).max(100),
  orderNo: z.string().trim().min(1).max(100).nullable().optional(),
  merchandiserUserId: IdSchema,
  processingFactory: ErpProcessingFactorySchema,
  problemPart: z.string().trim().min(1).max(200),
  problemDescription: z.string().trim().min(1).max(2000),
  reworkQuantity: z.number().int().positive(),
}).strict();

export const ErpSourceReferenceSchema = z.object({
  sourceSystem: z.literal("erp"),
  externalId: ExternalIdSchema,
  externalIdempotencyKey: IdempotencyKeySchema,
  erpNodeId: ExternalIdSchema.nullable(),
}).strict();

export const ErpReworkIntakeV1Schema = z.object({
  contractVersion: ContractVersionSchema,
  source: ErpSourceReferenceSchema,
  payload: ErpReworkPayloadSchema,
}).strict();

export const ErpEmergencyReworkIntakeV1Schema = z.object({
  contractVersion: ContractVersionSchema,
  reason: ReasonSchema,
  payload: ErpReworkPayloadSchema,
}).strict();

export const ErpEmergencyLinkV1Schema = z.object({
  contractVersion: ContractVersionSchema,
  externalId: ExternalIdSchema,
  externalIdempotencyKey: IdempotencyKeySchema,
  erpNodeId: ExternalIdSchema,
}).strict();

export const ErpReworkOrderParamsSchema = z.object({
  reworkOrderId: IdSchema,
}).strict();

export const ErpIntakeResponseSchema = z.object({
  contractVersion: ContractVersionSchema,
  reworkOrderId: IdSchema,
  reworkNo: z.string().min(1),
  status: z.string().min(1),
  intakeMode: z.enum(["erp", "emergency"]),
  linkageStatus: z.enum(["linked", "pending"]),
  source: z.object({
    sourceSystem: z.string().min(1),
    externalId: z.string().min(1),
    externalIdempotencyKey: z.string().min(1),
    erpNodeId: z.string().nullable(),
  }).strict(),
  createdAt: z.string().datetime(),
}).strict();

export const ErpEmergencyLinkResponseSchema = z.object({
  contractVersion: ContractVersionSchema,
  reworkOrderId: IdSchema,
  linkageStatus: z.literal("linked"),
  source: ErpSourceReferenceSchema,
  linkedAt: z.string().datetime(),
}).strict();

export const ErpReceiptQuerySchema = z.object({requestFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const ErpCommandReceiptSchema = z.discriminatedUnion('outcome',[
  z.object({contractVersion:ContractVersionSchema,outcome:z.literal('confirmed'),receipt:z.union([ErpIntakeResponseSchema,ErpEmergencyLinkResponseSchema]),expiresAt:z.string().datetime(),message:z.string().min(1)}).strict(),
  z.object({contractVersion:ContractVersionSchema,outcome:z.literal('unconfirmed'),reason:z.enum(['missing_or_expired','in_progress']),receipt:z.null(),message:z.string().min(1)}).strict(),
]);
export type ErpCommandReceipt=z.infer<typeof ErpCommandReceiptSchema>;
export type ErpCommandScope='erp.rework.intake.v1'|'erp.rework.emergency_intake.v1'|'erp.rework.link.v1';
/** SHA-256 this UTF-8 string after parsing the original v1 command. This keeps
 * the existing stored request hash byte-for-byte; no submitted values belong
 * in URLs or diagnostic output. Arrays retain their original order. */
export function serializeErpCommandFingerprint(scope:ErpCommandScope,payload:unknown):string {
  const canonicalize=(value:unknown):unknown=>{
    if(Array.isArray(value))return value.map(canonicalize);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,canonicalize(child)]));
    return value;
  };
  return JSON.stringify(canonicalize({scope,payload}));
}

const WorkerWageItemSchema = z.object({
  personId: IdSchema,
  personName: z.string().min(1),
  amount: MoneySchema,
}).strict();

const ResponsibilityAllocationSchema = z.object({
  responsibilityType: z.string().min(1),
  amount: MoneySchema,
}).strict();

const AttachmentReferenceSchema = z.object({
  attachmentId: IdSchema,
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().datetime(),
}).strict();

export const ErpReworkResultV1Schema = z.object({
  contractVersion: ContractVersionSchema,
  source: z.object({
    original: z.object({
      sourceSystem: z.string().min(1),
      externalId: z.string().min(1),
      externalIdempotencyKey: z.string().min(1),
      erpNodeId: z.string().nullable(),
    }).strict(),
    linkedErp: ErpSourceReferenceSchema.nullable(),
    linkageStatus: z.enum(["linked", "pending"]),
  }).strict(),
  reworkOrder: z.object({
    reworkOrderId: IdSchema,
    reworkNo: z.string().nullable(),
    status: z.string().min(1),
    completedQuantity: QuantitySchema,
    updatedAt: z.string().datetime(),
  }).strict(),
  workerWages: z.object({
    totalAmount: MoneySchema,
    items: z.array(WorkerWageItemSchema),
  }).strict(),
  responsibility: z.object({
    totalAmount: MoneySchema,
    ownFactoryAmount: MoneySchema,
    allocations: z.array(ResponsibilityAllocationSchema),
  }).strict(),
  deduction: z.object({
    proposedAmount: MoneySchema,
    deductedAmount: MoneySchema,
    remainingAmount: MoneySchema,
  }).strict(),
  approval: z.object({
    ownFactory: z.object({
      status: z.enum(["pending", "approved", "rejected"]),
      decision: z.enum(["approved", "rejected"]).nullable(),
      decidedAt: z.string().datetime().nullable(),
    }).strict().nullable(),
  }).strict(),
  attachments: z.array(AttachmentReferenceSchema),
  asOf: z.string().datetime(),
}).strict();

export type ErpReworkPayload = z.infer<typeof ErpReworkPayloadSchema>;
export type ErpSourceReference = z.infer<typeof ErpSourceReferenceSchema>;
export type ErpReworkIntakeV1 = z.infer<typeof ErpReworkIntakeV1Schema>;
export type ErpEmergencyReworkIntakeV1 = z.infer<typeof ErpEmergencyReworkIntakeV1Schema>;
export type ErpEmergencyLinkV1 = z.infer<typeof ErpEmergencyLinkV1Schema>;
export type ErpIntakeResponse = z.infer<typeof ErpIntakeResponseSchema>;
export type ErpEmergencyLinkResponse = z.infer<typeof ErpEmergencyLinkResponseSchema>;
export type ErpReworkResultV1 = z.infer<typeof ErpReworkResultV1Schema>;
