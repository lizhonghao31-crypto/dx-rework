import type { Pool, PoolClient } from "pg";
import { DigitalProductionTaskService } from "./task-service.js";
import type { CreateSourcingCase } from "@dx-rework/contracts";
import type { BudgetDocument } from "@dx-rework/contracts/digital-budget";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy, digitalForbidden } from "./access-policy.js";
import { linkNewDigitalChild } from "./child-link-repository.js";

const conflict = (message: string): never => { throw new ApplicationError("BUDGET_CONFLICT", message, 409); };
export async function readBudgetSourcing(db: Pick<PoolClient, "query">, actor: TrustedActorContext, orderId: string) {
  await new DigitalProductionAccessPolicy(db).assert(actor, "order", orderId, "budget");
  const order = (await db.query("SELECT *,contract_delivery_date::text AS delivery FROM digital_production_orders WHERE production_order_id=$1", [orderId])).rows[0];
  if (!isRootActor(actor) && (!actor.actorRoles.includes("order_merchandiser") || order.primary_merchandiser_id !== actor.actorId || !await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId, "order_merchandiser"))) digitalForbidden();
  const linked = (await db.query("SELECT child_id FROM digital_production_child_links WHERE module='sourcing' AND production_order_id=$1", [orderId])).rows[0];
  if (linked) conflict("该母单已关联外发订单，请打开原订单");
  const lifecycle = (await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1", [orderId])).rows[0];
  if (lifecycle && lifecycle.state !== "active") conflict("母单已暂停或取消");
  const budget = (await db.query(`SELECT d.* FROM digital_budget_documents d JOIN digital_budget_preparations p USING(production_order_id)
    WHERE d.production_order_id=$1 AND d.status='published' AND d.version=p.budget_version`, [orderId])).rows[0] ?? conflict("请先发布当前预算");
  const document = budget.document as BudgetDocument;
  const lines = (await db.query(`SELECT l.line_id,l.position,l.formal_style_no,l.temporary_style_no,l.color,l.customer_warehouse_arrival_date::text AS customer,
    (SELECT sum(s.quantity)::integer FROM digital_production_po_sizes s WHERE s.line_id=l.line_id) AS quantity
    FROM digital_production_po_lines l WHERE l.production_order_id=$1 ORDER BY l.position`, [orderId])).rows;
  return { order, budgetVersion: budget.version as number, document, lines };
}
export async function validateBudgetSourcing(db: PoolClient, actor: TrustedActorContext, input: CreateSourcingCase) {
  const ref = input.digitalBudget;
  if (!ref) return null;
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
  await db.query("SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE", [ref.productionOrderId]);
  const source = await readBudgetSourcing(db, actor, ref.productionOrderId);
  if (source.budgetVersion !== ref.budgetVersion || source.order.version !== ref.orderVersion) conflict("母单或预算已更新，请重新从预算进入外发发起");
  const gender = ["男装", "男童"].includes(source.order.product_group) ? "男装" : "女装";
  const numericPrice = (value: string) => { const [whole, fraction = ""] = value.split("."); return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0")); };
  if (input.gender !== gender || input.styleName !== source.document.productCategory || numericPrice(input.daxingUnitPrice) !== numericPrice(source.document.outsourcingUnitPrice)) conflict("性别、款式和预算价须沿用已发布预算");
  if (input.lineItems.length !== source.lines.length) conflict("必须整款沿用全部款色");
  for (let i = 0; i < source.lines.length; i++) {
    const line = source.lines[i]!, entered = input.lineItems[i]!;
    const alternate = line.temporary_style_no || source.order.temporary_style_no || source.order.design_style_no;
    if (entered.lineId !== line.line_id || (entered.alternateStyleNo ?? "") !== alternate || entered.color !== line.color || entered.quantity !== line.quantity) conflict("PO 身份、代用号、颜色和数量须沿用当前母单");
    if (!entered.factoryDeliveryDate || entered.factoryDeliveryDate < input.estimatedCutPieceSendDate || line.customer && entered.factoryDeliveryDate > line.customer) conflict("请逐 PO 填写合法的加工厂交货日，不能早于裁片发出或晚于出货日期");
  }
  return source.lines.map((line, index) => ({ childLineKey: String(index + 1), lineId: line.line_id as string }));
}
export async function bindBudgetSourcing(db: PoolClient, pool: Pool, actor: TrustedActorContext, input: CreateSourcingCase, caseId: string, lines: Array<{ childLineKey: string; lineId: string }> | null) {
  if (!input.digitalBudget || !lines) return;
  const orderId = input.digitalBudget.productionOrderId;
  await linkNewDigitalChild(db, { module: "sourcing", childId: caseId, productionOrderId: orderId, lines });
  const preparation = (await db.query("SELECT task_id FROM digital_budget_preparations WHERE production_order_id=$1", [orderId])).rows[0];
  if (preparation?.task_id) {
    const tasks = new DigitalProductionTaskService(pool);
    await tasks.setConditionWithClient(db, actor, preparation.task_id, "business_recorded", true, new Date().toISOString(), "原外发单已创建");
    await tasks.completeWithClient(db, actor, preparation.task_id, { note: "原外发单已创建" }, `sourcing-created:${caseId}`);
  }
}
