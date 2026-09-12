import { createHash } from "node:crypto";
import { canUsePatternPrice, PatternPriceChangeSchema, type PatternPriceCapability, type PatternPriceChange, type PatternPriceItem } from "@dx-rework/contracts/pattern-room";
import type { Pool } from "pg";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type SqlClient, type TrustedActorContext } from "../tools/repositories.js";

export const PATTERN_HOURLY_PRICE_ID = "92000000-0000-4000-8000-000000000100";
const caps = (actor: TrustedActorContext) => actor.authorizationCapabilities ?? [actor.authorizationCapability];
export function assertPatternPriceAccess(actor: TrustedActorContext, capability: PatternPriceCapability): void {
  if (!canUsePatternPrice(actor.actorRoles, caps(actor), capability)) throw new ApplicationError("FORBIDDEN", "当前账号无权执行此价格操作", 403);
}
export async function requirePatternPriceAccess(db: SqlClient, actor: TrustedActorContext, capability: PatternPriceCapability): Promise<void> {
  assertPatternPriceAccess(actor, capability);
  try { await db.query("SELECT pattern_room_authorized_price_roles($1,$2)", [actor.actorId, capability]); }
  catch (error) {
    if ((error as { code?: string }).code === "42501") throw new ApplicationError("FORBIDDEN", "当前账号的价格权限已失效", 403);
    throw error;
  }
}
type PriceRow = { price_id: string; kind: "category" | "hourly"; name: string; unit: "件" | "套" | "小时"; amount: string | null; enabled: boolean; version: number; updated_by: string | null; updated_at: Date; updated_name?: string | null };
const item = (row: PriceRow): PatternPriceItem => ({ priceId: row.price_id, kind: row.kind, name: row.name, unit: row.unit, amount: row.amount,
  enabled: row.enabled, version: row.version, updatedBy: row.updated_name ?? row.updated_by, updatedAt: row.updated_at.toISOString() });

export class PatternRoomPriceService {
  constructor(private readonly db: Pool, private readonly idempotency = new IdempotencyService(), private readonly events = new OperationEventRepository()) {}

  async management(actor: TrustedActorContext) {
    await requirePatternPriceAccess(this.db, actor, "pattern_room:prices:read");
    const result = await this.db.query<PriceRow>(`SELECT price.*,person.display_name updated_name FROM pattern_room_prices price
      LEFT JOIN app_users person ON person.id=price.updated_by ORDER BY price.sort_order,price.price_id`);
    const hourly = result.rows.find(row => row.kind === "hourly");
    if (!hourly) throw new ApplicationError("NOT_FOUND", "小时价格配置尚未初始化", 404);
    return { categories: result.rows.filter(row => row.kind === "category").map(item), hourly: item(hourly),
      canWriteCategories: canUsePatternPrice(actor.actorRoles, caps(actor), "pattern_room:prices:write"),
      canWriteHourly: canUsePatternPrice(actor.actorRoles, caps(actor), "pattern_room:hourly:write") };
  }

  async options(actor: TrustedActorContext) {
    await requirePatternPriceAccess(this.db, actor, "pattern_room:catalog:read");
    const result = await this.db.query<{ price_id: string; name: string; unit: string }>(
      "SELECT price_id,name,unit FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY sort_order,price_id");
    return result.rows.map(row => ({ priceId: row.price_id, name: row.name, unit: row.unit }));
  }

  async quote(actor: TrustedActorContext, kind: "category" | "hourly", priceId: string) {
    await requirePatternPriceAccess(this.db, actor, kind === "category" ? "pattern_room:catalog:read" : "pattern_room:misc:quote");
    const row = (await this.db.query<PriceRow>("SELECT * FROM pattern_room_prices WHERE price_id=$1 AND kind=$2 AND enabled", [priceId, kind])).rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "品类不存在或已停用，请重新选择", 404);
    // null is intentional: callers may prepare a misc request, but must not submit it at a made-up zero price.
    return { priceId: row.price_id, name: row.name, unit: row.unit, amount: row.amount, version: row.version };
  }

  async history(actor: TrustedActorContext, priceId: string) {
    await requirePatternPriceAccess(this.db, actor, "pattern_room:prices:read");
    const result = await this.db.query<{ version: number; old_amount: string | null; amount: string | null; old_enabled: boolean | null; enabled: boolean; reason: string; changed_by: string | null; changed_name: string | null; changed_at: Date }>(
      `SELECT history.*,person.display_name changed_name FROM pattern_room_price_history history
       LEFT JOIN app_users person ON person.id=history.changed_by WHERE price_id=$1 ORDER BY version DESC`, [priceId]);
    return result.rows.map(row => ({ version: row.version, oldAmount: row.old_amount, amount: row.amount, oldEnabled: row.old_enabled,
      enabled: row.enabled, reason: row.reason, changedBy: row.changed_name ?? row.changed_by, changedAt: row.changed_at.toISOString() }));
  }

  async change(actor: TrustedActorContext, kind: "category" | "hourly", priceId: string, input: PatternPriceChange, key: string): Promise<PatternPriceItem> {
    const capability = kind === "category" ? "pattern_room:prices:write" : "pattern_room:hourly:write";
    assertPatternPriceAccess(actor, capability);
    const parsed = PatternPriceChangeSchema.safeParse(input);
    if (!parsed.success) throw new ApplicationError("VALIDATION_ERROR", "请填写有效价格、版本与调整原因", 400);
    if (kind === "hourly" && !parsed.data.enabled) throw new ApplicationError("VALIDATION_ERROR", "小时价格不能停用", 400);
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new ApplicationError("VALIDATION_ERROR", "缺少有效操作标识，请重新操作", 400);
    const scope = `pattern_room.price.${kind}.changed`;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await requirePatternPriceAccess(client, actor, capability);
      const outcome = await this.idempotency.execute(client, { scope, actorKey: actor.actorId, key,
        requestHash: createHash("sha256").update(JSON.stringify({ priceId, ...parsed.data })).digest("hex"), expiresAt: new Date("9999-12-31T00:00:00Z") }, async () => {
        const before = (await client.query<PriceRow>("SELECT * FROM pattern_room_prices WHERE price_id=$1 AND kind=$2 FOR UPDATE", [priceId, kind])).rows[0];
        if (!before) throw new ApplicationError("NOT_FOUND", "价格项不存在", 404);
        if (before.version !== parsed.data.version) throw new ApplicationError("CONFLICT", "价格已被调整，请刷新后核对最新价格再保存", 409);
        const after = (await client.query<PriceRow>(`UPDATE pattern_room_prices SET amount=$2,enabled=$3,version=version+1,updated_by=$4,updated_at=CURRENT_TIMESTAMP
          WHERE price_id=$1 RETURNING *`, [priceId, parsed.data.amount, parsed.data.enabled, actor.actorId])).rows[0]!;
        await client.query(`INSERT INTO pattern_room_price_history(price_id,version,old_amount,amount,old_enabled,enabled,reason,changed_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [priceId, after.version, before.amount, after.amount, before.enabled, after.enabled, parsed.data.reason, actor.actorId]);
        await this.events.append(client, { ...actor, authorizationCapability: capability }, { action: scope, entityType: "pattern_room_price", entityId: priceId,
          before: item(before), after: item(after), reason: parsed.data.reason });
        return { statusCode: 200, response: item(after) };
      });
      await client.query("COMMIT");
      return outcome.response;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
