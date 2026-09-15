import { BasicReworkPageSchema, type BasicReworkQuery, type BasicReworkPage } from "@dx-rework/contracts/reporting";
import type { Pool } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";
import { capabilities, fail, nodeMeta } from "./management-reporting-shared.js";

import { canReadFinanceOrders } from "../rework/finance-order-access.js";

// A separate whitelist projection: no financial, process, approval or workflow-history joins.
export async function readBasicRework(db: Pool, actor: TrustedActorContext, query: BasicReworkQuery): Promise<BasicReworkPage> {
  const financeReader=await canReadFinanceOrders(db,actor);
  if (!financeReader) {
    if (!capabilities(actor).includes("rework:basic:view")) fail("缺少返工基础查看权限");
    await db.query("SELECT access_authorized_actor_roles($1,$2)", [actor.actorId,"rework:basic:view"]);
  }
  const result = await db.query<{items: Array<Omit<BasicReworkPage["items"][number],"nodeLabel">>; page: number; total_pages: number; total_count: number}>(`
    WITH filtered AS (
      SELECT orders.rework_order_id, orders.rework_no, orders.style_no, orders.order_no,
        CASE WHEN orders.processing_factory_type='own_factory' THEN '本厂' ELSE supplier.supplier_name END factory,
        merchandiser.display_name merchandiser, orders.rework_quantity::text quantity,
        to_jsonb(orders)->>'rework_reason' reason, orders.problem_part, orders.problem_description,
        orders.status, orders.updated_at, orders.source_receiving_batch_id
      FROM rework_orders orders
      LEFT JOIN app_users merchandiser ON merchandiser.id=orders.merchandiser_user_id
      LEFT JOIN supplier_catalog_versions supplier ON supplier.supplier_id=orders.processing_factory_supplier_id
        AND supplier.version=orders.processing_factory_supplier_version
      WHERE orders.status<>'deleted' AND ($2::text IS NULL OR orders.status=$2)
        AND ($1::text IS NULL OR strpos(lower(concat_ws(' ',orders.rework_no,orders.style_no,orders.order_no,
          merchandiser.display_name,supplier.supplier_name)),lower($1))>0)
    ), totals AS (SELECT count(*)::int total_count, greatest(1,ceil(count(*)/15.0)::int) total_pages FROM filtered),
    paging AS (SELECT *,least($3::int,total_pages) page FROM totals),
    selected AS (SELECT * FROM filtered ORDER BY (status IN ('completed','cancelled')),updated_at DESC,rework_order_id
      LIMIT 15 OFFSET ((SELECT page FROM paging)-1)*15)
    SELECT paging.*,COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'reworkOrderId',s.rework_order_id,'reworkNo',s.rework_no,'styleNo',s.style_no,'orderNo',s.order_no,
      'processingFactory',s.factory,'merchandiser',s.merchandiser,'quantity',s.quantity,'reason',s.reason,
      'problemPart',s.problem_part,'problemDescription',s.problem_description,'status',s.status,
      'photos',COALESCE((SELECT jsonb_agg(jsonb_build_object('attachmentId',a.attachment_id,'filename',a.original_filename)
        ORDER BY a.created_at,a.attachment_id) FROM attachments a
        WHERE a.status='ready' AND a.mime_type LIKE 'image/%' AND (
          (a.entity_type='rework_order' AND a.entity_id=s.rework_order_id::text) OR
          (a.entity_type='receiving_batch' AND a.entity_id=s.source_receiving_batch_id::text
            AND NOT EXISTS(SELECT 1 FROM receiving_attachment_retirements retired WHERE retired.attachment_id=a.attachment_id))
        )),'[]'::jsonb)
    ) ORDER BY (s.status IN ('completed','cancelled')),s.updated_at DESC,s.rework_order_id) FROM selected s),'[]'::jsonb) items FROM paging`,
    [query.q || null,query.status ?? null,query.page]);
  const row=result.rows[0]!;
  return BasicReworkPageSchema.parse({canOpenOrder:financeReader,items:row.items.map(item=>({...item,nodeLabel:nodeMeta[item.status].label})),
    page:row.page,totalPages:row.total_pages,totalCount:row.total_count});
}
