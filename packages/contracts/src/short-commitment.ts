import {z} from 'zod';
import {DigitalOrderCreateSchema,formalCommitmentFacts,type FormalCommitmentFacts,type DigitalOrderInput} from './digital-production.js';
export {formalCommitmentFacts,type FormalCommitmentFacts} from './digital-production.js';
export const ShortLeadRequestSchema=z.object({order:DigitalOrderCreateSchema,reason:z.string().trim().min(1).max(1000)}).strict();
export const ShortLeadDecisionSchema=z.object({approved:z.boolean(),reason:z.string().trim().min(1).max(1000)}).strict();
export type ShortLeadRequest={requestId:string;sourceId:string|null;customerCode:string;designStyleNo:string;order:DigitalOrderInput;facts:FormalCommitmentFacts;
 commitmentDay:string;minimumNormalDate:string;reason:string;requestedBy:string;requesterName:string;requestedAt:string;
 decision:{approved:boolean;reason:string;decidedBy:string;deciderName:string;authority:'owner_group'|'root_superuser';decidedAt:string}|null;consumedOrderId:string|null;staleReason:string|null};
export type ShortLeadState={canRequest:boolean;canApprove:boolean;serverToday:string;minimumNormalDate:string;requests:ShortLeadRequest[]};
export function matchingShortLeadApproval(input:DigitalOrderInput,requests:ShortLeadRequest[]):ShortLeadRequest|null{
 const facts=JSON.stringify(formalCommitmentFacts(input));
 return requests.find(r=>r.decision?.approved&&!r.consumedOrderId&&!r.staleReason&&JSON.stringify(r.facts)===facts)??null;
}
