import {z} from 'zod';
import {DigitalOrderCreateSchema,formalCommitmentFacts,type FormalCommitmentFacts,type DigitalOrderInput} from './digital-production.js';
export {formalCommitmentFacts,type FormalCommitmentFacts} from './digital-production.js';
export const ShortLeadRequestSchema=z.object({order:DigitalOrderCreateSchema,reason:z.string().trim().min(1).max(1000)}).strict();
export const ShortLeadDecisionSchema=z.object({approved:z.boolean(),reason:z.string().trim().min(1).max(1000)}).strict();
export type ShortLeadRequest={requestId:string;sourceId:string|null;customerCode:string;designStyleNo:string;order:DigitalOrderInput;facts:FormalCommitmentFacts;
 commitmentDay:string;minimumNormalDate:string;sourceDocumentVersion?:number|null;currentDocumentVersion?:number|null;canDecide?:boolean;changes?:string[];reason:string;requestedBy:string;requesterName:string;requestedAt:string;
 decision:{approved:boolean;reason:string;decidedBy:string;deciderName:string;authority:'owner_group'|'root_superuser';decidedAt:string}|null;consumedOrderId:string|null;staleReason:string|null};
export type ShortLeadState={canRequest:boolean;canApprove:boolean;serverToday:string;minimumNormalDate:string;requests:ShortLeadRequest[]};
export function matchingShortLeadApproval(input:DigitalOrderInput,requests:ShortLeadRequest[]):ShortLeadRequest|null{
 const facts=JSON.stringify(formalCommitmentFacts(input));
 return requests.find(r=>r.decision?.approved&&!r.consumedOrderId&&!r.staleReason&&JSON.stringify(r.facts)===facts)??null;
}

/** Compare only the original approved customer facts; unknown technical history is never invented. */
export function shortLeadFactChanges(before:FormalCommitmentFacts,after:FormalCommitmentFacts):string[]{
 const fields={customerCode:'客户',productGroup:'产品分组',designStyleNo:'设计款号',temporaryStyleNo:'代用款号',orderDate:'客户下单日期',contractDeliveryDate:'合同约定日期',salesYear:'销售年份',salesSeries:'销售系列',requiresColorMatching:'对色路线'};
 const changes=Object.entries(fields).filter(([key])=>JSON.stringify(before[key as keyof FormalCommitmentFacts])!==JSON.stringify(after[key as keyof FormalCommitmentFacts])).map(([,label])=>`${label}已改变`);
 if(before.lines.length!==after.lines.length)changes.push('PO或颜色行数已改变');
 for(let index=0;index<Math.max(before.lines.length,after.lines.length);index++){const a=before.lines[index],b=after.lines[index];if(!a||!b)continue;const name=a.formalPoNo??a.color;for(const [key,label]of Object.entries({formalPoNo:'PO号码',temporaryStyleNo:'代用款号',color:'颜色',colorForeign:'外文颜色',customerDate:'客户约定出货日期',sizes:'尺码数量'}))if(JSON.stringify(a[key as keyof typeof a])!==JSON.stringify(b[key as keyof typeof b]))changes.push(`${name}：${label}已改变`);}
 return changes;
}
