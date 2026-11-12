import {z} from 'zod';

export const WholeOrderSelectionSchema=z.object({ids:z.array(z.uuid()).min(1).max(200)}).strict();
export const WholeOrderDeletionPreviewSchema=z.object({
 orders:z.array(z.object({id:z.uuid(),sourceId:z.uuid().nullable(),orderId:z.uuid().nullable(),label:z.string(),customer:z.string().nullable(),poCount:z.number().int().nonnegative(),revision:z.string(),deleted:z.boolean(),counts:z.record(z.string(),z.number().int().nonnegative())})),
});
export type WholeOrderDeletionPreview=z.infer<typeof WholeOrderDeletionPreviewSchema>;
export const WholeOrderDeletionInputSchema=z.object({orders:z.array(z.object({id:z.uuid(),revision:z.string().length(64)}).strict()).min(1).max(200)}).strict();
export type WholeOrderDeletionInput=z.infer<typeof WholeOrderDeletionInputSchema>;
export const WholeOrderDeletionResultSchema=z.object({results:z.array(z.object({id:z.uuid(),status:z.enum(['deleted','already_deleted','failed','unknown']),message:z.string().optional()}))});
export type WholeOrderDeletionResult=z.infer<typeof WholeOrderDeletionResultSchema>;
