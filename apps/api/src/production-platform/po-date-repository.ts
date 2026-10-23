import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy } from "./access-policy.js";
import { recordSlaPoDateChange } from "./sla-po-date-adapter.js";
import type { BusinessClock } from "@dx-rework/domain/business-clock";

type Database = Pick<PoolClient, "query">;
export type PoDateChange = { lineId: string; date: string; expectedVersion: number };
type Source = "initial_po" | "approved_customer_change" | "approved_factory_change";
const conflict = (message: string): never => { throw new ApplicationError("DIGITAL_PRODUCTION_CONFLICT", message, 409); };

// Internal transaction adapter. There is no generic HTTP date writer. Callers must
// record the actual creation/approved command audit before passing its immutable ID.
export class DigitalPoDateRepository {
  constructor(private readonly db: Database, private readonly businessClock?: BusinessClock) {}

  async applyWithClient(actor: TrustedActorContext, orderId: string, source: Source,
    changes: readonly PoDateChange[], approvalEventId: string): Promise<void> {
    if (!changes.length || changes.length > 50 || new Set(changes.map(change => change.lineId)).size !== changes.length)
      conflict("请选择不重复的明确 PO");
    const kind = source === "approved_factory_change" ? "factory" : "customer";
    const policy = new DigitalProductionAccessPolicy(this.db);
    if (!isRootActor(actor)) {
      const permitted = source === "initial_po"
        ? actor.actorRoles.includes("sample_designer") && await policy.activeRole(actor.actorId,"sample_designer")
        : source === "approved_customer_change"
          ? actor.actorRoles.includes("production_management") && await policy.activeRole(actor.actorId,"production_management")
          : actor.actorRoles.includes("production_management") && actor.authorizationCapability === "sourcing:decision:record"
            && await policy.activeRole(actor.actorId,"production_management")
            || actor.actorRoles.includes("owner_group") && actor.authorizationCapability === "sourcing:owner:approve"
              && await policy.activeRole(actor.actorId,"owner_group");
      if (!permitted) throw new ApplicationError("FORBIDDEN","当前岗位无权生效 PO 交期",403);
    }
    if (kind === "factory") {
      // Same source-case lock as contract/finance writes, before the mother lock.
      await this.db.query(`SELECT s.sourcing_case_id FROM sourcing_cases s JOIN digital_production_child_links link
        ON link.module='sourcing' AND link.child_id=s.sourcing_case_id WHERE link.production_order_id=$1
        ORDER BY s.sourcing_case_id FOR UPDATE OF s`,[orderId]);
      for(const change of changes)if((await this.db.query<{locked:boolean}>(
        "SELECT sourcing_po_factory_date_locked($1,$2,$3,$4::date) AS locked",[orderId,change.lineId,approvalEventId,change.date])).rows[0]?.locked)
        conflict("当前合同版本财务核对后工厂交期锁定");
    }
    const order = (await this.db.query("SELECT created_by FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE",[orderId])).rows[0];
    if (!order) conflict("母单不存在");
    if (source === "initial_po" && !isRootActor(actor) && order.created_by !== actor.actorId)
      throw new ApplicationError("FORBIDDEN","不能登记其他设计师的订单交期",403);
    const approval = (await this.db.query("SELECT * FROM audit_events WHERE id=$1",[approvalEventId])).rows[0];
    const action = source === "initial_po" ? "digital_order_created"
      : source === "approved_customer_change" ? "digital_po_customer_dates_approved" : "digital_po_factory_dates_approved";
    if (!approval || approval.actor_id !== actor.actorId || approval.request_id !== actor.requestId
      || approval.entity_type !== "digital_production" || approval.entity_id !== orderId || approval.action !== action)
      conflict("缺少本次合法登记或审批证据");
    let applied = false;
    for (const change of [...changes].sort((a,b) => a.lineId.localeCompare(b.lineId))) {
      if (!z.iso.date().safeParse(change.date).success || !Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 0)
        conflict("PO 交期或版本无效");
      const prior = (await this.db.query("SELECT new_date::text AS date,version FROM digital_po_date_changes WHERE line_id=$1 AND date_kind=$2 AND approval_event_id=$3",
        [change.lineId,kind,approvalEventId])).rows[0];
      if (prior) {
        if (prior.date !== change.date || prior.version !== change.expectedVersion+1) conflict("同一审批证据不能用于不同交期");
        continue;
      }
      const line = (await this.db.query(`SELECT *,customer_warehouse_arrival_date::text AS customer,
        factory_delivery_date::text AS factory FROM digital_production_po_lines WHERE production_order_id=$1 AND line_id=$2 FOR UPDATE`,
        [orderId,change.lineId])).rows[0];
      if (!line || Number(line[`${kind}_date_version`]) !== change.expectedVersion) conflict("PO 交期已更新，请刷新后重试");
      const customer = kind === "customer" ? change.date : line.customer;
      const factory = kind === "factory" ? change.date : line.factory;
      if (customer && factory && factory > customer) conflict("加工厂交货日不能晚于出货日期");
      const reason = source === "initial_po" ? "设计师逐 PO 登记出货日期" : approval.after_state?.reason;
      if (typeof reason !== "string" || !reason.trim() || reason.length > 500) conflict("审批必须保留交期变更原因");
      await this.db.query(`INSERT INTO digital_po_date_changes(change_id,production_order_id,line_id,date_kind,old_date,new_date,version,source,approval_event_id,changed_by,request_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [randomUUID(),orderId,change.lineId,kind,line[kind],change.date,change.expectedVersion+1,source,approvalEventId,actor.actorId,actor.requestId,reason]);
      // Field names are selected from fixed constants, never from a request.
      if (kind === "customer") await this.db.query(`UPDATE digital_production_po_lines SET customer_warehouse_arrival_date=$3,
        customer_date_version=customer_date_version+1,customer_date_source=$4 WHERE production_order_id=$1 AND line_id=$2`,[orderId,change.lineId,change.date,source]);
      else await this.db.query(`UPDATE digital_production_po_lines SET factory_delivery_date=$3,
        factory_date_version=factory_date_version+1,factory_date_source=$4 WHERE production_order_id=$1 AND line_id=$2`,[orderId,change.lineId,change.date,source]);
      applied = true;
    }
    if (applied && source !== "initial_po") await recordSlaPoDateChange(this.db, actor, orderId, kind, approvalEventId, approval.after_state.reason, this.businessClock);
  }
}
