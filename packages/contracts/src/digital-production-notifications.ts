import { z } from "zod";
import { TodoRouteDescriptorSchema } from "./todos.js";
export const DigitalNotificationSchema = z.object({
  eventId: z.string().uuid(), title: z.string().max(200), actionable: z.boolean(),
  context: z.object({ styleNo: z.string().nullable(), orderId: z.string().uuid().nullable(), colors: z.array(z.string()), poNumbers: z.array(z.string()) }).strict().optional(),
  route: TodoRouteDescriptorSchema, createdAt: z.string().datetime(),
}).strict();
export const DigitalNotificationClaimSchema = z.object({ notification: DigitalNotificationSchema.nullable(), remainingCount:z.number().int().nonnegative().optional() }).strict();
export type DigitalNotification = z.infer<typeof DigitalNotificationSchema>;
