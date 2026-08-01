import { z } from "zod";

export const LiveHealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string().min(1),
  timestamp: z.string().datetime(),
});

export const ReadyHealthResponseSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  service: z.string().min(1),
  checks: z.object({
    database: z.enum(["up", "down"]),
    schema: z.enum(["current", "drift", "unavailable"]),
  }),
  timestamp: z.string().datetime(),
});

export const VersionResponseSchema = z.object({
  service: z.string().min(1),
  gitSha: z.string().min(1),
  buildTime: z.string().min(1),
  schemaVersion: z.string().nullable(),
  expectedSchemaVersion: z.string().min(1),
});

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
  }),
});

export type LiveHealthResponse = z.infer<typeof LiveHealthResponseSchema>;
export type ReadyHealthResponse = z.infer<typeof ReadyHealthResponseSchema>;
export type VersionResponse = z.infer<typeof VersionResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
