import {shipSampleTargets} from './ship-sample-timing.js';
import type { Pool,PoolClient } from "pg";
import { PoDeliveryDateSchema,type PoDeliveryDate } from "@dx-rework/contracts";
type Db=Pick<Pool|PoolClient,"query">;
/** Caller supplies already authorized stable lines. */
export async function readOrderPoDeliveryDates(db:Db,orderId:string,lineIds:string[]):Promise<PoDeliveryDate[]> {
  if(!lineIds.length)return [];
  const rows=(await db.query(`SELECT line_id AS "lineId",position,COALESCE(formal_style_no,po_number) AS "poNumber",color,
    to_jsonb(line)->>'customer_warehouse_arrival_date' AS "customerWarehouseArrivalDate",to_jsonb(line)->>'factory_delivery_date' AS "factoryDeliveryDate",
    ((to_jsonb(line)->>'customer_warehouse_arrival_date')::date-10)::text AS "sampleTargetDate",to_jsonb(o)->>'order_time_managed' AS order_time_managed
    FROM digital_production_po_lines line JOIN digital_production_orders o USING(production_order_id) WHERE line.production_order_id=$1 AND line_id=ANY($2::uuid[]) ORDER BY position`,[orderId,lineIds])).rows;
  const targets=await shipSampleTargets(db,orderId,rows.some(row=>row.order_time_managed==='true'));
  return rows.map(({order_time_managed:managed,...row})=>{void managed;return PoDeliveryDateSchema.parse({...row,sampleTargetDate:targets.lines.find(l=>l.lineId===row.lineId)?.targetDate??null});});
}
