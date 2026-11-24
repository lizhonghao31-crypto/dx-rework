import {createHash} from "node:crypto";
import type {PoolClient} from "pg";
import {
  SOURCING_OWNER_APPROVAL_CHANGED,
  SourcingOwnerApprovalBasisSchema,
  type SourcingCaseSummary,
  type SourcingOwnerApprovalBasis,
  type SourcingOwnerReview,
} from "@dx-rework/contracts";
import {ApplicationError} from "../platform/errors.js";

type Db=Pick<PoolClient,"query">;
type Dates={lineId:string;position:number;customerVersion:number;factoryVersion:number};
type TransferDate={lineId:string;position:number;date:string;oldDate:string|null;expectedVersion:number};
type TransferProposal={factoryChangeRequestId:string;deliveryDate:string|null;poDates:TransferDate[]};
type Evidence={
  budgetRevision:number;
  detailRevision:number;
  attachments:readonly string[];
  dates:readonly Dates[];
  proposal:TransferProposal|null;
};
type ExpectedInput=Partial<{[Key in keyof SourcingOwnerApprovalBasis]:SourcingOwnerApprovalBasis[Key]|undefined}>;

export function sourcingOwnerExpectation(input:ExpectedInput):SourcingOwnerApprovalBasis|null {
  const result=SourcingOwnerApprovalBasisSchema.safeParse({
    expectedDecisionId:input.expectedDecisionId,
    expectedDecisionVersion:input.expectedDecisionVersion,
    expectedVersion:input.expectedVersion,
    expectedApprovalBasis:input.expectedApprovalBasis,
  });
  return result.success?result.data:null;
}

export function requireSourcingOwnerApproval(expected:SourcingOwnerApprovalBasis|null,actual:SourcingOwnerReview|null):SourcingOwnerApprovalBasis {
  if(!expected||!actual||expected.expectedDecisionId!==actual.basis.expectedDecisionId
    ||expected.expectedDecisionVersion!==actual.basis.expectedDecisionVersion||expected.expectedVersion!==actual.basis.expectedVersion
    ||expected.expectedApprovalBasis!==actual.basis.expectedApprovalBasis)
    throw new ApplicationError("CONFLICT",SOURCING_OWNER_APPROVAL_CHANGED,409);
  return actual.basis;
}

const byPosition=<T extends {position:number}>(rows:readonly T[])=>[...rows].sort((a,b)=>a.position-b.position);

/** The same finite projection defines the displayed original approval and its write guard. */
export function buildSourcingOwnerApprovalBasis(item:SourcingCaseSummary,evidence:Evidence):SourcingOwnerReview|null {
  const {decision,ieQuote}=item;
  if(item.status!=="pending_owner_approval"||!decision)return null;
  const prices=(rows:typeof decision.linePrices)=>byPosition(rows).map(({position,quantity,unitPrice,totalAmount})=>[position,quantity,unitPrice,totalAmount]);
  const proposal=evidence.proposal;
  const digest=createHash("sha256").update(JSON.stringify({
    protocol:"sourcing-owner-review-v1",
    case:[item.sourcingCaseId,item.status,item.version,item.identityRevision??0,evidence.detailRevision,item.erpOrderNo,item.styleNo,item.gender??null,item.styleName??null,item.orderQuantity],
    decision:[decision.sourcingDecisionId,decision.decisionVersion,decision.sourceType,decision.sourceIeQuoteId,decision.supplierId,decision.supplierCode,decision.supplierName,
      decision.unitPrice,decision.quantity,decision.totalAmount,prices(decision.linePrices),decision.cuttingProcess??null,decision.cuttingProcessOther??null,decision.decisionReason],
    ieQuote:ieQuote?[ieQuote.sourcingIeQuoteId,ieQuote.quoteVersion,ieQuote.unitPrice,ieQuote.quantity,ieQuote.totalAmount,prices(ieQuote.linePrices)]:null,
    budget:[item.daxingUnitPrice??null,evidence.budgetRevision],
    craft:[item.processDescription,item.processes,item.crafts?.map(row=>[row.position,row.craftId,row.craftCode,row.craftVersion,row.craftName])??null],
    headerDates:[item.estimatedCutPieceSendDate,item.deliveryDate,proposal?.deliveryDate??item.deliveryDate,proposal?.factoryChangeRequestId??null],
    lines:byPosition(item.lineItems).map(row=>[
      row.position,row.lineId??null,row.styleNo,row.alternateStyleNo,row.formalStyleNo??null,row.color,row.quantity,row.externalUnitPrice,row.imageAttachmentId??null,
      row.customerWarehouseArrivalDate??null,row.factoryDeliveryDate??null,proposal?null:row.proposedFactoryDeliveryDate??null,
    ]),
    dates:byPosition(evidence.dates).map(row=>[row.lineId,row.position,row.customerVersion,row.factoryVersion]),
    transferDates:byPosition(proposal?.poDates??[]).map(row=>[row.lineId,row.position,row.date,row.oldDate,row.expectedVersion]),
    attachments:[...evidence.attachments].sort(),
  })).digest("hex");
  return {item,proposal:proposal?{
    factoryChangeRequestId:proposal.factoryChangeRequestId,deliveryDate:proposal.deliveryDate,
    poDates:byPosition(proposal.poDates).map(({lineId,position,date})=>({lineId,position,date})),
  }:null,basis:{
    expectedDecisionId:decision.sourcingDecisionId,expectedDecisionVersion:decision.decisionVersion,expectedVersion:item.version,expectedApprovalBasis:digest,
  }};
}

export async function readSourcingOwnerApprovalBasis(db:Db,item:SourcingCaseSummary,attachments:readonly string[]):Promise<SourcingOwnerReview|null>{
  if(item.status!=="pending_owner_approval"||!item.decision)return null;
  const source=(await db.query<{
    budget_revision:number;
    detail_revision:number;
    proposal_id:string|null;
    proposal_date:string|null;
    transfer_dates:TransferDate[]|null;
  }>(`SELECT
    COALESCE((SELECT correction_version FROM sourcing_budget_price_corrections WHERE sourcing_case_id=d.sourcing_case_id ORDER BY correction_version DESC LIMIT 1),0) AS budget_revision,
    COALESCE((SELECT correction_version FROM sourcing_case_corrections WHERE sourcing_case_id=d.sourcing_case_id ORDER BY correction_version DESC LIMIT 1),0) AS detail_revision,
    request.factory_change_request_id AS proposal_id,after_state->>'deliveryDate' AS proposal_date,
    after_state->'transferPoDates' AS transfer_dates
    FROM sourcing_decisions d
    LEFT JOIN sourcing_factory_change_requests request ON request.factory_change_request_id=d.source_change_request_id AND request.sourcing_case_id=d.sourcing_case_id
    LEFT JOIN operation_events event ON event.event_id=request.operation_event_id
    WHERE d.sourcing_case_id=$1 AND d.sourcing_decision_id=$2`,[item.sourcingCaseId,item.decision.sourcingDecisionId])).rows[0];
  if(!source||(item.decision.sourceType==="factory_change"&&!source.proposal_id))return null;
  const dateVersions=item.lineItems.some(line=>line.lineId)?(await db.query<Dates>(`SELECT po.line_id AS "lineId",child.child_line_key::int AS position,
    po.customer_date_version AS "customerVersion",po.factory_date_version AS "factoryVersion"
    FROM digital_production_child_lines child
    JOIN digital_production_po_lines po ON po.production_order_id=child.production_order_id AND po.line_id=child.line_id
    WHERE child.module='sourcing' AND child.child_id=$1`,[item.sourcingCaseId])).rows:[];
  const selectedPositions=new Set(item.decision.linePrices.map(row=>row.position));
  const selectedLines=new Map(item.lineItems.map(row=>[row.lineId,row.position]));
  const proposal=source.proposal_id?{factoryChangeRequestId:source.proposal_id,deliveryDate:source.proposal_date,
    poDates:(source.transfer_dates??[]).filter(row=>selectedLines.get(row.lineId)===row.position&&selectedPositions.has(row.position)),
  }:null;
  return buildSourcingOwnerApprovalBasis(item,{budgetRevision:source.budget_revision,detailRevision:source.detail_revision,attachments,dates:dateVersions,proposal});
}
