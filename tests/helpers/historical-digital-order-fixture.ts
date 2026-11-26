import {SlaOrderService} from '../../apps/api/src/production-platform/sla-order-service.js';
import {observedBusinessTime,registerAcceptanceCreated} from '../../apps/api/src/acceptance-clock/business-time.js';
import {enrollPreparation} from '../../apps/api/src/production-platform/preparation-material-repository.js';
import {createHash,randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {digitalFormalPoNo,type DigitalOrderInput} from "@dx-rework/contracts/digital-production";
import type {TrustedActorContext} from "../../apps/api/src/tools/repositories.js";
import {ProductionOrderRootRepository} from "../../apps/api/src/production-platform/order-root-repository.js";
import {DigitalPoDateRepository} from "../../apps/api/src/production-platform/po-date-repository.js";
import {DigitalProductionIdentityService} from "../../apps/api/src/production-platform/identity-service.js";

/** Seed genuine pre-rule records in an owned test schema. Never a production creation bypass. */
export async function historicalDigitalOrder(database:Pool,actor:TrustedActorContext,input:DigitalOrderInput,options?:{slaBeforePreparation?:boolean;scenarioOwnedPreparation?:boolean}){
  const client=await database.connect();
  let id:string;
  try{
    await client.query("BEGIN");
    id=(await new ProductionOrderRootRepository(client).create(actor.actorId)).productionOrderId;
    await client.query(`INSERT INTO digital_production_orders(production_order_id,customer_code,product_group,design_style_no,temporary_style_no,order_date,contract_delivery_date,created_by,creation_hash,primary_merchandiser_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,input.customerCode,input.productGroup,input.designStyleNo,input.temporaryStyleNo,input.orderDate,input.contractDeliveryDate,actor.actorId,createHash("sha256").update(JSON.stringify(input)).digest("hex"),input.primaryMerchandiserId??null]);
    const eventId=randomUUID();
    await client.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state)
      VALUES($1,$2,$3,'digital_order_created','digital_production',$4,$5)`,[eventId,actor.requestId,actor.actorId,id,JSON.stringify({...input,...(options?.slaBeforePreparation?{slaBusinessTime:observedBusinessTime()}:{})})]);
    if(options?.scenarioOwnedPreparation){
      await client.query('UPDATE digital_production_orders SET requires_color_matching=$2 WHERE production_order_id=$1',[id,input.requiresColorMatching??null]);
      await registerAcceptanceCreated(client,{kind:'order',id},actor.actorId,eventId);
      // This fixture variant has an actual recorded old business acceptance;
      // only the first PO's customer date is absent, not the order's origin.
      await client.query(`INSERT INTO digital_order_time_subjects(resource_kind,production_order_id,effective,created_by,created_business_time,creation_event_ref,production_route)
        VALUES('order',$1,true,$2,$3,$4,$5)`,[id,actor.actorId,JSON.stringify(observedBusinessTime()),'audit_events:'+eventId,JSON.stringify(input.productionPlanning??null)]);
      await enrollPreparation(client,{kind:'order',id},actor.actorId,eventId);
    }
    for(const [position,line] of input.lines.entries()){
      const lineId=randomUUID();
      await client.query(`INSERT INTO digital_production_po_lines(line_id,production_order_id,position,po_number,formal_style_no,temporary_style_no,color,color_foreign,delivery_date)
        VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8)`,[lineId,id,position+1,digitalFormalPoNo(line),line.temporaryStyleNo,line.color,line.colorForeign,line.deliveryDate]);
      const date=line.customerWarehouseArrivalDate===undefined?line.deliveryDate:line.customerWarehouseArrivalDate;
      if(date)await new DigitalPoDateRepository(client).applyWithClient(actor,id,"initial_po",[{lineId,date,expectedVersion:0}],eventId);
      for(const size of line.sizes)await client.query("INSERT INTO digital_production_po_sizes(line_id,size,quantity) VALUES($1,$2,$3)",[lineId,size.size,size.quantity]);
    }
    if(options?.slaBeforePreparation)await new SlaOrderService(database).enrollNewOrder(client,actor,id,eventId,observedBusinessTime());
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  return new DigitalProductionIdentityService(database,false).read(actor,id);
}
