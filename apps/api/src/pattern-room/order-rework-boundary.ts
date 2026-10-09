import type { PoolClient } from "pg";

export const PATTERN_REWORK_CUT_BLOCK = "关联大货已开始实裁，不能发起需要新开发轮确认的原单返工";

export async function patternReworkCutBlocked(db: Pick<PoolClient, "query">, orderId: string): Promise<boolean> {
  if (!(await db.query("SELECT to_regclass('digital_development_pattern_links') AS relation")).rows[0]?.relation) return false;
  return !!(await db.query(`SELECT 1 FROM digital_development_pattern_links pattern
    JOIN digital_production_orders mother ON mother.source_id=pattern.source_id
    JOIN digital_production_child_links link ON link.production_order_id=mother.production_order_id AND link.module='sourcing'
    JOIN cutting_orders cutting ON cutting.sourcing_case_id=link.child_id
    JOIN cutting_records actual ON actual.cutting_order_id=cutting.cutting_order_id
    WHERE pattern.order_id=$1 LIMIT 1`, [orderId])).rowCount;
}
