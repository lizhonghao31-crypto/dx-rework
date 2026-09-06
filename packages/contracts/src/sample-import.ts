import {z} from 'zod';
import {SampleStatusSchema,SampleMoneySchema} from './samples.js';
const id=z.string().uuid(),text=z.string().trim().min(1).max(2000),hash=z.string().regex(/^[a-f0-9]{64}$/),date=z.string().datetime({offset:true});
export const SampleImportCustodySchema=z.object({legacyId:text,sourceHash:hash,holderUserId:id,holderName:text,department:text,purpose:text,borrowedAt:date,returnedAt:date.nullable(),disposedAt:date.nullable(),initialCustody:z.boolean(),requestedBy:id.nullable(),confirmedBy:id.nullable()}).strict();
export const SampleImportRequestSchema=z.object({legacyId:text,sourceHash:hash,type:z.enum(['borrow','return','sale','gift','scrap','loss']),status:z.enum(['pending','payment_pending','completed','rejected','cancelled']),fromStatus:z.enum(['in_stock','borrowed']),requestedBy:id,requestedFor:id.nullable(),purpose:text.nullable(),reason:z.string().max(2000),createdAt:date,resolvedBy:id.nullable(),resolvedAt:date.nullable(),resolutionReason:z.string().max(2000).nullable(),
 disposal:z.object({recipient:text.nullable(),responsibleUserId:id.nullable(),proposedAmount:SampleMoneySchema.nullable(),finalAmount:SampleMoneySchema.nullable(),approvedBy:id.nullable(),approvedAt:date.nullable(),paidBy:id.nullable(),paidAt:date.nullable()}).strict().nullable(),
 proofObjectKeys:z.array(text).max(100).refine(keys=>new Set(keys).size===keys.length),
}).strict();
export const SampleImportItemSchema=z.object({legacyId:text,sourceHash:hash,status:SampleStatusSchema,purchaserUserId:id,holderUserId:id.nullable(),holderName:text.nullable(),borrowedAt:date.nullable(),purpose:text.nullable(),storageLocation:text.nullable(),archivedFromStatus:SampleStatusSchema.nullable(),archiveReason:text.nullable(),normalizationReason:text,
 custody:z.array(SampleImportCustodySchema),requests:z.array(SampleImportRequestSchema),
}).strict();
export const SampleImportPlanSchema=z.object({sourceHash:hash,reason:text,
 items:z.array(SampleImportItemSchema).min(1).max(20000),
 objects:z.array(z.object({objectKey:text,attachmentId:id,sha256:hash,sizeBytes:z.number().int().positive()}).strict()).max(100000),
 decisions:z.array(z.object({entityType:text,legacyId:text,code:text,field:z.string().optional(),conclusion:text}).strict()),
}).strict();
export type SampleImportPlan=z.infer<typeof SampleImportPlanSchema>;
export type SampleImportItem=z.infer<typeof SampleImportItemSchema>;
export const SampleCutoverSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('enable'),reconciliationId:id,sourceHash:hash,sourceFreezeEvidence:text,backupRestoreEvidence:text,businessUatEvidence:text,reason:text}).strict(),
 z.object({action:z.literal('disable'),reason:text}).strict(),
]);
