import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { preflightAcceptanceRootState, preflightExistingAcceptanceIdentity } from "./authorization-guard.js";
import { assertAcceptanceDatabaseUrl } from "./database-guard.js";
import { ensureAcceptanceWorkerPerson } from "./worker-people.js";

export function workerPeopleConfiguration(env: NodeJS.ProcessEnv, args: string[]) {
  const modes = args.filter(arg => ["--check", "--apply"].includes(arg));
  const aliases = args.filter(arg => arg.startsWith("--alias="));
  const ids = args.filter(arg => arg.startsWith("--expected-user-id="));
  const alias = aliases[0]?.slice("--alias=".length);
  const expectedUserId = ids[0]?.slice("--expected-user-id=".length);
  if (modes.length > 1 || aliases.length > 1 || ids.length > 1
    || modes.length + aliases.length + ids.length !== args.length
    || (aliases.length && !workers.some(worker => worker.alias === alias))
    || (ids.length && (!alias || !expectedUserId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(expectedUserId)))) {
    throw new Error("Usage: check-worker-people.ts [--check|--apply] [--alias=worker-a|worker-b|pattern-room-worker] [--expected-user-id=UUID]; default is read-only --check");
  }
  if (env.NODE_ENV !== "test" || env.ACCEPTANCE_LAB_ENABLED !== "true") {
    throw new Error("Requires NODE_ENV=test and ACCEPTANCE_LAB_ENABLED=true");
  }
  const connectionString = env.ACCEPTANCE_DATABASE_URL?.trim();
  if (!connectionString) throw new Error("ACCEPTANCE_DATABASE_URL is required; DATABASE_URL fallback is forbidden");
  assertAcceptanceDatabaseUrl(connectionString);
  const corpId = env.DINGTALK_CORP_ID?.trim();
  if (!corpId) throw new Error("DINGTALK_CORP_ID is required");
  const apply = modes[0] === "--apply";
  const connection = new URL(connectionString);
  if (!apply) {
    // pg gives URL options precedence over Pool options. Preserve caller options,
    // then force read-only last so a configured search_path cannot drop the guard.
    connection.searchParams.set("options", `${connection.searchParams.get("options") ?? ""} -c default_transaction_read_only=on`.trim());
  }
  return { connectionString: connection.toString(), corpId, apply, alias, expectedUserId };
}

const workers = [
  { alias: "worker-a", roleCode: "worker" },
  { alias: "worker-b", roleCode: "worker" },
  { alias: "pattern-room-worker", roleCode: "pattern_room_worker" },
] as const;

/** Check every identity and existing record before allowing any personnel creation. */
type Selection = { alias?: string; expectedUserId?: string };
async function inspect(database: Pool, corpId: string, selection: Selection) {
  const selected = selection.alias ? workers.filter(worker => worker.alias === selection.alias) : workers;
  if (!selected.length || (selection.expectedUserId && !selection.alias)) throw new Error("Invalid worker selection");
  const root = await preflightAcceptanceRootState(database, corpId);
  if (root.mode !== "existing") throw new Error("Existing Acceptance Root is required; this tool never bootstraps accounts");
  const rootActive = await database.query("SELECT 1 FROM app_users WHERE id=$1 AND NOT manual_access_disabled AND access_is_root_actor($1)", [root.userId]);
  if (!rootActive.rowCount) throw new Error("Acceptance Root must be active; no account state will be repaired");
  const result = [];
  for (const worker of selected) {
    const userId = await preflightExistingAcceptanceIdentity(database, {
      corpId, alias: worker.alias, expectedRole: worker.roleCode,
    });
    if (!userId) throw new Error(`Missing existing Acceptance identity: ${worker.alias}`);
    if (selection.expectedUserId && userId.toLowerCase() !== selection.expectedUserId.toLowerCase()) {
      throw new Error(`Acceptance identity ${worker.alias} does not match the expected user ID; stopped`);
    }
    const user = await database.query<{ display_name: string }>(
      `SELECT u.display_name FROM app_users u
       JOIN identity_mappings i ON i.user_id=u.id
       WHERE u.id=$1 AND u.enabled AND NOT u.manual_access_disabled
       AND i.provider='dingtalk' AND i.corp_id=$2 AND i.provider_user_id=$3 AND i.active AND i.employed
       AND EXISTS(SELECT 1 FROM user_role_assignments a JOIN business_roles r ON r.role_code=a.role_code
         WHERE a.user_id=u.id AND a.role_code=$4 AND a.revoked_at IS NULL AND r.enabled)`,
      [userId, corpId, `uat-${worker.alias}`, worker.roleCode],
    );
    if (user.rows.length !== 1) throw new Error(`Acceptance identity ${worker.alias} is inactive or missing its enabled standard role; stopped`);
    const people = await database.query<{ person_id: string; person_type: string; active: boolean }>(
      "SELECT person_id,person_type,active FROM business_people WHERE app_user_id=$1", [userId],
    );
    if (people.rows.length > 1 || people.rows.some(person => person.person_type !== "internal" || !person.active)) {
      throw new Error(`Acceptance worker ${worker.alias} has conflicting personnel records; stopped`);
    }
    result.push({ ...worker, userId, displayName: user.rows[0]!.display_name,
      personId: people.rows[0]?.person_id ?? null });
  }
  if (new Set(result.map(worker => worker.userId)).size !== selected.length) {
    throw new Error("Standard Acceptance workers must map to distinct existing accounts");
  }
  return { rootId: root.userId, workers: result };
}

/** Internal service; the CLI must validate configured and connected Acceptance database names first. */
export async function maintainAcceptanceWorkerPeople(database: Pool, corpId: string, apply = false, selection: Selection = {}) {
  const before = await inspect(database, corpId, selection);
  if (apply) {
    const access = new AccessMasterDataService(database, corpId);
    for (const worker of before.workers) {
      await ensureAcceptanceWorkerPerson(database, access, {
        actorId: before.rootId, actorRoles: ["root_superuser", "owner_group"],
        authorizationCapability: "master_data:manage", requestId: randomUUID(),
      }, worker);
    }
  }
  const after = apply ? await inspect(database, corpId, selection) : before;
  return { mode: apply ? "apply" : "check", ready: after.workers.every(worker => worker.personId !== null),
    workers: after.workers.map(worker => ({ ...worker, status: worker.personId ? "ready" : "missing" })) };
}
