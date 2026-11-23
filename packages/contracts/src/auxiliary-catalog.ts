import {z} from 'zod';
export const AUXILIARY_CATALOG_ROLES=['order_merchandiser','sample_designer','production_management','owner_group'] as const;
export const AuxiliaryKindSchema=z.enum(['普通辅料','拉链','扁机']);
const name=z.string().trim().min(1,'请填写辅料品名').max(100),text=z.string().trim().max(100),reason=z.string().trim().min(1,'请填写本次变更原因').max(500);
export const AuxiliaryReferenceSchema=z.object({id:z.string().uuid(),version:z.number().int().positive()}).strict();
export const CreateAuxiliarySchema=z.object({name,specification:text,supplier:text,auxiliaryKind:AuxiliaryKindSchema}).strict();
export const RenameAuxiliarySchema=z.object({expectedVersion:z.number().int().positive(),name,reason}).strict();
export const DisableAuxiliarySchema=z.object({expectedVersion:z.number().int().positive(),reason}).strict();
export const MergeAuxiliarySchema=DisableAuxiliarySchema.extend({targetId:z.string().uuid(),expectedTargetVersion:z.number().int().positive()}).strict();
export const AuxiliaryQuerySchema=z.object({q:z.string().trim().max(100).default(''),page:z.coerce.number().int().min(1).max(100000).default(1),includeInactive:z.enum(['true','false']).default('false').transform(x=>x==='true')}).strict();
export const AuxiliaryItemSchema=z.object({id:z.string().uuid(),version:z.number().int().positive(),name,specification:text,supplier:text,auxiliaryKind:AuxiliaryKindSchema,active:z.boolean(),mergedInto:z.string().uuid().nullable(),changedAt:z.string()});
export const AuxiliaryPageSchema=z.object({items:z.array(AuxiliaryItemSchema),total:z.number().int().nonnegative(),page:z.number().int().positive(),pageSize:z.number().int().positive(),canManage:z.boolean()});
export const AuxiliaryHistoryQuerySchema=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),
 version:z.coerce.number().int().positive().max(2147483647).optional(),
}).strict();
export const AuxiliaryVersionSchema=AuxiliaryItemSchema.extend({reason:z.string().nullable(),changedBy:z.string().nullable(),action:z.string()});
export const AuxiliaryHistorySchema=z.object({items:z.array(AuxiliaryVersionSchema),total:z.number().int().nonnegative(),page:z.number().int().positive(),pageSize:z.number().int().positive()});
export type AuxiliaryItem=z.infer<typeof AuxiliaryItemSchema>;
export type CreateAuxiliary=z.infer<typeof CreateAuxiliarySchema>;
export type AuxiliaryQuery=z.infer<typeof AuxiliaryQuerySchema>;
