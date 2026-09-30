import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

/** Run only after the role seeder's database, Root and standard-identity guards. */
export async function ensureAcceptanceWorkerPerson(
  database: Pick<Pool, "query">,
  access: Pick<AccessMasterDataService, "createPerson">,
  actor: TrustedActorContext,
  user: { alias: string; userId: string; displayName: string; roleCode: string },
): Promise<void> {
  if (!["worker", "pattern_room_worker"].includes(user.roleCode)) return;
  if (!["worker-a", "worker-b", "pattern-room-worker"].includes(user.alias)) {
    throw new Error("Only standard Acceptance workers may be seeded");
  }
  const existing = await database.query<{ person_type: string; active: boolean }>(
    "SELECT person_type,active FROM business_people WHERE app_user_id=$1", [user.userId],
  );
  if (existing.rows.length) {
    if (existing.rows.length !== 1 || existing.rows[0]?.person_type !== "internal" || !existing.rows[0]?.active) {
      throw new Error(`Acceptance worker ${user.alias} has a conflicting personnel record; stopped`);
    }
    return;
  }
  await access.createPerson({ ...actor, requestId: randomUUID(), authorizationCapability: "master_data:manage",
    authorizationCapabilities: ["master_data:manage"] }, {
    personType: "internal", appUserId: user.userId, displayName: user.displayName,
    aliases: [], reason: "补齐标准验收工人的作业人员档案，不改变已有角色",
  });
}
