import { randomUUID } from "node:crypto";

import pg from "pg";

import { AccessMasterDataService } from "../../apps/api/dist/access/service.js";

const { Pool } = pg;

const STANDARD_USERS = [
  ["development-clerk", "[UAT] 开发文员", "development_clerk"],
  ["pattern-room-tail-inspector", "[UAT] 板房尾查", "pattern_room_tail_inspector"],
  ["pattern-room-supervisor", "[UAT] 技术主管", "pattern_room_supervisor"],
  ["pattern-room-worker", "[UAT] 板房师傅", "pattern_room_worker"],
];

const databaseUrl = process.env.DATABASE_URL?.trim();
const corpId = process.env.DINGTALK_CORP_ID?.trim();

if (!databaseUrl || !corpId) throw new Error("Acceptance role seeding requires DATABASE_URL and DINGTALK_CORP_ID");

const pool = new Pool({
  connectionString: databaseUrl,
  application_name: "dx-rework-acceptance-runtime-seed",
  max: 2,
});

const userIds = new Map();

async function readIdentity(alias) {
  const providerUserId = `uat-${alias}`;
  const result = await pool.query(
    `SELECT identity.user_id,identity.union_id,identity.active,identity.employed,
            app_user.display_name,app_user.enabled
     FROM identity_mappings identity
     JOIN app_users app_user ON app_user.id=identity.user_id
     WHERE identity.provider='dingtalk'
       AND identity.corp_id=$1
       AND identity.provider_user_id=$2`,
    [corpId, providerUserId],
  );
  return result.rows[0] ?? null;
}

async function assertCleanExisting(alias, expectedRole) {
  const identity = await readIdentity(alias);
  if (!identity) return null;
  if (
    identity.union_id !== `uat-union-${alias}`
    || identity.active !== true
    || identity.employed !== true
    || identity.enabled !== true
  ) {
    throw new Error(`Acceptance identity is dirty: ${alias}`);
  }
  const [roles, delegations] = await Promise.all([
    pool.query(
      `SELECT role_code FROM user_role_assignments
       WHERE user_id=$1 AND revoked_at IS NULL
       ORDER BY role_code`,
      [identity.user_id],
    ),
    pool.query(
      `SELECT delegation_id FROM delegated_authorizations
       WHERE grantee_user_id=$1 AND revoked_at IS NULL
       ORDER BY delegation_id`,
      [identity.user_id],
    ),
  ]);
  const activeRoles = roles.rows.map((row) => row.role_code);
  if (activeRoles.length > 1 || (activeRoles.length === 1 && activeRoles[0] !== expectedRole)) {
    throw new Error(`Acceptance identity has unexpected roles: ${alias}`);
  }
  if (delegations.rows.length > 0) throw new Error(`Acceptance identity has active delegation: ${alias}`);
  userIds.set(alias, identity.user_id);
  return identity.user_id;
}

try {
  const databaseName = (await pool.query("SELECT current_database() AS name")).rows[0]?.name;
  if (databaseName !== "dx_rework_acceptance") {
    throw new Error(`Acceptance role seeding refused database: ${String(databaseName)}`);
  }

  const root = (await pool.query(
    `SELECT identity.user_id
     FROM identity_mappings identity
     JOIN app_users app_user ON app_user.id=identity.user_id
     JOIN user_role_assignments role
       ON role.user_id=identity.user_id
      AND role.role_code='owner_group'
      AND role.revoked_at IS NULL
     WHERE identity.provider='dingtalk'
       AND identity.corp_id=$1
       AND identity.provider_user_id='uat-root'
       AND identity.union_id='uat-union-root'
       AND identity.active=true
       AND identity.employed=true
       AND app_user.enabled=true
     LIMIT 1`,
    [corpId],
  )).rows[0];

  if (!root?.user_id) throw new Error("Acceptance uat-root identity is unavailable");

  for (const [alias, , roleCode] of STANDARD_USERS) {
    await assertCleanExisting(alias, roleCode);
  }

  const access = new AccessMasterDataService(pool, corpId);
  await access.ensureOrganizationPolicy();
  const rootActor = {
    actorId: root.user_id,
    actorRoles: ["root_superuser", "owner_group"],
    authorizationCapability: "access:admin",
    authorizationCapabilities: ["access:admin"],
    requestId: randomUUID(),
  };

  for (const [alias, displayName, roleCode] of STANDARD_USERS) {
    let userId = userIds.get(alias);
    if (!userId) {
      userId = randomUUID();
      await pool.query(
        "INSERT INTO app_users(id,display_name,enabled,manual_access_disabled) VALUES($1,$2,true,false)",
        [userId, displayName],
      );
      await pool.query(
        `INSERT INTO identity_mappings(
           id,user_id,provider,corp_id,provider_user_id,union_id,
           active,employed,last_verified_at
         ) VALUES($1,$2,'dingtalk',$3,$4,$5,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, corpId, `uat-${alias}`, `uat-union-${alias}`],
      );
      userIds.set(alias, userId);
    } else {
      await pool.query(
        "UPDATE app_users SET display_name=$2 WHERE id=$1",
        [userId, displayName],
      );
    }

    const role = await pool.query(
      `SELECT 1 FROM user_role_assignments
       WHERE user_id=$1 AND role_code=$2 AND revoked_at IS NULL`,
      [userId, roleCode],
    );
    if (!role.rows[0]) {
      await access.assignRole(
        { ...rootActor, requestId: randomUUID() },
        { userId, roleCode, reason: "隔离验收中心标准角色" },
      );
    }

    await assertCleanExisting(alias, roleCode);
  }

  process.stdout.write(JSON.stringify({
    status: "ready",
    database: databaseName,
    aliases: STANDARD_USERS.map(([alias]) => alias),
  }) + "\n");
} finally {
  await pool.end();
}
