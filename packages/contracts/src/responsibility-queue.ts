import {QueuePageResponseFields} from './queue-page.js';
import { z } from "zod";

const IdSchema = z.string().uuid();

export const ResponsibilityQueueItemSchema = z.object({
  reworkOrderId: IdSchema,
  reworkNo: z.string().nullable(),
  styleNo: z.string().nullable(),
  orderNo: z.string().nullable(),
  problemPart: z.string().nullable(),
  problemDescription: z.string().nullable(),
  orderVersion: z.number().int().positive(),
  handlerUserId: IdSchema.nullable(),
  determinationVersion: z.number().int().positive().nullable(),
  determinationStage: z.enum(["draft", "finalized"]).nullable(),
  canDetermine: z.boolean(),
  canTakeover: z.boolean(),
  canConfirmHighMultiplier: z.boolean(),
  highMultiplierPending: z.boolean(),
}).strict();

export const ResponsibilityQueueResponseSchema = z.object({
  items: z.array(ResponsibilityQueueItemSchema),
  ...QueuePageResponseFields,
}).strict();

export type ResponsibilityQueueItem = z.infer<
  typeof ResponsibilityQueueItemSchema
>;
export type ResponsibilityQueueResponse = z.infer<
  typeof ResponsibilityQueueResponseSchema
>;
