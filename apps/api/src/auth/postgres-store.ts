import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import type { OrganizationMember } from "./provider.js";
import type { AuthStore, AuthUser, QrChallenge, SessionIdentity, SessionRecord } from "./service.js";

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly database: Pool) {}
  async consumeCode(codeHash: string, expiresAt: Date): Promise<boolean> {
    const result = await this.database.query("INSERT INTO auth_consumed_codes(code_hash, expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING", [codeHash, expiresAt]);
    return result.rowCount === 1;
  }
  async createQrState(value: QrChallenge): Promise<void> {
    await this.database.query("INSERT INTO auth_qr_challenges(state_hash, nonce, expires_at) VALUES($1,$2,$3)", [value.stateHash, value.bindingHash, value.expiresAt]);
  }
  async consumeQrState(stateHash: string, now: Date): Promise<QrChallenge | null> {
    const result = await this.database.query<QrChallenge>("UPDATE auth_qr_challenges SET used_at=$2 WHERE state_hash=$1 AND used_at IS NULL AND expires_at>$2 RETURNING state_hash AS \"stateHash\", nonce AS \"bindingHash\", expires_at AS \"expiresAt\", used_at AS \"usedAt\"", [stateHash, now]);
    return result.rows[0] ?? null;
  }
  async upsertIdentity(member: OrganizationMember): Promise<AuthUser> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`dingtalk:${member.corpId}:${member.unionId}`]);
      const existing = await client.query<{ user_id: string }>("SELECT user_id FROM identity_mappings WHERE provider='dingtalk' AND corp_id=$1 AND (provider_user_id=$2 OR union_id=$3) FOR UPDATE", [member.corpId, member.userId, member.unionId]);
      const userId = existing.rows[0]?.user_id ?? randomUUID();
      if (!existing.rows[0]) await client.query("INSERT INTO app_users(id, display_name) VALUES($1,$2)", [userId, member.displayName]);
      else await client.query("UPDATE app_users SET display_name=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$1", [userId, member.displayName]);
      if (existing.rows[0]) await client.query("UPDATE identity_mappings SET provider_user_id=$2,union_id=$3,active=$4,employed=$5,last_verified_at=CURRENT_TIMESTAMP WHERE provider='dingtalk' AND corp_id=$1 AND user_id=$6", [member.corpId, member.userId, member.unionId, member.active, member.employed, userId]);
      else await client.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk',$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)", [randomUUID(), userId, member.corpId, member.userId, member.unionId, member.active, member.employed]);
      const capabilities = await client.query<{ capability: string }>("SELECT capability FROM user_capabilities WHERE user_id=$1", [userId]);
      await client.query("COMMIT");
      return { id: userId, displayName: member.displayName, capabilities: capabilities.rows.map((row) => row.capability) };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async createSession(value: SessionRecord): Promise<void> {
    await this.database.query("INSERT INTO auth_sessions(id,token_hash,user_id,expires_at) VALUES($1,$2,$3,$4)", [value.id, value.tokenHash, value.userId, value.expiresAt]);
  }
  async findSession(tokenHash: string, now: Date): Promise<(SessionRecord & { user: AuthUser; identity: SessionIdentity }) | null> {
    const result = await this.database.query<{ id: string; token_hash: string; user_id: string; expires_at: Date; revoked_at: Date | null; display_name: string; capabilities: string[]; provider_user_id: string; union_id: string; corp_id: string; active: boolean; employed: boolean; last_verified_at: Date }>("SELECT s.id,s.token_hash,s.user_id,s.expires_at,s.revoked_at,u.display_name,i.provider_user_id,i.union_id,i.corp_id,i.active,i.employed,i.last_verified_at,COALESCE(array_agg(DISTINCT c.capability) FILTER (WHERE c.capability IS NOT NULL),'{}') capabilities FROM auth_sessions s JOIN app_users u ON u.id=s.user_id JOIN identity_mappings i ON i.user_id=u.id AND i.provider='dingtalk' LEFT JOIN user_capabilities c ON c.user_id=u.id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 AND u.enabled=true GROUP BY s.id,u.id,i.id", [tokenHash, now]);
    const row = result.rows[0];
    return row ? { id: row.id, tokenHash: row.token_hash, userId: row.user_id, expiresAt: row.expires_at, revokedAt: row.revoked_at, user: { id: row.user_id, displayName: row.display_name, capabilities: row.capabilities }, identity: { userId: row.provider_user_id, unionId: row.union_id, corpId: row.corp_id, active: row.active, employed: row.employed, lastVerifiedAt: row.last_verified_at } } : null;
  }
  async deactivateIdentity(userId: string, verifiedAt: Date): Promise<void> { await this.database.query("UPDATE identity_mappings SET active=false,employed=false,last_verified_at=$2 WHERE user_id=$1 AND provider='dingtalk'", [userId, verifiedAt]); }
  async revokeSession(tokenHash: string, now: Date): Promise<void> { await this.database.query("UPDATE auth_sessions SET revoked_at=$2 WHERE token_hash=$1 AND revoked_at IS NULL", [tokenHash, now]); }
}
