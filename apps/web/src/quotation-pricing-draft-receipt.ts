import {z} from 'zod';
import {QuotationResourceSchema,type QuotationResource} from '@dx-rework/contracts/digital-quotation';

const receipt=z.object({
 resource:QuotationResourceSchema,quoteId:z.uuid(),version:z.number().int().positive(),
 commandReceipt:z.object({action:z.literal('workbench-pricing-draft'),appliedVersion:z.number().int().positive()}),
});

/** A saved calculation applies to the same quotation version. A later read
 * may report a newer head, but cannot substitute a different command receipt. */
export function confirmsQuotationPricingDraft(value:unknown,expected:{resource:QuotationResource;quoteId:string;version:number}){
 const response=receipt.safeParse(value);
 return response.success&&response.data.resource.kind===expected.resource.kind&&response.data.resource.id===expected.resource.id
  &&response.data.quoteId===expected.quoteId&&response.data.commandReceipt.appliedVersion===expected.version
  &&response.data.version>=expected.version;
}
