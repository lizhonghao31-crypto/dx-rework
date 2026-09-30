import { z } from 'zod';
export const ReopenOrderResponsibilitySchema = z.object({
  expectedOrderVersion: z.number().int().positive(), expectedDeterminationVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
}).strict();
export type ReopenOrderResponsibility = z.infer<typeof ReopenOrderResponsibilitySchema>;
export const OrderResponsibilityRevisionSchema = z.object({
  orderVersion: z.number().int().positive(), status: z.string(), canReopen: z.boolean(), currentVersion: z.number().int().positive().nullable(),
  history: z.array(z.object({id: z.string().uuid(), version: z.number().int().positive(), stage: z.enum(['draft','finalized']),
    reason: z.string().nullable(), at: z.string(), actor: z.string().nullable(), ownAmount: z.string(), externalAmount: z.string(),
    signature: z.object({decision: z.string(), actor: z.string().nullable(), at: z.string()}).nullable(),
  })),
  revisions: z.array(z.object({id:z.string().uuid(), reason:z.string().nullable(), actor:z.string().nullable(), at:z.string()})),
  paidAmount: z.string(),
});
export type OrderResponsibilityRevision = z.infer<typeof OrderResponsibilityRevisionSchema>;
