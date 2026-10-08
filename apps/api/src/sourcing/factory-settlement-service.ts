import {randomUUID} from "node:crypto";
import type {PoolClient} from "pg";
import type {TrustedActorContext} from "../tools/repositories.js";
import type {OperationEventRepository} from "../tools/repositories.js";
import {ApplicationError} from "../platform/errors.js";
type Query=Pick<PoolClient,"query">;
export async function factorySettlements(client:Query,caseId:string){
 const result=await client.query<{decision_id:string;supplier_id:string;supplier_code:string;supplier_name:string;quantity:number;unit_price:string;total_amount:string;document_id:string;contract_version:number;contract_fingerprint:string;contract_number:string;pdf_attachment_id:string|null;status:string;result:string|null}>(`SELECT production.sourcing_decision_id AS decision_id,production.supplier_id,approval.supplier_code_snapshot AS supplier_code,
  production.supplier_name_snapshot AS supplier_name,production.quantity,decision.unit_price::text,
  (SELECT COALESCE(sum(round(allocation.quantity*line.unit_price,2)),0)::text FROM sourcing_factory_execution_lines(production.production_order_id,production.sourcing_decision_id) allocation
   JOIN sourcing_approval_snapshot_lines line ON line.sourcing_approval_snapshot_id=production.sourcing_approval_snapshot_id AND line.position=allocation.position) AS total_amount,
  document.sourcing_contract_document_id AS document_id,document.contract_version,document.snapshot_fingerprint AS contract_fingerprint,
  sourcing_contract_display_number(document.sourcing_contract_document_id,document.contract_number) AS contract_number,document.pdf_attachment_id,document.status,
  reconciliation.result
  FROM sourcing_production_factory_orders production JOIN sourcing_approval_snapshots approval USING(sourcing_approval_snapshot_id)
  JOIN sourcing_decisions decision ON decision.sourcing_decision_id=production.sourcing_decision_id
  JOIN sourcing_contract_documents document ON document.sourcing_contract_document_id=production.sourcing_contract_document_id
  LEFT JOIN LATERAL(SELECT result FROM sourcing_finance_reconciliations reconciliation WHERE reconciliation.sourcing_case_id=production.sourcing_case_id
    AND reconciliation.sourcing_decision_id=production.sourcing_decision_id ORDER BY reconciliation.reconciliation_version DESC LIMIT 1) reconciliation ON true
  WHERE production.sourcing_case_id=$1 AND EXISTS(SELECT 1 FROM sourcing_cases source_case WHERE source_case.sourcing_case_id=$1 AND source_case.deleted_at IS NULL) AND production.quantity>0 AND EXISTS(SELECT 1 FROM sourcing_production_factory_transfers transfer WHERE transfer.production_order_id=production.production_order_id)
  ORDER BY production.decision_version`,[caseId]);
 return result.rows;
}
export async function reconcileFactory(client:PoolClient,actor:TrustedActorContext,caseId:string,input:{factoryDecisionId:string;result:"match"|"difference";differenceFields?:string[]|undefined;differenceReason?:string|undefined},events:OperationEventRepository){
 const source=(await factorySettlements(client,caseId)).find(s=>s.decision_id===input.factoryDecisionId);
 if(!source)throw new ApplicationError("NOT_FOUND","该加工厂没有本单可核对的生产份额",404);
 if(source.status!=="ready"||!source.pdf_attachment_id)throw new ApplicationError("INVALID_STATE_TRANSITION","本厂合同 PDF 尚未就绪",409);
 const id=randomUUID(),version=Number((await client.query("SELECT COALESCE(max(reconciliation_version),0)+1 AS version FROM sourcing_finance_reconciliations WHERE sourcing_case_id=$1",[caseId])).rows[0].version);
 const difference=input.result==="difference",reason=difference?input.differenceReason!.trim():null,fields=input.differenceFields??[];
 const event=await events.append(client,actor,{action:difference?"sourcing.finance.difference":"sourcing.finance.matched",entityType:"sourcing_case",entityId:caseId,
  after:{factoryDecisionId:input.factoryDecisionId,reconciliationId:id,reconciliationVersion:version,result:input.result,differenceFields:fields},...(reason?{reason}:{})});
 await client.query(`INSERT INTO sourcing_finance_reconciliations(sourcing_reconciliation_id,sourcing_case_id,reconciliation_version,sourcing_decision_id,
  sourcing_contract_document_id,contract_version,contract_fingerprint,actual_supplier_id,actual_supplier_code_snapshot,actual_supplier_name_snapshot,
  actual_unit_price,actual_quantity,actual_total_amount,result,difference_fields,difference_reason,reconciled_by,operation_event_id,request_id,factory_decision_id)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$4)`,
  [id,caseId,version,input.factoryDecisionId,source.document_id,source.contract_version,source.contract_fingerprint,source.supplier_id,source.supplier_code,source.supplier_name,
   source.unit_price,source.quantity,source.total_amount,input.result,fields,reason,actor.actorId,event,actor.requestId]);
}
