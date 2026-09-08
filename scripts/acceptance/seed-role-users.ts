import { randomUUID } from "node:crypto";

import pg from "pg";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const { Pool } = pg;

const ACCEPTANCE_USERS = [
  ["root", "[UAT] Root", "owner_group"],
  ["owner", "[UAT] 老板", "owner_group"],
  ["production-management", "[UAT] 生产管理", "production_management"],
  ["ie", "[UAT] IE", "ie_reviewer"],
  ["tail-supervisor", "[UAT] 尾部主管", "tail_supervisor"],
  ["qc", "[UAT] 质检", "quality_control"],
  ["warehouse", "[UAT] 仓管", "warehouse_receiver"],
  ["worker-a", "[UAT] 工人甲", "worker"],
  ["worker-b", "[UAT] 工人乙", "worker"],
  ["merchandiser", "[UAT] 订单跟单", "order_merchandiser"],
  ["finance-read", "[UAT] 财务全局查看", "finance_read"],
  ["finance-director", "[UAT] 财务总监", "finance_director"],
  ["factory-payables", "[UAT] 加工厂应付会计", "factory_payables"],
  ["system-admin", "[UAT] 系统管理员", "system_admin"],
  ["production-reporter", "[UAT] 驻厂生产填报", "production_reporter"],
  ["sample-designer", "[UAT] 样衣设计师", "sample_designer"],
  ["sample-admin", "[UAT] 样衣管理员", "sample_administrative"],
  ["sample-finance", "[UAT] 样衣财务", "sample_finance"],
  ["sample-approver", "[UAT] 样衣审批人", "sample_approver"],
] as const;

const acceptanceDatabaseUrl = process.env.ACCEPTANCE_DATABASE_URL?.trim();
if (process.env.NODE_ENV !== "test" || process.env.ACCEPTANCE_LAB_ENABLED !== "true") {
  throw new Error("Acceptance role seeding requires NODE_ENV=test and ACCEPTANCE_LAB_ENABLED=true");
}
if (!acceptanceDatabaseUrl) throw new Error("ACCEPTANCE_DATABASE_URL is required; DATABASE_URL fallback is forbidden");
const parsed = new URL(acceptanceDatabaseUrl);
if (!/(?:accept|uat|test)/i.test(parsed.pathname)) {
  throw new Error("Acceptance database name must visibly contain accept, uat, or test");
}
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
  if (!/(?:accept|uat|test)/i.test(databaseName)) {
    throw new Error(`Refusing acceptance seed against database ${databaseName || "<unknown>"}`);
  }

  for (const [alias, displayName] of ACCEPTANCE_USERS) await ensureUser(alias, displayName);

  const rootId = userIdByAlias.get("root")!;
  const policy = await pool.query("SELECT 1 FROM access_security_policy WHERE policy_key='primary'");
  const rootAssignment = await pool.query(
    "SELECT 1 FROM user_role_assignments WHERE user_id=$1 AND role_code='owner_group' AND revoked_at IS NULL",
    [rootId],
  );

  if (!policy.rows[0]) {
    if (!rootAssignment.rows[0]) {
      await pool.query(
        `INSERT INTO user_role_assignments(
           assignment_id,user_id,role_code,granted_by,grant_reason
         ) VALUES($1,$2,'owner_group',$2,'验收环境首次Root角色')`,
        [randomUUID(), rootId],
      );
    }
    const bootstrap = await pool.query("SELECT user_id FROM owner_bootstrap_consumptions WHERE singleton=true");
    if (!bootstrap.rows[0]) {
      await pool.query(
        `INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id)
         VALUES(true,$1,'uat-root',$2)`,
        [rootId, corpId],
      );
    } else if (bootstrap.rows[0].user_id !== rootId) {
      throw new Error("Acceptance database is already bound to a different Root identity");
    }
    await pool.query(
      "INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary',$1)",
      [corpId],
    );
  } else if (!rootAssignment.rows[0]) {
    throw new Error("Acceptance security policy exists but the UAT Root owner role is missing; rebuild the acceptance database instead of bypassing guards");
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

  for (const [alias, _displayName, roleCode] of ACCEPTANCE_USERS) {
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
