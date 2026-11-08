import {z} from "zod";
const page=z.coerce.number().int().min(1).max(100000).default(1);
export const SUPPLIER_DIRECTORY_TYPE_LABELS={factory:"加工厂",embroidery_washing:"印绣花 / 洗水厂",fabric:"面料商",other:"其他供应商"} as const;
export const PeopleDirectoryQuerySchema=z.object({q:z.string().trim().max(200).default(""),internalPage:page,temporaryPage:page}).strict();
export type PeopleDirectoryQuery=z.infer<typeof PeopleDirectoryQuerySchema>;
export const DirectoryPersonSchema=z.object({
 personId:z.string().uuid(),personType:z.enum(["internal","temporary"]),appUserId:z.string().uuid().nullable(),displayName:z.string(),temporaryCode:z.string().nullable(),temporaryRemark:z.string().nullable(),
 temporaryPhoneNumber:z.string().nullable(),temporaryIdentityNumber:z.string().nullable(),privateProfileMasked:z.boolean(),active:z.boolean(),
 aliases:z.array(z.object({aliasId:z.string().uuid(),alias:z.string(),revokedAt:z.string().nullable(),revokeReason:z.string().nullable()})),
});
export const PeopleDirectoryPageSchema=z.object({
 pageSize:z.literal(15),totalCount:z.number().int().nonnegative(),matchedCount:z.number().int().nonnegative(),
 internal:z.object({page:z.number().int().positive(),totalCount:z.number().int().nonnegative(),items:z.array(DirectoryPersonSchema)}),
 temporary:z.object({page:z.number().int().positive(),totalCount:z.number().int().nonnegative(),items:z.array(DirectoryPersonSchema)}),
});
export type PeopleDirectoryPage=z.infer<typeof PeopleDirectoryPageSchema>;
export const SupplierDirectoryQuerySchema=z.object({q:z.string().trim().max(200).default(""),page,type:z.enum(["all","factory","embroidery_washing","fabric","other"]).default("all"),status:z.enum(["all","active","inactive"]).default("active"),craft:z.string().trim().max(100).default(""),completeness:z.enum(["all","missing","complete"]).default("all")}).strict();
export type SupplierDirectoryQuery=z.infer<typeof SupplierDirectoryQuerySchema>;
export const DirectorySupplierSchema=z.object({supplierId:z.string().uuid(),supplierCode:z.string(),supplierType:z.enum(["factory","embroidery_washing","fabric","other"]),version:z.number().int().positive(),supplierName:z.string(),active:z.boolean(),supportedCrafts:z.array(z.string()),dailyCapacity:z.number().nullable(),contractDataMissing:z.array(z.string()),changedAt:z.string().datetime()});
export const SupplierDirectoryPageSchema=z.object({page:z.number().int().positive(),pageSize:z.literal(15),totalCount:z.number().int().nonnegative(),crafts:z.array(z.string()),items:z.array(DirectorySupplierSchema)});
export type SupplierDirectoryPage=z.infer<typeof SupplierDirectoryPageSchema>;
