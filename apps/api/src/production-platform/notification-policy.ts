import type { Pool, PoolClient } from "pg";
import type { TodoRouteDescriptor } from "@dx-rework/contracts";
import { resolveDigitalChild } from "./child-link-repository.js";

// Evaluated again at delivery time: an adapter may link its new child later in
// the same transaction than the original service creates its todo/outbox row.
export async function digitalTodoOrder(database: Pick<Pool | PoolClient, "query">, route: TodoRouteDescriptor): Promise<string | null> {
  const module = route.routeName === "sourcing_detail" ? "sourcing"
    : route.routeName === "production_detail" ? "production"
    : route.routeName === "pattern_room_order" ? "pattern_room"
    : route.reworkOrderId || ["rework_detail", "process_configuration", "whole_order_review", "responsibility_detail", "own_factory_approval"].includes(route.routeName) ? "rework" : null;
  if (!module) return null;
  // Older isolated schemas and legacy installations do not contain P01 tables.
  if (!(await database.query("SELECT to_regclass('digital_production_child_links') AS relation")).rows[0]?.relation) return null;
  if (module === "sourcing") {
    const source = (await database.query("SELECT to_jsonb(s)->>'workflow_generation' AS generation FROM sourcing_cases s WHERE sourcing_case_id=$1", [route.entityId])).rows[0];
    if (source?.generation === "digital_production_v1") return resolveDigitalChild(database, "sourcing", route.entityId, "digital_production_v1");
  }
  const row = (await database.query(`SELECT l.production_order_id FROM digital_production_child_links l
    JOIN digital_production_orders o USING(production_order_id)
    WHERE l.module=$1 AND l.child_id=$2 AND o.notification_policy='IN_APP_ONLY'`, [module, route.reworkOrderId ?? route.entityId])).rows[0];
  return row?.production_order_id ?? null;
}

export async function digitalTodoTarget(database: Pick<Pool|PoolClient,"query">,route:TodoRouteDescriptor):Promise<{kind:"order"|"source";id:string}|null>{
  if(["digital_order_quotation","digital_bulk_washing"].includes(route.routeName))return {kind:"order",id:route.entityId};
  const order=await digitalTodoOrder(database,route);
  if(order)return {kind:"order",id:order};
  if(route.routeName!=="pattern_room_order"||!(await database.query("SELECT to_regclass('digital_development_pattern_links') AS relation")).rows[0]?.relation)return null;
  const source=(await database.query("SELECT source_id FROM digital_development_pattern_links WHERE order_id=$1",[route.entityId])).rows[0];
  return source?{kind:"source",id:source.source_id}:null;
}
