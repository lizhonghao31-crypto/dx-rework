import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { DigitalOrder } from "@dx-rework/contracts/digital-production";
export async function instructionNotice(db: PoolClient, order: DigitalOrder, version: number | null, title: string, key: string, directorsOnly = false, includePrimary = false, includeOwnerApprover = false) {
  const eventId = randomUUID();
    await db.query("INSERT INTO digital_production_notification_events(event_id,source_key,instruction_order_id,event_kind) VALUES($1,$2,$3,'instruction_information')", [eventId,key,order.productionOrderId]);
    await db.query("INSERT INTO digital_instruction_notices(event_id,version,title) VALUES($1,$2,$3)",[eventId,version,`${order.designStyleNo} · ${title}`]);
    const people = (await db.query(`SELECT DISTINCT u.id FROM app_users u JOIN user_role_assignments a ON a.user_id=u.id AND a.revoked_at IS NULL JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
      WHERE u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)
      AND (a.role_code='production_management' OR ($5::boolean AND a.role_code='owner_group') OR ($2::boolean=false AND (a.role_code='owner_group' OR (a.role_code='sample_designer' AND u.id=$1) OR ($3::boolean AND a.role_code='order_merchandiser' AND u.id=$4::uuid))))`,[order.createdBy,directorsOnly,includePrimary,order.primaryMerchandiserId,includeOwnerApprover])).rows;
    for (const p of people) await db.query("INSERT INTO digital_production_notification_receipts(event_id,source_event_id,recipient_id) VALUES($1,$1,$2)",[eventId,p.id]);
  }
