import {craftStepIdentity,type AdoptedCraftStep} from '@dx-rework/contracts/digital-craft';
import type {QuotationAssembly} from '@dx-rework/contracts/digital-quotation';
import type {PoolClient} from 'pg';
import type {AssembledQuotation} from './quotation-assembly.js';
import {approvedSecondaryCraftRows,secondaryCraftReady} from './secondary-craft-quotation.js';

type CraftStep=Pick<AdoptedCraftStep,'stepId'|'craftKind'|'sequence'|'specialCraft'>;

/** Quote approval is per exact bulk step, never a matching factory label or
 * an approval on the old development worksheet. Multiple matches require
 * review rather than taking the first or latest arbitrary quotation row. */
export function exactBulkCraftQuotationRow(assembly:QuotationAssembly,step:CraftStep){
 if(!step.specialCraft)return null;
 const {id,version}=step.specialCraft;
 const sourceRef=`craft:bulk:${craftStepIdentity(step)}`;
 const matching=Object.entries(assembly.rows).filter(([,ref])=>ref.kind==='craft'&&ref.stage==='bulk'&&ref.sourceRef===sourceRef&&
  ref.craftRef?.libraryId===id&&ref.craftRef.libraryVersion===version&&(!ref.craftRef.stepId||ref.craftRef.stepId===step.stepId));
 return matching.length===1?matching[0]![0]:null;
}

/** Original qualification only. Caller owns current warehouse assignment and
 * the scoped work/task lock. Do not return prices, approvals for another step,
 * or fabricate a link from a development supplier. For a physical return,
 * read the original captured send instead of changing its factory here. */
export async function readWarehouseCraftFactoryBasis(db:Pick<PoolClient,'query'>,orderId:string,step:CraftStep,lock:boolean){
 if(!step.specialCraft||!await secondaryCraftReady(db))return null;
 const {rows}=await db.query<AssembledQuotation>(`SELECT q.* FROM digital_quotation_documents q JOIN digital_production_orders o
  ON o.production_order_id=q.production_order_id AND o.source_id=q.source_id
  WHERE q.production_order_id=$1 AND q.assembly IS NOT NULL ${lock?'FOR SHARE OF q':''}`,[orderId]);
 if(rows.length!==1||!rows[0]?.assembly)return null;
 const quote=rows[0],rowId=exactBulkCraftQuotationRow(quote.assembly!,step);
 if(!rowId)return null;
 const approvals=await approvedSecondaryCraftRows(db,quote,lock),approved=approvals.confirmed.get(rowId);
 if(!approved)return null;
 const original=(await db.query<{supplier_id:string;supplier_version:number;supplier_name:string}>(`SELECT r.supplier_id,r.supplier_version,s.supplier_name
  FROM digital_secondary_craft_quote_revisions r JOIN digital_secondary_craft_quote_decisions d USING(quote_id,row_id,revision)
  JOIN supplier_catalog_versions s ON s.supplier_id=r.supplier_id AND s.version=r.supplier_version
  WHERE r.quote_id=$1 AND r.row_id=$2 AND r.revision=$3 AND d.decision_id=$4
   AND r.stage='bulk' AND r.scope_id=$5 AND d.decision='approved'`,[quote.quote_id,rowId,approved.revision,approved.decisionId,orderId])).rows[0];
 if(!original)return null;
 return {stepRef:step.stepId,quoteId:quote.quote_id,rowId,approvalRevision:approved.revision,approvalId:approved.decisionId,
  supplierId:original.supplier_id,supplierVersion:original.supplier_version,supplierName:original.supplier_name};
}
