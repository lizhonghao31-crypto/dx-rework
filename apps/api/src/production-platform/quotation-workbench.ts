import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {calculateQuotationPricing,calculateQuotationUnitCost,quotationDraftReviewSummary,QuotationPricingInputSchema,
  type QuotationAssignment,type QuotationLineReviewCommand,type QuotationPricingInput,type QuotationResource,type QuotationReviewField} from '@dx-rework/contracts/digital-quotation';
import type {BudgetRow} from '@dx-rework/contracts/digital-budget';
import {businessNow} from '../acceptance-clock/business-time.js';
import {ApplicationError} from '../platform/errors.js';
import {DigitalProductionAccessPolicy,digitalForbidden,digitalNotFound} from './access-policy.js';
import type {AssembledQuotation} from './quotation-assembly.js';

const conflict=(message:string):never=>{throw new ApplicationError('QUOTATION_CONFLICT',message,409);};

function fieldSource(quote:AssembledQuotation,rowId:string,field:QuotationReviewField) {
  return field==='consumption' ? quote.consumption_sources[rowId] : quote.price_sources[rowId];
}

function rowKind(quote:AssembledQuotation,row:BudgetRow,assignment:QuotationAssignment|undefined){
  if(quote.assembly)return quote.assembly.rows[row.rowId]?.kind;
  if(row.section!=='外发工序')return 'material';
  if(assignment)return assignment.priceRole==='ie_reviewer'?'ie':'craft';
}

function costRows(quote:AssembledQuotation) {
  return quote.document.rows.map(row=>{
    const assignment=quote.assignments.find(value=>value.rowId===row.rowId);
    const kind=rowKind(quote,row,assignment);
    const usage=quote.consumption_sources[row.rowId];
    return {row,complete:Boolean(kind&&row.name&&row.unit&&row.consumption!==''&&row.unitPrice!==''
      &&assignment?.priceAssigneeId&&quote.price_sources[row.rowId]
      &&(kind!=='material'||assignment.technicalAssigneeId&&usage&&(!quote.assembly||usage.kind==='technical_artifact'))),
      requiresCraftReview:kind==='craft'};
  });
}

function workbenchCost(quote:AssembledQuotation){
  return costRows(quote).every(value=>value.complete) ? calculateQuotationUnitCost(quote.document) : null;
}

type LineReview = {
  review_id:string;
  row_id:string;
  field:QuotationReviewField;
  reason:string;
  return_field_version:number|null;
  resubmit_field_version:number|null;
};

const roundFor=(quote:AssembledQuotation):number|null=>quote.assembly?.roundNumber??(quote.source_id===null?1:null);

export async function readWorkbenchQuotation(db:PoolClient,quote:AssembledQuotation,resource:QuotationResource,actorId:string){
  const round=roundFor(quote);
  const {rows:reviews}=await db.query<LineReview>(`SELECT review_id,row_id,field,reason,return_field_version,resubmit_field_version
    FROM digital_quotation_line_reviews WHERE quote_id=$1 AND round_number=$2 AND resolve_at IS NULL
    ORDER BY return_at,review_id`,[quote.quote_id,round]);
  const {rows:[draft]}=await db.query<{quote_version:number;pricing:{input:unknown}}>(
    'SELECT quote_version,pricing FROM digital_quotation_pricing_drafts WHERE quote_id=$1 AND actor_id=$2',[quote.quote_id,actorId]);
  const audited=costRows(quote);
  const currentRows=new Set(audited.map(({row})=>row.rowId));
  const visibleReviews=reviews.filter(review=>currentRows.has(review.row_id)).map(review=>({
    reviewId:review.review_id,rowId:review.row_id,field:review.field,reason:review.reason,
    status:review.resubmit_field_version!==null&&fieldSource(quote,review.row_id,review.field)?.version===review.resubmit_field_version
      ?'resubmitted' as const:'returned' as const,
  }));
  const reviewsByRow=new Map<string,Array<'returned'|'resubmitted'>>();
  for(const review of visibleReviews){
    const group=reviewsByRow.get(review.rowId)??[];
    group.push(review.status);
    reviewsByRow.set(review.rowId,group);
  }
  const states=audited.map(({row,complete,requiresCraftReview})=>({
    complete,reviews:reviewsByRow.get(row.rowId)??[],
    craftApproval:requiresCraftReview?'pending' as const:'not_applicable' as const,
  }));
  // A review of a retired row is retained for history. It cannot be resolved against another row.
  const result=quotationDraftReviewSummary(states);
  const unitCost=audited.every(value=>value.complete)?calculateQuotationUnitCost(quote.document):null;
  return {resource,quoteId:quote.quote_id,version:quote.version,unitCost,...result,
    saved:draft?{input:QuotationPricingInputSchema.parse(draft.pricing.input),version:draft.quote_version}:null,reviews:visibleReviews,
    confirmation:'awaiting_joint_release' as const};
}

export async function persistWorkbenchPricing(db:PoolClient,quote:AssembledQuotation,actorId:string,input:QuotationPricingInput){
  const cost=workbenchCost(quote),pricing=calculateQuotationPricing(cost,input);
  if(pricing.status==='price_out_of_range')conflict('按此倍率计算的客户单价超出金额范围');
  await db.query(`INSERT INTO digital_quotation_pricing_drafts(quote_id,actor_id,quote_version,pricing,updated_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(quote_id,actor_id) DO UPDATE SET
    quote_version=EXCLUDED.quote_version,pricing=EXCLUDED.pricing,updated_at=EXCLUDED.updated_at`,
  [quote.quote_id,actorId,quote.version,JSON.stringify({input,cost,...pricing}),businessNow().toISOString()]);
}

async function lockResponsibleRole(db:PoolClient,userId:string,role:string){
  if(!await new DigitalProductionAccessPolicy(db).lockActiveRole(userId,role))digitalForbidden();
}

function fieldTarget(quote:AssembledQuotation,rowId:string,field:QuotationReviewField){
  const row=quote.document.rows.find(value=>value.rowId===rowId)??digitalNotFound();
  const assignment=quote.assignments.find(value=>value.rowId===rowId)??digitalNotFound();
  const kind=rowKind(quote,row,assignment)??conflict('报价行的业务来源待核');
  if(field==='consumption'&&quote.assembly&&kind!=='material')conflict('按件计价的 IE 或工艺行没有独立用量办理');
  const recipient=field==='consumption'?assignment.technicalAssigneeId:assignment.priceAssigneeId;
  if(!recipient)return conflict('请在原入口核对本字段的有效责任人');
  return {row,recipient,role:field==='consumption'?'pattern_room_worker':assignment.priceRole,
    version:fieldSource(quote,rowId,field)?.version??null,craft:kind==='craft'};
}

/** Called only by the already scoped, idempotent quotation transaction. */
export async function applyWorkbenchLineReview(db:PoolClient,quote:AssembledQuotation,actorId:string,designer:boolean,command:QuotationLineReviewCommand){
  const round=roundFor(quote)??conflict('没有可以核对的当前报价轮次');
  const at=businessNow().toISOString();
  if(command.action==='return'){
    if(!designer)digitalForbidden();
    const target=fieldTarget(quote,command.rowId,command.field);
    if(round!==command.expectedRound||target.version!==command.expectedFieldVersion)conflict('本字段或轮次已更新，请重新核对后退回');
    await lockResponsibleRole(db,target.recipient,target.role);
    const inserted=await db.query(`INSERT INTO digital_quotation_line_reviews(review_id,quote_id,round_number,row_id,
      field,return_quote_version,return_field_version,reason,return_actor,return_at,recipient_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [randomUUID(),quote.quote_id,round,command.rowId,command.field,quote.version,target.version,command.reason,actorId,at,target.recipient]);
    if(inserted.rowCount!==1)conflict('本字段已有待处理退回');
    return;
  }
  const {rows:[review]}=await db.query<LineReview>(`SELECT review_id,row_id,field,reason,return_field_version,resubmit_field_version
    FROM digital_quotation_line_reviews WHERE quote_id=$1 AND round_number=$2 AND review_id=$3 AND resolve_at IS NULL FOR UPDATE`,
  [quote.quote_id,round,command.reviewId]);
  if(!review)return digitalNotFound();
  const target=fieldTarget(quote,review.row_id,review.field);
  if(command.action==='resubmit'){
    if(actorId!==target.recipient||fieldSource(quote,review.row_id,review.field)?.actorId!==actorId)digitalForbidden();
    await lockResponsibleRole(db,actorId,target.role);
    if(target.version!==command.expectedFieldVersion||target.version<=(review.return_field_version??0)
      ||review.resubmit_field_version!==null&&target.version<=review.resubmit_field_version||target.row[review.field]==='')conflict('请先在原入口保存本字段的新版本，再明确重报');
    await db.query(`UPDATE digital_quotation_line_reviews SET resubmit_field_version=$2,resubmit_actor=$3,resubmit_at=$4
      WHERE review_id=$1`,[review.review_id,target.version,actorId,at]);
    return;
  }
  if(!designer)digitalForbidden();
  if(target.version!==command.expectedFieldVersion||review.resubmit_field_version!==target.version)conflict('本字段没有可复核的当前重报版本');
  if(target.craft)conflict('工艺报价须先核对本项当前版本的有效审批');
  await db.query('UPDATE digital_quotation_line_reviews SET resolve_actor=$2,resolve_at=$3 WHERE review_id=$1',[review.review_id,actorId,at]);
}
