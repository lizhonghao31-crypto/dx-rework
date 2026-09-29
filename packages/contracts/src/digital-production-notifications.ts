import { z } from "zod";
import { TodoRouteDescriptorSchema } from "./todos.js";
export const DigitalNotificationSchema = z.object({
  eventId: z.string().uuid(), title: z.string().max(200), actionable: z.boolean(),
  route: TodoRouteDescriptorSchema, createdAt: z.string().datetime(),
}).strict();
export const DigitalNotificationClaimSchema = z.object({ notification: DigitalNotificationSchema.nullable() }).strict();
export type DigitalNotification = z.infer<typeof DigitalNotificationSchema>;
