import { z } from "zod";
export const DIGITAL_TECHNICAL_ROLES = ["pattern_room_supervisor", "development_clerk", "pattern_room_tail_inspector", "pattern_room_worker", "quality_control", "embroidery_washing_merchandiser", "warehouse_receiver", "cutting_supervisor", "cutting_worker"] as const;
export const DigitalResourceKindSchema = z.enum(["order", "source", "task"]);
export const DigitalAccessPurposeSchema = z.enum(["technical", "budget", "execute"]);
export const DigitalDelegationSchema = z.object({
  resourceKind: DigitalResourceKindSchema, resourceId: z.string().uuid(),
  delegateId: z.string().uuid(), purpose: DigitalAccessPurposeSchema,
  expiresAt: z.iso.datetime({ offset: true }),
}).strict().refine(value => value.resourceKind === "task" ? value.purpose !== "budget" : value.purpose !== "execute", "任务代理不能访问整单预算，订单代理不能代替任务指派");
export const DigitalCustomerAssignmentSchema = z.object({ merchandiserId: z.string().uuid().nullable() }).strict();
export const DigitalMerchandiserAssignmentSchema = z.object({ merchandiserId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict();
export const DigitalDeliveryRequestSchema = z.object({ deliveryDate: z.iso.date(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) }).strict();
export const DigitalDeliveryDecisionSchema = z.object({ decision: z.enum(["approved", "rejected"]) }).strict();
export type DigitalResourceKind = z.infer<typeof DigitalResourceKindSchema>;
export type DigitalAccessPurpose = z.infer<typeof DigitalAccessPurposeSchema>;
