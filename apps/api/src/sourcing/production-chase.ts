import type { PoolClient } from 'pg';
import { inclusiveWorkdays, shanghaiDay } from '@dx-rework/domain';
import type { ProductionDashboardItem } from '@dx-rework/contracts';
export type ProductionDay = { day: string; quantity: number };
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
type ChaseOrder=Pick<ProductionDashboardItem['order'],'productionOrderId'|'factoryDecisionId'|'supplierId'|'status'|'quantity'|'deliveryDate'>;
export function addProductionChase<T extends {order:ChaseOrder;progress:ProductionDashboardItem['progress']}>(items:T[], days: Map<string, ProductionDay[]>, asOf: string,
 fullRange:readonly ChaseOrder[]=items.map(item=>item.order)) {
  const today = shanghaiDay(asOf), weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const weekStart = shift(today, -((weekday + 6) % 7)), weekEnd = shift(weekStart, 6);
  const suppliers = new Map<string, { open: number; due: number }>();
  for (const order of fullRange) if (order.status === 'in_production') {
    const value = suppliers.get(order.supplierId) ?? {open: 0, due: 0}; value.open++;
    if (order.deliveryDate && order.deliveryDate >= weekStart && order.deliveryDate <= weekEnd) value.due++;
    suppliers.set(order.supplierId, value);
  }
  return items.map(item => {
    const {order, progress} = item, active = order.status === 'in_production';
    const remaining = Math.max(0, order.quantity - progress.completedQuantity);
    const workdays = active && order.deliveryDate ? inclusiveWorkdays(today, order.deliveryDate) : null;
    const required = workdays && remaining > 0 ? Math.ceil(remaining / workdays) : null;
    const recent = (days.get(order.factoryDecisionId?`${order.productionOrderId}:${order.factoryDecisionId}`:order.productionOrderId) ?? []).filter(row => row.day >= shift(today, -6) && row.day <= today).sort((a,b) => b.day.localeCompare(a.day)).slice(0,3);
    const average = recent.length === 3 ? recent.reduce((sum,row) => sum + row.quantity, 0) / 3 : null;
    const pressure = active && remaining > 0 && required !== null && average !== null && average < required;
    const concentration = suppliers.get(order.supplierId) ?? {open: 0, due: 0};
    return {...item, chase: {remainingQuantity: remaining, remainingWorkdays: workdays, requiredDailyQuantity: required,
      recentDayCount: recent.length, recentDailyQuantity: average === null ? null : Math.round(average * 100) / 100,
      deliveryPressure: pressure, dueThisWeek: active && order.deliveryDate !== null && order.deliveryDate >= weekStart && order.deliveryDate <= weekEnd,
      supplierOpenCount: concentration.open, supplierDueThisWeekCount: concentration.due}};
  });
}
export async function readProductionDays(client: PoolClient, ids: string[], asOf: string,perFactory=false): Promise<Map<string, ProductionDay[]>> {
  const result = await client.query<{id: string; day: string; quantity: number}>(`WITH effective AS (
    SELECT DISTINCT ON(root_report_id) production_order_id,factory_decision_id, business_date, quantity FROM sourcing_production_reports
    WHERE production_order_id=ANY($1::uuid[]) AND created_at<=$2 ORDER BY root_report_id, revision DESC
  ) SELECT production_order_id::text || CASE WHEN $3::boolean AND factory_decision_id IS NOT NULL THEN ':'||factory_decision_id::text ELSE '' END AS id, business_date::text AS day, sum(quantity)::int AS quantity FROM effective
    WHERE business_date BETWEEN ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date-6 AND ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
    GROUP BY 1,2`, [ids, asOf,perFactory]);
  const days = new Map<string, ProductionDay[]>();
  for (const row of result.rows) { const values = days.get(row.id) ?? []; values.push({day:row.day,quantity:row.quantity}); days.set(row.id,values); }
  return days;
}
