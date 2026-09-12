import type { PoolClient } from "pg";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { isPatternRoot } from "./order-authority.js";

export async function bindPatternMaterials(client: PoolClient, actor: TrustedActorContext, orderId: string, roundId: string, attachmentIds: readonly string[], reason: string): Promise<void> {
  if (!attachmentIds.length) throw new ApplicationError("VALIDATION_ERROR", "请上传制作PDF或清晰图片", 400);
  const ids = [...new Set(attachmentIds)].sort();
  for (const id of ids) {
    const file = (await client.query<{ status: string; uploaded_by: string; entity_type: string | null; entity_id: string | null; mime_type: string }>(
      "SELECT status,uploaded_by,entity_type,entity_id,mime_type FROM attachments WHERE attachment_id=$1 FOR UPDATE", [id])).rows[0];
    if (!file || file.status !== "ready" || !["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.mime_type)) throw new ApplicationError("VALIDATION_ERROR", "制作资料必须是已上传完成的PDF或图片", 400);
    const bindings = (await client.query<{ order_id: string }>("SELECT DISTINCT order_id FROM pattern_room_attachment_bindings WHERE attachment_id=$1", [id])).rows;
    if (file.entity_type && (file.entity_type !== "pattern_room_attachment" || file.entity_id !== id)) throw new ApplicationError("CONFLICT", "该附件已用于其他业务", 409);
    if (bindings.some(binding => binding.order_id !== orderId)) throw new ApplicationError("CONFLICT", "其他订单的制作资料不能直接挪用，请上传本单资料", 409);
    if (!bindings.length && file.uploaded_by !== actor.actorId && !isPatternRoot(actor)) throw new ApplicationError("FORBIDDEN", "不能绑定其他人上传的资料", 403);
    await client.query("UPDATE attachments SET entity_type='pattern_room_attachment',entity_id=attachment_id::text,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=$1", [id]);
    await client.query(`INSERT INTO pattern_room_attachment_bindings(order_id,round_id,attachment_id,bound_by,reason)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(round_id,attachment_id) DO UPDATE SET active=true`, [orderId, roundId, id, actor.actorId, reason]);
  }
  // Original objects and earlier bindings stay available in authorized history.
  await client.query("UPDATE pattern_room_attachment_bindings SET active=false WHERE round_id=$1 AND NOT attachment_id=ANY($2::uuid[])", [roundId, ids]);
}
