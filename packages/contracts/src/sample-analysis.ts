import { z } from 'zod';
import { SampleStatusSchema } from './samples.js';
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;});
const money=z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/);
const price=z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/);
const count=z.number().int().nonnegative();
const amountPair=z.object({count,amount:money}).strict();
export const SampleAnalysisQuerySchema=z.object({
 purchaseFrom:date.optional(),purchaseTo:date.optional(),eventFrom:date.optional(),eventTo:date.optional(),
 purchaserUserId:z.string().uuid().optional(),holderUserId:z.string().uuid().optional(),
 brandId:z.string().uuid().optional(),departmentId:z.string().uuid().optional(),
 brand:z.string().min(1).max(200).optional(),department:z.string().min(1).max(200).optional(),category:z.string().max(200).optional(),
 minPrice:price.optional(),maxPrice:price.optional(),status:SampleStatusSchema.optional(),
 group:z.enum(['purchaser','brand','department','category','holder','purchaser_brand']).default('purchaser'),
 page:z.coerce.number().int().min(1).max(100000).default(1),groupPage:z.coerce.number().int().min(1).max(100000).default(1),
}).strict().refine(q=>!q.purchaseFrom||!q.purchaseTo||q.purchaseFrom<=q.purchaseTo,'采购日期范围无效')
 .refine(q=>!q.eventFrom||!q.eventTo||q.eventFrom<=q.eventTo,'事件日期范围无效')
 .refine(q=>!q.minPrice||!q.maxPrice||Number(q.minPrice)<=Number(q.maxPrice),'单价区间无效');
export type SampleAnalysisQuery=z.infer<typeof SampleAnalysisQuerySchema>;
const identity=z.object({id:z.string(),name:z.string()}).strict();
export const SampleAnalysisResponseSchema=z.object({
 asOf:z.string(),filters:SampleAnalysisQuerySchema,
 coverage:z.object({unclassifiedArchivedCount:count,excludedTestCount:count,formalArchivedCount:count,unmappedBrandCount:count,unmappedDepartmentCount:count,missingCategoryCount:count}).strict(),
 summary:z.object({purchaseCount:count,purchaseAmount:money,purchaserCount:count,averagePrice:money,legacyScopeAmount:money,
 heldCount:count,heldAmount:money,heldOver90Days:count,initialCustodyCount:count,borrowCount:count,returnCount:count,
 saleReceipts:money,confirmedLossCompensation:money,disposalCount:count}).strict(),
 trend:z.array(z.object({month:z.string(),count,amount:money}).strict()),
 groups:z.array(z.object({key:z.string(),person:identity.nullable(),dimension:identity.nullable(),count,amount:money}).strict()).max(15),
 groupTotal:count,groupPage:count,
 disposals:z.array(z.object({type:z.enum(['sale','gift','scrap','loss']),count,originalValue:money,confirmedAmount:money}).strict()),
 items:z.array(z.object({sampleId:z.string().uuid(),sampleCode:z.string(),styleName:z.string(),styleNo:z.string(),status:SampleStatusSchema,
 purchaseDate:date,purchaser:identity,holder:identity.nullable(),brand:z.string(),brandId:z.string().uuid().nullable(),brandName:z.string(),brandVersion:count.nullable(),
 department:z.string(),departmentId:z.string().uuid().nullable(),departmentName:z.string(),departmentVersion:count.nullable(),category:z.string(),purchasePrice:money,
 borrowedAt:z.string().nullable(),heldDays:count.nullable(),canOpenDetail:z.boolean()}).strict()).max(15),
 page:count,totalCount:count,
 options:z.object({people:z.array(identity),brands:z.array(identity),departments:z.array(identity),categories:z.array(z.string())}).strict(),
 archiveReview:amountPair,
}).strict();
export type SampleAnalysisResponse=z.infer<typeof SampleAnalysisResponseSchema>;
