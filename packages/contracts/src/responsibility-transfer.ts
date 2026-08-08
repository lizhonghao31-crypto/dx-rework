import { z } from "zod";

const IdSchema = z.string().uuid();

export const ResponsibilityTransferOptionsResponseSchema = z.object({
  items: z.array(z.object({
    userId: IdSchema,
    displayName: z.string().trim().min(1),
  }).strict()),
}).strict();

export type ResponsibilityTransferOptionsResponse = z.infer<
  typeof ResponsibilityTransferOptionsResponseSchema
>;
