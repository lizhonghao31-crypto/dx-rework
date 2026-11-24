import { z } from 'zod';
import { SalesSeriesSchema } from './digital-production.js';

const componentCode = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{0,11}$/, '请输入由英文字母开头的 1 至 12 位字母或数字');
export const OrderNumberProductGroupSchema = z.enum(['男装', '女装', '男童', '女童']);
export const OrderNumberContextSchema = z.object({
  kind: z.enum(['development', 'preorder', 'formal']),
  customerCode: z.string().trim().min(1).max(100).nullable(),
  productGroup: OrderNumberProductGroupSchema.nullable(),
  salesYear: z.number().int().min(1000).max(9999).nullable(),
  salesSeries: SalesSeriesSchema.nullable(),
}).strict();

export const NumberedDraftInputSchema = z.object({
  developmentType: z.enum(['头版', '开发板']),
  temporaryStyleNo: z.string().trim().max(100).nullable(),
  numbering: OrderNumberContextSchema,
}).strict();

const settings = z.object({
  boys: componentCode.nullable(),
  girls: componentCode.nullable(),
  designers: z.array(z.object({ userId: z.uuid(), code: componentCode }).strict()).max(2000),
}).strict();

export const OrderNumberSettingsSaveSchema = settings.extend({
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export const OrderNumberPreviewSchema = OrderNumberContextSchema.extend({ designerId: z.uuid() }).strict();

export type OrderNumberContext = z.infer<typeof OrderNumberContextSchema>;
export type NumberedDraftInput = z.infer<typeof NumberedDraftInputSchema>;
export type OrderNumberSettings = z.infer<typeof settings>;
export type OrderNumberSettingsSave = z.infer<typeof OrderNumberSettingsSaveSchema>;
export type OrderNumberPreviewInput = z.infer<typeof OrderNumberPreviewSchema>;
export type OrderNumberPreview = { prefix: string; example: string } | { missing: string[] };
export type NumberedDraftIdentity = { sourceId: string; orderNumber: string | null };
export type OrderNumberSettingsRead = {
  version: number;
  values: OrderNumberSettings;
  designers: Array<{ userId: string; name: string; suggestion: string | null; needsReview: boolean }>;
  customers: Array<{ code: string; name: string; productGroups: string[] }>;
};
