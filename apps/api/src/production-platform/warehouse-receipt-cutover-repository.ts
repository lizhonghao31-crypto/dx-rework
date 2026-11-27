import type {PreparationResource,WarehouseReceiptWorkItem} from '@dx-rework/contracts/production-readiness';
import type {PreparationDB} from './preparation-material-repository.js';
import {reconciliationResourceKey} from './warehouse-receipt-reconciliation-repository.js';

export type WarehouseCutover={generation:number;mode:'active'|'safe_read';scopeKeys:string[];resource:PreparationResource};
export const warehouseCutoverPaused='本采购范围暂停收布和放行，原实收与质量记录仍可查看';
export const warehouseCutoverScopeKey=(item:WarehouseReceiptWorkItem)=>JSON.stringify([
 item.basis.resource.kind,item.basis.resource.id,item.materialId,item.lineId,item.scopeRef,item.basis.supplierId,item.basis.unit,
]);

export function warehouseCutoverScopesCurrent(rows:readonly WarehouseReceiptWorkItem[],cutover:WarehouseCutover){
 const keys=rows.filter(row=>row.kind==='fabric_receipt').map(warehouseCutoverScopeKey).sort();
 return keys.length===cutover.scopeKeys.length&&keys.every((key,index)=>key===cutover.scopeKeys[index]);
}
export function warehouseCutoverResources(resource:PreparationResource,sourceId:string|null){
 return [resource,...(resource.kind==='order'&&sourceId?[{kind:'source' as const,id:sourceId}]:[])];
}
export async function warehouseCutovers(db:PreparationDB,resources:readonly PreparationResource[]){
 const state=new Map<string,WarehouseCutover>();
 if(!resources.length||!(await db.query("SELECT to_regclass('digital_warehouse_receipt_cutovers') AS relation")).rows[0]?.relation)return state;
 const {rows}=await db.query<{resource_kind:PreparationResource['kind'];resource_id:string;generation:number;
  mode:WarehouseCutover['mode'];scope_keys:string[]}>(`SELECT DISTINCT ON (c.resource_kind,c.resource_id)
  c.resource_kind,c.resource_id,c.generation,c.mode,c.scope_keys
  FROM jsonb_to_recordset($1::jsonb) AS scope(kind text,id uuid)
  JOIN digital_warehouse_receipt_cutovers c ON (c.resource_kind,c.resource_id)=(scope.kind,scope.id)
  ORDER BY c.resource_kind,c.resource_id,c.generation DESC`,[JSON.stringify(resources)]);
 for(const row of rows){
  const resource={kind:row.resource_kind,id:row.resource_id};
  state.set(reconciliationResourceKey(resource),{resource,generation:row.generation,mode:row.mode,scopeKeys:row.scope_keys});
 }
 return state;
}
export function effectiveWarehouseCutover(state:Map<string,WarehouseCutover>,resources:PreparationResource[]){
 return resources.map(reconciliationResourceKey).map(key=>state.get(key)).find(Boolean)??null;
}
export async function readWarehouseCutover(db:PreparationDB,resource:PreparationResource,sourceId:string|null=null){
 const resources=warehouseCutoverResources(resource,sourceId);
 return effectiveWarehouseCutover(await warehouseCutovers(db,resources),resources);
}
