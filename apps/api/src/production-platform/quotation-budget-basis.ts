import type {Pool,PoolClient} from 'pg';
import {compareQuotationBudget,type BudgetQuoteComparison,type QuotationConfirmation} from '@dx-rework/contracts/digital-quotation';
import type {BudgetDocument} from '@dx-rework/contracts/digital-budget';
import {ApplicationError} from '../platform/errors.js';
import {approvedSecondaryCraftRows,hasPublishedSecondaryCraft,hasUnmappedSecondaryCraft,requiredCraftRows,secondaryCraftReady,type SecondaryCraftApprovalRef} from './secondary-craft-quotation.js';
import type {AssembledQuotation} from './quotation-assembly.js';
type Database=Pick<Pool|PoolClient,'query'>;
export async function hasQuotationSchema(db:Database){return Boolean((await db.query("SELECT to_regclass('digital_quotation_documents') AS relation")).rows[0]?.relation);}
export const designerQuotationPolicy='designer_quote_v1';
export async function workbenchCommercialOrderPolicy(db:Database,orderId:string):Promise<string|null>{
 const row=(await db.query("SELECT to_jsonb(rule)->>'workbench_commercial_policy' AS policy FROM digital_commercial_order_rules rule WHERE production_order_id=$1",[orderId])).rows[0];
 return row?.policy??null;
}
export async function formalOrderQuantity(db:Database,orderId:string):Promise<number>{
 return Number((await db.query('SELECT coalesce(sum(s.quantity),0)::text AS quantity FROM digital_production_po_lines l JOIN digital_production_po_sizes s USING(line_id) WHERE l.production_order_id=$1',[orderId])).rows[0]?.quantity??0);
}
// Called only inside an authenticated command transaction holding the shared
// lifecycle lock. GET/read operations never create drafts or adopt old orders.
export async function hasCurrentBudgetCraftBasis(db:Database,quote:AssembledQuotation,stored:SecondaryCraftApprovalRef[]|null,lock:boolean){
 if(await hasUnmappedSecondaryCraft(db,quote))return false;
 if(!requiredCraftRows(quote).length)return true;
 if(!Array.isArray(stored)||!await secondaryCraftReady(db))return false;
 const {required,confirmed}=await approvedSecondaryCraftRows(db,quote,lock);
 return required.length>0&&confirmed.size===required.length&&stored.length===required.length
  &&stored.every(item=>{
   const actual=confirmed.get(item.rowId);
   return actual?.revision===item.revision&&actual.decisionId===item.decisionId&&actual.actorId===item.actorId;
  });
}

export async function budgetCraftBasisIsCurrent(db:Database,orderId:string,policy:BudgetQuoteComparison['policy'],lock=false){
 if(policy==='legacy')return true; // Only the original commercial enrollment governs this budget.
 if(!await hasQuotationSchema(db))return true;
 const result=(await db.query<AssembledQuotation&{approvals:SecondaryCraftApprovalRef[]|null}>(`SELECT q.*,
  to_jsonb(v)->'secondary_craft_approvals' approvals FROM digital_quotation_documents q
  LEFT JOIN digital_quotation_versions v ON v.quote_id=q.quote_id AND v.version=q.confirmed_version
  WHERE q.production_order_id=$1`,[orderId])).rows[0];
 if(result)return hasCurrentBudgetCraftBasis(db,result,result.approvals,lock);
 const source=(await db.query('SELECT source_id FROM digital_production_orders WHERE production_order_id=$1',[orderId])).rows[0];
 return !await hasPublishedSecondaryCraft(db,source?.source_id??null);
}

export async function assertBudgetCraftBasis(db:PoolClient,orderId:string,policy:BudgetQuoteComparison['policy']){
 if(!await budgetCraftBasisIsCurrent(db,orderId,policy,true))
  throw new ApplicationError('BUDGET_QUOTE_BASIS_CONFLICT','请先核对本单当前工艺批准版本及客户确认报价',409);
}

export async function ensureQuotationBudget(db:PoolClient,orderId:string,actorId:string){
 if(!await hasQuotationSchema(db))return;
 const order=(await db.query('SELECT * FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[orderId])).rows[0];
 if(!order)return;
 const candidates=(await db.query('SELECT * FROM digital_quotation_documents WHERE production_order_id=$1 OR ($2::uuid IS NOT NULL AND source_id=$2) FOR UPDATE',[orderId,order.source_id])).rows;
 if(candidates.length>1)throw new ApplicationError('QUOTATION_RESOURCE_CONFLICT','订单与开发来源各有独立报价，不能自动合并或覆盖确认依据；请先核对原报价',409);
 const quote=candidates[0];
 if(!quote)return;
 if(!quote.production_order_id)await db.query('UPDATE digital_quotation_documents SET production_order_id=$2 WHERE quote_id=$1',[quote.quote_id,orderId]);
 if(!quote.confirmed_version)return;
 const rule=(await db.query("SELECT to_jsonb(rule)->>'workbench_commercial_policy' AS policy FROM digital_commercial_order_rules rule WHERE production_order_id=$1",[orderId])).rows[0];
 if(!rule)return; // Explicit historical adoption is separate; never infer consent.
 const current=(await db.query('SELECT * FROM digital_budget_documents WHERE production_order_id=$1 FOR UPDATE',[orderId])).rows[0];
 if(current)return; // Revisions must be explicitly adopted; no overwrite.
 const version=(await db.query('SELECT * FROM digital_quotation_versions WHERE quote_id=$1 AND version=$2',[quote.quote_id,quote.confirmed_version])).rows[0];
 if(!version||rule.policy===designerQuotationPolicy&&version.customer_code!==order.customer_code)return;
 if(!await hasCurrentBudgetCraftBasis(db,quote,version.secondary_craft_approvals??null,true))return;
 await db.query('INSERT INTO digital_budget_quote_conversions(production_order_id,quote_id,quote_version,created_budget_version) VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING',[orderId,quote.quote_id,quote.confirmed_version]);
 await db.query(`INSERT INTO digital_budget_documents(production_order_id,version,status,document,updated_by,quote_id,quote_version)
 VALUES($1,1,'draft',$2,$3,$4,$5)`,[orderId,version.document,actorId,quote.quote_id,quote.confirmed_version]);
}
export async function readBudgetQuoteComparison(db:Database,orderId:string,budget:{document:BudgetDocument;quote_id?:string|null;quote_version?:number|null}|undefined,historical=false):Promise<BudgetQuoteComparison>{
 const legacy:BudgetQuoteComparison={policy:'legacy',quoteId:null,quoteVersion:null,currentConfirmedVersion:null,state:'legacy',reason:'历史预算，未补造客户确认报价',budgetComparableTotal:null,confirmedQuoteTotal:null,amountScope:null,baseline:null,confirmation:null};
 if(!await hasQuotationSchema(db))return legacy;
 const rule=(await db.query("SELECT to_jsonb(rule)->>'workbench_commercial_policy' AS policy FROM digital_commercial_order_rules rule WHERE production_order_id=$1",[orderId])).rows[0];
 if(!rule)return legacy;
 const scoped=rule.policy===designerQuotationPolicy&&!historical;
 const quote=(await db.query(`SELECT q.quote_id,q.version,q.confirmed_version,v.customer_code AS confirmed_customer,o.customer_code AS order_customer
   FROM digital_quotation_documents q JOIN digital_production_orders o USING(production_order_id)
   LEFT JOIN digital_quotation_versions v ON v.quote_id=q.quote_id AND v.version=q.confirmed_version
   WHERE q.production_order_id=$1`,[orderId])).rows[0];
 const comparison:BudgetQuoteComparison={...legacy,policy:'quote_v1',state:'waiting_confirmation',reason:'等待客户确认报价与正式下单，不能发布预算',currentConfirmedVersion:quote?.confirmed_version??null,pendingQuotationVersion:quote&&quote.version!==quote.confirmed_version?quote.version:null,...(scoped?{workbenchBasis:'unconfirmed'}:{})};
 if(!quote?.confirmed_version)return comparison;
 if(scoped&&quote.confirmed_customer!==quote.order_customer)return {...comparison,workbenchBasis:'customer_mismatch',state:'incomparable',reason:'客户确认报价所属客户与当前订单不一致，请核对原报价'};
 if(!budget?.quote_id||!budget.quote_version||budget.quote_id!==quote.quote_id||!historical&&budget.quote_version!==quote.confirmed_version)return {...comparison,state:'review_required',reason:'客户确认报价已有新版本，请跟单明确采用后复核预算',...(scoped?{workbenchBasis:'adoption_required'}:{})};
 const source=(await db.query('SELECT document,confirmation,customer_code FROM digital_quotation_versions WHERE quote_id=$1 AND version=$2',[budget.quote_id,budget.quote_version])).rows[0];
 if(!source)throw new ApplicationError('BUDGET_QUOTE_BASIS_MISSING','报价对照依据缺失，未放行预算',409);
 if(source.customer_code!==quote.order_customer)return {...comparison,state:'incomparable',reason:'客户确认报价所属客户与当前订单不一致，不能发布预算'};
 const confirmation=source.confirmation as QuotationConfirmation;
 return {...comparison,...compareQuotationBudget(budget.document,confirmation,historical&&confirmation.quantity!==null?confirmation.quantity:await formalOrderQuantity(db,orderId)),quoteId:budget.quote_id,quoteVersion:budget.quote_version,baseline:source.document,confirmation,amountScope:confirmation.amountScope,...(scoped?{workbenchBasis:'valid'}:{})};
}
