import {z} from 'zod';
import {QuotationDecimalSchema,QuotationResourceSchema} from './digital-quotation.js';

const decisionVersion=z.number().int().positive();
const expectedVersion=z.number().int().nonnegative();
const attachmentIds=z.array(z.uuid()).max(30)
 .refine(ids=>new Set(ids).size===ids.length,'同一附件不能重复引用');
const unit=z.string().trim().max(100);
const positiveQuantity=QuotationDecimalSchema.refine(value=>Number(value)>0,'适用数量必须大于零');
const detail={
 applicableQuantity:positiveQuantity.nullable(),
 note:z.string().trim().max(1000),
 attachmentIds,
};
const draft={
 expectedVersion,unitPrice:z.union([QuotationDecimalSchema,z.literal('')]),unit,...detail,
};
const submission={
 expectedVersion,unitPrice:QuotationDecimalSchema,unit:unit.min(1,'请填写计价单位'),...detail,
};

export const SecondaryCraftDraftSchema=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('in_house'),supplierId:z.null(),...draft}).strict(),
 z.object({mode:z.literal('outsourced'),supplierId:z.uuid().nullable(),...draft}).strict(),
]);
export const SecondaryCraftSubmissionSchema=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('in_house'),supplierId:z.null(),...submission}).strict(),
 z.object({mode:z.literal('outsourced'),supplierId:z.uuid(),...submission}).strict(),
]);
export const SecondaryCraftDecisionSchema=z.discriminatedUnion('decision',[
 z.object({decision:z.literal('approved'),expectedVersion:decisionVersion,reason:z.string().trim().max(500).optional()}).strict(),
 z.object({decision:z.literal('returned'),expectedVersion:decisionVersion,reason:z.string().trim().min(1).max(500)}).strict(),
]);
export type SecondaryCraftQuoteInput=z.infer<typeof SecondaryCraftDraftSchema>|z.infer<typeof SecondaryCraftSubmissionSchema>;
export type SecondaryCraftDecision=z.infer<typeof SecondaryCraftDecisionSchema>;

const state=z.enum(['pending','draft','submitted','approved','returned']);
const stage=z.enum(['development','bulk']);
const target=z.object({rowId:z.uuid(),scopeId:z.uuid(),label:z.string(),round:decisionVersion,stage,
 sourceVersion:decisionVersion,instructions:z.string(),attachmentIds});
const storedDraft=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('in_house'),supplierId:z.null(),unitPrice:draft.unitPrice,unit,...detail}).strict(),
 z.object({mode:z.literal('outsourced'),supplierId:z.uuid().nullable(),unitPrice:draft.unitPrice,unit,...detail}).strict(),
]);
const supplier=z.object({supplierId:z.uuid(),code:z.string(),name:z.string()}).strict();
export const SecondaryCraftSuppliersSchema=z.object({items:z.array(supplier)});
export const SecondaryCraftDetailSchema=z.object({target,version:expectedVersion,state,note:z.string().nullable(),
 draft:storedDraft.nullable(),supplier:supplier.nullable(),canEdit:z.boolean(),canDecide:z.boolean(),
 versions:z.array(decisionVersion),historical:z.boolean()});
export const SecondaryCraftReceiptSchema=SecondaryCraftDetailSchema.extend({
 receipt:z.object({action:z.enum(['draft','submit','decision']),appliedVersion:decisionVersion}),
});
export const SecondaryCraftListSchema=z.object({ready:z.boolean(),items:z.array(z.object({
 resource:QuotationResourceSchema,styleNo:z.string(),rowId:z.uuid(),label:z.string(),round:decisionVersion,stage,
 sourceVersion:decisionVersion,version:expectedVersion,state,authorName:z.string().nullable(),supplier:supplier.nullable(),
 note:z.string().nullable(),canDecide:z.boolean(),approvalTodoId:z.uuid().nullable(),submittedAt:z.string().nullable(),
}))});
export type SecondaryCraftDetail=z.infer<typeof SecondaryCraftDetailSchema>;
export type SecondaryCraftList=z.infer<typeof SecondaryCraftListSchema>;
