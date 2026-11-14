import { ContextBusinessClock } from '../acceptance-clock/business-time.js';
import type { Pool, PoolClient } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { BusinessClock } from "@dx-rework/domain/business-clock";
import { SlaPlanRepository } from "./sla-plan-repository.js";
import {OrderTimePlanRepository} from './order-time-plan-repository.js';

/** Called after the approved PO-date writer in the same transaction.
 * Both factory and customer adapters inherit verified scenario time; ordinary
 * orders retain the real-time fallback. Explicit injected clocks remain supported. */
export async function recordSlaPoDateChange(client: Pick<PoolClient, "query">, actor: TrustedActorContext,
  orderId: string, kind: "customer" | "factory", approvalEventId: string, reason: string,
  clock: BusinessClock = new ContextBusinessClock()): Promise<void> {
  const repo = new SlaPlanRepository(client);
  const previous = await repo.available()?(await repo.plans(orderId)).at(-1):null;
  const orderTime=new OrderTimePlanRepository(client),resource={kind:'order' as const,id:orderId};
  const confirmed=kind==='customer'?await orderTime.current(resource):null;
  if (!previous&&!confirmed) return; // Never invent a first plan for a legacy order during date correction.
  const changes = (await client.query("SELECT line_id,new_date::text AS date FROM digital_po_date_changes WHERE production_order_id=$1 AND date_kind=$2 AND approval_event_id=$3", [orderId, kind, approvalEventId])).rows;
  if (!changes.length) throw new Error("SLA date revision requires persisted approved change evidence");
  const time=await clock.read({kind:'order',id:orderId});
  if(previous){
    const plan = structuredClone(previous.plan);
    for (const change of changes) plan.anchors[`${kind === "customer" ? "customer_shipping_date" : "factory_delivery_date"}:${change.line_id}`] = {
      precision: "date", value: change.date, source: `digital_po_date_changes:${approvalEventId}:${change.line_id}`,
    };
    await repo.appendPlan({ orderId, expectedRevision: previous.revision, snapshotId: previous.snapshotId, plan,
      time, actorId: actor.actorId, reason, requestKey: approvalEventId });
  }
  if(confirmed)await orderTime.approvedCustomerChange(resource,actor.actorId,approvalEventId,time,async()=>{
    // All services on this internal read are bound to the approved writer's
    // original client. An accidental attempt to open a second transaction fails.
    const bound={query:client.query.bind(client),connect:async()=>{throw Error('改期事实读取不能切换事务');}} as unknown as Pool;
    const {loadOrderTimeOperation}=await import('./order-time-operation-state.js');
    const current=await loadOrderTimeOperation(bound,client as PoolClient,actor,{kind:'arrangement',resource},time);
    if(!current.value.frameworkContext)throw Error('本单三层时间依据不可读取');
    return current.value.frameworkContext;
  });
}
