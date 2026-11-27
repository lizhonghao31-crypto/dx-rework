import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {preparationInvestmentRowKey,type PreparationMaterialFact,type PreparationResource,type WarehouseReceiptAttestation,
 type WarehouseReceiptReconciliation,type WarehouseReceiptWorkItem} from '@dx-rework/contracts/production-readiness';
import {acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import {ApplicationError} from '../platform/errors.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {digitalForbidden} from './access-policy.js';
import {warehouseLegacyReceiptHeads,type ReconciliationBinding} from './warehouse-receipt-reconciliation-projection.js';
import {reconciliationDocumentIdentity} from './warehouse-receipt-reconciliation-repository.js';

type ReconciliationScope=Pick<WarehouseReceiptAttestation,'materialId'|'scopeRef'|'lineId'|'unit'|'supplierId'|'investment'|'materialFingerprint'|'legacy'>;
type Confirm=Extract<WarehouseReceiptReconciliation,{action:'confirm'}>;
type Ref=Confirm['batch'];
export type ReconciliationAttestation=Omit<WarehouseReceiptAttestation,'note'>;
export const warehouseReconciliationAttestationAction='preparation_warehouse_receipt_operator_attestation';
export const reconciliationConflict=(message:string):never=>{throw new ApplicationError('CONFLICT',message,409);};
export const sameReceiptRef=(a:Ref,b:Ref)=>a.recordId===b.recordId&&a.version===b.version;
export const sameReconciliationScope=(a:ReconciliationScope,b:ReconciliationScope)=>a.scopeRef===b.scopeRef&&a.materialId===b.materialId&&
 a.lineId===b.lineId&&a.supplierId===b.supplierId&&a.unit===b.unit&&a.materialFingerprint===b.materialFingerprint&&
 sameReceiptRef(a.investment,b.investment)&&sameReceiptRef(a.legacy.ref,b.legacy.ref)&&a.legacy.quantityRowKey===b.legacy.quantityRowKey;

export function findWarehouseReceiptReconciliationItem(items:WarehouseReceiptWorkItem[],input:ReconciliationScope){
 return items.find(item=>item.kind==='fabric_receipt'&&item.scopeRef===input.scopeRef&&item.materialId===input.materialId&&
  item.lineId===input.lineId&&item.basis.supplierId===input.supplierId&&item.basis.unit===input.unit&&
  item.basis.adoptedRef===input.materialFingerprint&&sameReceiptRef(item.purchase.original,input.investment))
  ??reconciliationConflict('采购投料依据、物料、PO 或单位已变化，请重新读取原物料');
}

export function originalWarehouseReconciliationPair(history:PreparationMaterialFact[],item:WarehouseReceiptWorkItem,input:Confirm|WarehouseReceiptAttestation){
 const old=warehouseLegacyReceiptHeads(history,item.basis).find(row=>sameReceiptRef(row,input.legacy.ref));
 const rows=old?.quantities.filter(row=>preparationInvestmentRowKey(row)===input.legacy.quantityRowKey)??[];
 const [quantity]=rows;
 const batch=history.find(row=>sameReceiptRef(row,input.batch));
 const occurrence=item.activeBatches.find(row=>sameReceiptRef(row.ref,input.batch));
 if(!old?.valid||!old.occurredAt||Date.parse(old.occurredAt)<Date.parse(item.purchase.investedAt)||!['partial','ready'].includes(old.state)||rows.length!==1||!quantity||quantity.quantity<=0||
  quantity.unit!==item.basis.unit||quantity.materialId!==null&&quantity.materialId!==item.materialId||
  quantity.lineId!==null&&quantity.lineId!==item.lineId||
  !batch?.valid||!batch.occurredAt||!batch.warehouseReceipt||!occurrence||Number(occurrence.quantity.quantity)<=0){
  return reconciliationConflict('原数量行或对照批不属于当前有效采购范围，请重新核对');
 }
 if(input.relation==='same_batch'&&Number(occurrence.quantity.quantity)!==quantity.quantity)
  return reconciliationConflict('数量不同，不能当成同一完整实物批；请保留原件待核');
 return {old,batch};
}

/** The original receipt-author identity and recoverable command both need to exist.
 * A note, a Root session or a submitted identity string cannot attest. */
export async function createWarehouseOperatorAttestation(db:PoolClient,actor:TrustedActorContext,resource:PreparationResource,
 input:WarehouseReceiptAttestation,record:PreparationMaterialFact){
 const context=acceptanceBusinessContext();
 if(!context?.scenarioId||!await context.acceptsActor(actor.actorId)||actor.actorId!==record.recordedBy)digitalForbidden();
 const ref={recordId:record.recordId,version:record.version};
 const originalCommand=(await db.query(`SELECT 1 FROM digital_production_commands c
  WHERE actor_id=$1 AND command=ANY($2::text[]) AND (c.response->'history') @> $3::jsonb LIMIT 1`,
 [actor.actorId,[`preparation:${resource.kind}:${resource.id}:record`,`preparation:${record.resource.kind}:${record.resource.id}:record`],
  JSON.stringify([ref])])).rows[0];
 if(!originalCommand)reconciliationConflict('找不到该笔原收料的系统操作回执，须使用原实物凭证');
 const id=randomUUID();
 await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state)
  VALUES($1,$2,$3,$4,'digital_preparation',$5,$6)`,[id,actor.requestId,actor.actorId,warehouseReconciliationAttestationAction,
  resource.id,JSON.stringify({...input,scenarioId:context!.scenarioId})]);
 return {attestationId:id};
}

export async function verifyWarehouseReconciliationProof(db:PoolClient,resource:PreparationResource,input:Confirm,
 pair:ReturnType<typeof originalWarehouseReconciliationPair>,
 current:readonly ReconciliationBinding[]){
 const proof=input.proof;
 if(proof.mode==='document'){
  const legacyIdentity=reconciliationDocumentIdentity(proof.legacy),batchIdentity=reconciliationDocumentIdentity(proof.batch);
  if((legacyIdentity===batchIdentity)!==(input.relation==='same_batch'))
   reconciliationConflict('两笔凭证明细与所选批次关系不符，请核对原送货单号及行');
  const competing=current.filter(other=>other.state==='confirmed'&&!sameReconciliationScope(other,input)&&other.proof.mode==='document'&&
   other.materialId===input.materialId&&other.scopeRef===input.scopeRef&&other.lineId===input.lineId&&other.supplierId===input.supplierId&&other.unit===input.unit);
  if(competing.some(other=>other.proof.mode==='document'&&(
   reconciliationDocumentIdentity(other.proof.legacy)===legacyIdentity||
   other.relation==='independent'&&reconciliationDocumentIdentity(other.proof.legacy)===batchIdentity||
   input.relation==='independent'&&reconciliationDocumentIdentity(other.proof.batch)===legacyIdentity||
   reconciliationDocumentIdentity(other.proof.batch)===batchIdentity&&!sameReceiptRef(other.batch,input.batch))))
   reconciliationConflict('该采购范围的原凭证明细已参与核对，请核对已有关系');
  return [...new Set([proof.legacy.attachmentId,proof.batch.attachmentId])];
 }
 const context=acceptanceBusinessContext();
 if(!context?.scenarioId)digitalForbidden();
 await context!.assertScope(resource);
 const records=(await db.query<{id:string;actor_id:string;after_state:ReconciliationAttestation&{scenarioId:string}}>(
  "SELECT id,actor_id,after_state FROM audit_events WHERE id=ANY($1::uuid[]) AND action=$2 AND entity_type='digital_preparation' AND entity_id=$3",
  [[proof.legacy,proof.batch],warehouseReconciliationAttestationAction,resource.id])).rows;
 for(const side of ['legacy','batch'] as const){
  const receipt=records.find(record=>record.id===proof[side]),owner=side==='legacy'?pair.old.recordedBy:pair.batch.recordedBy;
  if(!receipt||receipt.actor_id!==owner||!await context!.acceptsActor(owner)||receipt.after_state.side!==side||
   receipt.after_state.scenarioId!==context!.scenarioId||!sameReconciliationScope(receipt.after_state,input)||
   !sameReceiptRef(receipt.after_state.batch,input.batch)||receipt.after_state.relation!==input.relation)
   reconciliationConflict('须由两笔实际操作者分别按原版本及采购范围签认，不能代签');
 }
 return [];
}
