import {z} from 'zod';

/** Explicit pagination leaves the existing unparameterized queue contract intact. */
export const QueuePageQuerySchema=z.object({
 page:z.coerce.number().int().min(1).max(100000).optional(),
 search:z.string().trim().max(100).optional(),
}).strict();
export type QueuePageQuery=z.infer<typeof QueuePageQuerySchema>;
export const QueuePageResponseFields={
 page:z.number().int().positive().optional(),
 pageSize:z.literal(15).optional(),
 totalCount:z.number().int().nonnegative().optional(),
};
