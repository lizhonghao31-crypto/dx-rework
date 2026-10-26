import { STANDARD_ACCEPTANCE_USERS as ACCEPTANCE_USERS } from "./standard-identities.js";
import { ensureAcceptanceWorkerPerson } from "./worker-people.js";
import { randomUUID } from "node:crypto";

import pg from "pg";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import {
  assertStandardAcceptanceAuthorization,
  preflightAcceptanceRootState,
  preflightExistingAcceptanceIdentity,
} from "./authorization-guard.js";
import {
  assertAcceptanceDatabaseName,
  assertAcceptanceDatabaseUrl,
} from "./database-guard.js";

const { Pool } = pg;

const acceptanceDatabaseUrl = process.env.ACCEPTANCE_DATABASE_URL?.trim();
if (process.env.NODE_ENV !== "test" || process.env.ACCEPTANCE_LAB_ENABLED !== "true") {
  throw new Error("Acceptance role seeding requires NODE_ENV=test and ACCEPTANCE_LAB_ENABLED=true");
}
if (!acceptanceDatabaseUrl) throw new Error("ACCEPTANCE_DATABASE_URL is required; DATABASE_URL fallback is forbidden");
assertAcceptanceDatabaseUrl(acceptanceDatabaseUrl);
const corpId = process.env.DINGTALK_CORP_ID?.trim();
if (!corpId) throw new Error("DINGTALK_CORP_ID is required");

const pool = new Pool({
  connectionString: acceptanceDatabaseUrl,
  application_name: "dx-rework-acceptance-seed",
  max: 2,
});

const userIdByAlias = new Map<string, string>();

const ensureUser = async (alias: string, displayName: string): Promise<string> => {
  const providerUserId = `uat-${alias}`;
  const existing = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM identity_mappings
     WHERE provider='dingtalk' AND corp_id=$1 AND provider_user_id=$2`,
    [corpId, providerUserId],
  );
  const userId = existing.rows[0]?.user_id ?? randomUUID();
  if (!existing.rows[0]) {
    await pool.query(
      "INSERT INTO app_users(id,display_name,enabled,manual_access_disabled) VALUES($1,$2,true,false)",
      [userId, displayName],
    );
    await pool.query(
      `INSERT INTO identity_mappings(
         id,user_id,provider,corp_id,provider_user_id,union_id,
         active,employed,last_verified_at
       ) VALUES($1,$2,'dingtalk',$3,$4,$5,true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(), userId, corpId, providerUserId, `uat-union-${alias}`],
    );
  } else {
    await pool.query(
      "UPDATE app_users SET display_name=$2,enabled=true,manual_access_disabled=false,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [userId, displayName],
    );
    await pool.query(
      `UPDATE identity_mappings
       SET active=true,employed=true,last_verified_at=CURRENT_TIMESTAMP
       WHERE user_id=$1 AND provider='dingtalk' AND corp_id=$2 AND provider_user_id=$3`,
      [userId, corpId, providerUserId],
    );
  }
  userIdByAlias.set(alias, userId);
  return userId;
};

try {
  const databaseName = (await pool.query<{ current_database: string }>("SELECT current_database()"))
    .rows[0]?.current_database ?? "";
  assertAcceptanceDatabaseName(databaseName, "connected");

  // Root invariants are checked before any user/identity/role mutation. Existing
  // partial or contradictory Root state is never repaired implicitly.
  const rootPreflight = await preflightAcceptanceRootState(pool, corpId);

  // Every existing non-Root standard identity is also checked using SELECTs only
  // before the first user/identity/role mutation.
  for (const [alias, , roleCode] of ACCEPTANCE_USERS) {
    if (alias === "root") continue;
    await preflightExistingAcceptanceIdentity(pool, {
      corpId,
      alias,
      expectedRole: roleCode,
    });
  }

  for (const [alias, displayName] of ACCEPTANCE_USERS) await ensureUser(alias, displayName);

  const rootId = userIdByAlias.get("root")!;
  if (rootPreflight.mode === "existing" && rootPreflight.userId !== rootId) {
    throw new Error("Acceptance Root identity changed after preflight; rebuild the acceptance database");
  }
  if (rootPreflight.mode === "fresh") {
    await pool.query(
      `INSERT INTO user_role_assignments(
         assignment_id,user_id,role_code,granted_by,grant_reason
       ) VALUES($1,$2,'owner_group',$2,'验收环境首次Root角色')`,
      [randomUUID(), rootId],
    );
    await pool.query(
      `INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id)
       VALUES(true,$1,'uat-root',$2)`,
      [rootId, corpId],
    );
    await pool.query(
      "INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary',$1)",
      [corpId],
    );
  }

  const access = new AccessMasterDataService(pool, corpId);
  await access.ensureOrganizationPolicy();
  const rootActor: TrustedActorContext = {
    actorId: rootId,
    actorRoles: ["root_superuser", "owner_group"],
    authorizationCapability: "access:admin",
    authorizationCapabilities: ["access:admin"],
    requestId: randomUUID(),
  };

  // Defense in depth: the post-mutation snapshot must still be standard before
  // any missing role is assigned.
  for (const [alias, , roleCode] of ACCEPTANCE_USERS) {
    if (alias === "root") continue;
    const userId = userIdByAlias.get(alias)!;
    const [roles, delegations] = await Promise.all([
      pool.query<{ role_code: string }>(
        `SELECT role_code FROM user_role_assignments
         WHERE user_id=$1 AND revoked_at IS NULL
         ORDER BY role_code`,
        [userId],
      ),
      pool.query<{ delegation_id: string }>(
        `SELECT delegation_id FROM delegated_authorizations
         WHERE grantee_user_id=$1 AND revoked_at IS NULL
         ORDER BY delegation_id`,
        [userId],
      ),
    ]);
    assertStandardAcceptanceAuthorization({
      alias,
      expectedRole: roleCode,
      activeRoles: roles.rows.map((row) => row.role_code),
      unrevokedDelegationIds: delegations.rows.map((row) => row.delegation_id),
    });
  }

  for (const [alias, , roleCode] of ACCEPTANCE_USERS) {
    if (alias === "root") continue;
    const userId = userIdByAlias.get(alias)!;
    const existing = await pool.query(
      "SELECT 1 FROM user_role_assignments WHERE user_id=$1 AND role_code=$2 AND revoked_at IS NULL",
      [userId, roleCode],
    );
    if (!existing.rows[0]) {
      await access.assignRole(
        { ...rootActor, requestId: randomUUID() },
        { userId, roleCode, reason: "隔离验收中心标准角色" },
      );
    }
  }

  // Existing role grants must also repair missing personnel on rerun.
  for (const [alias, displayName, roleCode] of ACCEPTANCE_USERS) {
    await ensureAcceptanceWorkerPerson(pool, access, rootActor, {
      alias, displayName, roleCode, userId: userIdByAlias.get(alias)!,
    });
  }

  console.log(JSON.stringify({
    database: databaseName,
    corpId,
    rootDingtalkUserId: "uat-root",
    users: ACCEPTANCE_USERS.map(([alias, displayName, roleCode]) => ({
      alias,
      displayName,
      roleCode,
      providerUserId: `uat-${alias}`,
    })),
  }, null, 2));
} finally {
  await pool.end();
}
