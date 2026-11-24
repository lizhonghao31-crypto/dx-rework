import {z} from 'zod';
import {QuotationDecimalSchema} from './digital-quotation.js';

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
