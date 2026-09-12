import { z } from "zod";

export const PATTERN_PRICE_READ_ROLES = ["owner_group", "production_management", "finance_director", "pattern_room_supervisor"] as const;
export const PATTERN_PRICE_WRITE_ROLES = ["owner_group", "production_management"] as const;
export const PATTERN_HOURLY_WRITE_ROLES = ["owner_group"] as const;
export const PATTERN_QUOTE_ROLES = [...PATTERN_PRICE_READ_ROLES, "sample_designer"] as const;
export const PATTERN_MISC_QUOTE_ROLES = [...PATTERN_QUOTE_ROLES, "order_merchandiser"] as const;
export const patternPriceRoles = {
  "pattern_room:prices:read": PATTERN_PRICE_READ_ROLES,
  "pattern_room:prices:write": PATTERN_PRICE_WRITE_ROLES,
  "pattern_room:hourly:write": PATTERN_HOURLY_WRITE_ROLES,
  "pattern_room:catalog:read": PATTERN_QUOTE_ROLES,
  "pattern_room:misc:quote": PATTERN_MISC_QUOTE_ROLES,
} as const;
export type PatternPriceCapability = keyof typeof patternPriceRoles;
export function canUsePatternPrice(roles: readonly string[], capabilities: readonly string[], capability: PatternPriceCapability): boolean {
  return roles.includes("root_superuser") || (capabilities.includes(capability) && patternPriceRoles[capability].some(role => roles.includes(role)));
}

// The wage system accepts decimal strings at three places. No floating-point rounding.
export const PatternPriceAmountSchema = z.string().regex(/^(?:0|[1-9]\d{0,10})(?:\.\d{1,3})?$/, "金额须为非负数，最多三位小数").transform(value => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(3, "0")}`;
});
export const PatternPriceChangeSchema = z.object({
  version: z.number().int().positive(),
  amount: PatternPriceAmountSchema,
  enabled: z.boolean(),
  reason: z.string().trim().min(1, "请填写调整原因").max(500),
}).strict();
export type PatternPriceChange = z.infer<typeof PatternPriceChangeSchema>;
export const PatternPriceParamsSchema = z.object({ priceId: z.string().uuid() });
export const PatternPriceItemSchema = z.object({
  priceId: z.string().uuid(), kind: z.enum(["category", "hourly"]), name: z.string(), unit: z.enum(["件", "套", "小时"]),
  amount: z.string().nullable(), enabled: z.boolean(), version: z.number().int().positive(),
  updatedBy: z.string().nullable(), updatedAt: z.string(),
});
export type PatternPriceItem = z.infer<typeof PatternPriceItemSchema>;
export const PatternPriceHistorySchema = z.array(z.object({
  version: z.number().int(), oldAmount: z.string().nullable(), amount: z.string().nullable(),
  oldEnabled: z.boolean().nullable(), enabled: z.boolean(), reason: z.string(), changedBy: z.string().nullable(), changedAt: z.string(),
}));
export const PatternPricesSchema = z.object({
  categories: z.array(PatternPriceItemSchema), hourly: PatternPriceItemSchema,
  canWriteCategories: z.boolean(), canWriteHourly: z.boolean(),
});
export const PatternCategoryOptionsSchema = z.array(PatternPriceItemSchema.pick({ priceId: true, name: true, unit: true }));
export const PatternPriceQuoteSchema = PatternPriceItemSchema.pick({ priceId: true, name: true, unit: true, amount: true, version: true });
