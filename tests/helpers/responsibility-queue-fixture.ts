// Synthetic historical READ dataset in one exact owned TEST schema. This is not
// evidence of business writes or event provenance; original permission SQL runs live.
// As in own-tail-responsibility-history.cases.ts, immutable historical rows are
// initialized with USER triggers suspended only inside this fixture transaction.
import {randomUUID} from "node:crypto";
import {businessAnchorFixture} from "./business-anchor-fixture.js";
export async function responsibilityQueueFixture(url:string){
 const f=await businessAnchorFixture(url),db=f.db,ids={production:f.people["production-management"]!.actorId,owner:f.people.owner!.actorId,merch:f.people.merchandiser!.actorId,otherMerch:f.people["sample-designer"]!.actorId};
 const actor=(actorId:string,actorRoles:readonly string[],...authorizationCapabilities:string[])=>({actorId,actorRoles,authorizationCapability:authorizationCapabilities[0]!,authorizationCapabilities,requestId:randomUUID()});
 const productionActor=()=>actor(ids.production,["production_management"],"responsibility:determine","external_responsibility:view");
 const merchActor=()=>actor(ids.merch,["order_merchandiser"],"external_responsibility:view");
 const payablesActor=()=>actor(ids.owner,["owner_group"],"external_responsibility:view","own_factory:view","own_factory:approve");
 const tables=["rework_orders","rework_process_configurations","rework_order_reviews","rework_responsibility_determinations","rework_own_factory_approvals","rework_external_responsibility_batches","rework_external_responsibility_cases"];
 const initialize=async()=>{
  const c=await db.connect(),pending:string[]=[],settled:string[]=[];
  try{
   await c.query("BEGIN");
   // Exact new schema owned by businessAnchorFixture, no existing data changes.
   for(const table of tables)await c.query("ALTER TABLE "+table+" DISABLE TRIGGER USER");
   const event=randomUUID();
   await c.query("INSERT INTO operation_events(event_id,request_id,actor_id,actor_roles,authorization_capability,action,entity_type,entity_id) VALUES($1,$2,$3,ARRAY['production_management'],'responsibility:determine','TEST.historical-read-fixture','TEST',$4)",[event,randomUUID(),ids.production,randomUUID()]);
   const supplier=(await c.query("SELECT i.supplier_code,v.supplier_name,v.version FROM supplier_catalog_versions v JOIN supplier_catalog_items i USING(supplier_id) WHERE v.supplier_id=$1 ORDER BY v.version DESC LIMIT 1",[f.supplierId])).rows[0]!;
   for(let i=0;i<201;i++){
    for(const finalized of [false,true]){
     const id=randomUUID(),label=i===200?"ONLY%_201":String(i),suffix=finalized?"final":"pending";
     await c.query("INSERT INTO rework_orders(rework_order_id,rework_no,status,style_no,order_no,merchandiser_user_id,processing_factory_type,processing_factory_supplier_id,processing_factory_supplier_version,problem_part,problem_description,rework_quantity,created_by,updated_by,tail_inspection_required,created_at,updated_at,submitted_at) VALUES($1,$2,$3,$4,$5,$6,'supplier',$9,$10,'袖口','TEST synthetic historical reading',1,$7,$7,false,CURRENT_TIMESTAMP+($8*interval '1 ms'),CURRENT_TIMESTAMP+($8*interval '1 ms'),CURRENT_TIMESTAMP)",[id,"RW-TEST-"+suffix+"-"+i,finalized?"pending_responsibility_action":"pending_responsibility_determination","TEST-"+label,"TEST-"+suffix+"-"+i,ids.merch,ids.production,i,f.supplierId,supplier.version]);
     if(!finalized){pending.push(id);continue;}
     settled.push(id);
     const config=randomUUID(),review=randomUUID(),determination=randomUUID(),approval=randomUUID(),batch=randomUUID(),caseId=randomUUID(),key=randomUUID();
     await c.query("INSERT INTO rework_process_configurations(configuration_id,rework_order_id,configuration_version,configuration_kind,status,created_by,reviewed_by,reviewed_at) VALUES($1,$2,1,'initial','approved',$3,$3,CURRENT_TIMESTAMP)",[config,id,ids.production]);
     await c.query("INSERT INTO rework_order_reviews(order_review_id,rework_order_id,reviewed_by,review_snapshot) VALUES($1,$2,$3,'{}')",[review,id,ids.production]);
     await c.query("INSERT INTO rework_responsibility_determinations(determination_id,rework_order_id,determination_version,source_order_review_id,stage,handler_user_id,created_by,input_snapshot,calculation_total,operation_event_id,request_id,settlement_schema_version) VALUES($1,$2,1,$3,'finalized',$4,$4,'{}',1,$5,$6,1)",[determination,id,review,ids.production,event,key]);
     await c.query("INSERT INTO rework_own_factory_approvals(approval_id,rework_order_id,finalized_determination_id,finalized_determination_version,approval_version,status,own_factory_total_amount,source_snapshot,created_operation_event_id,request_id,created_at) VALUES($1,$2,$3,1,1,'pending',0.5,'{}',$4,$5,CURRENT_TIMESTAMP+($6*interval '1 ms'))",[approval,id,determination,event,key,i]);
     await c.query("INSERT INTO rework_external_responsibility_batches(batch_id,rework_order_id,finalized_determination_id,finalized_determination_version,batch_version,status,source_snapshot,created_by,operation_event_id,request_id) VALUES($1,$2,$3,1,1,'active','{}',$4,$5,$6)",[batch,id,determination,ids.production,event,key]);
     await c.query("INSERT INTO rework_external_responsibility_cases(case_id,batch_id,rework_order_id,responsibility_type,supplier_id,supplier_version,supplier_code_snapshot,supplier_name_snapshot,supplier_type_snapshot,business_handler_user_id,payables_handler_role_snapshot,proposed_deduction_amount,status,created_by,operation_event_id,request_id,created_at) VALUES($1,$2,$3,'processing_factory',$4,$5,$6,$7,'factory',$8,'factory_payables',0.5,'pending_payables_confirmation',$8,$9,$10,CURRENT_TIMESTAMP+($11*interval '1 ms'))",[caseId,batch,id,f.supplierId,supplier.version,supplier.supplier_code,supplier.supplier_name,ids.merch,event,key,i]);
    }
   }
   for(const table of tables)await c.query("ALTER TABLE "+table+" ENABLE TRIGGER USER");
   await c.query("COMMIT");return {pending,settled};
  }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
 };
 return {...f,database:db,ids,actor,productionActor,merchActor,payablesActor,initialize};
}

