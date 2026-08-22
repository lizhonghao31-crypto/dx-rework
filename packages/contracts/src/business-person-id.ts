import { z } from "zod";

export const BusinessPersonIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "Expected a PostgreSQL UUID value",
);

export type BusinessPersonId = z.infer<typeof BusinessPersonIdSchema>;

type ZodLike<T> = Readonly<{
  safeParse(value: unknown):
    | Readonly<{ success: true; data: T }>
    | Readonly<{ success: false; error: { issues: readonly unknown[] } }>;
}>;

type MaskState = {
  next: number;
  byOriginal: Map<string, string>;
  byPlaceholder: Map<string, string>;
};

const placeholder = (index: number): string =>
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

const maskPersonId = (value: unknown, state: MaskState): unknown => {
  if (typeof value !== "string" || !BusinessPersonIdSchema.safeParse(value).success) return value;
  const existing = state.byOriginal.get(value);
  if (existing) return existing;
  const next = placeholder(state.next++);
  state.byOriginal.set(value, next);
  state.byPlaceholder.set(next, value);
  return next;
};

const mask = (value: unknown, state: MaskState): unknown => {
  if (Array.isArray(value)) return value.map((item) => mask(item, state));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    if (key === "personId" || key === "rejectedPersonId") return [key, child === null ? null : maskPersonId(child, state)];
    if (key === "memberIds" && Array.isArray(child)) return [key, child.map((item) => maskPersonId(item, state))];
    return [key, mask(child, state)];
  }));
};

const restore = (value: unknown, state: MaskState): unknown => {
  if (Array.isArray(value)) return value.map((item) => restore(item, state));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    if (key === "personId" || key === "rejectedPersonId") {
      return [key, typeof child === "string" ? state.byPlaceholder.get(child) ?? child : child];
    }
    if (key === "memberIds" && Array.isArray(child)) {
      return [key, child.map((item) => typeof item === "string" ? state.byPlaceholder.get(item) ?? item : item)];
    }
    return [key, restore(child, state)];
  }));
};

export const businessPersonCompatibleSchema = <T,>(schema: ZodLike<T>) =>
  z.unknown().transform((value, context): T => {
    const state: MaskState = {
      next: 1,
      byOriginal: new Map<string, string>(),
      byPlaceholder: new Map<string, string>(),
    };
    const result = schema.safeParse(mask(value, state));
    if (!result.success) {
      for (const issue of result.error.issues) context.addIssue(issue as never);
      return z.NEVER as never;
    }
    return restore(result.data, state) as T;
  });
