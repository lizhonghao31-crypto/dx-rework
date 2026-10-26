import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { assertAcceptanceServerDatabase } from "../../apps/api/src/auth/acceptance-server-guard.js";
import { OperationEventRepository } from "../../apps/api/src/tools/repositories.js";
import { preflightAcceptanceRootState, preflightExistingAcceptanceIdentity } from "./authorization-guard.js";
import { assertAcceptanceDatabaseName, assertAcceptanceDatabaseUrl } from "./database-guard.js";
import { STANDARD_ACCEPTANCE_USERS } from "./standard-identities.js";

const alias = "cutting-worker", providerId = "uat-cutting-worker", unionId = "uat-union-cutting-worker";
const roleCode = "cutting_worker", displayName = "[UAT] 裁床师傅";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function cuttingWorkerConfiguration(env: NodeJS.ProcessEnv, args: string[]) {
  if (env.NODE_ENV !== "test" || env.ACCEPTANCE_LAB_ENABLED !== "true" || env.ROOT_DINGTALK_USER_ID !== "uat-root")
    throw new Error("Requires test Acceptance runtime and ROOT_DINGTALK_USER_ID=uat-root");
  const connectionString = env.ACCEPTANCE_DATABASE_URL?.trim(), corpId = env.DINGTALK_CORP_ID?.trim();
  if (!connectionString || !corpId) throw new Error("Explicit ACCEPTANCE_DATABASE_URL and DINGTALK_CORP_ID are required; no DATABASE_URL fallback");
  let databaseName: string;
  try {
    const parsed = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("Invalid protocol");
    databaseName = assertAcceptanceDatabaseUrl(connectionString);
  } catch { throw new Error("Configured database must be a valid isolated Acceptance PostgreSQL URL"); }
  const modes = args.filter(a => a === "--check" || a === "--apply"), ids = args.filter(a => a.startsWith("--expected-user-id="));
  const expectedUserId = ids[0]?.slice("--expected-user-id=".length).toLowerCase();
  if (modes.length > 1 || ids.length > 1 || args.length !== modes.length + ids.length || ids.length && !uuid.test(expectedUserId ?? ""))
    throw new Error("Only --check/--apply and one --expected-user-id=UUID are supported; alias and role are fixed");
  const apply = modes[0] === "--apply";
  if (apply && !expectedUserId) throw new Error("Apply requires --expected-user-id=UUID to pin this one identity");
  const url = new URL(connectionString);
  if (!apply) url.searchParams.set("options", `${url.searchParams.get("options") ?? ""} -c default_transaction_read_only=on`.trim());
  return { connectionString: url.toString(), databaseName, corpId, apply, expectedUserId };
}
type Configuration = ReturnType<typeof cuttingWorkerConfiguration>;
type State = { rootId: string; userId: string | null; assignmentId: string | null; status: "missing" | "missing_role" | "ready" };
async function inspect(pool: Pool, db: PoolClient, config: Configuration, env: NodeJS.ProcessEnv): Promise<State> {
  const actual = assertAcceptanceDatabaseName((await db.query("SELECT current_database()")).rows[0]?.current_database ?? "", "connected");
  if (actual !== config.databaseName) throw new Error("Configured and connected Acceptance database names differ");
  await assertAcceptanceServerDatabase(config.connectionString, db, env, config.corpId, "uat-root");
  const root = await preflightAcceptanceRootState(db, config.corpId);
  if (root.mode !== "existing") throw new Error("Existing fully initialized Acceptance Root required; no bootstrap or repair");
  if (!await new RootAuthority(pool, config.corpId, "uat-root").isRootUser(root.userId, db, config.apply)) throw new Error("Acceptance Root must be active");
  if (!(await db.query(`SELECT 1 FROM identity_mappings i JOIN app_users u ON u.id=i.user_id WHERE i.user_id=$1 AND i.provider='dingtalk' AND i.corp_id=$2
    AND i.provider_user_id='uat-root' AND i.union_id='uat-union-root' AND i.active AND i.employed AND u.enabled AND NOT u.manual_access_disabled`, [root.userId, config.corpId])).rowCount)
    throw new Error("Acceptance Root must retain both UAT identity markers");
  const policy = (await db.query("SELECT dingtalk_corp_id FROM access_security_policy WHERE policy_key='primary'")).rows[0];
  if (policy?.dingtalk_corp_id !== config.corpId) throw new Error("Acceptance corporation policy differs");
  // Preserve the original all-standard-identity rejection guard, using SELECTs only.
  for (const [oldAlias, , expectedRole] of STANDARD_ACCEPTANCE_USERS) if (oldAlias !== "root")
    await preflightExistingAcceptanceIdentity(db, { corpId: config.corpId, alias: oldAlias, expectedRole });
  if (!(await db.query(`SELECT 1 FROM business_roles WHERE role_code='cutting_worker' AND enabled ${config.apply ? "FOR SHARE" : ""}`)).rowCount)
    throw new Error("The original cutting_worker role is unavailable");
  const identities = (await db.query(`SELECT * FROM identity_mappings WHERE provider='dingtalk'
    AND (provider_user_id=$1 OR union_id=$2) ${config.apply ? "FOR UPDATE" : ""}`, [providerId, unionId])).rows;
  if (!identities.length) {
    if (config.expectedUserId && (await db.query("SELECT 1 FROM app_users WHERE id=$1", [config.expectedUserId])).rowCount)
      throw new Error("Expected user ID already belongs to an existing account; no reuse or rebinding");
    return { rootId: root.userId, userId: null, assignmentId: null, status: "missing" };
  }
  const identity = identities[0];
  if (identities.length !== 1 || identity.corp_id !== config.corpId || identity.provider_user_id !== providerId || identity.union_id !== unionId || !identity.active || !identity.employed)
    throw new Error("Existing cutting-worker identity is conflicting or inactive; no repair");
  const userId = identity.user_id as string;
  if (userId === root.userId || config.expectedUserId && userId !== config.expectedUserId) throw new Error("Cutting-worker does not match the expected distinct user ID");
  const user = (await db.query(`SELECT * FROM app_users WHERE id=$1 ${config.apply ? "FOR UPDATE" : ""}`, [userId])).rows[0];
  if (!user?.enabled || user.manual_access_disabled || user.display_name !== displayName) throw new Error("Existing cutting-worker account is non-standard or disabled; no repair");
  if ((await db.query("SELECT 1 FROM identity_mappings WHERE user_id=$1", [userId])).rowCount !== 1) throw new Error("Cutting-worker has another identity binding");
  await preflightExistingAcceptanceIdentity(db, { corpId: config.corpId, alias, expectedRole: roleCode });
  if ((await db.query("SELECT 1 FROM user_capabilities WHERE user_id=$1", [userId])).rowCount) throw new Error("Cutting-worker has direct capability grants");
  if ((await db.query("SELECT 1 FROM delegated_authorizations WHERE grantor_user_id=$1 AND revoked_at IS NULL", [userId])).rowCount) throw new Error("Cutting-worker has outgoing delegations");
  if ((await db.query("SELECT 1 FROM business_people WHERE app_user_id=$1", [userId])).rowCount) throw new Error("Cutting-worker has an unexpected personnel record; no repair");
  const roles = (await db.query("SELECT assignment_id,role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL", [userId])).rows;
  if (roles.length > 1 || roles.some(r => r.role_code !== roleCode)) throw new Error("Cutting-worker must have exactly its one standard role");
  return { rootId: root.userId, userId, assignmentId: roles[0]?.assignment_id ?? null, status: roles.length ? "ready" : "missing_role" };
}

/** Fixed-purpose tool, not a generic identity or permission administration API. */
export async function maintainAcceptanceCuttingWorker(pool: Pool, env: NodeJS.ProcessEnv, args: string[] = []) {
  const config = cuttingWorkerConfiguration(env, args), db = await pool.connect();
  try {
    await db.query(config.apply ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    if (config.apply) await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`acceptance-cutting-worker:${config.corpId}`]);
    const before = await inspect(pool, db, config, env);
    let created = false, grantedRole = false;
    if (config.apply && before.status !== "ready") {
      const userId = before.userId ?? config.expectedUserId!;
      const actor = { actorId: before.rootId, actorRoles: ["root_superuser", "owner_group"], authorizationCapability: "access:admin", requestId: `acceptance-cutting-worker:${randomUUID()}` };
      if (!before.userId) {
        await db.query("INSERT INTO app_users(id,display_name,enabled,manual_access_disabled) VALUES($1,$2,true,false)", [userId, displayName]);
        await db.query(`INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
          VALUES($1,$2,'dingtalk',$3,$4,$5,true,true,CURRENT_TIMESTAMP)`, [randomUUID(), userId, config.corpId, providerId, unionId]);
        await new OperationEventRepository().append(db, actor, { action: "acceptance.cutting_worker.created", entityType: "app_user", entityId: userId,
          after: { alias, providerId, unionId, roleCode }, reason: "新增独立Acceptance裁床测试身份，不修改旧标准身份" });
        created = true;
      }
      // Same transaction-local audited role-writer protocol used by AccessMasterDataService.
      // The original DB creation/authority/lifecycle triggers remain enabled.
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`dx_rework:role_assignment:${userId}:${roleCode}`]);
      await db.query("SELECT set_config('dx_rework.role_assign_event_id',$1,true),set_config('dx_rework.role_assign_request_id',$2,true)", [randomUUID(), actor.requestId]);
      await db.query(`INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason)
        VALUES($1,$2,'cutting_worker',$3,'独立Acceptance裁床测试身份，仅授原裁床角色')`, [randomUUID(), userId, before.rootId]);
      grantedRole = true;
    }
    const after = config.apply ? await inspect(pool, db, config, env) : before;
    if (config.apply && after.status !== "ready") throw new Error("Cutting-worker postcondition failed");
    await db.query("COMMIT");
    return { alias, roleCode, ...after, applied: config.apply, created, grantedRole };
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
