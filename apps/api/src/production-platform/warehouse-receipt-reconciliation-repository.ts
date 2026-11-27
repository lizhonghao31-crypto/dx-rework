import type {PreparationResource,WarehouseReceiptReconciliation} from '@dx-rework/contracts/production-readiness';
import type {PreparationDB} from './preparation-material-repository.js';
import type {ReconciliationBinding} from './warehouse-receipt-reconciliation-projection.js';

type Confirm=Extract<WarehouseReceiptReconciliation,{action:'confirm'}>;
export const reconciliationDocumentIdentity=(line:{documentNumber:string;line:string})=>
 JSON.stringify([line.documentNumber.normalize('NFKC').toUpperCase(),line.line.normalize('NFKC').toUpperCase()]);

export const reconciliationResourceKey=({kind,id}:PreparationResource)=>kind+':'+id;
export const warehouseReceiptReconciliationAvailable=async(db:PreparationDB)=>
 Boolean((await db.query("SELECT to_regclass('digital_warehouse_receipt_reconciliations') AS relation")).rows[0]?.relation);

// One set-oriented repository read for every exact authorized warehouse subject.
export async function readWarehouseReceiptReconciliations(db:PreparationDB,resources:readonly PreparationResource[]){
 const result=new Map<string,ReconciliationBinding[]>();
 if(!resources.length||!await warehouseReceiptReconciliationAvailable(db))return result;
 const rows=(await db.query<{resource_kind:PreparationResource['kind'];resource_id:string;generation:number;state:ReconciliationBinding['state'];
  binding:Confirm;recorded_at:Date;proof_valid:boolean}>(`SELECT DISTINCT ON (r.original_record_id,r.original_version,r.quantity_row_key)
  r.*,NOT EXISTS(SELECT 1 FROM unnest(r.proof_attachment_ids) ids(id)
   LEFT JOIN attachments a ON a.attachment_id=ids.id AND a.status='ready' WHERE a.attachment_id IS NULL) AS proof_valid
  FROM jsonb_to_recordset($1::jsonb) keys(kind text,id uuid)
  JOIN digital_warehouse_receipt_reconciliations r ON (r.resource_kind,r.resource_id)=(keys.kind,keys.id)
  ORDER BY r.original_record_id,r.original_version,r.quantity_row_key,r.generation DESC`,[JSON.stringify(resources)])).rows;
 for(const row of rows){
  const key=reconciliationResourceKey({kind:row.resource_kind,id:row.resource_id}),current=result.get(key)??[];
  current.push({...row.binding,generation:row.generation,state:row.state,recordedAt:row.recorded_at.toISOString(),proofValid:row.proof_valid});
  result.set(key,current);
 }
 return result;
}

export async function appendWarehouseReceiptReconciliation(db:PreparationDB,resource:PreparationResource,actorId:string,
 binding:Confirm,generation:number,state:ReconciliationBinding['state'],proofAttachmentIds:string[]){
 await db.query(`INSERT INTO digital_warehouse_receipt_reconciliations
  (resource_kind,resource_id,original_record_id,original_version,quantity_row_key,generation,state,binding,proof_attachment_ids,actor_id)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[resource.kind,resource.id,binding.legacy.ref.recordId,binding.legacy.ref.version,
  binding.legacy.quantityRowKey,generation,state,JSON.stringify(binding),proofAttachmentIds,actorId]);
}
