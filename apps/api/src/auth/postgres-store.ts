import { effectiveMemberAuthorization, type BusinessModule } from "../access/member-module-policy.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import type { OrganizationMember } from "./provider.js";
import {
  AuthDeniedError,
  stableEqual,
  type AuthStore,
  type AuthUser,
  type QrChallenge,
  type SessionIdentity,
  type SessionRecord,
} from "./service.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export class PostgresAuthStore implements AuthStore {
  constructor(
    private readonly database: Pool,
    private readonly corporationId: string,
    private readonly rootDingtalkUserId?: string,
  ) {}

  async cleanupExpiredAuthArtifacts(now: Date): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM auth_consumed_codes WHERE expires_at <= $1", [now]);
      await client.query("DELETE FROM auth_qr_challenges WHERE expires_at <= $1", [now]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeCode(codeHash: string, expiresAt: Date): Promise<boolean> {
    const result = await this.database.query(
      "INSERT INTO auth_consumed_codes(code_hash, expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [codeHash, expiresAt],
    );
    return result.rowCount === 1;
  }

  async createQrState(value: QrChallenge): Promise<void> {
    await this.database.query(
      "INSERT INTO auth_qr_challenges(state_hash, nonce, expires_at) VALUES($1,$2,$3)",
      [value.stateHash, value.bindingHash, value.expiresAt],
    );
  }

  async consumeQrState(stateHash: string, bindingHash: string, now: Date): Promise<boolean> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ binding_hash: string }>(
        "SELECT nonce AS binding_hash FROM auth_qr_challenges WHERE state_hash=$1 AND used_at IS NULL AND expires_at>$2 FOR UPDATE",
        [stateHash, now],
      );
      if (!result.rows[0] || !stableEqual(result.rows[0].binding_hash, bindingHash)) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query("UPDATE auth_qr_challenges SET used_at=$2 WHERE state_hash=$1", [stateHash, now]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertIdentity(member: OrganizationMember): Promise<AuthUser> {
    const client = await this.database.connect();
    let user: AuthUser | undefined;
    let enabled = false;
    try {
      await client.query("BEGIN");
      user = await this.upsertDirectoryIdentity(client, member);
      const access = await client.query<{ enabled: boolean }>(
        "SELECT enabled FROM app_users WHERE id=$1",
        [user.id],
      );
      enabled = access.rows[0]?.enabled === true;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!enabled) throw new AuthDeniedError("ACCOUNT_DISABLED", "账号尚未分配有效业务权限");
    if (!user) throw new Error("DingTalk identity upsert did not return a user");
    return user;
  }

  async upsertDirectoryIdentity(client: PoolClient, member: OrganizationMember): Promise<AuthUser> {
    if (!stableEqual(member.corpId, this.corporationId)) {
      throw new Error("DingTalk identity belongs to a different corporation");
    }
    if (!member.active || !member.employed) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dx_rework:owner_group_guard'))");
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `dingtalk:${member.corpId}:${member.unionId}`,
    ]);
    const isRootIdentity = member.userId === this.rootDingtalkUserId;
    const existing = await client.query<{ user_id: string }>(
      "SELECT user_id FROM identity_mappings WHERE provider='dingtalk' AND corp_id=$1 AND (provider_user_id=$2 OR union_id=$3) FOR UPDATE",
      [member.corpId, member.userId, member.unionId],
    );
    const userId = existing.rows[0]?.user_id ?? randomUUID();
    if (!existing.rows[0]) {
      await client.query(
        "INSERT INTO app_users(id,display_name,enabled,manual_access_disabled) VALUES($1,$2,$3,false)",
        [userId, member.displayName, isRootIdentity],
      );
    } else {
      await client.query(
        `UPDATE app_users
         SET display_name=$2,
             enabled=CASE WHEN $3 THEN true ELSE enabled END,
             manual_access_disabled=CASE WHEN $3 THEN false ELSE manual_access_disabled END,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$1`,
        [userId, member.displayName, isRootIdentity],
      );
    }
    if (existing.rows[0]) {
      await client.query(
        "UPDATE identity_mappings SET active=$2,employed=$3,last_verified_at=CURRENT_TIMESTAMP WHERE provider='dingtalk' AND corp_id=$1 AND user_id=$4",
        [member.corpId, member.active, member.employed, userId],
      );
    } else {
      await client.query(
        "INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk',$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)",
        [randomUUID(), userId, member.corpId, member.userId, member.unionId, member.active, member.employed],
      );
    }
    const accessState = await client.query<{ enabled: boolean }>(
      `UPDATE app_users app_user
       SET enabled=CASE
             WHEN $2 THEN true
             WHEN app_user.manual_access_disabled THEN false
             ELSE access_user_has_effective_authorization(app_user.id)
           END,
           manual_access_disabled=CASE
             WHEN $2 THEN false
             ELSE app_user.manual_access_disabled
           END,
           updated_at=CURRENT_TIMESTAMP
       WHERE app_user.id=$1
       RETURNING app_user.enabled`,
      [userId, isRootIdentity],
    );
    if (accessState.rows[0]?.enabled !== true) {
      await client.query(
        "UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND revoked_at IS NULL",
        [userId],
      );
    }
    const authorization = await this.loadAuthorization(client, userId);
    return { id: userId, displayName: member.displayName, ...authorization };
  }

  async createSession(value: SessionRecord): Promise<void> {
    await this.database.query(
      "INSERT INTO auth_sessions(id,token_hash,user_id,expires_at) VALUES($1,$2,$3,$4)",
      [value.id, value.tokenHash, value.userId, value.expiresAt],
    );
  }

  async findSession(
    tokenHash: string,
    now: Date,
  ): Promise<(SessionRecord & { user: AuthUser; identity: SessionIdentity }) | null> {
    const result = await this.database.query<{
      id: string;
      token_hash: string;
      user_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      display_name: string;
      provider_user_id: string;
      union_id: string;
      corp_id: string;
      active: boolean;
      employed: boolean;
      last_verified_at: Date;
    }>(
      `SELECT s.id,s.token_hash,s.user_id,s.expires_at,s.revoked_at,u.display_name,
              i.provider_user_id,i.union_id,i.corp_id,i.active,i.employed,i.last_verified_at
       FROM auth_sessions s
       JOIN app_users u ON u.id=s.user_id
       JOIN identity_mappings i ON i.user_id=u.id AND i.provider='dingtalk' AND i.corp_id=$3
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 AND u.enabled=true
         AND i.active=true AND i.employed=true`,
      [tokenHash, now, this.corporationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const authorization = await this.loadAuthorization(this.database, row.user_id);
    return {
      id: row.id,
      tokenHash: row.token_hash,
      userId: row.user_id,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      user: { id: row.user_id, displayName: row.display_name, ...authorization },
      identity: {
        userId: row.provider_user_id,
        unionId: row.union_id,
        corpId: row.corp_id,
        active: row.active,
        employed: row.employed,
        lastVerifiedAt: row.last_verified_at,
      },
    };
  }

  async deactivateIdentity(userId: string, verifiedAt: Date): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dx_rework:owner_group_guard'))");
      await client.query(
        `UPDATE identity_mappings
         SET active=false,employed=false,last_verified_at=$2
         WHERE user_id=$1 AND provider='dingtalk' AND corp_id=$3`,
        [userId, verifiedAt, this.corporationId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.database.query(
      "UPDATE auth_sessions SET revoked_at=$2 WHERE token_hash=$1 AND revoked_at IS NULL",
      [tokenHash, now],
    );
  }

  private async loadAuthorization(
    queryable: Queryable,
    userId: string,
  ): Promise<{ capabilities: string[]; businessRoles: string[]; readOnlyModules: BusinessModule[]; effectiveWriteCapabilities: string[] }> {
    const roles = await queryable.query<{ role_code: string }>(
      `SELECT ura.role_code
       FROM user_role_assignments ura
       JOIN business_roles br ON br.role_code=ura.role_code AND br.enabled=true
       WHERE ura.user_id=$1 AND ura.revoked_at IS NULL
       ORDER BY ura.role_code`,
      [userId],
    );
    const capabilities = await queryable.query<{ capability: string }>(
      `SELECT capability
       FROM (
         SELECT rc.capability
         FROM user_role_assignments ura
         JOIN business_roles br ON br.role_code=ura.role_code AND br.enabled=true
         JOIN role_capabilities rc ON rc.role_code=ura.role_code
         WHERE ura.user_id=$1 AND ura.revoked_at IS NULL
         UNION
         SELECT da.capability
         FROM delegated_authorizations da
         WHERE da.grantee_user_id=$1
           AND da.scope_type='global'
           AND da.scope_id IS NULL
           AND da.revoked_at IS NULL
           AND da.valid_from <= CURRENT_TIMESTAMP
           AND da.valid_until > CURRENT_TIMESTAMP
           AND EXISTS (
             SELECT 1
             FROM app_users grantor
             JOIN identity_mappings i ON i.user_id=grantor.id
             WHERE grantor.id=da.grantor_user_id AND grantor.enabled=true
               AND i.provider='dingtalk' AND i.corp_id=$2
               AND i.active=true AND i.employed=true
           )
           AND EXISTS (
             SELECT 1
             FROM user_role_assignments grantor_role
             JOIN business_roles grantor_business_role
               ON grantor_business_role.role_code=grantor_role.role_code
               AND grantor_business_role.enabled=true
             JOIN role_capabilities grantor_capability
               ON grantor_capability.role_code=grantor_role.role_code
             WHERE grantor_role.user_id=da.grantor_user_id
               AND grantor_role.revoked_at IS NULL
               AND grantor_capability.capability=da.capability
           )
       ) effective
       ORDER BY capability`,
      [userId, this.corporationId],
    );
    const granted = capabilities.rows.map((row) => row.capability);
    const effective = await effectiveMemberAuthorization(queryable, userId, granted);
    return {
      businessRoles: roles.rows.map((row) => row.role_code),
      capabilities: granted,
      effectiveWriteCapabilities: effective.capabilities,
      readOnlyModules: effective.readOnlyModules,
    };
  }
}
