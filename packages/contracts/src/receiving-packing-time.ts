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
export function packingActualTime(value:unknown):PackingActualTime{
 const parsed=PackingActualTimeSchema.safeParse(value);
 return parsed.success?parsed.data:{precision:'unknown'};
}
