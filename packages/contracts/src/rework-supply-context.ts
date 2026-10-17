import { z } from "zod";
import { OtherCraftDescriptionSchema, SpecialProcessTypeSchema } from "./rework-special-process.js";

const IdSchema = z.string().uuid();

export const ReworkSupplySupplierSnapshotSchema = z.object({
  supplierId: IdSchema,
  supplierVersion: z.number().int().positive(),
}).strict();

export const SaveReworkSupplyContextSchema = z.object({
  washingSupplierId: IdSchema.nullable(),
  embroiderySupplierId: IdSchema.nullable(),
  fabricSupplierId: IdSchema.nullable(),
  embroideryMerchandiserUserId: IdSchema.nullable(),
}).strict();

export const ReworkSupplyContextResponseSchema = z.object({
  reworkOrderId: IdSchema,
  washingSupplier: ReworkSupplySupplierSnapshotSchema.nullable(),
  embroiderySupplier: ReworkSupplySupplierSnapshotSchema.nullable(),
  fabricSupplier: ReworkSupplySupplierSnapshotSchema.nullable(),
  embroideryMerchandiserUserId: IdSchema.nullable(),
  version: z.number().int().positive().nullable(),
}).strict();

const SupplierOptionSchema = z.object({
  supplierId: IdSchema,
  supplierVersion: z.number().int().positive(),
  supplierName: z.string().trim().min(1).max(200),
}).strict();

export const ReworkSupplyContextOptionsResponseSchema = z.object({
  embroideryWashingMerchandisers: z.array(z.object({
    userId: IdSchema,
    displayName: z.string().trim().min(1).max(200),
  }).strict()),
  embroideryWashingSuppliers: z.array(SupplierOptionSchema),
  fabricSuppliers: z.array(SupplierOptionSchema),
}).strict();

const ReworkV2ProcessingFactoryInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("own_factory") }).strict(),
  z.object({ type: z.literal("supplier"), supplierId: IdSchema }).strict(),
]);

export const SaveReworkV2DraftSchema = z.object({
  expectedVersion: z.number().int().positive(),
  styleNo: z.string().trim().min(1).max(80).nullable(),
  merchandiserUserId: IdSchema.nullable(),
  processingFactory: ReworkV2ProcessingFactoryInputSchema.nullable(),
  tailInspectionRequired: z.boolean(),
  specialProcessType: SpecialProcessTypeSchema.optional(),
  otherCraftDescription: OtherCraftDescriptionSchema,
  tailInspectionCostBearer: z.enum(["own_factory", "processing_factory"]).nullable(),
}).strict();

export type SaveReworkSupplyContext = z.infer<typeof SaveReworkSupplyContextSchema>;
export type ReworkSupplyContextResponse = z.infer<typeof ReworkSupplyContextResponseSchema>;
export type ReworkSupplyContextOptionsResponse = z.infer<typeof ReworkSupplyContextOptionsResponseSchema>;
export type SaveReworkV2Draft = z.infer<typeof SaveReworkV2DraftSchema>;
