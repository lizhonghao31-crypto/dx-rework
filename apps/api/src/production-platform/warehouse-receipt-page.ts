import type {Pool} from 'pg';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {InstructionDocument} from '@dx-rework/contracts/production-instruction';
import type {PreparationMaterialFact,PreparationResource,WarehouseReceiptListItem,WarehouseReceiptPage,
 WarehouseReceiptPageQuery} from '@dx-rework/contracts/production-readiness';
import {businessNow} from '../acceptance-clock/business-time.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {assignedWarehousePreparationResources} from './warehouse-assigned-resources.js';
import {developmentReadTables} from './development-amendment-repository.js';
import {currentPreparationMaterials,instructionInvestmentMaterials,preparationHandoverCurrent,preparationHash} from './preparation-material-repository.js';
import {deriveWarehouseReceiptWork} from './warehouse-receipt-projection.js';
import {prioritizeWithinRushGroups,projectDevelopmentRushResources} from './development-order-rush.js';
import {readWarehouseInstructionDemands} from './warehouse-instruction-demand.js';

type Source={kind:'source'|'order';id:string;order_id:string|null;source_id:string|null;order_number:string|null;customer_code:string|null;
 assignee_name:string|null;development_version:number|null;development:DevelopmentDocument|null;instruction_version:number|null;instruction:InstructionDocument|null;
 lines:{lineId:string;color:string;orderQuantity:number;poNumber:string|null}[]};
type Raw={record_id:string;version:number;resource_kind:PreparationResource['kind'];resource_id:string;kind:PreparationMaterialFact['kind'];
 scope_ref:string;state:PreparationMaterialFact['state'];occurred_at:Date|null;recorded_at:Date;actor_id:string;evidence_valid:boolean;
 body:Partial<PreparationMaterialFact>&{materialBasis?:string}};
const iso=(value:Date|null)=>value?.toISOString()??null;

function validMaterialEvidence(raw:Raw,ctx:Source){
 if(!raw.evidence_valid)return false;
 if(raw.kind==='design_handover'){
  const record={...raw.body,sourceDocumentVersion:raw.body.sourceDocumentVersion??null};
  if(raw.body.orderInstructionVersion!==undefined&&ctx.order_id){
   const instruction=ctx.instruction&&ctx.instruction_version!==null?
    {version:ctx.instruction_version,materials:instructionInvestmentMaterials(ctx.instruction)}:null;
   return preparationHandoverCurrent(record,instruction,'instruction');
  }
  if(ctx.source_id&&(raw.resource_kind==='source'||raw.body.sourceDocumentVersion!=null)){
   const source=ctx.development&&ctx.development_version!==null?
    {version:ctx.development_version,materials:ctx.development.materials}:null;
   return preparationHandoverCurrent(record,source);
  }
 }
 if(raw.body.materialBasis&&(raw.kind==='fabric_receipt'||raw.kind==='accessories_ready')){
  const kind=raw.kind;
  const materials=(ctx.development?.materials??[]).filter(m=>kind==='fabric_receipt'?m.category!=='辅料':m.category==='辅料')
   .map(m=>[m.materialId,m.name,m.color,m.specification,m.width,m.weight,m.composition]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  return raw.body.materialBasis===preparationHash({materials,accessories:kind==='accessories_ready'?ctx.instruction?.accessories??null:null});
 }
 return true;
}

/** Only batch-load known authorized subjects. Projection, filter, total and
 * pagination share one read snapshot. No placeholder task or business write. */
export async function warehouseReceiptPage(pool:Pool,actor:TrustedActorContext,input:WarehouseReceiptPageQuery):Promise<WarehouseReceiptPage>{
 const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const keys=await assignedWarehousePreparationResources(db,actor),out:WarehouseReceiptListItem[]=[];
  if(keys.length){
   const views=await developmentReadTables(db);
   const context=(await db.query<Source>(`WITH requested AS(SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id uuid))
    SELECT k.kind,k.id,o.production_order_id AS order_id,s.source_id,COALESCE(o.design_style_no,s.design_style_no) AS order_number,
     COALESCE(o.customer_code,s.customer_code) AS customer_code,worker.display_name AS assignee_name,
     COALESCE(round.document_version,d.version) AS development_version,COALESCE(round.document,d.document) AS development,
     instruction.version AS instruction_version,instruction.document AS instruction,
     COALESCE((SELECT jsonb_agg(jsonb_build_object('lineId',p.line_id,'color',p.color,'poNumber',COALESCE(p.po_number,p.formal_style_no),
      'orderQuantity',COALESCE((SELECT sum(q.quantity)::int FROM digital_production_po_sizes q WHERE q.line_id=p.line_id),0)) ORDER BY p.position)
      FROM digital_production_po_lines p WHERE p.production_order_id=o.production_order_id),'[]'::jsonb) AS lines
    FROM requested k
    LEFT JOIN digital_production_orders o ON k.kind='order' AND o.production_order_id=k.id
    LEFT JOIN digital_production_sources s ON s.source_id=CASE WHEN k.kind='source' THEN k.id ELSE o.source_id END
    LEFT JOIN ${views.documents} d ON d.source_id=s.source_id
    LEFT JOIN LATERAL(SELECT r.document_version,r.document FROM ${views.rounds} r WHERE r.source_id=s.source_id ORDER BY r.round_number DESC LIMIT 1) round ON true
    LEFT JOIN digital_instruction_documents instruction ON instruction.production_order_id=o.production_order_id
    JOIN app_users worker ON worker.id=$2
    WHERE o.production_order_id IS NOT NULL OR d.status='published' OR
      EXISTS(SELECT 1 FROM digital_development_preorder_publications x WHERE x.source_id=s.source_id)`,[JSON.stringify(keys),actor.actorId])).rows;
   const nativeKeys=new Map<string,PreparationResource>();
   for(const target of context){
    if(target.order_id)nativeKeys.set('order:'+target.order_id,{kind:'order',id:target.order_id});
    if(target.source_id)nativeKeys.set('source:'+target.source_id,{kind:'source',id:target.source_id});
   }
   const history=(await db.query<Raw>(`SELECT m.*,
    NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(m.body->'evidenceIds','[]'::jsonb)) x(id)
      LEFT JOIN attachments a ON a.attachment_id::text=x.id AND a.status='ready' WHERE a.attachment_id IS NULL) AS evidence_valid
    FROM jsonb_to_recordset($1::jsonb) AS target(kind text,id uuid)
    JOIN digital_preparation_material_versions m ON m.resource_kind=target.kind AND m.resource_id=target.id
    WHERE m.kind IN ('design_handover','material_investment','fabric_receipt','accessories_ready')
    ORDER BY m.recorded_at DESC,m.version DESC,m.record_id`,[JSON.stringify([...nativeKeys.values()])])).rows;
   const indexed=new Map<string,Raw[]>();
   const demands=await readWarehouseInstructionDemands(db,context.flatMap(row=>row.order_id?[row.order_id]:[]));
   for(const row of history){
    const key=`${row.resource_kind}:${row.resource_id}`,values=indexed.get(key)??[];values.push(row);indexed.set(key,values);
   }
   const asOf=businessNow().toISOString(),search=input.search.toLowerCase();
   for(const scope of context){
    const nativeRows=[...(indexed.get(`order:${scope.order_id}`)??[]),...(indexed.get(`source:${scope.source_id}`)??[])];
    const materialHistory=nativeRows.map(row=>({...row.body,kind:row.kind,scopeRef:row.scope_ref,state:row.state,
     resource:{kind:row.resource_kind,id:row.resource_id},recordId:row.record_id,version:row.version,occurredAt:iso(row.occurred_at),
     recordedAt:iso(row.recorded_at)!,recordedBy:row.actor_id,operatorName:'',valid:validMaterialEvidence(row,scope),
     invalidReasons:[],quantities:row.body.quantities??[],evidenceIds:row.body.evidenceIds??[],
     note:row.body.note??'',expectedVersion:row.body.expectedVersion??0,recipientId:row.body.recipientId??null,
     sourceDocumentVersion:row.body.sourceDocumentVersion??null})) as PreparationMaterialFact[];
    const facts=currentPreparationMaterials(materialHistory,scope.order_id);
    for(const item of deriveWarehouseReceiptWork({history:materialHistory,facts,lines:scope.lines},asOf,scope.order_id?demands.get(scope.order_id):undefined)){
     const line=scope.lines.find(row=>row.lineId===item.lineId);
     const procurementComplete=item.balance.procurementRemaining==='0'&&item.balance.excessReceived==='0';
     if((input.status==='completed')!==procurementComplete)continue;
     if(search&&![scope.order_number,line?.poNumber,item.name,item.supplier].some(value=>value?.toLowerCase().includes(search)))continue;
     out.push({id:JSON.stringify([scope.kind,scope.id,item.materialId,item.lineId,item.scopeRef,item.kind]),
      resource:{kind:scope.kind,id:scope.id},orderNumber:scope.order_number,customerCode:scope.customer_code,poNumber:line?.poNumber??null,
      assigneeName:scope.assignee_name,kind:item.kind,materialId:item.materialId,name:item.name,lineId:item.lineId,scopeRef:item.scopeRef,supplier:item.supplier,
      received:item.received,productionRequired:item.productionRequired,balance:item.balance,invested:item.purchase.invested,investedAt:item.purchase.investedAt});
    }
   }
  }
  out.sort((a,b)=>Date.parse(b.investedAt)-Date.parse(a.investedAt)||a.id.localeCompare(b.id));
  const prioritized=prioritizeWithinRushGroups(await projectDevelopmentRushResources(db,out),
   row=>input.status==='completed'||row.balance.procurementRemaining==='0'?null:row.kind,row=>row.orderRush===true);
  const offset=(input.page-1)*15;
  await db.query('COMMIT');return {items:prioritized.slice(offset,offset+15),page:input.page,total:out.length};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
