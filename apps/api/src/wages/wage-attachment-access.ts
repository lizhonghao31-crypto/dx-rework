import type { Pool } from "pg";

type WageAttachmentActor = Readonly<{
  actorId: string;
  actorRoles: readonly string[];
  capabilities: readonly string[];
}>;

type AttachmentBinding = Readonly<{
  entityType: string;
  entityId: string;
}>;

export async function canDownloadWageAttachment(
  database: Pool,
  actor: WageAttachmentActor,
  binding: AttachmentBinding,
): Promise<boolean> {
  if (binding.entityType !== "wage_adjustment") return false;

  const result = await database.query<{ requested_by: string }>(
    "SELECT requested_by FROM rework_wage_adjustments WHERE adjustment_id=$1",
    [binding.entityId],
  );
  const adjustment = result.rows[0];
  if (!adjustment) return false;

  const isRequester = adjustment.requested_by === actor.actorId
    && actor.actorRoles.includes("tail_supervisor")
    && actor.capabilities.includes("wage:adjustment_request");
  const isAdministrativeApprover =
    actor.actorRoles.includes("administrative_clerk")
    && actor.capabilities.includes("wage:adjustment_approve");

  return isRequester || isAdministrativeApprover;
}
