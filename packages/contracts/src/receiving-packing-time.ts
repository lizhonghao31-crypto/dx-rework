import {z} from 'zod';

/** Optional on the original packing command. Omission never means "now". */
export const PackingTimeInputSchema=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('now')}).strict(),
 z.object({mode:z.literal('instant'),value:z.iso.datetime({offset:true})}).strict(),
 z.object({mode:z.literal('date'),value:z.iso.date()}).strict(),
 z.object({mode:z.literal('unknown')}).strict(),
]);
export type PackingTimeInput=z.infer<typeof PackingTimeInputSchema>;
export const PackingActualTimeSchema=z.discriminatedUnion('precision',[
 z.object({precision:z.literal('instant'),at:z.iso.datetime({offset:true})}).strict(),
 z.object({precision:z.literal('date'),date:z.iso.date()}).strict(),
 z.object({precision:z.literal('unknown')}).strict(),
]);
export type PackingActualTime=z.infer<typeof PackingActualTimeSchema>;
export const PackingAllocationInputSchema=z.object({receiptId:z.string().uuid(),quantityVersion:z.string().uuid(),quantity:z.number().int().min(1).max(10000000),packingTime:PackingTimeInputSchema}).strict();
export const PackingAllocationsInputSchema=z.array(PackingAllocationInputSchema).max(500).superRefine((rows,context)=>{
 if(new Set(rows.map(row=>row.receiptId)).size!==rows.length)context.addIssue({code:'custom',message:'同一收货记录不能重复分配装箱'});
});
export type PackingAllocationInput=z.infer<typeof PackingAllocationInputSchema>;
export const PackingAllocationSchema=PackingAllocationInputSchema.omit({packingTime:true}).extend({actualTime:PackingActualTimeSchema}).strict();
export const PackingAllocationsSchema=z.array(PackingAllocationSchema).max(500);
export type PackingAllocation=z.infer<typeof PackingAllocationSchema>;
export function packingActualTime(value:unknown):PackingActualTime{
 const parsed=PackingActualTimeSchema.safeParse(value);
 return parsed.success?parsed.data:{precision:'unknown'};
}
