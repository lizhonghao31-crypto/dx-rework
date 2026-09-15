import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;
export type BusinessModule = "rework" | "sourcing";

// Historical migration fixtures legitimately predate this optional policy.
export async function hasMemberModulePolicy(db: Queryable): Promise<boolean> {
  const result = await db.query<{ available: boolean }>(
    "SELECT to_regclass('business_module_owner_bindings') IS NOT NULL AS available",
  );
  return result.rows[0]?.available === true;
}

export async function effectiveMemberAuthorization(db: Queryable, userId: string, capabilities: string[]): Promise<{
  capabilities: string[]; readOnlyModules: BusinessModule[];
}> {
  if (!(await hasMemberModulePolicy(db))) return { capabilities, readOnlyModules: [] };
  const result = await db.query<{ capabilities: string[]; read_only_modules: BusinessModule[] }>(
    `SELECT ARRAY(SELECT capability FROM unnest($2::text[]) AS c(capability)
       WHERE member_module_capability_allowed($1::uuid,capability)) capabilities,
     ARRAY(SELECT module FROM unnest(ARRAY['rework','sourcing']) AS m(module)
       WHERE NOT member_module_can_write($1::uuid,module)) read_only_modules`, [userId, capabilities],
  );
  return { capabilities: result.rows[0]!.capabilities, readOnlyModules: result.rows[0]!.read_only_modules };
}

export async function memberCanReceiveFact(db: Queryable, userId: string, sourceAction: string, entityType: string, entityId?: string): Promise<boolean> {
  if (!(await hasMemberModulePolicy(db))) return true;
  const result = await db.query<{ allowed: boolean }>(
    `SELECT COALESCE(member_module_can_notify($1::uuid,member_module_for_todo_fact($2,$3,$4)),true) allowed`,
    [userId, sourceAction, entityType, entityId ?? null],
  );
  return result.rows[0]?.allowed === true;
}

export async function memberCanWriteModule(db: Queryable, userId: string, module: BusinessModule): Promise<boolean> {
  if (!(await hasMemberModulePolicy(db))) return true;
  const result = await db.query<{ allowed: boolean }>("SELECT member_module_can_write($1::uuid,$2) allowed", [userId, module]);
  return result.rows[0]?.allowed === true;
}
